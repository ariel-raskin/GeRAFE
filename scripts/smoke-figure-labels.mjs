import { chromium } from 'playwright-core'
import { access, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.argv[2] ?? 'http://127.0.0.1:5173'
const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'] : ['/usr/bin/google-chrome', '/usr/bin/chromium']
let executablePath
for (const path of candidates) { try { await access(path); executablePath = path; break } catch {} }
if (!executablePath) throw new Error('Chrome or Edge is required.')
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1640, height: 1120 } }), errors = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url, { waitUntil: 'networkidle' })
  // Seed a real GeR undo entry so keyboard isolation is a meaningful check.
  const header = await page.locator('#genome-header').boundingBox()
  await page.keyboard.down('Control'); await page.mouse.click(header.x + header.width * 0.55, header.y + 35); await page.keyboard.up('Control')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').comparisonDividers?.length === 1)
  const viewerBefore = await page.evaluate(() => localStorage.getItem('gerafe-track-document'))
  const ids = await page.evaluate(async () => {
    const { createManuscriptFixture } = await import('/scripts/fixtures/manuscript-figure.ts')
    const { FigureEditor } = await import('/src/figure-editor.ts')
    const { addSignalTrack, assignDisplayGroup, collapseSignalStack } = await import('/src/track-document.ts')
    const fixture = createManuscriptFixture(), doc = fixture.document
    const region = doc.columns[0].region
    const names = ['Control R1', 'Control R2', 'Control R3'], colors = ['#cc2244', '#2255cc', '#229955']
    for (let index = 0; index < 3; index++) {
      const id = `rep-${index}`
      addSignalTrack(doc.sourceDocument, { id, name: names[index], format: 'bedgraph', files: [] }, { id, color: colors[index], label: names[index], autoPair: false })
      fixture.sources.set(id, { name: names[index], chromosomes: new Map([['chr1', 3000000]]), async getFeatures() { return Array.from({ length: 100 }, (_, bin) => ({ start: region.start + bin * 2000, end: region.start + (bin + 1) * 2000, score: (bin < 50 ? 5 : 15) * (0.5 + 0.5 * Math.sin(bin / 7 + index)) })) } })
    }
    assignDisplayGroup(doc.sourceDocument, ['rep-0', 'rep-1', 'rep-2'], 'Replicates')
    const group = doc.sourceDocument.groups.find((group) => group.label === 'Replicates')
    collapseSignalStack(doc.sourceDocument, group.id)
    const row = { id: 'replicate-row', label: '', groupLabel: group.label, trackIds: ['rep-0', 'rep-1', 'rep-2'], heightMm: 15, gapAfterMm: 0, included: true }
    doc.rows.push(row); doc.groups.push({ id: group.id, label: group.label, rowIds: [row.id], appearance: {} })
    for (const column of doc.columns) column.assignments[row.id] = [...row.trackIds]
    doc.page.labelWidthMm = 32
    window.__figureQueryCalls = []
    for (const [id, reader] of fixture.sources) fixture.sources.set(id, { ...reader, async getFeatures(region, pixels, signal, options) {
      window.__figureQueryCalls.push({ id, region, pixels, options })
      return reader.getFeatures(region, pixels, signal, options)
    } })
    window.__labelFixture = new FigureEditor({ document: doc, sources: fixture.sources, genes: () => fixture.genes, chromosomes: () => new Map([['chr1', 3000000]]), restoreSources: async () => fixture.sources, relinkSource: async () => undefined, onClose: () => {} })
    window.__labelFixture.show()
    return { group: group.id, row: row.id, factorA: doc.rows.find((row) => row.trackIds[0] === 'factor-0-0').id, factorB: doc.rows.find((row) => row.trackIds[0] === 'factor-1-0').id }
  })
  const ready = () => page.waitForFunction(() => document.querySelector('.figure-editor [data-role="status"]')?.textContent.includes('mm'))
  const current = () => page.evaluate(() => window.__labelFixture.currentDocument)
  // A coarse bin crossing a crop edge must not spill into the legend's empty corner.
  const edgePixels = await page.evaluate(async () => {
    const { createTrackDocument, addMatrixTrack } = await import('/src/track-document.ts')
    const { createFigureDocument } = await import('/src/figure-document.ts')
    const { FigureRenderSession, layoutFigure, figureCellBounds } = await import('/src/figure-render.ts')
    const region = { chr: 'chr1', start: 500, end: 10500 }, source = createTrackDocument('hg38', region)
    addMatrixTrack(source, { id: 'edge', name: 'edge', format: 'cool', files: [] }, { id: 'edge' })
    const figure = createFigureDocument(source), row = figure.rows.find((row) => row.trackIds[0] === 'edge')
    figure.rows.forEach((candidate) => { candidate.included = candidate.id === row.id })
    Object.assign(figure.page, { widthMm: 80, labelWidthMm: 15, marginMm: 5 })
    row.heightMm = 40; row.frameWidthPt = 0; row.appearance = { showAnnotations: false }
    figure.columns[0].styles[row.id] = { matrixPalette: 'warm', scaleMode: 'fixed', scaleMin: 0, scaleMax: 20, appearance: { matrixLegend: 'none' } }
    const reader = { name: 'edge', chromosomes: new Map(), async getFeatures() { return [{ featureType: 'matrix', ...region, resolution: 2000, cells: [{ bin1: 0, bin2: 8000, value: 20 }], missingCells: [], maskedBins: [] }] } }
    const result = await new FigureRenderSession().render(figure, new Map([['edge', reader]]))
    const bounds = figureCellBounds(layoutFigure(figure), row.id, figure.columns[0].id)
    const image = new Image(), blobUrl = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }))
    try {
      image.src = blobUrl; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(result.widthMm * 10); canvas.height = Math.ceil(result.heightMm * 10)
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      const sample = (fraction) => [...ctx.getImageData(Math.round((bounds.x + fraction * bounds.width) * 10), Math.round((bounds.y + bounds.height - 0.4 * bounds.width) * 10), 1, 1).data].slice(0, 3)
      return { outside: sample(0.375), inside: sample(0.45) }
    } finally { URL.revokeObjectURL(blobUrl) }
  })
  assert.deepEqual(edgePixels.outside, [255, 255, 255], 'A bin spanning the crop edge must be clipped out of the empty triangle corner.')
  assert(edgePixels.inside.some((channel) => channel < 200), 'Clipping must preserve contact color inside the triangle.')

  await ready()
  assert.equal(await page.locator('.fe-page [data-fe-member-marker="rep-0"]').getAttribute('fill'), '#cc2244')
  assert.equal(await page.locator('.fe-page [data-fe-track-label="rep-1"] text').textContent(), 'Control R2')
  assert.equal(await page.locator('.fe-page [data-fe-legend-position="inside-left"]').count(), 3)
  // Bounds include legend text, not just the gradient rectangle.
  const clear = await page.locator('.fe-page [data-fe-legend-position="inside-left"]').evaluateAll((legends) => legends.every((legend) => {
    const [x, y, width, height] = legend.dataset.legendFootprint.split(' ').map(Number)
    const frame = legend.parentElement.querySelector(':scope > rect:last-child')
    return x > Number(frame.getAttribute('x')) && y >= Number(frame.getAttribute('y')) && x + width - Number(frame.getAttribute('x')) < Number(frame.getAttribute('y')) + Number(frame.getAttribute('height')) - y - height
  }))
  assert(clear, 'Inside color bars and their labels must not intersect the triangle.')
  const rowCells = page.locator(`.fe-page [data-fe-row="${ids.row}"]`)
  assert.equal(await rowCells.locator('[data-scale-start]').count(), 6)
  await page.locator('[data-action="zoom-detail"]').click(); await ready()
  assert.equal(await page.locator('[data-role="zoom"]').textContent(), '200%')
  await page.locator('[data-action="zoom-actual"]').click(); await ready()
  const groupLabel = () => page.locator(`[data-fe-group-label="${ids.group}"]`)
  const before = (await current()).groups.find((group) => group.id === ids.group).appearance
  const box = await groupLabel().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 12, { steps: 6 }); await page.mouse.up(); await ready()
  const moved = (await current()).groups.find((group) => group.id === ids.group).appearance
  assert(moved.groupLabelXmm > (before.groupLabelXmm ?? 5) + 5 && moved.groupLabelYmm > 2)
  await page.locator('[data-action="zoom-actual"]').focus(); await page.keyboard.press('Control+z'); await ready()
  assert.equal((await current()).groups.find((group) => group.id === ids.group).appearance.groupLabelYmm ?? 0, before.groupLabelYmm ?? 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('gerafe-track-document')), viewerBefore)
  await groupLabel().click({ button: 'right' })
  await page.locator('.fe-label-menu [data-label-action="rename"]').click()
  await page.locator('.fe-label-dialog input').fill('Replicate signals'); await page.locator('.fe-label-dialog input').press('Enter'); await ready()
  assert.equal((await current()).groups.find((group) => group.id === ids.group).label, 'Replicate signals')
  const member = () => page.locator('.fe-page [data-fe-track-label="rep-0"] text')
  await member().click({ button: 'right' }); await page.locator('.fe-label-menu [data-label-action="rename"]').click()
  await page.locator('.fe-label-dialog input').fill('Control one'); await page.locator('.fe-label-dialog input').press('Enter'); await ready()
  assert.equal(await member().textContent(), 'Control one')
  await member().click(); await page.locator('[data-label-edit="track-color"]').fill('#8844cc'); await page.locator('[data-label-edit="track-color"]').dispatchEvent('change'); await ready()
  assert.equal(await page.locator('.fe-page [data-fe-member-marker="rep-0"]').getAttribute('fill'), '#8844cc')
  assert.equal((await current()).sourceDocument.tracks.find((track) => track.id === 'rep-0').color, '#8844cc')
  // Grouping from labels follows the same Ctrl/Shift selection convention as GeR.
  await page.locator(`.fe-page [data-fe-row-label="${ids.factorA}"] text`).click()
  await page.keyboard.down('Control'); await page.locator(`.fe-page [data-fe-row-label="${ids.factorB}"] text`).click(); await page.keyboard.up('Control')
  await page.locator(`.fe-page [data-fe-row-label="${ids.factorA}"] text`).click({ button: 'right' })
  await page.locator('.fe-label-menu [data-label-action="group-selected"]').click()
  await page.locator('.fe-label-dialog input').fill('Signal factors'); await page.locator('.fe-label-dialog input').press('Enter'); await ready()
  assert.equal((await current()).groups.find((group) => group.label === 'Signal factors').rowIds.length, 2)
  await page.locator('.fe-sidebar [data-select="page"]').click()
  const [saved] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')])
  assert(saved.suggestedFilename().endsWith('.gerafe-figure.json'))
  const project = JSON.parse(await readFile(await saved.path(), 'utf8'))
  assert.equal(project.schemaVersion, 3)
  assert.equal(project.groups.find((group) => group.id === ids.group).label, 'Replicate signals')
  const geometry = () => page.locator('.fe-page svg').evaluate((svg) => [...svg.querySelectorAll('path,rect,line,text,polygon,circle')].map((node) => ({ type: node.tagName, text: node.tagName === 'text' ? node.textContent : '', attributes: [...node.attributes].filter((attribute) => !['class', 'style'].includes(attribute.name)).map((attribute) => [attribute.name, attribute.value]).sort() })))
  const preview = await geometry()
  const previewQueries = await page.evaluate(() => window.__figureQueryCalls)
  const [exported] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="export-svg"]').click()])
  const svg = await readFile(await exported.path(), 'utf8')
  const exportGeometry = await page.evaluate((svg) => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('path,rect,line,text,polygon,circle')].map((node) => ({ type: node.tagName, text: node.tagName === 'text' ? node.textContent : '', attributes: [...node.attributes].filter((attribute) => !['class', 'style'].includes(attribute.name)).map((attribute) => [attribute.name, attribute.value]).sort() })), svg)
  assert.deepEqual(preview, exportGeometry, 'Preview and exported SVG must have identical plot/label geometry at the same settings.')
  await page.locator('[data-action="export-png"]').click()
  const [png] = await Promise.all([page.waitForEvent('download'), page.locator('.fe-confirm [value="300"]').click()])
  assert.deepEqual(await page.evaluate(() => window.__figureQueryCalls), previewQueries, 'SVG and PNG exports must reuse the same source-query detail as the preview, independent of PNG DPI.')
  await writeFile('dist/figure-labels-publication.png', await readFile(await png.path()))
  await page.screenshot({ path: 'dist/figure-labels-editor.png' })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-action="open"]').click()])
  await chooser.setFiles(await saved.path()); await ready()
  assert.equal(await page.locator('.fe-page [data-fe-track-label="rep-0"] text').textContent(), 'Control one')
  assert.equal(await page.evaluate(() => localStorage.getItem('gerafe-track-document')), viewerBefore)
  assert.deepEqual(errors, [])
  console.log('FE labels: semantic groups, member names/colors, draggable vertical labels, context rename/group, default divider values, protected GeR shortcuts, JSON reopen, identical preview/SVG geometry and print PNG passed.')
} finally { await browser.close() }
