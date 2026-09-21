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
const matrixInspectorSizing = await page.evaluate(() => {
  const inspector = document.createElement('div')
  inspector.className = 'matrix-inspector'
  inspector.textContent = '7.5'
  document.body.append(inspector)
  const compact = inspector.getBoundingClientRect()
  const value = document.createElement('strong')
  value.textContent = '7.5'
  const bins = document.createElement('span')
  bins.textContent = 'chr21:35,000,000-35,005,000 × chr21:35,010,000-35,015,000'
  const details = document.createElement('small')
  details.textContent = '10 kb separation · 5 kb bins · raw · log'
  inspector.replaceChildren(value, bins, details)
  const expanded = inspector.getBoundingClientRect()
  inspector.remove()
  return { compactWidth: compact.width, compactHeight: compact.height, expandedWidth: expanded.width, expandedHeight: expanded.height }
})
const initialTrackStatus = await page.locator('#track-status').textContent()
const emptyWorkspaceVisible = await page.locator('#empty-workspace').isVisible()
const emptyWorkspaceText = await page.locator('#empty-workspace').textContent()
const emptyWorkspaceBrand = await page.locator('.empty-workspace-brand').evaluate((element) => {
  const workspace = element.parentElement.getBoundingClientRect()
  const heading = element.parentElement.querySelector(':scope > strong')
  const formats = element.parentElement.querySelector(':scope > span')
  const image = element.querySelector('img').getBoundingClientRect()
  const wordmark = element.querySelector('strong').getBoundingClientRect()
  return {
    centerOffset: workspace.left + workspace.width / 2 - window.innerWidth / 2,
    headingOffset: heading.getBoundingClientRect().top - workspace.top,
    headingFontSize: parseFloat(getComputedStyle(heading).fontSize),
    imageGap: image.top - formats.getBoundingClientRect().bottom,
    imageHeight: image.height,
    wordmarkHeight: wordmark.height,
  }
})
const cornerBrandCount = await page.locator('.corner-brand').count()
const footerHeight = await page.locator('.browser-footer').evaluate((element) => element.getBoundingClientRect().height)
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
const emptyWorkspaceHiddenAfterLoad = dataPaths.length > 0 ? await page.locator('#empty-workspace').isHidden() : undefined
const trackDocument = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}'))
const visualDataTracks = (trackDocument.tracks ?? []).filter((track) => track.kind !== 'genes')
const visualDataTrackCount = visualDataTracks.length
const hasStrandedTrack = (trackDocument.tracks ?? []).some((track) => track.kind === 'stranded')
const firstTrackSpec = (trackDocument.tracks ?? []).find((track) => track.kind !== 'genes')
const firstTwoAreSignals = visualDataTracks.slice(0, 2).length === 2 && visualDataTracks.slice(0, 2).every((track) => track.kind === 'signal' || track.kind === 'stranded')
const firstTrackHeight = firstTrackSpec
  ? Math.round((16 + Math.max(1, Math.min(100, firstTrackSpec.height)) * 3.6) * (firstTrackSpec.kind === 'stranded' ? 2 : 1))
  : 132
const secondTrackSpec = visualDataTracks[1]
const secondTrackHeight = secondTrackSpec
  ? Math.round((16 + Math.max(1, Math.min(100, secondTrackSpec.height)) * 3.6) * (secondTrackSpec.kind === 'stranded' ? 2 : 1))
  : firstTrackHeight

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
await page.locator('#interaction-guide-menu-item').click()
const interactionGuideVisible = await page.locator('#action-dialog').isVisible()
const interactionGuideText = await page.locator('#action-dialog-message').textContent()
await page.locator('#action-dialog-submit').click()
await page.locator('#help-menu-button').click()
await page.locator('#about-menu-item').click()
const aboutDialogVisible = await page.locator('#update-dialog').isVisible()
const aboutVersionText = await page.locator('#update-installed-version').textContent()
const browserUpdateDisabled = await page.locator('#update-primary-action').isDisabled()
await page.screenshot({ path: 'dist/smoke-about.png', fullPage: true })
await page.locator('#update-dialog-close').click()
if (hasStrandedTrack) await canvas.screenshot({ path: 'dist/smoke-stranded.png' })
const contextX = box.x + 60
const firstTrackY = box.y + firstTrackHeight / 2
const secondTrackY = box.y + firstTrackHeight + secondTrackHeight / 2
if (dataPaths.length) await page.mouse.click(contextX, firstTrackY, { button: 'right' })
else {
  const bottomBox = await page.locator('#bottom-canvas').boundingBox()
  if (!bottomBox) throw new Error('Bottom track canvas was not visible.')
  await page.mouse.click(bottomBox.x + 60, bottomBox.y + Math.min(30, bottomBox.height / 2), { button: 'right' })
}
const trackContextVisible = await page.locator('#track-context-menu').isVisible()
const initialTrackContextText = await page.locator('#track-context-menu').textContent()
const initialSubmenu = firstTrackSpec?.kind === 'alignment' ? 'bam-content'
  : firstTrackSpec?.kind === 'interval' ? 'interval-display'
    : firstTrackSpec?.kind === 'interaction' ? 'interaction-filter'
    : firstTrackSpec?.kind === 'genes' ? 'genes-display'
      : firstTrackSpec?.kind === 'signal' || firstTrackSpec?.kind === 'stranded' ? 'signal-scale'
        : firstTrackSpec ? undefined : 'genes-display'
if (initialSubmenu && await page.locator(`[data-context-submenu="${initialSubmenu}"]`).count()) await page.locator(`[data-context-submenu="${initialSubmenu}"]`).hover()
const currentIndicatorCount = await page.locator('#track-context-menu .context-item.is-current, #track-context-flyout .context-item.is-current').count()
const arcFlipOptionCount = await page.locator('#track-context-menu [data-context-action="interaction-flip"]').count()
const trackContextFocusedAction = await page.evaluate(() => document.activeElement?.getAttribute('data-context-action'))
if (await page.locator('[data-context-submenu="appearance"]').count()) await page.locator('[data-context-submenu="appearance"]').hover()
const initialAppearanceText = `${await page.locator('#track-context-menu').textContent()} ${await page.locator('#track-context-flyout').textContent()}`
const singleItemFlyoutFlattened = dataPaths.length > 0 || (!await page.locator('[data-context-submenu="appearance"]').count() && initialTrackContextText?.includes('Set color'))
let strandedRoundTrip = false
if (hasStrandedTrack) {
  await page.locator('[data-context-action="strand-unlink"]').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks?.filter((track) => track.kind === 'signal').length === 2)
  await page.mouse.click(contextX, box.y + firstTrackHeight * 0.75, { button: 'right' })
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
await page.locator('[data-context-submenu="genes-display"]').hover()
const geneMenuText = `${await page.locator('#track-context-menu').textContent()} ${await page.locator('#track-context-flyout').textContent()}`
await page.locator(`[data-context-action="genes-${testGeneMode}"]`).click()
await page.waitForFunction((mode) => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks?.find((track) => track.kind === 'genes')?.geneDisplayMode === mode, testGeneMode, { timeout: 5_000 })
const geneModePersisted = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks?.find((track) => track.kind === 'genes')?.geneDisplayMode) === testGeneMode
const expandedBottomPaneHeight = await page.locator('#bottom-pane').evaluate((element) => element.getBoundingClientRect().height)
const expandedBottomCanvasHeight = await page.locator('#bottom-canvas').evaluate((element) => element.getBoundingClientRect().height)
await page.locator('#settings-menu-button').click()
const settingsMenuText = await page.locator('#settings-menu-popup').textContent()
const settingsMenuActiveElement = await page.locator(':focus').getAttribute('id')
await page.locator('#track-options-menu-item').click()
await page.screenshot({ path: 'dist/smoke-track-behavior.png', fullPage: true })
const tssBeforeToggle = await page.locator('#tss-indicators-toggle').isChecked()
const matrixDisplayDefaults = {
  inspector: await page.locator('#matrix-inspector-toggle').isChecked(),
  value: await page.locator('#matrix-inspector-value-toggle').isChecked(),
  bins: await page.locator('#matrix-inspector-bins-toggle').isChecked(),
  details: await page.locator('#matrix-inspector-details-toggle').isChecked(),
}
const matrixMetadataOptionCount = await page.locator('#matrix-metadata-toggle').count()
await page.locator('#matrix-inspector-bins-toggle').check()
await page.locator('#tss-indicators-toggle').click()
const tssAfterToggle = await page.locator('#tss-indicators-toggle').isChecked()
await page.keyboard.press('Escape')
let linkedScaleText
let groupMenuText
let groupAppearanceText
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
let groupRightClickHighlightChanged
let clickAwaySelectionText
let newWorkspaceConfirmationVisible
let flyoutClosesOnPlainAction
let redundantGroupingHidden
let crossGroupSelectionText
let heightInputUsesPixels
if (visualDataTrackCount > 1) {
  await page.keyboard.press('Escape')
  await page.mouse.click(contextX, firstTrackY)
  await page.keyboard.down('Control')
  await page.mouse.click(contextX, secondTrackY)
  await page.keyboard.up('Control')
  await page.mouse.click(contextX, secondTrackY, { button: 'right' })
  const scaleTrigger = page.locator('[data-context-submenu="signal-scale"]')
  if (await scaleTrigger.count()) await scaleTrigger.hover()
  linkedScaleText = `${await page.locator('#track-context-menu').textContent()} ${await page.locator('#track-context-flyout').textContent()}`
  await page.locator('[data-context-submenu="appearance"]').hover()
  await page.locator('[data-context-action="rename"]').hover()
  flyoutClosesOnPlainAction = await page.locator('#track-context-flyout').isHidden()
  await page.locator('[data-context-submenu="appearance"]').hover()
  await page.locator('[data-context-action="color"]').click()
  colorDialogVisible = await page.locator('#color-dialog').isVisible()
  await page.screenshot({ path: 'dist/smoke-color.png', fullPage: true })
  await page.locator('#color-cancel').click()
  await page.mouse.click(contextX, secondTrackY, { button: 'right' })
  if (await page.locator('[data-context-submenu="signal-scale"]').count()) {
    await page.locator('[data-context-submenu="signal-scale"]').hover()
    if (await page.locator('[data-context-action="scale-toggle-sharing"]').count()) await page.locator('[data-context-action="scale-toggle-sharing"]').click()
    else await page.keyboard.press('Escape')
  }
  await page.mouse.click(contextX, firstTrackY, { button: 'right' })
  await page.locator('[data-context-action="group"]').click()
  await page.locator('#action-dialog-input').fill('Experiment A')
  await page.locator('#action-dialog-submit').click()
  await page.mouse.click(box.x + Math.max(240, box.width * 0.4), box.y + 60)
  const groupUnselected = await canvas.evaluate((element) => element.toDataURL())
  await page.mouse.click(box.x + 8, box.y + 60)
  const groupSelected = await canvas.evaluate((element) => element.toDataURL())
  groupHighlightChanged = groupUnselected !== groupSelected
  await page.screenshot({ path: 'dist/smoke-group-selected.png', fullPage: true })
  await page.mouse.click(contextX, firstTrackY, { button: 'right' })
  groupClickSelectionText = await page.locator('#track-context-menu').textContent()
  redundantGroupingHidden = !groupClickSelectionText?.includes('Group selected')
  await page.keyboard.press('Escape')
  await page.mouse.click(box.x + Math.max(240, box.width * 0.4), box.y + 60)
  const groupBeforeRightClick = await canvas.evaluate((element) => element.toDataURL())
  await page.mouse.click(box.x + 8, box.y + 60, { button: 'right' })
  await page.waitForTimeout(50)
  const groupAfterRightClick = await canvas.evaluate((element) => element.toDataURL())
  groupRightClickHighlightChanged = groupBeforeRightClick !== groupAfterRightClick
  groupMenuText = await page.locator('#track-context-menu').textContent()
  await page.locator('[data-context-submenu="group-appearance"]').hover()
  groupAppearanceText = await page.locator('#track-context-flyout').textContent()
  groupContextFocusedAction = await page.evaluate(() => document.activeElement?.getAttribute('data-context-action'))
  if (await page.locator('[data-context-submenu="group-scaling"]').count()) {
    await page.locator('[data-context-submenu="group-scaling"]').hover()
    await page.locator('[data-context-action="group-auto-linked"]').click()
  } else await page.keyboard.press('Escape')
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
  await page.locator('#file-menu-button').click()
  await page.locator('#new-workspace-menu-item').click()
  newWorkspaceConfirmationVisible = await page.locator('#action-dialog').isVisible()
  await page.locator('#action-dialog-cancel').click()
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
const referenceMenuText = await page.locator('#reference-popup').textContent()
await page.screenshot({ path: 'dist/smoke-dark-reference.png', fullPage: true })
await page.keyboard.press('Escape')
await page.reload({ waitUntil: 'networkidle' })
const themeAfterReload = await page.locator('html').getAttribute('data-theme')
await page.locator('#settings-menu-button').click()
await page.locator('#track-options-menu-item').click()
const tssAfterReload = await page.locator('#tss-indicators-toggle').isChecked()
const matrixDisplayAfterReload = {
  bins: await page.locator('#matrix-inspector-bins-toggle').isChecked(),
}
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
  schemaVersion: 16,
  referenceId: existing.referenceId,
  region: { chr: existing.region?.chr ?? 'contigA', start: 10_000, end: 30_000 },
  sources: [
    { id: 'matrix-source-a', name: 'first.cool', format: 'cool', files: [{ name: 'first.cool', size: 1, lastModified: 1, role: 'signal' }] },
    { id: 'matrix-source-b', name: 'second.cool', format: 'cool', files: [{ name: 'second.cool', size: 1, lastModified: 1, role: 'signal' }] },
  ],
  tracks: [
    { id: 'matrix-a', kind: 'matrix', sourceIds: ['matrix-source-a'], label: 'First matrix', color: '#6d55e0', enabled: true, height: 50, pane: 'main', displayGroupId: 'matrix-group', matrixDirection: 'up', matrixNormalization: 'raw', matrixTransform: 'log1p', matrixPalette: 'warm' },
    { id: 'matrix-b', kind: 'matrix', sourceIds: ['matrix-source-b'], label: 'Second matrix', color: '#6d55e0', enabled: true, height: 50, pane: 'main', displayGroupId: 'matrix-group', matrixDirection: 'up', matrixNormalization: 'raw', matrixTransform: 'log1p', matrixPalette: 'warm' },
    { id: 'reference-genes', kind: 'genes', sourceIds: [], label: 'RefSeq genes', color: '#6652c9', enabled: true, height: 32, pane: 'bottom', geneDisplayMode: 'collapsed' },
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
await page.mouse.move(matrixCanvasBox.x + 300, matrixCanvasBox.y + firstMatrixPixels + 8)
await page.mouse.up()
await page.waitForTimeout(100)
const matrixResizeBeforeDelay = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks)
const resizeRequiresHoverDelay = matrixResizeBeforeDelay[0]?.manualPixelHeight === matrixResizeBefore[0]?.manualPixelHeight
await page.mouse.move(matrixCanvasBox.x + 300, matrixCanvasBox.y + firstMatrixPixels + 30)
await page.mouse.move(matrixCanvasBox.x + 300, matrixCanvasBox.y + firstMatrixPixels)
await page.waitForTimeout(300)
await page.mouse.down()
await page.mouse.move(matrixCanvasBox.x + 300, matrixCanvasBox.y + firstMatrixPixels + 18, { steps: 4 })
await page.mouse.up()
await page.waitForTimeout(250)
const matrixResizeAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks)
const unselectedBottomBoundaryResize = matrixResizeAfter[0]?.manualPixelHeight > firstMatrixPixels
  && matrixResizeAfter[1]?.manualPixelHeight === matrixResizeBefore[1]?.manualPixelHeight
const matrixGroupBeforeRightClick = await page.locator('#genome-canvas').evaluate((element) => element.toDataURL())
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.waitForTimeout(50)
const matrixGroupAfterRightClick = await page.locator('#genome-canvas').evaluate((element) => element.toDataURL())
const matrixGroupRightClickHighlightChanged = matrixGroupBeforeRightClick !== matrixGroupAfterRightClick
const matrixGroupMenuText = await page.locator('#track-context-menu').textContent()
await page.locator('[data-context-submenu="group-appearance"]').hover()
const matrixGroupAppearanceText = await page.locator('#track-context-flyout').textContent()
await page.locator('[data-context-action="matrix-settings"]').click()
const matrixSettingsVisible = await page.locator('#matrix-settings-dialog').isVisible()
await page.screenshot({ path: 'dist/smoke-matrix-settings.png', fullPage: true })
await page.locator('#matrix-palette').selectOption('custom')
await page.locator('#matrix-add-color').click()
await page.locator('#matrix-scale-mode').selectOption('percentile')
await page.locator('#matrix-scale-percentile').fill('98.5')
await page.locator('#matrix-depth').selectOption('250000')
await page.locator('#matrix-palette-reversed').check()
await page.locator('#matrix-zero-style').selectOption('low-color')
await page.locator('#matrix-missing-style').selectOption('custom')
await page.locator('#matrix-missing-color').fill('#8a8f99')
await page.locator('#matrix-masked-style').selectOption('background')
await page.locator('#matrix-group-scaling').selectOption('independent')
await page.locator('#matrix-value-mode').selectOption('log2-observed-expected')
await page.locator('.matrix-settings-content').evaluate((element) => { element.scrollTop = element.scrollHeight })
await page.locator('#matrix-settings-form button[type="submit"]').click()
await page.waitForTimeout(250)
const matrixGroupSettingsApplied = await page.evaluate(() => {
  const document = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  return document.tracks?.every((track) => track.kind !== 'matrix' || (
    track.matrixValueMode === 'log2-observed-expected'
    && track.matrixPalette === 'custom' && track.matrixPaletteReversed === true && track.matrixPaletteColors?.length === 6
    && track.matrixScaleMode === 'percentile' && track.matrixScalePercentile === 0.985
    && track.matrixDepthMode === 'fixed' && track.matrixMaxDistance === 250000
    && track.matrixZeroStyle === 'background' && track.matrixMissingStyle === 'custom' && track.matrixMissingColor === '#8a8f99'
    && track.matrixMaskedStyle === 'background'
  ))
    && document.groups?.find((group) => group.id === 'matrix-group')?.scaleBehavior === 'independent'
})
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.locator('[data-context-action="matrix-settings"]').click()
const matrixSettingsReopenedAtTop = await page.locator('.matrix-settings-content').evaluate((element) => element.scrollTop === 0)
  && await page.locator('#matrix-scale-mode').isVisible()
  && await page.locator('#matrix-value-mode').inputValue() === 'log2-observed-expected'
await page.screenshot({ path: 'dist/smoke-matrix-settings-reopened.png', fullPage: true })
await page.locator('#matrix-settings-cancel').click()
const matrixBottomBox = await page.locator('#bottom-canvas').boundingBox()
if (!matrixBottomBox) throw new Error('Matrix smoke bottom canvas was not visible.')
await page.mouse.click(matrixBottomBox.x + 60, matrixBottomBox.y + Math.min(24, matrixBottomBox.height / 2))
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60)
await page.mouse.click(matrixCanvasBox.x + 60, matrixCanvasBox.y + 60, { button: 'right' })
crossGroupSelectionText = await page.locator('#track-context-menu').textContent()
await page.keyboard.press('Escape')
await page.mouse.click(matrixCanvasBox.x + 300, matrixCanvasBox.y + 60)
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.keyboard.press('Escape')
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60)
await page.mouse.click(matrixCanvasBox.x + 60, matrixCanvasBox.y + 60, { button: 'right' })
const selectedMatrixMenuText = await page.locator('#track-context-menu').textContent()
redundantGroupingHidden = !selectedMatrixMenuText?.includes('Group selected')
await page.locator('[data-context-submenu="appearance"]').hover()
await page.locator('[data-context-action="move-pane-bottom"]').hover()
flyoutClosesOnPlainAction = await page.locator('#track-context-flyout').isHidden()
await page.locator('[data-context-submenu="appearance"]').hover()
await page.locator('[data-context-action="height"]').click()
heightInputUsesPixels = (await page.locator('#action-dialog').textContent())?.includes('Height in pixels (20–4000)')
await page.locator('#action-dialog-cancel').click()
await page.keyboard.press('Control+A')
await page.mouse.click(matrixCanvasBox.x + 60, matrixCanvasBox.y + 60, { button: 'right' })
const mixedSelectionMenuText = await page.locator('#track-context-menu').textContent()
await page.keyboard.press('Escape')
await page.locator('#file-menu-button').click()
await page.locator('#new-workspace-menu-item').click()
newWorkspaceConfirmationVisible = await page.locator('#action-dialog').isVisible()
await page.screenshot({ path: 'dist/smoke-new-workspace-dialog.png', fullPage: true })
await page.locator('#action-dialog-cancel').click()
await page.evaluate(() => {
  const existing = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  localStorage.setItem('gerafe-track-document', JSON.stringify({
    schemaVersion: 15,
    referenceId: existing.referenceId,
    region: existing.region,
    sources: [{ id: 'bam-source', name: 'example.bam', format: 'bam', files: [
      { name: 'example.bam', size: 1, lastModified: 1, role: 'signal' },
      { name: 'example.bam.bai', size: 1, lastModified: 1, role: 'index' },
    ] }],
    tracks: [{ id: 'bam-track', kind: 'alignment', sourceIds: ['bam-source'], label: 'Example BAM', color: '#6d55e0', enabled: true, height: 40, pane: 'main' }],
    groups: [],
    scales: [],
  }))
})
await page.reload({ waitUntil: 'networkidle' })
const bamCanvasBox = await page.locator('#genome-canvas').boundingBox()
if (!bamCanvasBox) throw new Error('BAM smoke canvas was not visible.')
await page.mouse.click(bamCanvasBox.x + 60, bamCanvasBox.y + 60, { button: 'right' })
const bamMenuText = await page.locator('#track-context-menu').textContent()
const bamSubmenuText = {}
for (const submenu of ['bam-content', 'bam-layout', 'bam-color', 'bam-filters']) {
  await page.locator(`[data-context-submenu="${submenu}"]`).hover()
  bamSubmenuText[submenu] = await page.locator('#track-context-flyout').textContent()
}
await page.screenshot({ path: 'dist/smoke-bam-menu.png', fullPage: true })
await page.evaluate(() => {
  const current = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const chr = current.region.chr
  localStorage.setItem('gerafe-track-document', JSON.stringify({
    schemaVersion: 24, referenceId: current.referenceId,
    region: { chr, start: 10_000, end: 30_000 },
    sources: [{ id: 'rect-source', name: 'offline.cool', format: 'cool', files: [] }],
    tracks: [{ id: 'rect-track', kind: 'matrix', sourceIds: ['rect-source'], label: 'Rectangular map',
      color: '#6d55e0', enabled: true, height: 50, pane: 'main', matrixValueMode: 'observed',
      matrixSecondaryRegion: { chr, start: 5_000, end: 15_000 } }],
    groups: [], scales: [],
  }))
})
await page.reload({ waitUntil: 'networkidle' })
const rectangularBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks[0]?.matrixSecondaryRegion)
const rectangularBox = await page.locator('#genome-canvas').boundingBox()
if (!rectangularBox) throw new Error('Rectangular matrix smoke canvas was not visible.')
await page.mouse.click(rectangularBox.x + 60, rectangularBox.y + 60, { button: 'right' })
const matrixDetailsMenuVisible = (await page.locator('#track-context-menu').textContent())?.includes('Matrix details')
await page.locator('[data-context-action="matrix-details"]').click()
const matrixDetailsText = await page.locator('#action-dialog').textContent()
await page.locator('#action-dialog-submit').click()
await page.mouse.move(rectangularBox.x + 300, rectangularBox.y + 60)
await page.keyboard.down('Shift')
await page.mouse.wheel(0, 100)
await page.keyboard.up('Shift')
await page.waitForTimeout(350)
const rectangularAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks[0]?.matrixSecondaryRegion)
const rectangularWorkspacePans = rectangularAfter?.start > rectangularBefore?.start && rectangularAfter?.chr === rectangularBefore?.chr
if (!rectangularWorkspacePans) console.error('Rectangular pan smoke:', rectangularBefore, rectangularAfter)
const matrixTileFidelity = await page.evaluate(async () => {
  const { MatrixTileRenderer } = await import('/src/matrix-tiles.ts')
  const cells = Array.from({ length: 30_000 }, (_, index) => ({ bin1: index % 512, bin2: Math.floor(index / 512), value: 1 }))
  const source = { featureType: 'matrix', start: 0, end: 512, resolution: 1, cells, missingCells: [], maskedBins: [] }
  const results = []
  for (const dpr of [1, 2]) {
    const renderer = new MatrixTileRenderer()
    const canvas = () => {
      const node = document.createElement('canvas')
      node.width = 512 * dpr; node.height = 128 * dpr
      const context = node.getContext('2d')
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      return context
    }
    const target = canvas()
    let painted = 0
    const options = { trackId: 'smoke-matrix', source, key: `fidelity:${dpr}`, target, plotLeft: 0,
      plotWidth: 512, top: 0, height: 128, worldLeft: 0, dpr,
      box: (cell) => ({ left: cell.bin1, top: cell.bin2, right: cell.bin1 + 1, bottom: cell.bin2 + 1 }),
      paint: (context, _cell, box) => { painted++; context.fillStyle = '#345678'; context.fillRect(box.left, box.top, 1, 1) },
    }
    let firstPainted = 0
    for (const offset of [0, 10]) {
      const direct = canvas()
      for (const cell of cells) { direct.fillStyle = '#345678'; direct.fillRect(cell.bin1 - offset, cell.bin2, 1, 1) }
      target.clearRect(0, 0, 512, 128)
      if (!renderer.render({ ...options, worldLeft: offset })) throw new Error('Dense matrix unexpectedly used direct fallback.')
      const first = direct.getImageData(0, 0, 512 * dpr, 128 * dpr).data
      const second = target.getImageData(0, 0, 512 * dpr, 128 * dpr).data
      let mismatches = 0
      for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) mismatches++
      results.push({ dpr, offset, mismatches })
      if (offset === 0) firstPainted = painted
    }
    results.push({ dpr, painted, reused: painted === firstPainted })
    const diamondSource = { ...source, cells: cells.map((cell) => ({ ...cell, bin1: cell.bin1 + 0.5, bin2: cell.bin2 + 0.5 })) }
    const diamondTarget = canvas()
    const diamondRenderer = new MatrixTileRenderer()
    const diamond = (ctx, x, y) => {
      ctx.fillStyle = '#345678'; ctx.globalAlpha = 0.3
      ctx.beginPath(); ctx.moveTo(x - 0.55, y); ctx.lineTo(x, y + 0.55)
      ctx.lineTo(x + 0.55, y); ctx.lineTo(x, y - 0.55); ctx.closePath(); ctx.fill()
    }
    const diamondOptions = { ...options, source: diamondSource, target: diamondTarget, key: `diamonds:${dpr}`,
      box: (cell) => ({ left: cell.bin1 - 0.55, top: cell.bin2 - 0.55, right: cell.bin1 + 0.55, bottom: cell.bin2 + 0.55 }),
      paint: (context, _cell, box) => diamond(context, (box.left + box.right) / 2, (box.top + box.bottom) / 2),
    }
    for (const offset of [0, 10]) {
      const direct = canvas()
      for (const cell of diamondSource.cells) diamond(direct, cell.bin1 - offset, cell.bin2)
      diamondTarget.clearRect(0, 0, 512, 128)
      if (!diamondRenderer.render({ ...diamondOptions, worldLeft: offset })) throw new Error('Dense diamonds unexpectedly used direct fallback.')
      const expected = direct.getImageData(0, 0, 512 * dpr, 128 * dpr).data
      const actual = diamondTarget.getImageData(0, 0, 512 * dpr, 128 * dpr).data
      let mismatches = 0
      for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) mismatches++
      results.push({ dpr, offset, geometry: 'diamonds', mismatches })
    }
  }
  return results
})
const matrixTilePerformance = await page.evaluate(async () => {
  const { MatrixTileRenderer } = await import('/src/matrix-tiles.ts')
  const cells = Array.from({ length: 100_000 }, (_, i) => ({ bin1: i % 1_000, bin2: Math.floor(i / 1_000), value: 1 }))
  const source = { featureType: 'matrix', start: 0, end: 1_000, resolution: 1, cells, missingCells: [], maskedBins: [] }
  const canvas = document.createElement('canvas')
  canvas.width = 1_000; canvas.height = 120
  const target = canvas.getContext('2d')
  const renderer = new MatrixTileRenderer()
  const options = { trackId: 'benchmark', source, key: '100k', target, plotLeft: 0, plotWidth: 1_000,
    top: 0, height: 120, worldLeft: 0, dpr: 1,
    box: (cell) => ({ left: cell.bin1, top: cell.bin2, right: cell.bin1 + 1, bottom: cell.bin2 + 1 }),
    paint: (ctx, _cell, box) => { ctx.fillStyle = '#345678'; ctx.fillRect(box.left, box.top, 1, 1) },
  }
  const first = performance.now()
  renderer.render(options)
  const buildMs = performance.now() - first
  let started = performance.now()
  for (let pan = 0; pan < 6; pan++) {
    target.clearRect(0, 0, 1_000, 120)
    for (const cell of cells) { target.fillStyle = '#345678'; target.fillRect(cell.bin1 - pan * 5, cell.bin2, 1, 1) }
  }
  const directSixPansMs = performance.now() - started
  started = performance.now()
  for (let pan = 0; pan < 6; pan++) {
    target.clearRect(0, 0, 1_000, 120)
    renderer.render({ ...options, worldLeft: pan * 5 })
  }
  return { cells: cells.length, buildMs, directSixPansMs, tiledSixPansMs: performance.now() - started,
    tileMiB: renderer.memoryBytes / 1_048_576 }
})
await browser.close()

console.log(JSON.stringify({ ...result, matrixInspectorSizing, emptyWorkspaceVisible, emptyWorkspaceText: emptyWorkspaceText?.trim(), emptyWorkspaceBrand, emptyWorkspaceHiddenAfterLoad, cornerBrandCount, footerHeight, zoomBeforeWheel, zoomAfterWheel, zoomTitle, spanBeforeSlider, spanAfterSlider, chromosomeMenuVisible, chromosomeMenuOpenClass, selectedChromosomeText, autoFitBeforeToggle, autoFitAfterToggle, autoFitAfterReload, visualDataTrackCount, hasStrandedTrack, strandedRoundTrip, initialTrackContextText, initialAppearanceText, singleItemFlyoutFlattened, currentIndicatorCount, arcFlipOptionCount, geneDetailProbe, geneMenuText, initialBottomPaneHeight, initialBottomCanvasHeight, expandedBottomPaneHeight, expandedBottomCanvasHeight, searchSelectAll, settingsMenuText: settingsMenuText?.trim(), settingsMenuActiveElement, tssBeforeToggle, tssAfterToggle, tssAfterReload, matrixDisplayDefaults, matrixMetadataOptionCount, matrixDisplayAfterReload, colorDialogVisible, dragGhostVisible, dragCursor, fitScrollRange, fitPaneGap, fittedTrackHeights, headerTopBeforeScroll, headerTopAfterScroll, fileMenuVisible, fileMenuText: fileMenuText?.trim(), fileMenuActiveElement, helpMenuVisible, helpMenuText: helpMenuText?.trim(), helpMenuActiveElement, interactionGuideVisible, interactionGuideText, aboutDialogVisible, aboutVersionText, browserUpdateDisabled, trackContextVisible, trackContextFocusedAction, linkedScaleText, groupMenuText, groupAppearanceText, groupContextFocusedAction, groupClickSelectionText, groupHighlightChanged, groupRightClickHighlightChanged, groupMenuAfterPaneMove, selectAllText, clickAwaySelectionText, newWorkspaceConfirmationVisible, flyoutClosesOnPlainAction, redundantGroupingHidden, crossGroupSelectionText, heightInputUsesPixels, offlineTrackStatus, offlineLeftPixel, themeBefore, themeAfterToggle, themeAfterReload, referenceMenuText, customReferenceBeforeReload, customReferenceAfterReload, matrixGroupMenuText, matrixGroupRightClickHighlightChanged, matrixGroupAppearanceText, matrixSettingsVisible, matrixGroupSettingsApplied, matrixSettingsReopenedAtTop, resizeRequiresHoverDelay, unselectedBottomBoundaryResize, selectedMatrixMenuText, mixedSelectionMenuText, bamMenuText, bamSubmenuText, matrixDetailsMenuVisible, matrixDetailsText, consoleErrors, screenshot: 'dist/smoke.png' }, null, 2))
console.log('Matrix tile fidelity and synthetic 100k-cell pan benchmark:', matrixTileFidelity, matrixTilePerformance)
if (themeBefore === themeAfterToggle || themeAfterToggle !== themeAfterReload) process.exitCode = 1
if (!emptyWorkspaceVisible || !emptyWorkspaceText?.includes('Open or drop genomics files') || !emptyWorkspaceText.includes('GeRAFE') || Math.abs(emptyWorkspaceBrand.centerOffset) > 1 || emptyWorkspaceBrand.headingOffset > 30 || emptyWorkspaceBrand.headingFontSize < 18 || emptyWorkspaceBrand.imageGap > 16 || emptyWorkspaceBrand.imageHeight < 600 || emptyWorkspaceBrand.wordmarkHeight < 60 || cornerBrandCount !== 0 || footerHeight > 24 || emptyWorkspaceHiddenAfterLoad === false) process.exitCode = 1
if (!(matrixInspectorSizing.expandedWidth > matrixInspectorSizing.compactWidth) || !(matrixInspectorSizing.expandedHeight > matrixInspectorSizing.compactHeight)) process.exitCode = 1
if (!fileMenuVisible || !fileMenuText?.includes('Open tracks')) process.exitCode = 1
if (fileMenuActiveElement !== 'file-menu-button' || settingsMenuActiveElement !== 'settings-menu-button' || helpMenuActiveElement !== 'help-menu-button') process.exitCode = 1
if (!helpMenuVisible || !helpMenuText?.includes('Track interactions') || !helpMenuText?.includes('Check for updates') || !interactionGuideVisible || !interactionGuideText?.includes('Ctrl+click') || !aboutDialogVisible || !aboutVersionText?.startsWith('Version ') || !browserUpdateDisabled) process.exitCode = 1
if (!trackContextVisible) process.exitCode = 1
if (!singleItemFlyoutFlattened || !flyoutClosesOnPlainAction || !redundantGroupingHidden || !crossGroupSelectionText?.includes('3 tracks selected') || !heightInputUsesPixels) process.exitCode = 1
if (trackContextFocusedAction || groupContextFocusedAction) process.exitCode = 1
if (initialTrackContextText?.toLocaleLowerCase().includes('current') || initialTrackContextText?.includes('Set visual group')) process.exitCode = 1
if ((!firstTrackSpec || ['interval', 'interaction', 'alignment'].includes(firstTrackSpec.kind)) && currentIndicatorCount < 1) process.exitCode = 1
if (firstTrackSpec?.kind === 'interaction' && (arcFlipOptionCount !== 1 || initialTrackContextText.includes('Arc base at'))) process.exitCode = 1
if (searchSelectAll.start !== 0 || searchSelectAll.end !== searchSelectAll.length) process.exitCode = 1
if (Number(zoomBeforeWheel) === Number(zoomAfterWheel) || !zoomTitle?.includes('100% shows the full chromosome')) process.exitCode = 1
if (!(Number(spanAfterSlider) < Number(spanBeforeSlider)) || !chromosomeMenuVisible || !chromosomeMenuOpenClass || !selectedChromosomeText) process.exitCode = 1
if (!geneMenuText?.includes('Expanded transcripts')) process.exitCode = 1
if (!settingsMenuText?.includes('Track behavior')) process.exitCode = 1
if (tssBeforeToggle === tssAfterToggle || tssAfterToggle !== tssAfterReload) process.exitCode = 1
if (!matrixDisplayDefaults.inspector || !matrixDisplayDefaults.value || matrixDisplayDefaults.bins || matrixDisplayDefaults.details || !matrixDisplayAfterReload.bins || matrixMetadataOptionCount !== 0) process.exitCode = 1
if (autoFitBeforeToggle === autoFitAfterToggle || autoFitAfterToggle !== autoFitAfterReload) process.exitCode = 1
if (Math.abs(initialBottomPaneHeight - initialBottomCanvasHeight - 1) > 2 || Math.abs(expandedBottomPaneHeight - expandedBottomCanvasHeight - 1) > 2) process.exitCode = 1
if (!geneModePersisted || expandedBottomPaneHeight < initialBottomPaneHeight) process.exitCode = 1
if (visualDataTrackCount > 1 && (!dragGhostVisible || dragCursor !== 'grabbing')) process.exitCode = 1
if (visualDataTrackCount > 1 && Number(fitScrollRange) > 2) process.exitCode = 1
if (visualDataTrackCount > 1 && (Math.abs(Number(fitPaneGap)) > 2 || fittedTrackHeights?.some((height) => !Number.isFinite(height)))) process.exitCode = 1
if (Math.abs(headerTopBeforeScroll - headerTopAfterScroll) > 1) process.exitCode = 1
if (Number(result.toolbarHeight) > 46.5 || Number(result.rulerHeight) > 70.5) process.exitCode = 1
if (Number(result.bottomPaneHeight) < initialBottomPaneHeight + 30) process.exitCode = 1
if (visualDataTrackCount > 1 && !linkedScaleText?.includes('2 tracks selected')) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupMenuText?.includes('Remove all tracks in group') || (firstTwoAreSignals && !groupMenuText?.includes('Signal scaling')))) process.exitCode = 1
if (visualDataTrackCount > 1 && (!groupAppearanceText?.includes('Set group track color') || groupAppearanceText?.includes('Set unstranded track color'))) process.exitCode = 1
if (visualDataTrackCount > 1 && !groupMenuAfterPaneMove?.includes('Experiment A')) process.exitCode = 1
if (visualDataTrackCount > 1 && !selectAllText?.includes(`${visualDataTrackCount + 1} tracks selected`)) process.exitCode = 1
if (visualDataTrackCount > 1 && selectAllText?.includes('Y-axis scale')) process.exitCode = 1
if (visualDataTrackCount > 1 && (!colorDialogVisible || !dragGhostVisible)) process.exitCode = 1
  if (visualDataTrackCount > 1 && (!groupHighlightChanged || !groupRightClickHighlightChanged || !groupClickSelectionText?.includes('2 tracks selected') || clickAwaySelectionText?.includes('tracks selected'))) process.exitCode = 1
if (hasStrandedTrack && (!initialTrackContextText?.includes('Stranded signal pair') || !initialAppearanceText?.includes('Set positive-strand color') || !initialAppearanceText?.includes('Set negative-strand color') || !initialTrackContextText.includes('Separate stranded pair'))) process.exitCode = 1
if (hasStrandedTrack && !strandedRoundTrip) process.exitCode = 1
if (dataPaths.length && (!offlineTrackStatus?.includes('reopening or attention') || offlineLeftPixel.slice(0, 3).join(',') === '150,144,135')) process.exitCode = 1
if (customReferenceBeforeReload !== customReferenceAfterReload) process.exitCode = 1
if (!referenceMenuText?.includes('Add reference')) process.exitCode = 1
if (!matrixGroupRightClickHighlightChanged || !matrixGroupMenuText?.includes('Matrix settings') || !matrixGroupMenuText.includes('Toggle matrix orientation') || matrixGroupMenuText.includes('Draw matrix downward') || !matrixGroupAppearanceText?.includes('Set group track color') || !matrixGroupAppearanceText?.includes('Set group track height')) process.exitCode = 1
if (!matrixSettingsVisible || !matrixGroupSettingsApplied || !matrixSettingsReopenedAtTop || !resizeRequiresHoverDelay || !unselectedBottomBoundaryResize || !selectedMatrixMenuText?.includes('2 tracks selected') || !selectedMatrixMenuText?.includes('Matrix settings') || !newWorkspaceConfirmationVisible) process.exitCode = 1
if (!mixedSelectionMenuText?.includes('3 tracks selected') || mixedSelectionMenuText.includes('Matrix settings') || mixedSelectionMenuText.includes('Remove 3 selected tracks')) process.exitCode = 1
if (!bamMenuText?.includes('Content') || !bamMenuText.includes('Read layout') || !bamMenuText.includes('Color by') || !bamMenuText.includes('Read filters') || bamMenuText.includes('Coverage only')) process.exitCode = 1
if (!bamSubmenuText['bam-content']?.includes('Coverage only') || !bamSubmenuText['bam-layout']?.includes('Squished') || !bamSubmenuText['bam-color']?.includes('Pair orientation') || !bamSubmenuText['bam-filters']?.includes('Minimum mapping quality')) process.exitCode = 1
if (consoleErrors.length > 0) process.exitCode = 1
if (!rectangularWorkspacePans) process.exitCode = 1
if (!matrixDetailsMenuVisible || !matrixDetailsText?.includes('Format: .cool') || !matrixDetailsText?.includes('Vertical query:')) process.exitCode = 1
if (matrixTileFidelity.some((check) => check.mismatches || check.reused === false)) { console.error('Matrix tile fidelity:', matrixTileFidelity); process.exitCode = 1 }
