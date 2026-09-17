import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'

const appUrl = process.argv[2] ?? 'http://127.0.0.1:5173'
const testGene = process.env.GERAFE_SMOKE_GENE ?? 'RUNX1'
const testGeneMode = process.env.GERAFE_SMOKE_GENE_MODE ?? 'expanded'
const dataPaths = process.argv.slice(3)
const candidates = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']

let executablePath
for (const candidate of candidates) {
  try {
    await access(candidate)
    executablePath = candidate
    break
  } catch { /* try the next installed browser */ }
}
if (!executablePath) throw new Error('Chrome, Chromium, or Edge is required for the browser smoke test.')

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(error.message))

await page.goto(appUrl, { waitUntil: 'networkidle' })
await page.waitForSelector('#track-status')
await page.waitForTimeout(500)
const initialTrackStatus = await page.locator('#track-status').textContent()
if (!initialTrackStatus?.includes('0 tracks loaded')) throw new Error(`Unexpected initial status: ${initialTrackStatus}; ${consoleErrors.join('; ')}`)
await page.locator('#locus-input').fill(testGene)
await page.locator('#locus-form').press('Enter')
await page.waitForFunction(() => document.querySelector('#locus-input')?.value?.includes(':'))
await page.locator('#locus-input').focus()
await page.keyboard.press('Control+A')
const searchSelectAll = await page.locator('#locus-input').evaluate((element) => ({
  start: element.selectionStart,
  end: element.selectionEnd,
  length: element.value.length,
}))

if (dataPaths.length > 0) {
  await page.locator('#file-input').setInputFiles(dataPaths)
  await page.waitForFunction(() => /^\d+ tracks? loaded$/.test(document.querySelector('#track-status')?.textContent ?? ''), undefined, { timeout: 30_000 })
  const expectedSources = dataPaths.filter((path) => !/\.(bai|csi)$/i.test(path)).length
  await page.waitForFunction((count) => {
    try { return JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').sources?.length === count } catch { return false }
  }, expectedSources, { timeout: 5_000 })
}
const trackDocument = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}'))
const visualDataTrackCount = (trackDocument.tracks ?? []).filter((track) => track.kind !== 'genes').length
const hasStrandedTrack = (trackDocument.tracks ?? []).some((track) => track.kind === 'stranded')
const firstTrackSpec = (trackDocument.tracks ?? []).find((track) => track.kind !== 'genes')
const firstTrackHeight = firstTrackSpec
  ? Math.round((16 + Math.max(1, Math.min(100, firstTrackSpec.height)) * 3.6) * (firstTrackSpec.kind === 'stranded' ? 2 : 1))
  : 132

const canvas = page.locator('#genome-canvas')
const box = await canvas.boundingBox()
if (!box) throw new Error('Genome canvas was not visible.')
await page.mouse.move(box.x + box.width * 0.72, box.y + 95)
await page.mouse.down()
await page.mouse.move(box.x + box.width * 0.48, box.y + 95, { steps: 12 })
await page.mouse.up()
await page.mouse.move(box.x + box.width * 0.55, box.y + 95)
const zoomBeforeWheel = await page.locator('#zoom-level').inputValue()
await page.keyboard.down('Control')
await page.mouse.wheel(0, -300)
await page.keyboard.up('Control')
await page.waitForTimeout(500)
const zoomAfterWheel = await page.locator('#zoom-level').inputValue()
const zoomTitle = await page.locator('#zoom-level').getAttribute('title')
const spanBeforeSlider = await page.evaluate(() => {
  const region = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').region
  return region?.end - region?.start
})
await page.locator('#zoom-level').fill('72')
await page.locator('#zoom-level').dispatchEvent('input')
await page.waitForTimeout(300)
const spanAfterSlider = await page.evaluate(() => {
  const region = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').region
  return region?.end - region?.start
})
await page.locator('#chromosome-button').click()
const chromosomeMenuVisible = await page.locator('#chromosome-popup').isVisible()
const chromosomeMenuOpenClass = await page.locator('#chromosome-picker').evaluate((element) => element.classList.contains('is-open'))
const selectedChromosomeText = await page.locator('#chromosome-popup [aria-selected="true"]').textContent()
await page.keyboard.press('Escape')
await page.locator('#file-menu-button').click()
const fileMenuVisible = await page.locator('#file-menu-popup').isVisible()
const fileMenuText = await page.locator('#file-menu-popup').textContent()
const fileMenuActiveElement = await page.locator(':focus').getAttribute('id')
await page.keyboard.press('Escape')
await page.locator('#help-menu-button').click()
const helpMenuVisible = await page.locator('#help-menu-popup').isVisible()
const helpMenuText = await page.locator('#help-menu-popup').textContent()
const helpMenuActiveElement = await page.locator(':focus').getAttribute('id')
await page.locator('#about-menu-item').click()
const aboutDialogVisible = await page.locator('#update-dialog').isVisible()
const aboutVersionText = await page.locator('#update-installed-version').textContent()
const browserUpdateDisabled = await page.locator('#update-primary-action').isDisabled()
await page.screenshot({ path: 'dist/smoke-about.png', fullPage: true })
await page.locator('#update-dialog-close').click()
if (hasStrandedTrack) await canvas.screenshot({ path: 'dist/smoke-stranded.png' })
const contextX = box.x + 60
const firstTrackY = box.y + 55
if (dataPaths.length) await page.mouse.click(contextX, firstTrackY, { button: 'right' })
else {
  const bottomBox = await page.locator('#bottom-canvas').boundingBox()
  if (!bottomBox) throw new Error('Bottom track canvas was not visible.')
  await page.mouse.click(bottomBox.x + 60, bottomBox.y + Math.min(30, bottomBox.height / 2), { button: 'right' })
}
const trackContextVisible = await page.locator('#track-context-menu').isVisible()
const initialTrackContextText = await page.locator('#track-context-menu').textContent()
const currentIndicatorCount = await page.locator('#track-context-menu .context-item.is-current').count()
const arcFlipOptionCount = await page.locator('#track-context-menu [data-context-action="interaction-flip"]').count()
const trackContextFocusedAction = await page.evaluate(() => document.activeElement?.getAttribute('data-context-action'))
let strandedRoundTrip = false
if (hasStrandedTrack) {
  await page.locator('[data-context-action="strand-unlink"]').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks?.filter((track) => track.kind === 'signal').length === 2)
  await page.mouse.click(contextX, firstTrackY + 132, { button: 'right' })
  const unlinkedMenuText = await page.locator('#track-context-menu').textContent()
  if (unlinkedMenuText?.includes('Link as stranded track')) {
    await page.locator('[data-context-action="strand-link"]').click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks?.some((track) => track.kind === 'stranded'))
    strandedRoundTrip = true
  }
} else await page.keyboard.press('Escape')
const bottomGeneBox = await page.locator('#bottom-canvas').boundingBox()
if (!bottomGeneBox) throw new Error('Bottom gene canvas was not visible.')
const initialBottomPaneHeight = await page.locator('#bottom-pane').evaluate((element) => element.getBoundingClientRect().height)
const initialBottomCanvasHeight = bottomGeneBox.height
await page.mouse.click(bottomGeneBox.x + 60, bottomGeneBox.y + Math.min(30, bottomGeneBox.height / 2), { button: 'right' })
const geneMenuText = await page.locator('#track-context-menu').textContent()
await page.locator(`[data-context-action="genes-${testGeneMode}"]`).click()
await page.waitForTimeout(100)
const expandedBottomPaneHeight = await page.locator('#bottom-pane').evaluate((element) => element.getBoundingClientRect().height)
const expandedBottomCanvasHeight = await page.locator('#bottom-canvas').evaluate((element) => element.getBoundingClientRect().height)
await page.locator('#settings-menu-button').click()
const settingsMenuText = await page.locator('#settings-menu-popup').textContent()
const settingsMenuActiveElement = await page.locator(':focus').getAttribute('id')
await page.locator('#track-options-menu-item').click()
const tssBeforeToggle = await page.locator('#tss-indicators-toggle').isChecked()
await page.locator('#tss-indicators-toggle').click()
const tssAfterToggle = await page.locator('#tss-indicators-toggle').isChecked()
await page.keyboard.press('Escape')
let linkedScaleText
let groupMenuText
let selectAllText
let groupMenuAfterPaneMove
let colorDialogVisible
let dragGhostVisible
let dragCursor
let fitScrollRange
let fitPaneGap
let fittedTrackHeights
let groupContextFocusedAction
let groupClickSelectionText
let groupHighlightChanged
let clickAwaySelectionText
if (visualDataTrackCount > 1) {
  await page.keyboard.press('Escape')
  await page.mouse.click(contextX, firstTrackY)
  await page.keyboard.down('Control')
  await page.mouse.click(contextX, firstTrackY + firstTrackHeight)
  await page.keyboard.up('Control')
  await page.mouse.click(contextX, firstTrackY + firstTrackHeight, { button: 'right' })
  linkedScaleText = await page.locator('#track-context-menu').textContent()
  await page.locator('[data-context-action="color"]').click()
  colorDialogVisible = await page.locator('#color-dialog').isVisible()
  await page.screenshot({ path: 'dist/smoke-color.png', fullPage: true })
  await page.locator('#color-cancel').click()
  await page.mouse.click(contextX, firstTrackY + firstTrackHeight, { button: 'right' })
  await page.locator('[data-context-action="link-scales"]').click()
  await page.mouse.click(contextX, firstTrackY, { button: 'right' })
  page.once('dialog', (dialog) => dialog.accept('Experiment A'))
  await page.locator('[data-context-action="group"]').click()
  await page.mouse.click(box.x + Math.max(240, box.width * 0.4), box.y + 60)
  const groupUnselected = await canvas.evaluate((element) => element.toDataURL())
  await page.mouse.click(box.x + 8, box.y + 60)
  const groupSelected = await canvas.evaluate((element) => element.toDataURL())
  groupHighlightChanged = groupUnselected !== groupSelected
  await page.screenshot({ path: 'dist/smoke-group-selected.png', fullPage: true })
  await page.mouse.click(contextX, firstTrackY, { button: 'right' })
  groupClickSelectionText = await page.locator('#track-context-menu').textContent()
  await page.keyboard.press('Escape')
  await page.mouse.click(box.x + 8, box.y + 60, { button: 'right' })
  groupMenuText = await page.locator('#track-context-menu').textContent()
  groupContextFocusedAction = await page.evaluate(() => document.activeElement?.getAttribute('data-context-action'))
  await page.locator('[data-context-action="group-auto-linked"]').click()
  const bottomBox = await page.locator('#bottom-canvas').boundingBox()
  if (!bottomBox) throw new Error('Bottom track canvas was not visible.')
  await page.mouse.move(box.x + 8, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(bottomBox.x + 8, bottomBox.y + 30, { steps: 8 })
  dragGhostVisible = await page.locator('.track-drag-ghost').isVisible()
  dragCursor = await page.locator('body').evaluate((element) => getComputedStyle(element).cursor)
  await page.mouse.up()
  await page.waitForTimeout(100)
  await page.mouse.click(bottomBox.x + 8, bottomBox.y + 30, { button: 'right' })
  groupMenuAfterPaneMove = await page.locator('#track-context-menu').textContent()
  await page.keyboard.press('Escape')
  await page.mouse.move(bottomBox.x + 8, bottomBox.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 8, box.y + 30, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.press('Control+A')
  await page.mouse.click(contextX, box.y + 55, { button: 'right' })
  selectAllText = await page.locator('#track-context-menu').textContent()
  await page.keyboard.press('Escape')
  await page.locator('#fit-tracks').click()
  await page.waitForTimeout(300)
  fitScrollRange = await page.locator('#main-track-scroll').evaluate((element) => element.scrollHeight - element.clientHeight)
  fitPaneGap = await page.evaluate(() => {
    const canvasBottom = document.querySelector('#genome-canvas')?.getBoundingClientRect().bottom ?? 0
    const paneTop = document.querySelector('#bottom-pane')?.getBoundingClientRect().top ?? 0
    return paneTop - canvasBottom
  })
  fittedTrackHeights = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks
    ?.filter((track) => track.pane === 'main' && track.kind !== 'interval').map((track) => track.fittedHeight))
  await page.mouse.click(contextX, box.y + 55, { button: 'right' })
  clickAwaySelectionText = await page.locator('#track-context-menu').textContent()
  await page.keyboard.press('Escape')
}
const autoFitBeforeToggle = await page.locator('#fit-tracks-auto').getAttribute('aria-pressed')
await page.locator('#fit-tracks-auto').click()
const autoFitAfterToggle = await page.locator('#fit-tracks-auto').getAttribute('aria-pressed')

const resizerBox = await page.locator('#pane-resizer').boundingBox()
if (!resizerBox) throw new Error('Bottom pane resizer was not visible.')
await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2)
await page.mouse.down()
await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y - 35, { steps: 5 })
await page.mouse.up()

const headerTopBeforeScroll = await page.locator('#genome-header').evaluate((element) => element.getBoundingClientRect().top)
await page.locator('#main-track-scroll').evaluate((element) => { element.scrollTop = 120 })
await page.waitForTimeout(50)
const headerTopAfterScroll = await page.locator('#genome-header').evaluate((element) => element.getBoundingClientRect().top)

const result = await page.evaluate(() => ({
  title: document.title,
  locus: document.querySelector('#locus-input')?.value,
  trackStatus: document.querySelector('#track-status')?.textContent,
  fps: document.querySelector('#fps-value')?.textContent,
  renderMs: document.querySelector('#render-value')?.textContent,
  visibleFeatures: document.querySelector('#feature-value')?.textContent,
  reference: document.querySelector('#reference-label')?.textContent,
  bottomPaneHeight: document.querySelector('#bottom-pane')?.getBoundingClientRect().height,
  toolbarHeight: document.querySelector('.toolbar')?.getBoundingClientRect().height,
  rulerHeight: document.querySelector('#genome-header')?.getBoundingClientRect().height,
}))
const geneDetailProbe = await page.evaluate(async () => {
  try {
    const response = await fetch(new URL('reference/refseq/hg38-chr21.tsv.gz', document.baseURI))
    if (!response.ok) return `HTTP ${response.status}`
    const bytes = new Uint8Array(await response.arrayBuffer())
    return `${bytes.length} bytes · gzip=${bytes[0] === 31 && bytes[1] === 139}`
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
})
await page.screenshot({ path: 'dist/smoke.png', fullPage: true })
const themeBefore = await page.locator('html').getAttribute('data-theme')
await page.locator('#theme-toggle').click()
const themeAfterToggle = await page.locator('html').getAttribute('data-theme')
await page.locator('#reference-button').click()
await page.screenshot({ path: 'dist/smoke-dark-reference.png', fullPage: true })
await page.keyboard.press('Escape')
await page.reload({ waitUntil: 'networkidle' })
const themeAfterReload = await page.locator('html').getAttribute('data-theme')
await page.locator('#settings-menu-button').click()
await page.locator('#track-options-menu-item').click()
const tssAfterReload = await page.locator('#tss-indicators-toggle').isChecked()
const autoFitAfterReload = await page.locator('#fit-tracks-auto').getAttribute('aria-pressed')
await page.keyboard.press('Escape')
const offlineTrackStatus = await page.locator('#track-status').textContent()
const offlineLeftPixel = await page.locator('#genome-canvas').evaluate((element) => [...element.getContext('2d').getImageData(0, 10, 1, 1).data])
await page.locator('#reference-file-input').setInputFiles({
  name: 'tiny.fai',
  mimeType: 'text/plain',
  buffer: Buffer.from('contigA\t120000\t0\t50\t51\ncontigB\t80000\t0\t50\t51\n'),
})
await page.waitForFunction(() => document.querySelector('#reference-label')?.textContent === 'tiny')
const customReferenceBeforeReload = await page.locator('#reference-label').textContent()
await page.reload({ waitUntil: 'networkidle' })
const customReferenceAfterReload = await page.locator('#reference-label').textContent()

await page.evaluate(() => {
  const existing = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  localStorage.setItem('gerafe-track-document', JSON.stringify({
  schemaVersion: 15,
  referenceId: existing.referenceId,
  region: { chr: existing.region?.chr ?? 'contigA', start: 10_000, end: 30_000 },
  sources: [
    { id: 'matrix-source-a', name: 'first.cool', format: 'cool', files: [{ name: 'first.cool', size: 1, lastModified: 1, role: 'signal' }] },
    { id: 'matrix-source-b', name: 'second.cool', format: 'cool', files: [{ name: 'second.cool', size: 1, lastModified: 1, role: 'signal' }] },
  ],
  tracks: [
    { id: 'matrix-a', kind: 'matrix', sourceIds: ['matrix-source-a'], label: 'First matrix', color: '#6d55e0', enabled: true, height: 50, pane: 'main', displayGroupId: 'matrix-group', matrixDirection: 'up', matrixNormalization: 'raw', matrixTransform: 'log1p', matrixPalette: 'warm' },
    { id: 'matrix-b', kind: 'matrix', sourceIds: ['matrix-source-b'], label: 'Second matrix', color: '#6d55e0', enabled: true, height: 50, pane: 'main', displayGroupId: 'matrix-group', matrixDirection: 'up', matrixNormalization: 'raw', matrixTransform: 'log1p', matrixPalette: 'warm' },
  ],
  groups: [{ id: 'matrix-group', label: 'Matrix group', scaleBehavior: 'linked' }],
  scales: [],
  }))
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(250)
const matrixCanvasBox = await page.locator('#genome-canvas').boundingBox()
if (!matrixCanvasBox) throw new Error('Matrix smoke canvas was not visible.')
await page.mouse.click(500, (await page.viewportSize()).height - 8)
const matrixResizeBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks)
const firstMatrixPixels = matrixResizeBefore[0]?.fittedHeight ?? matrixResizeBefore[0]?.manualPixelHeight ?? 16 + matrixResizeBefore[0]?.height * 3.6
await page.mouse.move(matrixCanvasBox.x + 300, matrixCanvasBox.y + firstMatrixPixels)
await page.mouse.down()
await page.mouse.move(matrixCanvasBox.x + 300, matrixCanvasBox.y + firstMatrixPixels + 18, { steps: 4 })
await page.mouse.up()
await page.waitForTimeout(250)
const matrixResizeAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks)
const unselectedBottomBoundaryResize = matrixResizeAfter[0]?.manualPixelHeight > firstMatrixPixels
  && matrixResizeAfter[1]?.manualPixelHeight === matrixResizeBefore[1]?.manualPixelHeight
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
const matrixGroupMenuText = await page.locator('#track-context-menu').textContent()
await page.locator('[data-context-action="matrix-settings"]').click()
const matrixSettingsVisible = await page.locator('#matrix-settings-dialog').isVisible()
await page.screenshot({ path: 'dist/smoke-matrix-settings.png', fullPage: true })
await page.locator('#matrix-palette').selectOption('custom')
await page.locator('#matrix-add-color').click()
await page.locator('#matrix-high-color-start').fill('95')
await page.locator('#matrix-palette-reversed').check()
await page.locator('#matrix-group-scaling').selectOption('independent')
await page.locator('.matrix-settings-content').evaluate((element) => { element.scrollTop = element.scrollHeight })
await page.locator('#matrix-settings-form button[type="submit"]').click()
await page.waitForTimeout(250)
const matrixGroupSettingsApplied = await page.evaluate(() => {
  const document = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  return document.tracks?.every((track) => track.kind !== 'matrix' || (track.matrixPalette === 'custom' && track.matrixPaletteReversed === true && track.matrixHighColorStart === 0.95 && track.matrixPaletteColors?.length === 6))
    && document.groups?.find((group) => group.id === 'matrix-group')?.scaleBehavior === 'independent'
})
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.locator('[data-context-action="matrix-settings"]').click()
const matrixSettingsReopenedAtTop = await page.locator('.matrix-settings-content').evaluate((element) => element.scrollTop === 0)
  && await page.locator('#matrix-scale-mode').isVisible()
await page.screenshot({ path: 'dist/smoke-matrix-settings-reopened.png', fullPage: true })
await page.locator('#matrix-settings-cancel').click()
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.locator('[data-context-action="group-select"]').click()
await page.mouse.click(matrixCanvasBox.x + 60, matrixCanvasBox.y + 60, { button: 'right' })
const selectedMatrixMenuText = await page.locator('#track-context-menu').textContent()
await browser.close()

console.log(JSON.stringify({ ...result, zoomBeforeWheel, zoomAfterWheel, zoomTitle, spanBeforeSlider, spanAfterSlider, chromosomeMenuVisible, chromosomeMenuOpenClass, selectedChromosomeText, autoFitBeforeToggle, autoFitAfterToggle, autoFitAfterReload, visualDataTrackCount, hasStrandedTrack, strandedRoundTrip, initialTrackContextText, currentIndicatorCount, arcFlipOptionCount, geneDetailProbe, geneMenuText, initialBottomPaneHeight, initialBottomCanvasHeight, expandedBottomPaneHeight, expandedBottomCanvasHeight, searchSelectAll, settingsMenuText: settingsMenuText?.trim(), settingsMenuActiveElement, tssBeforeToggle, tssAfterToggle, tssAfterReload, colorDialogVisible, dragGhostVisible, dragCursor, fitScrollRange, fitPaneGap, fittedTrackHeights, headerTopBeforeScroll, headerTopAfterScroll, fileMenuVisible, fileMenuText: fileMenuText?.trim(), fileMenuActiveElement, helpMenuVisible, helpMenuText: helpMenuText?.trim(), helpMenuActiveElement, aboutDialogVisible, aboutVersionText, browserUpdateDisabled, trackContextVisible, trackContextFocusedAction, linkedScaleText, groupMenuText, groupContextFocusedAction, groupClickSelectionText, groupHighlightChanged, groupMenuAfterPaneMove, selectAllText, clickAwaySelectionText, offlineTrackStatus, offlineLeftPixel, themeBefore, themeAfterToggle, themeAfterReload, customReferenceBeforeReload, customReferenceAfterReload, matrixGroupMenuText, matrixSettingsVisible, matrixGroupSettingsApplied, matrixSettingsReopenedAtTop, unselectedBottomBoundaryResize, selectedMatrixMenuText, consoleErrors, screenshot: 'dist/smoke.png' }, null, 2))
if (themeBefore === themeAfterToggle || themeAfterToggle !== themeAfterReload) process.exitCode = 1
if (!fileMenuVisible || !fileMenuText?.includes('Open tracks')) process.exitCode = 1
if (fileMenuActiveElement !== 'file-menu-button' || settingsMenuActiveElement !== 'settings-menu-button' || helpMenuActiveElement !== 'help-menu-button') process.exitCode = 1
if (!helpMenuVisible || !helpMenuText?.includes('Check for updates') || !aboutDialogVisible || !aboutVersionText?.startsWith('Version ') || !browserUpdateDisabled) process.exitCode = 1
if (!trackContextVisible) process.exitCode = 1
if (trackContextFocusedAction || groupContextFocusedAction) process.exitCode = 1
if (initialTrackContextText?.toLocaleLowerCase().includes('current') || initialTrackContextText?.includes('Set visual group')) process.exitCode = 1
if ((!firstTrackSpec || ['interval', 'interaction', 'alignment'].includes(firstTrackSpec.kind)) && currentIndicatorCount < 1) process.exitCode = 1
if (firstTrackSpec?.kind === 'interaction' && (arcFlipOptionCount !== 1 || initialTrackContextText.includes('Arc base at'))) process.exitCode = 1
if (searchSelectAll.start !== 0 || searchSelectAll.end !== searchSelectAll.length) process.exitCode = 1
if (Number(zoomBeforeWheel) === Number(zoomAfterWheel) || !zoomTitle?.includes('100% shows the full chromosome')) process.exitCode = 1
if (!(Number(spanAfterSlider) < Number(spanBeforeSlider)) || !chromosomeMenuVisible || !chromosomeMenuOpenClass || !selectedChromosomeText) process.exitCode = 1
if (!geneMenuText?.includes('Expanded transcript view')) process.exitCode = 1
if (!settingsMenuText?.includes('Track options')) process.exitCode = 1
if (tssBeforeToggle === tssAfterToggle || tssAfterToggle !== tssAfterReload) process.exitCode = 1
if (autoFitBeforeToggle === autoFitAfterToggle || autoFitAfterToggle !== autoFitAfterReload) process.exitCode = 1
if (Math.abs(initialBottomPaneHeight - initialBottomCanvasHeight - 1) > 2 || Math.abs(expandedBottomPaneHeight - expandedBottomCanvasHeight - 1) > 2) process.exitCode = 1
if (testGene === 'RUNX1' && testGeneMode === 'expanded' && expandedBottomPaneHeight <= initialBottomPaneHeight) process.exitCode = 1
if (visualDataTrackCount > 1 && (!dragGhostVisible || dragCursor !== 'grabbing')) process.exitCode = 1
if (visualDataTrackCount > 1 && Number(fitScrollRange) > 2) process.exitCode = 1
if (visualDataTrackCount > 1 && (Math.abs(Number(fitPaneGap)) > 2 || fittedTrackHeights?.some((height) => !Number.isFinite(height)))) process.exitCode = 1
if (Math.abs(headerTopBeforeScroll - headerTopAfterScroll) > 1) process.exitCode = 1
if (Number(result.toolbarHeight) > 46.5 || Number(result.rulerHeight) > 70.5) process.exitCode = 1
if (Number(result.bottomPaneHeight) < initialBottomPaneHeight + 30) process.exitCode = 1
if (visualDataTrackCount > 1 && !linkedScaleText?.includes('2 tracks selected')) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupMenuText?.includes('Autoscale group together') || !groupMenuText?.includes('Remove all group tracks'))) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupMenuText?.includes('Set group track color') || groupMenuText?.includes('Set unstranded track color'))) process.exitCode = 1
if (visualDataTrackCount > 1 && !groupMenuAfterPaneMove?.includes('Experiment A')) process.exitCode = 1
if (visualDataTrackCount > 1 && !selectAllText?.includes(`${visualDataTrackCount + 1} tracks selected`)) process.exitCode = 1
if (visualDataTrackCount > 1 && (!colorDialogVisible || !dragGhostVisible)) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupHighlightChanged || !groupClickSelectionText?.includes('2 tracks selected') || clickAwaySelectionText?.includes('tracks selected'))) process.exitCode = 1
if (hasStrandedTrack && (!initialTrackContextText?.includes('Linked stranded signal') || !initialTrackContextText.includes('Set positive-strand color') || !initialTrackContextText.includes('Set negative-strand color') || !initialTrackContextText.includes('Unlink stranded sources'))) process.exitCode = 1
if (hasStrandedTrack && !strandedRoundTrip) process.exitCode = 1
if (dataPaths.length && (!offlineTrackStatus?.includes('reopening or attention') || offlineLeftPixel.slice(0, 3).join(',') === '150,144,135')) process.exitCode = 1
if (customReferenceBeforeReload !== customReferenceAfterReload) process.exitCode = 1
if (!matrixGroupMenuText?.includes('Matrix settings') || !matrixGroupMenuText?.includes('Set group track color') || !matrixGroupMenuText?.includes('Set group track height')) process.exitCode = 1
if (!matrixSettingsVisible || !matrixGroupSettingsApplied || !matrixSettingsReopenedAtTop || !unselectedBottomBoundaryResize || !selectedMatrixMenuText?.includes('2 tracks selected') || !selectedMatrixMenuText?.includes('Matrix settings')) process.exitCode = 1
if (consoleErrors.length > 0) process.exitCode = 1
