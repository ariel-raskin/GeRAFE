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
await page.evaluate(async () => {
  localStorage.setItem('gerafe:last-track-folder', 'C:\\Smoke')
  localStorage.setItem('gerafe-workspace-directory', 'D:\\Workspaces')
  window.__pickerVisited = []
  window.__pickerCloudState = 'online-only'
  const { pickNativeTrackPaths } = await import('/src/desktop-track-picker.ts')
  window.__trackPickerSmoke = pickNativeTrackPaths(async (path) => {
    window.__pickerVisited.push(path)
    return path === 'C:\\Smoke\\folder'
    ? { path, parent: 'C:\\Smoke', drives: ['C:\\'], entries: [{ name: 'signal.bw', path: `${path}\\signal.bw`, isDirectory: false, availability: 'on-device' }] }
    : { path: 'C:\\Smoke', parent: 'C:\\', drives: ['C:\\'], entries: [
      { name: 'folder', path: 'C:\\Smoke\\folder', isDirectory: true },
      { name: 'sample.bam.bai', path: 'C:\\Smoke\\sample.bam.bai', isDirectory: false, availability: window.__pickerCloudState },
      { name: 'notes.txt', path: 'C:\\Smoke\\notes.txt', isDirectory: false },
    ] }
  })
})
await page.locator('.track-file-picker-entry.is-folder').click()
await page.locator('.track-file-picker-entry').filter({ hasText: 'signal.bw' }).click()
await page.locator('.track-file-picker [data-action="up"]').click()
await page.locator('.track-file-picker [data-action="save-folder"]').click()
const pickerSavedShortcut = await page.locator('.track-file-picker-favorites .picker-chip').filter({ hasText: 'Smoke' }).count() === 1
await page.locator('.track-file-picker-breadcrumbs .picker-crumb').first().click()
await page.locator('.track-file-picker-favorites .picker-chip').filter({ hasText: 'Smoke' }).click()
const pickerHidesUnsupported = await page.locator('.track-file-picker-entry').filter({ hasText: 'notes.txt' }).count() === 0
const pickerOnlineOnlyBadge = await page.locator('.track-file-picker-entry').filter({ hasText: 'sample.bam.bai' }).locator('.is-online-only').textContent()
await page.evaluate(() => { window.__pickerCloudState = 'on-device' })
await page.locator('.track-file-picker [data-action="refresh"]').click()
const pickerRefreshedBadge = await page.locator('.track-file-picker-entry').filter({ hasText: 'sample.bam.bai' }).locator('.is-on-device').textContent()
await page.locator('.track-file-picker-entry').filter({ hasText: 'sample.bam.bai' }).click()
const pickerSelectionText = await page.locator('.track-file-picker-summary').textContent()
await page.locator('.track-file-picker [data-action="open"]').click()
const pickerPaths = await page.evaluate(() => window.__trackPickerSmoke)
const pickerClosed = await page.locator('.track-file-picker').count() === 0
const pickerState = await page.evaluate(() => ({ visited: window.__pickerVisited, lastTrack: localStorage.getItem('gerafe:last-track-folder'), lastWorkspace: localStorage.getItem('gerafe-workspace-directory'), saved: localStorage.getItem('gerafe:saved-track-folders') }))
const openingTrackCanvas = await page.evaluate(async () => {
  const { GenomeBrowser } = await import('/src/browser.ts')
  const { createTrackDocument, addSignalTrack, removeTrack } = await import('/src/track-document.ts')
  const host = document.createElement('div')
  Object.assign(host.style, { width: '760px', height: '210px', position: 'fixed', left: '-1000px', top: '0' })
  const header = document.createElement('canvas')
  const main = document.createElement('canvas')
  const bottom = document.createElement('canvas')
  host.append(header, main, bottom)
  document.body.append(host)
  const callbacks = new Proxy({}, { get: () => () => {} })
  const genome = new GenomeBrowser(header, main, bottom, new Map([['chr1', 100000]]), { chr: 'chr1', start: 0, end: 10000 }, callbacks)
  const documentState = createTrackDocument('test', { chr: 'chr1', start: 0, end: 10000 })
  addSignalTrack(documentState, { id: 'pending-source', name: 'cloud-signal.bw', format: 'bigwig', files: [{ name: 'cloud-signal.bw', size: 100, lastModified: 1, role: 'signal', path: 'C:\\Cloud\\cloud-signal.bw' }] }, { id: 'pending-track', autoPair: false })
  genome.syncDocument(documentState, new Map())
  await new Promise((resolve) => setTimeout(resolve, 100))
  genome.setOpeningProgress('pending-track', { message: 'Available locally', percent: 42, basis: 'local' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  genome.render()
  const ctx = main.getContext('2d')
  const filled = [...ctx.getImageData(220, 24, 1, 1).data]
  const empty = [...ctx.getImageData(500, 24, 1, 1).data]
  const order = documentState.tracks.map((track) => track.id)
  genome.setOpeningProgress('pending-track', { message: 'Still waiting for cloud provider' })
  genome.render()
  const indeterminateStart = [...ctx.getImageData(220, 24, 1, 1).data]
  const indeterminateEnd = [...ctx.getImageData(500, 24, 1, 1).data]
  removeTrack(documentState, 'pending-track')
  genome.syncDocument(documentState, new Map())
  genome.render()
  const afterRemoval = [...ctx.getImageData(220, 24, 1, 1).data]
  genome.destroy()
  host.remove()
  return { filled, empty, indeterminateStart, indeterminateEnd, afterRemoval, order }
})
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
if (!pickerHidesUnsupported || !pickerSavedShortcut || !pickerOnlineOnlyBadge?.includes('Online-only') || !pickerRefreshedBadge?.includes('On this device') || !pickerSelectionText?.includes('2 selected') || pickerPaths.length !== 2 || !pickerPaths.some((path) => path.endsWith('signal.bw')) || !pickerPaths.some((path) => path.endsWith('sample.bam.bai')) || !pickerClosed || pickerState.visited[0] !== 'C:\\Smoke' || !pickerState.visited.includes('C:\\') || pickerState.lastTrack !== 'C:\\Smoke' || pickerState.lastWorkspace !== 'D:\\Workspaces' || !pickerState.saved?.includes('C:\\\\Smoke')) throw new Error('In-app track picker smoke failed')
if (openingTrackCanvas.order[0] !== 'pending-track' || openingTrackCanvas.filled.slice(0, 3).join(',') === openingTrackCanvas.empty.slice(0, 3).join(',') || openingTrackCanvas.indeterminateStart.slice(0, 3).join(',') !== openingTrackCanvas.indeterminateEnd.slice(0, 3).join(',') || openingTrackCanvas.filled.slice(0, 3).join(',') === openingTrackCanvas.afterRemoval.slice(0, 3).join(',')) throw new Error(`In-row cloud progress smoke failed: ${JSON.stringify(openingTrackCanvas)}; ${consoleErrors.join('; ')}`)
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
const blankCanvasFillsPane = dataPaths.length > 0 || await page.evaluate(() => {
  const canvas = document.querySelector('#genome-canvas')?.getBoundingClientRect()
  const scroll = document.querySelector('#main-track-scroll')?.getBoundingClientRect()
  return Boolean(canvas && scroll && canvas.height >= scroll.height - 72)
})
const canvasWidthsAligned = await page.evaluate(() => {
  const widths = ['#genome-header', '#genome-canvas', '#bottom-canvas'].map((selector) => document.querySelector(selector)?.getBoundingClientRect().width)
  return widths.every((width) => width === widths[0])
})
const regionMenuText = await (async () => {
  await page.locator('#region-menu-button').click()
  const text = await page.locator('#region-menu-popup').textContent()
  await page.keyboard.press('Escape')
  return text
})()
const regionMenuOrder = regionMenuText.indexOf('Comparison dividers') < regionMenuText.indexOf('Add region')
  && regionMenuText.indexOf('Add region') < regionMenuText.indexOf('Saved regions')
const headerBoxForRegion = await page.locator('#genome-header').boundingBox()
if (!headerBoxForRegion) throw new Error('Genome header was not visible for region selection.')
const regionHeaderBefore = await page.locator('#genome-header').evaluate((element) => element.toDataURL())
const regionCanvasBefore = await canvas.evaluate((element) => element.toDataURL())
await page.keyboard.down('Control')
const ctrlRegionSelectionActivated = await canvas.evaluate((element) => element.classList.contains('is-region-selecting'))
await page.mouse.move(headerBoxForRegion.x + headerBoxForRegion.width * 0.42, headerBoxForRegion.y + 48)
await page.mouse.down()
await page.mouse.move(headerBoxForRegion.x + headerBoxForRegion.width * 0.56, headerBoxForRegion.y + 48, { steps: 6 })
await page.mouse.up()
await page.keyboard.up('Control')
await page.waitForSelector('#action-dialog:not([hidden])')
await page.locator('#action-dialog-input').fill('Smoke region')
await page.locator('#action-dialog-submit').click()
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').savedRegions?.[0]?.label === 'Smoke region')
const regionCanvasAfter = await canvas.evaluate((element) => element.toDataURL())
const regionHeaderAfter = await page.locator('#genome-header').evaluate((element) => element.toDataURL())
const regionHighlightChanged = regionCanvasBefore !== regionCanvasAfter
const regionHeaderUnchanged = regionHeaderBefore === regionHeaderAfter
await page.locator('#region-menu-button').click()
await page.locator('[data-region-action="save-current"]').click()
const actionHistoryEmptyBeforeTyping = await page.locator('#action-input-history option').count() === 0
const actionAutocompleteDisabled = await page.locator('#action-dialog-input').getAttribute('autocomplete') === 'off'
await page.locator('#action-dialog-input').fill('Smoke')
const actionHistoryMatches = await page.locator('#action-input-history option').evaluateAll((options) => options.map((option) => option.value))
await page.locator('#action-dialog-cancel').click()
await page.locator('#region-menu-button').click()
await page.locator('[data-region-color]').click()
const visualRegionColorPicker = await page.locator('#color-dialog:not([hidden]) #track-color-field').isVisible()
await page.locator('#track-color-input').fill('#1188cc')
await page.locator('#color-dialog-form').evaluate((form) => form.requestSubmit())
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').savedRegions?.[0]?.color === '#1188cc')
await page.locator('#region-menu-button').click()
const regionColorIcon = await page.locator('[data-region-color]').evaluate((element) => element.style.color)
if (!await page.locator('.saved-region-options').isVisible().catch(() => false)) await page.locator('[data-region-options]').click()
const regionAppearanceControlsVisible = await page.locator('.saved-region-options').isVisible()
await page.locator('[data-region-boundary]').selectOption('solid')
const regionCanvasBeforeShadePreview = await canvas.evaluate((element) => element.toDataURL())
await page.locator('[data-region-opacity]').evaluate((input) => { input.value = '25'; input.dispatchEvent(new Event('input', { bubbles: true })) })
await page.waitForTimeout(50)
const regionCanvasAfterShadePreview = await canvas.evaluate((element) => element.toDataURL())
const regionShadePreviewChanged = regionCanvasBeforeShadePreview !== regionCanvasAfterShadePreview
await page.locator('[data-region-opacity]').dispatchEvent('change')
const regionSnapStatusText = await page.locator('#region-snap-status').textContent()
await page.locator('[data-region-action="place-divider"]').click()
await page.mouse.click(box.x + box.width * 0.64, box.y + Math.min(95, box.height - 5))
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').comparisonDividers?.length === 1)
await page.locator('#region-menu-button').click()
await page.locator('[data-region-action="place-divider"]').click()
await page.mouse.click(box.x + box.width * 0.76, box.y + Math.min(95, box.height - 5))
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').comparisonDividers?.length === 2)
await page.locator('#region-menu-button').click()
await page.locator('[data-divider-style]').first().click()
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').comparisonDividers?.[0]?.lineStyle === 'solid')
await page.locator('[data-divider-color]').first().click()
const visualDividerColorPicker = await page.locator('#color-dialog:not([hidden]) #track-color-field').isVisible()
await page.locator('#track-color-input').fill('#22aa44')
await page.locator('#color-dialog-form').evaluate((form) => form.requestSubmit())
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').comparisonDividers?.[0]?.color === '#22aa44')
await page.locator('#region-menu-button').click()
const dividerColorIcon = await page.locator('[data-divider-color]').first().evaluate((element) => element.style.color)
await page.keyboard.press('Escape')
const regionStateBeforeReload = await page.evaluate(() => {
  const document = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  return { saved: document.savedRegions?.[0], dividers: document.comparisonDividers, snap: document.regionSnapToMatrixBins }
})
if (!dataPaths.length) {
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('#track-status')
}
const regionStateAfterReload = await page.evaluate(() => {
  const document = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  return { saved: document.savedRegions?.[0], dividers: document.comparisonDividers, snap: document.regionSnapToMatrixBins }
})
const regionRoundTrip = JSON.stringify(regionStateBeforeReload) === JSON.stringify(regionStateAfterReload)
await page.locator('#region-menu-button').click()
const savedRegionMenuText = await page.locator('#region-menu-popup').textContent()
await page.locator('[data-region-options]').click()
await page.screenshot({ path: 'dist/smoke-region-tools.png', fullPage: true })
await page.keyboard.press('Escape')
const regionBoundaryDragStart = await page.evaluate(() => {
  const documentState = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const canvas = document.querySelector('#genome-canvas')?.getBoundingClientRect()
  const region = documentState.region
  const saved = documentState.savedRegions?.[0]
  if (!canvas || !region || !saved) return undefined
  return { id: saved.id, x: canvas.left + 176 + ((saved.region.start - region.start) / (region.end - region.start)) * (canvas.width - 176), y: canvas.top + Math.min(60, canvas.height - 5), start: saved.region.start }
})
let regionBoundaryHoverCursor = ''
if (regionBoundaryDragStart) {
  await page.mouse.move(regionBoundaryDragStart.x, regionBoundaryDragStart.y)
  regionBoundaryHoverCursor = await canvas.evaluate((element) => getComputedStyle(element).cursor)
  await page.mouse.down()
  await page.mouse.move(regionBoundaryDragStart.x + 35, regionBoundaryDragStart.y, { steps: 5 })
  await page.mouse.up()
}
const regionBoundaryMoved = regionBoundaryDragStart ? await page.waitForFunction(({ id, start }) => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').savedRegions?.find((region) => region.id === id)?.region?.start !== start, { id: regionBoundaryDragStart.id, start: regionBoundaryDragStart.start }).then(() => true).catch(() => false) : false
const dividerDragStart = await page.evaluate(() => {
  const documentState = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const canvas = document.querySelector('#genome-header')?.getBoundingClientRect()
  const region = documentState.region
  const divider = documentState.comparisonDividers?.[0]
  if (!canvas || !region || !divider) return undefined
  return { id: divider.id, x: canvas.left + 176 + ((divider.position - region.start) / (region.end - region.start)) * (canvas.width - 176), y: canvas.top + 35, position: divider.position }
})
let dividerHoverCursor = ''
if (dividerDragStart) {
  await page.mouse.move(dividerDragStart.x, dividerDragStart.y)
  dividerHoverCursor = await page.locator('#genome-header').evaluate((element) => getComputedStyle(element).cursor)
  await page.mouse.down()
  await page.mouse.move(dividerDragStart.x + 45, dividerDragStart.y, { steps: 5 })
  await page.mouse.up()
}
const dividerMoved = dividerDragStart ? await page.waitForFunction(({ id, position }) => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').comparisonDividers?.find((divider) => divider.id === id)?.position !== position, { id: dividerDragStart.id, position: dividerDragStart.position }).then(() => true).catch(() => false) : false
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
const interactionGuideVisible = await page.locator('#interaction-guide-dialog').isVisible()
const interactionGuideText = await page.locator('#interaction-guide-dialog').textContent()
const interactionGuideSectionCount = await page.locator('#interaction-guide-dialog .interaction-guide-grid section').count()
const interactionGuideKeyCount = await page.locator('#interaction-guide-dialog kbd').count()
await page.screenshot({ path: 'dist/smoke-interaction-guide.png', fullPage: true })
await page.locator('#interaction-guide-dialog').click({ position: { x: 5, y: 5 } })
const interactionGuideBackdropDismissed = await page.locator('#interaction-guide-dialog').isHidden()
await page.locator('#help-menu-button').click()
await page.locator('#interaction-guide-menu-item').click()
await page.keyboard.press('Escape')
const interactionGuideEscapeDismissed = await page.locator('#interaction-guide-dialog').isHidden()
await page.locator('#help-menu-button').click()
await page.locator('#interaction-guide-menu-item').click()
await page.locator('#interaction-guide-done').click()
const interactionGuideButtonDismissed = await page.locator('#interaction-guide-dialog').isHidden()
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
const trackOptionsStayedOpenForControls = await page.locator('#track-options-dialog').isVisible()
await page.locator('#track-options-dialog').click({ position: { x: 5, y: 5 } })
const trackOptionsBackdropDismissed = await page.locator('#track-options-dialog').isHidden()
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
    { id: 'overlay-source', name: 'loops.bedpe', format: 'bedpe', files: [{ name: 'loops.bedpe', size: 1, lastModified: 1, role: 'signal' }] },
  ],
  tracks: [
    { id: 'matrix-a', kind: 'matrix', sourceIds: ['matrix-source-a'], label: 'First matrix', color: '#6d55e0', enabled: true, height: 50, pane: 'main', displayGroupId: 'matrix-group', matrixDirection: 'up', matrixNormalization: 'raw', matrixTransform: 'log1p', matrixPalette: 'warm' },
    { id: 'matrix-b', kind: 'matrix', sourceIds: ['matrix-source-b'], label: 'Second matrix', color: '#6d55e0', enabled: true, height: 50, pane: 'main', displayGroupId: 'matrix-group', matrixDirection: 'up', matrixNormalization: 'raw', matrixTransform: 'log1p', matrixPalette: 'warm' },
    { id: 'overlay-track', kind: 'interaction', sourceIds: ['overlay-source'], label: 'Called loops', color: '#169b8f', enabled: false, height: 32, pane: 'main', interactionDirection: 'up', interactionFilterMode: 'all', interactionMaxFeatures: 800, interactionColorMode: 'track' },
    { id: 'reference-genes', kind: 'genes', sourceIds: [], label: 'RefSeq genes', color: '#6652c9', enabled: true, height: 32, pane: 'bottom', geneDisplayMode: 'collapsed' },
  ],
  groups: [{ id: 'matrix-group', label: 'Matrix group', scaleBehavior: 'linked' }],
  scales: [],
  savedRegions: [{ id: 'matrix-region-smoke', label: 'Matrix region',
    region: { chr: existing.region?.chr ?? 'contigA', start: 12_000, end: 16_000 }, color: '#d95d74',
    highlighted: true, boundaryStyle: 'solid', fill: true, shadeOpacity: 0.09 }],
  matrixOutlines: [{ id: 'outline-smoke', label: 'Shared matrix block',
    axis1: { chr: existing.region?.chr ?? 'contigA', start: 12_000, end: 16_000 },
    axis2: { chr: existing.region?.chr ?? 'contigA', start: 18_000, end: 22_000 },
    color: '#3478c9', visible: true, sourceTrackId: 'matrix-a', targetTrackIds: ['matrix-a', 'matrix-b'] }],
  }))
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(250)
const matrixCanvasBox = await page.locator('#genome-canvas').boundingBox()
if (!matrixCanvasBox) throw new Error('Matrix smoke canvas was not visible.')
await page.mouse.click(500, (await page.viewportSize()).height - 8)
const matrixResizeBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks)
const firstMatrixPixels = matrixResizeBefore[0]?.fittedHeight ?? matrixResizeBefore[0]?.manualPixelHeight ?? 16 + matrixResizeBefore[0]?.height * 3.6
const matrixRegionHandle = await page.evaluate(({ canvasWidth, trackHeight }) => {
  const state = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const saved = state.savedRegions?.[0]?.region
  const view = state.region
  if (!saved || !view) return undefined
  const plotWidth = canvasWidth - 176
  const x1 = 176 + (saved.start - view.start) / (view.end - view.start) * plotWidth
  const x2 = 176 + (saved.end - view.start) / (view.end - view.start) * plotWidth
  const depth = Math.min((x2 - x1) / 2, trackHeight - 1)
  return { x1, slantedX: x1 + depth / 2, y: trackHeight - 0.5 - depth / 2, start: saved.start }
}, { canvasWidth: matrixCanvasBox.width, trackHeight: firstMatrixPixels })
let matrixImaginaryBoundaryCursor = ''
let matrixSlantedBoundaryCursor = ''
let matrixSlantedBoundaryMoved = false
if (matrixRegionHandle) {
  await page.mouse.move(matrixCanvasBox.x + matrixRegionHandle.x1, matrixCanvasBox.y + matrixRegionHandle.y)
  matrixImaginaryBoundaryCursor = await page.locator('#genome-canvas').evaluate((element) => getComputedStyle(element).cursor)
  await page.mouse.move(matrixCanvasBox.x + matrixRegionHandle.slantedX, matrixCanvasBox.y + matrixRegionHandle.y)
  matrixSlantedBoundaryCursor = await page.locator('#genome-canvas').evaluate((element) => getComputedStyle(element).cursor)
  await page.mouse.down()
  await page.mouse.move(matrixCanvasBox.x + matrixRegionHandle.slantedX + 12, matrixCanvasBox.y + matrixRegionHandle.y, { steps: 3 })
  await page.mouse.up()
  matrixSlantedBoundaryMoved = await page.waitForFunction((start) => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').savedRegions?.[0]?.region?.start !== start, matrixRegionHandle.start).then(() => true).catch(() => false)
}
const matrixCornerResizeGeometry = await page.evaluate(async () => {
  const { resizeMatrixOutlineCorner } = await import('/src/browser.ts')
  return resizeMatrixOutlineCorner(
    { chr: 'chr1', start: 100, end: 300 }, { chr: 'chr1', start: 400, end: 700 }, 2, 350, 750, 50,
  )
})
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
const matrixOutlineShortcutVisible = matrixGroupMenuText?.includes('Draw matrix outline')
await page.locator('[data-context-action="matrix-outline-draw"]').click()
const matrixOutlineDrawMode = await page.locator('#genome-canvas').evaluate((element) => element.classList.contains('is-matrix-outline-selecting') && getComputedStyle(element).cursor === 'crosshair')
await page.keyboard.press('Escape')
await page.locator('#region-menu-button').click()
const matrixOutlineMenuText = await page.locator('#region-menu-popup').textContent()
const matrixOutlineColorIcon = await page.locator('[data-outline-color]').evaluate((element) => element.style.color)
await page.locator('[data-outline-options]').click()
const matrixOutlineTargetsBefore = await page.locator('[data-outline-target]:checked').count()
await page.locator('[data-outline-target]').nth(1).uncheck()
const matrixOutlineTargetRemoved = await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').matrixOutlines?.[0]?.targetTrackIds?.length === 1).then(() => true).catch(() => false)
await page.locator('[data-outline-target]').nth(1).check()
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').matrixOutlines?.[0]?.targetTrackIds?.length === 2)
await page.locator('[data-outline-color]').click()
const visualMatrixOutlineColorPicker = await page.locator('#color-dialog:not([hidden]) #track-color-field').isVisible()
await page.locator('#track-color-input').fill('#aa55cc')
await page.locator('#color-dialog-form').evaluate((form) => form.requestSubmit())
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').matrixOutlines?.[0]?.color === '#aa55cc')
await page.locator('#region-menu-button').click()
if (!await page.locator('.matrix-outline-options').isVisible().catch(() => false)) await page.locator('[data-outline-options]').click()
await page.screenshot({ path: 'dist/smoke-matrix-outlines.png', fullPage: true })
await page.keyboard.press('Escape')
await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  state.region = { ...state.region, start: 17_000, end: 37_000 }
  localStorage.setItem('gerafe-track-document', JSON.stringify(state))
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(250)
const matrixOutlineVisibleAfterBasePan = await page.locator('#genome-canvas').evaluate((element) => {
  const context = element.getContext('2d')
  const scale = element.width / element.getBoundingClientRect().width
  const plotLeft = Math.floor(176 * scale)
  const image = context.getImageData(plotLeft, 0, element.width - plotLeft, element.height).data
  for (let index = 0; index < image.length; index += 4) {
    if (Math.abs(image[index] - 170) <= 12 && Math.abs(image[index + 1] - 85) <= 12 && Math.abs(image[index + 2] - 204) <= 12 && image[index + 3] > 200) return true
  }
  return false
})
await page.screenshot({ path: 'dist/smoke-matrix-outline-partial-pan.png', fullPage: true })
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.locator('[data-context-submenu="group-appearance"]').hover()
const matrixGroupAppearanceText = await page.locator('#track-context-flyout').textContent()
await page.locator('[data-context-submenu="matrix-overlay-source"]').hover()
const matrixOverlaySourceText = await page.locator('#track-context-flyout').textContent()
await page.screenshot({ path: 'dist/smoke-matrix-overlay.png', fullPage: true })
await page.locator('[data-context-action="matrix-overlay-link-overlay-track"]').click()
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks
  ?.filter((track) => track.kind === 'matrix').every((track) => track.matrixOverlayInteractionTrackId === 'overlay-track'))
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
await page.locator('[data-context-submenu="matrix-overlay-focus"]').hover()
const matrixOverlayFocusText = await page.locator('#track-context-flyout').textContent()
await page.locator('[data-context-action="matrix-overlay-focus-genes"]').click()
await page.locator('#action-dialog-input').fill('RUNX1')
await page.locator('#action-dialog-submit').click()
await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks
  ?.filter((track) => track.kind === 'matrix').every((track) => track.matrixOverlayFocusMode === 'genes' && track.matrixOverlayFocusGenes?.[0] === 'RUNX1'))
const matrixOverlayGroupLinked = await page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks
  ?.filter((track) => track.kind === 'matrix').every((track) => track.matrixOverlayInteractionTrackId === 'overlay-track'
    && track.matrixOverlayFocusMode === 'genes' && track.matrixOverlayMaxFeatures === 250))
await page.mouse.click(matrixCanvasBox.x + 8, matrixCanvasBox.y + 60, { button: 'right' })
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
  const current = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const chr = current.region.chr
  localStorage.setItem('gerafe-track-document', JSON.stringify({
    schemaVersion: 31, referenceId: current.referenceId, region: { chr, start: 10_000, end: 30_000 },
    sources: [
      { id: 'stack-source-a', name: 'control.bw', format: 'bigwig', files: [{ name: 'control.bw', size: 1, lastModified: 1, role: 'signal' }] },
      { id: 'stack-source-b', name: 'treatment.bw', format: 'bigwig', files: [{ name: 'treatment.bw', size: 1, lastModified: 1, role: 'signal' }] },
    ],
    tracks: [
      { id: 'stack-a', kind: 'signal', sourceIds: ['stack-source-a'], label: 'Control replicate', color: '#6d55e0', enabled: true, height: 40, pane: 'main', displayGroupId: 'signal-stack', scaleBindingId: 'stack-scale' },
      { id: 'stack-b', kind: 'signal', sourceIds: ['stack-source-b'], label: 'Treatment replicate', color: '#6d55e0', enabled: true, height: 40, pane: 'main', displayGroupId: 'signal-stack', scaleBindingId: 'stack-scale' },
      { id: 'reference-genes', kind: 'genes', sourceIds: [], label: 'RefSeq genes', color: '#6652c9', enabled: true, height: 32, pane: 'bottom', geneDisplayMode: 'collapsed' },
    ],
    groups: [{ id: 'signal-stack', label: 'Signal stack', scaleBehavior: 'linked', signalStackMode: 'collapsed', signalStackDifferentiation: 'patterns', signalStackRenderStyle: 'line' }],
    scales: [{ id: 'stack-scale', label: 'Stack scale', mode: 'auto-visible', includeZero: true }],
  }))
})
await page.reload({ waitUntil: 'networkidle' })
const signalStackCanvas = page.locator('#genome-canvas')
const signalStackBox = await signalStackCanvas.boundingBox()
if (!signalStackBox) throw new Error('Signal stack smoke canvas was not visible.')
const signalStackBeforeStyle = await signalStackCanvas.evaluate((element) => element.toDataURL())
await page.mouse.click(signalStackBox.x + 60, signalStackBox.y + 50, { button: 'right' })
const signalStackMenuText = await page.locator('#track-context-menu').textContent()
await page.locator('[data-context-submenu="signal-stack"]').hover()
const signalStackFlyoutText = await page.locator('#track-context-flyout').textContent()
await page.locator('[data-context-action="signal-stack-diff-shades"]').click()
await page.waitForTimeout(300)
const signalStackLegendChanged = signalStackBeforeStyle !== await signalStackCanvas.evaluate((element) => element.toDataURL())
const signalStackBeforeMove = await page.evaluate(async () => {
  const { signalStackLegendEntries } = await import('/src/browser.ts')
  const state = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const members = state.tracks.filter((track) => track.displayGroupId === 'signal-stack')
  const group = state.groups.find((item) => item.id === 'signal-stack')
  return { order: members.map((track) => track.id), styleIds: group.signalStackStyleTrackIds,
    styles: signalStackLegendEntries(members, members, group.signalStackDifferentiation, [], group.signalStackStyleTrackIds) }
})
await page.mouse.click(signalStackBox.x + 60, signalStackBox.y + 50, { button: 'right' })
await page.locator('[data-context-submenu="signal-stack"]').hover()
await page.locator('[data-context-action="signal-stack-up-stack-b"]').click()
await page.waitForTimeout(300)
const signalStackAfterMove = await page.evaluate(async () => {
  const { signalStackLegendEntries } = await import('/src/browser.ts')
  const state = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const members = state.tracks.filter((track) => track.displayGroupId === 'signal-stack')
  const group = state.groups.find((item) => item.id === 'signal-stack')
  return { order: members.map((track) => track.id), styleIds: group.signalStackStyleTrackIds,
    styles: signalStackLegendEntries(members, members, group.signalStackDifferentiation, [], group.signalStackStyleTrackIds) }
})
const signalStackStylesFollowTracks = signalStackBeforeMove.order.join(',') === 'stack-a,stack-b'
  && signalStackAfterMove.order.join(',') === 'stack-b,stack-a'
  && signalStackBeforeMove.styleIds.join(',') === 'stack-a,stack-b'
  && signalStackAfterMove.styleIds.join(',') === 'stack-a,stack-b'
  && signalStackBeforeMove.styles.every((entry) => {
    const moved = signalStackAfterMove.styles.find((item) => item.id === entry.id)
    return moved?.color === entry.color && JSON.stringify(moved.dash) === JSON.stringify(entry.dash)
  })
await page.screenshot({ path: 'dist/smoke-signal-stack.png', fullPage: true })
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
await page.waitForTimeout(250)
const bamCanvasBox = await page.locator('#genome-canvas').boundingBox()
if (!bamCanvasBox) throw new Error('BAM smoke canvas was not visible.')
await page.mouse.click(bamCanvasBox.x + 60, bamCanvasBox.y + Math.min(60, bamCanvasBox.height / 2), { button: 'right' })
await page.waitForSelector('#track-context-menu:not([hidden])')
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
await page.evaluate(() => {
  const existing = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const chr = existing.region?.chr ?? 'contigA'
  localStorage.setItem('gerafe-track-document', JSON.stringify({
    schemaVersion: 32, referenceId: existing.referenceId, region: { chr, start: 10_000, end: 30_000 },
    sources: [
      { id: 'fit-source-a', name: 'first.bw', format: 'bigwig', files: [{ name: 'first.bw', size: 1, lastModified: 1, role: 'signal' }] },
      { id: 'fit-source-b', name: 'second.bw', format: 'bigwig', files: [{ name: 'second.bw', size: 1, lastModified: 1, role: 'signal' }] },
    ],
    tracks: [
      { id: 'fit-a', kind: 'signal', sourceIds: ['fit-source-a'], label: 'First signal', color: '#6d55e0', enabled: true, height: 40, pane: 'main' },
      { id: 'fit-b', kind: 'signal', sourceIds: ['fit-source-b'], label: 'Second signal', color: '#d95d74', enabled: true, height: 40, pane: 'main' },
      { id: 'reference-genes', kind: 'genes', sourceIds: [], label: 'RefSeq genes', color: '#6652c9', enabled: true, height: 32, pane: 'bottom', geneDisplayMode: 'collapsed' },
    ],
    groups: [], scales: [],
  }))
})
await page.reload({ waitUntil: 'networkidle' })
if (await page.locator('#fit-tracks-auto').getAttribute('aria-pressed') === 'true') await page.locator('#fit-tracks-auto').click()
const fitGapMetrics = async (clickFit = true) => {
  if (clickFit) await page.locator('#fit-tracks').click()
  await page.waitForTimeout(300)
  await page.locator('#main-track-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(60)
  return page.evaluate(() => {
    const scroll = document.querySelector('#main-track-scroll')
    const canvas = document.querySelector('#genome-canvas')
    const lower = document.querySelector('#bottom-pane')
    const state = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
    const trackHeight = state.tracks.filter((track) => track.enabled && track.pane === 'main')
      .reduce((sum, track) => sum + (track.fittedHeight ?? track.manualPixelHeight ?? Math.round(16 + track.height * 3.6)), 0)
    return { range: scroll.scrollHeight - scroll.clientHeight, scrollTop: scroll.scrollTop,
      gap: lower.getBoundingClientRect().top - (canvas.getBoundingClientRect().top + trackHeight),
      paneAlignment: lower.getBoundingClientRect().top - scroll.getBoundingClientRect().bottom }
  })
}
const fitGapBeforeResize = await fitGapMetrics()
const fitResizer = await page.locator('#pane-resizer').boundingBox()
if (!fitResizer) throw new Error('Fit regression pane resizer was not visible.')
await page.mouse.move(fitResizer.x + fitResizer.width / 2, fitResizer.y + fitResizer.height / 2)
await page.mouse.down()
await page.mouse.move(fitResizer.x + fitResizer.width / 2, fitResizer.y - 90, { steps: 5 })
await page.mouse.up()
const fitGapAfterResize = await fitGapMetrics()
await page.locator('#fit-tracks-auto').click()
const autoFitResizer = await page.locator('#pane-resizer').boundingBox()
if (!autoFitResizer) throw new Error('Auto-fit regression pane resizer was not visible.')
await page.mouse.move(autoFitResizer.x + autoFitResizer.width / 2, autoFitResizer.y + autoFitResizer.height / 2)
await page.mouse.down()
await page.mouse.move(autoFitResizer.x + autoFitResizer.width / 2, autoFitResizer.y + 60, { steps: 5 })
await page.mouse.up()
const fitGapAfterAutoResize = await fitGapMetrics(false)
await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  const locked = state.tracks.find((track) => track.id === 'fit-a')
  locked.heightLocked = true
  locked.manualPixelHeight = 1_200
  delete locked.fittedHeight
  localStorage.setItem('gerafe-track-document', JSON.stringify(state))
})
await page.reload({ waitUntil: 'networkidle' })
const fitLockedOverflow = await fitGapMetrics()
await browser.close()

console.log(JSON.stringify({ ...result, matrixInspectorSizing, emptyWorkspaceVisible, emptyWorkspaceText: emptyWorkspaceText?.trim(), emptyWorkspaceBrand, emptyWorkspaceHiddenAfterLoad, cornerBrandCount, footerHeight, blankCanvasFillsPane, canvasWidthsAligned, regionMenuText, regionMenuOrder, savedRegionMenuText, ctrlRegionSelectionActivated, regionHighlightChanged, regionHeaderUnchanged, actionHistoryEmptyBeforeTyping, actionAutocompleteDisabled, actionHistoryMatches, regionAppearanceControlsVisible, regionShadePreviewChanged, regionSnapStatusText, regionColorIcon, dividerColorIcon, visualRegionColorPicker, visualDividerColorPicker, regionRoundTrip, regionStateAfterReload, regionBoundaryHoverCursor, regionBoundaryMoved, dividerHoverCursor, dividerMoved, zoomBeforeWheel, zoomAfterWheel, zoomTitle, spanBeforeSlider, spanAfterSlider, chromosomeMenuVisible, chromosomeMenuOpenClass, selectedChromosomeText, autoFitBeforeToggle, autoFitAfterToggle, autoFitAfterReload, visualDataTrackCount, hasStrandedTrack, strandedRoundTrip, initialTrackContextText, initialAppearanceText, singleItemFlyoutFlattened, currentIndicatorCount, arcFlipOptionCount, geneDetailProbe, geneMenuText, initialBottomPaneHeight, initialBottomCanvasHeight, expandedBottomPaneHeight, expandedBottomCanvasHeight, searchSelectAll, settingsMenuText: settingsMenuText?.trim(), settingsMenuActiveElement, trackOptionsStayedOpenForControls, trackOptionsBackdropDismissed, tssBeforeToggle, tssAfterToggle, tssAfterReload, matrixDisplayDefaults, matrixMetadataOptionCount, matrixDisplayAfterReload, colorDialogVisible, dragGhostVisible, dragCursor, fitScrollRange, fitPaneGap, fittedTrackHeights, headerTopBeforeScroll, headerTopAfterScroll, fileMenuVisible, fileMenuText: fileMenuText?.trim(), fileMenuActiveElement, helpMenuVisible, helpMenuText: helpMenuText?.trim(), helpMenuActiveElement, interactionGuideVisible, interactionGuideText, interactionGuideSectionCount, interactionGuideKeyCount, interactionGuideBackdropDismissed, interactionGuideEscapeDismissed, interactionGuideButtonDismissed, aboutDialogVisible, aboutVersionText, browserUpdateDisabled, trackContextVisible, trackContextFocusedAction, linkedScaleText, groupMenuText, groupAppearanceText, groupContextFocusedAction, groupClickSelectionText, groupHighlightChanged, groupRightClickHighlightChanged, groupMenuAfterPaneMove, selectAllText, clickAwaySelectionText, newWorkspaceConfirmationVisible, flyoutClosesOnPlainAction, redundantGroupingHidden, crossGroupSelectionText, heightInputUsesPixels, offlineTrackStatus, offlineLeftPixel, themeBefore, themeAfterToggle, themeAfterReload, referenceMenuText, customReferenceBeforeReload, customReferenceAfterReload, signalStackMenuText, signalStackFlyoutText, signalStackLegendChanged, matrixGroupMenuText, matrixOutlineShortcutVisible, matrixOutlineDrawMode, matrixOutlineMenuText, matrixOutlineColorIcon, matrixOutlineTargetsBefore, matrixOutlineTargetRemoved, visualMatrixOutlineColorPicker, matrixOutlineVisibleAfterBasePan, matrixImaginaryBoundaryCursor, matrixSlantedBoundaryCursor, matrixSlantedBoundaryMoved, matrixCornerResizeGeometry, matrixGroupRightClickHighlightChanged, matrixGroupAppearanceText, matrixOverlaySourceText, matrixOverlayFocusText, matrixOverlayGroupLinked, matrixSettingsVisible, matrixGroupSettingsApplied, matrixSettingsReopenedAtTop, resizeRequiresHoverDelay, unselectedBottomBoundaryResize, selectedMatrixMenuText, mixedSelectionMenuText, bamMenuText, bamSubmenuText, matrixDetailsMenuVisible, matrixDetailsText, consoleErrors, screenshot: 'dist/smoke.png' }, null, 2))
console.log('Matrix tile fidelity and synthetic 100k-cell pan benchmark:', matrixTileFidelity, matrixTilePerformance)
console.log('Signal stack member styles after reordering:', { signalStackStylesFollowTracks, signalStackBeforeMove, signalStackAfterMove })
console.log('Fitted upper-pane scroll geometry:', { fitGapBeforeResize, fitGapAfterResize, fitGapAfterAutoResize, fitLockedOverflow })
if ([fitGapBeforeResize, fitGapAfterResize, fitGapAfterAutoResize].some((metrics) => metrics.range > 2 || metrics.scrollTop > 2 || Math.abs(metrics.gap) > 2 || Math.abs(metrics.paneAlignment) > 2)) process.exitCode = 1
if (fitLockedOverflow.range < 100 || Math.abs(fitLockedOverflow.scrollTop - fitLockedOverflow.range) > 2 || Math.abs(fitLockedOverflow.gap) > 2 || Math.abs(fitLockedOverflow.paneAlignment) > 2) process.exitCode = 1
if (themeBefore === themeAfterToggle || themeAfterToggle !== themeAfterReload) process.exitCode = 1
if (!emptyWorkspaceVisible || !emptyWorkspaceText?.includes('Open or drop genomics files') || !emptyWorkspaceText.includes('GeRAFE') || Math.abs(emptyWorkspaceBrand.centerOffset) > 1 || emptyWorkspaceBrand.headingOffset > 30 || emptyWorkspaceBrand.headingFontSize < 18 || emptyWorkspaceBrand.imageGap > 16 || emptyWorkspaceBrand.imageHeight < 600 || emptyWorkspaceBrand.wordmarkHeight < 60 || cornerBrandCount !== 0 || footerHeight > 24 || emptyWorkspaceHiddenAfterLoad === false) process.exitCode = 1
if (!blankCanvasFillsPane || !canvasWidthsAligned || !regionMenuOrder || !regionMenuText?.includes('Add region') || !regionMenuText.includes('Add comparison divider') || !regionMenuText.includes('Add current view as region') || !savedRegionMenuText?.includes('Smoke region') || !ctrlRegionSelectionActivated || !regionHighlightChanged || !regionHeaderUnchanged || !actionHistoryEmptyBeforeTyping || !actionAutocompleteDisabled || !actionHistoryMatches.includes('Smoke region') || !regionAppearanceControlsVisible || !regionShadePreviewChanged || !regionSnapStatusText?.startsWith('On') || regionColorIcon !== 'rgb(17, 136, 204)' || dividerColorIcon !== 'rgb(34, 170, 68)' || !visualRegionColorPicker || !visualDividerColorPicker || !regionRoundTrip || !regionBoundaryHoverCursor.includes('ew-resize') || !regionBoundaryMoved || !dividerHoverCursor.includes('ew-resize') || !dividerMoved || regionStateAfterReload.snap !== true || regionStateAfterReload.saved?.highlighted !== true || regionStateAfterReload.saved?.color !== '#1188cc' || regionStateAfterReload.saved?.boundaryStyle !== 'solid' || regionStateAfterReload.saved?.fill !== true || regionStateAfterReload.saved?.shadeOpacity !== 0.25 || regionStateAfterReload.dividers?.length !== 2 || regionStateAfterReload.dividers[0]?.color !== '#22aa44' || regionStateAfterReload.dividers[0]?.lineStyle !== 'solid' || !regionStateAfterReload.dividers.every((divider) => Number.isFinite(divider.position) && /^#[0-9a-f]{6}$/i.test(divider.color))) process.exitCode = 1
if (!(matrixInspectorSizing.expandedWidth > matrixInspectorSizing.compactWidth) || !(matrixInspectorSizing.expandedHeight > matrixInspectorSizing.compactHeight)) process.exitCode = 1
if (!fileMenuVisible || !fileMenuText?.includes('Open tracks')) process.exitCode = 1
if (fileMenuActiveElement !== 'file-menu-button' || settingsMenuActiveElement !== 'settings-menu-button' || helpMenuActiveElement !== 'help-menu-button') process.exitCode = 1
if (!helpMenuVisible || !helpMenuText?.includes('Track interactions') || !helpMenuText?.includes('Check for updates') || !interactionGuideVisible
  || !interactionGuideText?.includes('Navigate the view') || !interactionGuideText.includes('Regions and matrices')
  || interactionGuideSectionCount !== 4 || interactionGuideKeyCount < 4 || !interactionGuideBackdropDismissed
  || !interactionGuideEscapeDismissed || !interactionGuideButtonDismissed
  || !aboutDialogVisible || !aboutVersionText?.startsWith('Version ') || !browserUpdateDisabled) process.exitCode = 1
if (!trackContextVisible) process.exitCode = 1
if (!singleItemFlyoutFlattened || !flyoutClosesOnPlainAction || !redundantGroupingHidden || !crossGroupSelectionText?.includes('2 tracks selected') || crossGroupSelectionText.includes('3 tracks selected') || !heightInputUsesPixels) process.exitCode = 1
if (!signalStackMenuText?.includes('Signal stack') || !signalStackFlyoutText?.includes('Distinct colors') || !signalStackFlyoutText.includes('Line patterns') || signalStackFlyoutText.includes('fill') || !signalStackLegendChanged || !signalStackStylesFollowTracks) process.exitCode = 1
if (trackContextFocusedAction || groupContextFocusedAction) process.exitCode = 1
if (initialTrackContextText?.toLocaleLowerCase().includes('current') || initialTrackContextText?.includes('Set visual group')) process.exitCode = 1
if ((!firstTrackSpec || ['interval', 'interaction', 'alignment'].includes(firstTrackSpec.kind)) && currentIndicatorCount < 1) process.exitCode = 1
if (firstTrackSpec?.kind === 'interaction' && (arcFlipOptionCount !== 1 || initialTrackContextText.includes('Arc base at'))) process.exitCode = 1
if (searchSelectAll.start !== 0 || searchSelectAll.end !== searchSelectAll.length) process.exitCode = 1
if (Number(zoomBeforeWheel) === Number(zoomAfterWheel) || !zoomTitle?.includes('100% shows the full chromosome')) process.exitCode = 1
if (!(Number(spanAfterSlider) < Number(spanBeforeSlider)) || !chromosomeMenuVisible || !chromosomeMenuOpenClass || !selectedChromosomeText) process.exitCode = 1
if (!geneMenuText?.includes('Expanded transcripts')) process.exitCode = 1
if (!settingsMenuText?.includes('Track behavior') || !trackOptionsStayedOpenForControls || !trackOptionsBackdropDismissed) process.exitCode = 1
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
if (!matrixOutlineShortcutVisible || !matrixOutlineDrawMode || !matrixOutlineMenuText?.includes('Shared matrix block') || matrixOutlineColorIcon !== 'rgb(52, 120, 201)' || matrixOutlineTargetsBefore !== 2 || !matrixOutlineTargetRemoved || !visualMatrixOutlineColorPicker || !matrixOutlineVisibleAfterBasePan) process.exitCode = 1
if (matrixImaginaryBoundaryCursor.includes('ew-resize') || !matrixSlantedBoundaryCursor.includes('ew-resize') || !matrixSlantedBoundaryMoved
  || matrixCornerResizeGeometry.axis1.end !== 400 || matrixCornerResizeGeometry.axis2.end !== 800) process.exitCode = 1
if (!matrixOverlaySourceText?.includes('Called loops') || !matrixOverlayFocusText?.includes('Matching gene symbols') || !matrixOverlayFocusText.includes('Interactions involving region') || !matrixOverlayGroupLinked) process.exitCode = 1
if (!matrixSettingsVisible || !matrixGroupSettingsApplied || !matrixSettingsReopenedAtTop || !resizeRequiresHoverDelay || !unselectedBottomBoundaryResize || !selectedMatrixMenuText?.includes('2 tracks selected') || !selectedMatrixMenuText?.includes('Matrix settings') || !newWorkspaceConfirmationVisible) process.exitCode = 1
if (!mixedSelectionMenuText?.includes('3 tracks selected') || mixedSelectionMenuText.includes('Matrix settings') || mixedSelectionMenuText.includes('Remove 3 selected tracks')) process.exitCode = 1
if (!bamMenuText?.includes('Content') || !bamMenuText.includes('Read layout') || !bamMenuText.includes('Color by') || !bamMenuText.includes('Read filters') || bamMenuText.includes('Coverage only')) process.exitCode = 1
if (!bamSubmenuText['bam-content']?.includes('Coverage only') || !bamSubmenuText['bam-layout']?.includes('Squished') || !bamSubmenuText['bam-color']?.includes('Pair orientation') || !bamSubmenuText['bam-filters']?.includes('Minimum mapping quality')) process.exitCode = 1
if (consoleErrors.length > 0) process.exitCode = 1
if (!rectangularWorkspacePans) process.exitCode = 1
if (!matrixDetailsMenuVisible || !matrixDetailsText?.includes('Format: .cool') || !matrixDetailsText?.includes('Vertical query:')) process.exitCode = 1
if (matrixTileFidelity.some((check) => check.mismatches || check.reused === false)) { console.error('Matrix tile fidelity:', matrixTileFidelity); process.exitCode = 1 }
