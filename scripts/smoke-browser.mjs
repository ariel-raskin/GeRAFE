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
const zoomBeforeWheel = await page.locator('#zoom-level').textContent()
await page.keyboard.down('Control')
await page.mouse.wheel(0, -300)
await page.keyboard.up('Control')
await page.waitForTimeout(500)
const zoomAfterWheel = await page.locator('#zoom-level').textContent()
const zoomTitle = await page.locator('#zoom-level').getAttribute('title')
await page.locator('#file-menu-button').click()
const fileMenuVisible = await page.locator('#file-menu-popup').isVisible()
const fileMenuText = await page.locator('#file-menu-popup').textContent()
const fileMenuActiveElement = await page.locator(':focus').getAttribute('id')
await page.keyboard.press('Escape')
if (hasStrandedTrack) await canvas.screenshot({ path: 'dist/smoke-stranded.png' })
const contextX = box.x + 60
const firstTrackY = box.y + 55
if (dataPaths.length) await page.mouse.click(contextX, firstTrackY, { button: 'right' })
else {
  const bottomBox = await page.locator('#bottom-canvas').boundingBox()
  if (!bottomBox) throw new Error('Bottom track canvas was not visible.')
  await page.mouse.click(bottomBox.x + 60, bottomBox.y + 55, { button: 'right' })
}
const trackContextVisible = await page.locator('#track-context-menu').isVisible()
const initialTrackContextText = await page.locator('#track-context-menu').textContent()
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
await page.mouse.click(bottomGeneBox.x + 60, bottomGeneBox.y + 55, { button: 'right' })
const geneMenuText = await page.locator('#track-context-menu').textContent()
await page.locator(`[data-context-action="genes-${testGeneMode}"]`).click()
await page.waitForTimeout(100)
const geneBeforeScroll = await page.locator('#bottom-canvas').evaluate((element) => element.toDataURL())
await page.mouse.move(bottomGeneBox.x + Math.min(500, bottomGeneBox.width - 20), bottomGeneBox.y + Math.min(65, bottomGeneBox.height - 10))
await page.mouse.wheel(0, 90)
await page.waitForTimeout(100)
const geneAfterScroll = await page.locator('#bottom-canvas').evaluate((element) => element.toDataURL())
const geneInternalScrollChanged = geneBeforeScroll !== geneAfterScroll
await page.locator('#settings-menu-button').click()
const settingsMenuText = await page.locator('#settings-menu-popup').textContent()
const settingsMenuActiveElement = await page.locator(':focus').getAttribute('id')
const tssBeforeToggle = await page.locator('#tss-indicators-menu-item').getAttribute('aria-checked')
await page.locator('#tss-indicators-menu-item').click()
const tssAfterToggle = await page.locator('#tss-indicators-menu-item').getAttribute('aria-checked')
await page.keyboard.press('Escape')
let linkedScaleText
let groupMenuText
let selectAllText
let groupMenuAfterPaneMove
let colorDialogVisible
let dragGhostVisible
let dragCursor
let fitScrollRange
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
  await page.waitForTimeout(100)
  fitScrollRange = await page.locator('#main-track-scroll').evaluate((element) => element.scrollHeight - element.clientHeight)
  await page.mouse.click(contextX, box.y + 55, { button: 'right' })
  clickAwaySelectionText = await page.locator('#track-context-menu').textContent()
  await page.keyboard.press('Escape')
}

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
const tssAfterReload = await page.locator('#tss-indicators-menu-item').getAttribute('aria-checked')
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
await browser.close()

console.log(JSON.stringify({ ...result, zoomBeforeWheel, zoomAfterWheel, zoomTitle, visualDataTrackCount, hasStrandedTrack, strandedRoundTrip, initialTrackContextText, geneDetailProbe, geneMenuText, geneInternalScrollChanged, initialBottomPaneHeight, initialBottomCanvasHeight, searchSelectAll, settingsMenuText: settingsMenuText?.trim(), settingsMenuActiveElement, tssBeforeToggle, tssAfterToggle, tssAfterReload, colorDialogVisible, dragGhostVisible, dragCursor, fitScrollRange, headerTopBeforeScroll, headerTopAfterScroll, fileMenuVisible, fileMenuText: fileMenuText?.trim(), fileMenuActiveElement, trackContextVisible, trackContextFocusedAction, linkedScaleText, groupMenuText, groupContextFocusedAction, groupClickSelectionText, groupHighlightChanged, groupMenuAfterPaneMove, selectAllText, clickAwaySelectionText, offlineTrackStatus, offlineLeftPixel, themeBefore, themeAfterToggle, themeAfterReload, customReferenceBeforeReload, customReferenceAfterReload, consoleErrors, screenshot: 'dist/smoke.png' }, null, 2))
if (themeBefore === themeAfterToggle || themeAfterToggle !== themeAfterReload) process.exitCode = 1
if (!fileMenuVisible || !fileMenuText?.includes('Open tracks')) process.exitCode = 1
if (fileMenuActiveElement !== 'file-menu-button' || settingsMenuActiveElement !== 'settings-menu-button') process.exitCode = 1
if (!trackContextVisible) process.exitCode = 1
if (trackContextFocusedAction || groupContextFocusedAction) process.exitCode = 1
if (searchSelectAll.start !== 0 || searchSelectAll.end !== searchSelectAll.length) process.exitCode = 1
if (!zoomBeforeWheel?.includes('%') || !zoomAfterWheel?.includes('%') || zoomBeforeWheel === zoomAfterWheel || !zoomTitle?.includes('100% shows the full chromosome')) process.exitCode = 1
if (!geneMenuText?.includes('Expanded transcript view')) process.exitCode = 1
if (!settingsMenuText?.includes('Show TSS elbow arrows')) process.exitCode = 1
if (tssBeforeToggle === tssAfterToggle || tssAfterToggle !== tssAfterReload) process.exitCode = 1
if (Math.abs(initialBottomPaneHeight - initialBottomCanvasHeight - 8) > 2) process.exitCode = 1
if (testGene === 'RUNX1' && testGeneMode === 'expanded' && !geneInternalScrollChanged) process.exitCode = 1
if (visualDataTrackCount > 1 && (!dragGhostVisible || dragCursor !== 'grabbing')) process.exitCode = 1
if (visualDataTrackCount > 1 && Number(fitScrollRange) > 2) process.exitCode = 1
if (Math.abs(headerTopBeforeScroll - headerTopAfterScroll) > 1) process.exitCode = 1
if (Number(result.bottomPaneHeight) < initialBottomPaneHeight + 30) process.exitCode = 1
if (visualDataTrackCount > 1 && !linkedScaleText?.includes('2 tracks selected')) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupMenuText?.includes('Autoscale group together') || !groupMenuText?.includes('Remove all group tracks'))) process.exitCode = 1
if (visualDataTrackCount > 1 && !groupMenuAfterPaneMove?.includes('Experiment A')) process.exitCode = 1
if (visualDataTrackCount > 1 && !selectAllText?.includes(`${visualDataTrackCount + 1} tracks selected`)) process.exitCode = 1
if (visualDataTrackCount > 1 && (!colorDialogVisible || !dragGhostVisible)) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupHighlightChanged || !groupClickSelectionText?.includes('2 tracks selected') || clickAwaySelectionText?.includes('tracks selected'))) process.exitCode = 1
if (hasStrandedTrack && (!initialTrackContextText?.includes('Linked stranded signal') || !initialTrackContextText.includes('Set positive-strand color') || !initialTrackContextText.includes('Set negative-strand color') || !initialTrackContextText.includes('Unlink stranded sources'))) process.exitCode = 1
if (hasStrandedTrack && !strandedRoundTrip) process.exitCode = 1
if (dataPaths.length && (!offlineTrackStatus?.includes('reopening or attention') || offlineLeftPixel.slice(0, 3).join(',') === '150,144,135')) process.exitCode = 1
if (customReferenceBeforeReload !== customReferenceAfterReload) process.exitCode = 1
if (consoleErrors.length > 0) process.exitCode = 1
