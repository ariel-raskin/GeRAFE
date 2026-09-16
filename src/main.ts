import './style.css'
import { ungzip } from 'pako-esm2'
import { GenomeBrowser, heightScoreForPixels, trackPixelHeight } from './browser.ts'
import { BedGraphSource, MAX_BEDGRAPH_BYTES } from './data/bedgraph.ts'
import { gzipText } from './data/gzip.ts'
import { BedSource } from './data/bed.ts'
import { BedPeSource } from './data/bedpe.ts'
import { BigWigSource } from './data/bigwig.ts'
import { TdfSource } from './data/tdf.ts'
import { BamAlignmentSource, findBamIndex } from './data/bam.ts'
import { formatBases, formatLocus, formatZoomPercentage, hg38, parseLocus, resolveChromosome } from './genome.ts'
import { parseCytobands } from './cytoband.ts'
import { GeneSource, parseChromosomeIndex, restoreReference, serializeReference } from './reference.ts'
import type { ReferenceGenome, StoredReferenceGenome } from './reference.ts'
import {
  addSignalTrack,
  addIntervalTrack,
  addInteractionTrack,
  addAlignmentTrack,
  applyAutomaticStrandedColors,
  autoPairStrandedTracks,
  assignDisplayGroup,
  createTrackDocument,
  duplicateTrack,
  inferSignalStrand,
  linkScales,
  normalizeTrackDocument,
  removeTrack,
  reorderTracks,
  pairStrandedTracks,
  TrackDocumentStore,
  unlinkScales,
  unlinkStrandedTrack,
} from './track-document.ts'
import type { SignalScaleChannel, SourceFormat, TrackDocument, TrackSourceSpec, TrackSpec } from './track-document.ts'
import type { TrackSource, TrackRuntime } from './types.ts'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { describeNativeFile, isDesktopApp, NativeFileHandle, prepareBedGraphCache } from './native-file.ts'
import type { LocalFileDescriptor } from './native-file.ts'
import { SUPPORTED_TRACK_DIALOG_EXTENSIONS, SUPPORTED_TRACK_EXTENSION_LABEL } from './supported-formats.ts'
import { migrateLegacyStorage, STORAGE_KEYS } from './storage.ts'
import { AppUpdateController, createTauriUpdateBackend, updateProgressPercent } from './app-update.ts'
import type { AppUpdateState } from './app-update.ts'

type Theme = 'light' | 'dark'
const {
  theme: THEME_KEY,
  reference: REFERENCE_KEY,
  customReferences: CUSTOM_REFERENCES_KEY,
  workspace: WORKSPACE_KEY,
  tssIndicators: TSS_INDICATORS_KEY,
  strandedAutoLink: STRANDED_AUTO_LINK_KEY,
  groupAutoscale: GROUP_AUTOSCALE_KEY,
  strandedAutoColors: STRANDED_AUTO_COLORS_KEY,
} = STORAGE_KEYS
migrateLegacyStorage(localStorage)
applyTheme(savedTheme())

const hg38Reference: ReferenceGenome = { id: 'hg38', name: 'Human (hg38)', chromosomes: hg38, builtIn: true }
const references = new Map<string, ReferenceGenome>([[hg38Reference.id, hg38Reference], ...loadStoredReferences().map((reference) => [reference.id, reference] as const)])
let activeReference = references.get(localStorage.getItem(REFERENCE_KEY) ?? '') ?? hg38Reference
const restoredDocument = loadWorkspace()
if (restoredDocument && references.has(restoredDocument.referenceId)) activeReference = references.get(restoredDocument.referenceId)!
let activeChromosomes: ReadonlyMap<string, number> = activeReference.chromosomes
let activeGeneSource: GeneSource | undefined
let hg38GenesPromise: Promise<GeneSource> | undefined
let hg38CytobandsPromise: Promise<ReturnType<typeof parseCytobands>> | undefined
const hg38TranscriptPromises = new Map<string, Promise<GeneSource>>()
const hg38TranscriptLoaded = new Set<string>()

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main class="workspace" id="drop-zone">
    <header class="toolbar">
      <nav class="menu-bar" aria-label="Application menus">
        <div class="app-menu" id="file-menu-root">
          <button class="menu-trigger" id="file-menu-button" type="button" aria-haspopup="menu" aria-expanded="false">File</button>
          <div class="menu-popover" id="file-menu-popup" role="menu" hidden>
            <button class="menu-item" id="open-tracks-menu-item" type="button" role="menuitem">
              <span>Open tracks…</span><kbd>Ctrl+O</kbd>
            </button>
            <span class="menu-separator"></span>
            <button class="menu-item" id="new-workspace-menu-item" type="button" role="menuitem"><span>New workspace</span></button>
            <button class="menu-item" id="open-workspace-menu-item" type="button" role="menuitem"><span>Open workspace…</span></button>
            <button class="menu-item" id="save-workspace-menu-item" type="button" role="menuitem"><span>Save workspace…</span><kbd>Ctrl+S</kbd></button>
          </div>
        </div>
        <div class="app-menu" id="edit-menu-root">
          <button class="menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false">Edit</button>
          <div class="menu-popover" role="menu" hidden>
            <button class="menu-item" id="undo-menu-item" type="button" role="menuitem" title="Undo the last track or workspace edit"><span>Undo track change</span><kbd>Ctrl+Z</kbd></button>
            <button class="menu-item" id="redo-menu-item" type="button" role="menuitem" title="Redo the last undone track or workspace edit"><span>Redo track change</span><kbd>Ctrl+Y</kbd></button>
          </div>
        </div>
        <div class="app-menu" id="settings-menu-root">
          <button class="menu-trigger" id="settings-menu-button" type="button" aria-haspopup="menu" aria-expanded="false">Settings</button>
          <div class="menu-popover" id="settings-menu-popup" role="menu" hidden>
            <button class="menu-item" id="track-options-menu-item" type="button" role="menuitem"><span>Track options…</span></button>
          </div>
        </div>
        <div class="app-menu" id="help-menu-root">
          <button class="menu-trigger" id="help-menu-button" type="button" aria-haspopup="menu" aria-expanded="false">Help</button>
          <div class="menu-popover" id="help-menu-popup" role="menu" hidden>
            <button class="menu-item" id="check-updates-menu-item" type="button" role="menuitem"><span>Check for updates…</span></button>
            <span class="menu-separator"></span>
            <button class="menu-item" id="about-menu-item" type="button" role="menuitem"><span>About GeRAFE</span><small>v${__GERAFE_VERSION__}</small></button>
          </div>
        </div>
      </nav>
      <span class="toolbar-divider"></span>
      <div class="reference-control">
        <div class="reference-picker" id="reference-picker">
          <button class="reference-trigger" id="reference-button" type="button" aria-haspopup="listbox" aria-expanded="false" title="Choose the default reference genome"><span id="reference-label"></span><i aria-hidden="true"></i></button>
          <div class="reference-popover" id="reference-popup" role="listbox" hidden></div>
        </div>
        <button id="reference-import" type="button" title="Import .fai, .genome, or chromosome-sizes file">＋</button>
        <input id="reference-file-input" type="file" accept=".fai,.genome,.sizes,.txt" />
      </div>
      <span class="toolbar-divider"></span>
      <input id="file-input" type="file" multiple />
      <input id="workspace-file-input" type="file" accept=".json,.gerafe.json,.locus.json" />
      <input id="relink-file-input" type="file" multiple />
      <form class="locus-form" id="locus-form">
        <select id="chromosome-select" aria-label="Chromosome"></select>
        <input id="locus-input" aria-label="Gene name or genomic locus" placeholder="Gene or locus" spellcheck="false" />
        <button type="submit" aria-label="Go to locus">Go</button>
      </form>
      <div class="toolbar-spacer"></div>
      <button class="fit-tracks-button" id="fit-tracks" type="button" title="Fit all upper tracks into the visible upper pane">Fit tracks</button>
      <div class="zoom-controls" aria-label="Zoom controls">
        <button id="zoom-out" type="button" aria-label="Zoom out">−</button>
        <span class="zoom-meter" id="zoom-level" role="status" aria-live="polite" title="Zoom level"><i></i></span>
        <button id="zoom-in" type="button" aria-label="Zoom in">＋</button>
      </div>
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch color theme"></button>
    </header>

    <div class="browser-body">
      <div class="canvas-wrap track-scroll" id="main-track-scroll">
        <div class="genome-header-wrap">
          <canvas id="genome-header" aria-label="Chromosome ideogram and genomic coordinate ruler"></canvas>
          <div class="corner-brand" aria-label="GeRAFE">
            <small title="Installed GeRAFE version">v${__GERAFE_VERSION__}</small>
            <img src="/gerafe-icon.png" alt="" />
            <strong>GeRAFE</strong>
          </div>
        </div>
        <canvas id="genome-canvas" aria-label="Interactive genome tracks"></canvas>
        <div class="drop-overlay"><strong>Drop genomics files to open</strong><span>${SUPPORTED_TRACK_EXTENSION_LABEL}</span></div>
      </div>
      <section class="bottom-pane" id="bottom-pane" aria-label="Secondary track list">
        <div class="pane-resizer" id="pane-resizer" title="Drag to resize the lower track list"></div>
        <div class="bottom-track-scroll track-scroll" id="bottom-track-scroll">
          <canvas id="bottom-canvas" aria-label="Secondary genome tracks"></canvas>
        </div>
      </section>
    </div>

    <footer class="browser-footer">
      <div class="status-group"><span class="live-dot"></span><span id="track-status">No tracks loaded</span></div>
      <div class="metrics" aria-label="Rendering performance">
        <span><b id="fps-value">60</b> fps</span>
        <span><b id="render-value">0.0</b> ms draw</span>
        <span><b id="feature-value">0</b> features</span>
      </div>
      <div class="interaction-hint">Wheel scrolls · Ctrl+wheel zooms · Right-click labels for options</div>
    </footer>
  </main>
  <div class="track-context-menu" id="track-context-menu" role="menu" hidden></div>
  <div class="color-dialog" id="color-dialog" role="dialog" aria-modal="true" aria-labelledby="color-dialog-title" hidden>
    <form class="color-dialog-card" id="color-dialog-form">
      <strong id="color-dialog-title">Set track color</strong>
      <canvas class="color-field" id="track-color-field" width="238" height="142" aria-label="Color saturation and brightness"></canvas>
      <input class="color-hue" id="track-color-hue" type="range" min="0" max="360" step="1" aria-label="Color hue" />
      <label class="color-value"><i id="track-color-preview"></i><span>Hex</span><input id="track-color-input" type="text" maxlength="7" spellcheck="false" aria-label="Track color hexadecimal value" /></label>
      <div><button class="dialog-button secondary" id="color-cancel" type="button">Cancel</button><button class="dialog-button primary" type="submit">Set color</button></div>
    </form>
  </div>
  <div class="update-dialog" id="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" hidden>
    <section class="update-dialog-card">
      <header>
        <img src="/gerafe-icon.png" alt="" />
        <div><strong id="update-dialog-title">About GeRAFE</strong><span id="update-installed-version">Version ${__GERAFE_VERSION__}</span></div>
        <button class="update-dialog-close" id="update-dialog-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="update-dialog-content">
        <strong id="update-status-heading">GeRAFE ${__GERAFE_VERSION__}</strong>
        <p id="update-status-message">Genomic Renderer and Figure Editor</p>
        <div class="update-release-notes" id="update-release-notes" hidden>
          <span>What’s new</span>
          <p id="update-release-notes-text"></p>
        </div>
        <div class="update-progress" id="update-progress" hidden>
          <progress id="update-progress-bar" max="100"></progress>
          <span id="update-progress-label">Preparing download…</span>
        </div>
      </div>
      <footer>
        <button class="dialog-button secondary" id="update-later" type="button">Close</button>
        <button class="dialog-button primary" id="update-primary-action" type="button">Check for updates</button>
      </footer>
    </section>
  </div>
  <div class="track-options-dialog" id="track-options-dialog" role="dialog" aria-modal="true" aria-labelledby="track-options-title" hidden>
    <section class="track-options-card">
      <header><strong id="track-options-title">Track options</strong><button class="update-dialog-close" id="track-options-close" type="button" aria-label="Close">×</button></header>
      <div class="track-options-content">
        <label><span><strong>Show TSS elbow arrows</strong><small>Draw transcription start site indicators in gene tracks.</small></span><input id="tss-indicators-toggle" type="checkbox" /></label>
        <label><span><strong>Auto-link stranded signals</strong><small>Pair matching positive and negative signal files when opened.</small></span><input id="stranded-auto-link-toggle" type="checkbox" /></label>
        <label><span><strong>Autoscale new visual groups</strong><small>Link compatible signal scales whenever tracks are added to a new group.</small></span><input id="group-autoscale-toggle" type="checkbox" /></label>
        <label><span><strong>Color linked strands red and blue</strong><small>Use red for positive and blue for negative strands when pairs are linked.</small></span><input id="stranded-auto-colors-toggle" type="checkbox" /></label>
      </div>
    </section>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`

const headerCanvas = document.querySelector<HTMLCanvasElement>('#genome-header')!
const canvas = document.querySelector<HTMLCanvasElement>('#genome-canvas')!
const bottomCanvas = document.querySelector<HTMLCanvasElement>('#bottom-canvas')!
const bottomPane = document.querySelector<HTMLElement>('#bottom-pane')!
const paneResizer = document.querySelector<HTMLElement>('#pane-resizer')!
const mainTrackScroll = document.querySelector<HTMLElement>('#main-track-scroll')!
const locusInput = document.querySelector<HTMLInputElement>('#locus-input')!
const chromosomeSelect = document.querySelector<HTMLSelectElement>('#chromosome-select')!
const referencePicker = document.querySelector<HTMLElement>('#reference-picker')!
const referenceButton = document.querySelector<HTMLButtonElement>('#reference-button')!
const referenceLabel = document.querySelector<HTMLElement>('#reference-label')!
const referencePopup = document.querySelector<HTMLElement>('#reference-popup')!
const referenceFileInput = document.querySelector<HTMLInputElement>('#reference-file-input')!
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const workspaceFileInput = document.querySelector<HTMLInputElement>('#workspace-file-input')!
const relinkFileInput = document.querySelector<HTMLInputElement>('#relink-file-input')!
const dropZone = document.querySelector<HTMLElement>('#drop-zone')!
const toast = document.querySelector<HTMLElement>('#toast')!
const trackStatus = document.querySelector<HTMLElement>('#track-status')!
const trackContextMenu = document.querySelector<HTMLElement>('#track-context-menu')!
const trackColorInput = document.querySelector<HTMLInputElement>('#track-color-input')!
const trackColorField = document.querySelector<HTMLCanvasElement>('#track-color-field')!
const trackColorHue = document.querySelector<HTMLInputElement>('#track-color-hue')!
const trackColorPreview = document.querySelector<HTMLElement>('#track-color-preview')!
const colorDialog = document.querySelector<HTMLElement>('#color-dialog')!
const colorDialogForm = document.querySelector<HTMLFormElement>('#color-dialog-form')!
const updateDialog = document.querySelector<HTMLElement>('#update-dialog')!
const updateDialogClose = document.querySelector<HTMLButtonElement>('#update-dialog-close')!
const updateLater = document.querySelector<HTMLButtonElement>('#update-later')!
const updatePrimaryAction = document.querySelector<HTMLButtonElement>('#update-primary-action')!
const updateStatusHeading = document.querySelector<HTMLElement>('#update-status-heading')!
const updateStatusMessage = document.querySelector<HTMLElement>('#update-status-message')!
const updateReleaseNotes = document.querySelector<HTMLElement>('#update-release-notes')!
const updateReleaseNotesText = document.querySelector<HTMLElement>('#update-release-notes-text')!
const updateProgress = document.querySelector<HTMLElement>('#update-progress')!
const updateProgressBar = document.querySelector<HTMLProgressElement>('#update-progress-bar')!
const updateProgressLabel = document.querySelector<HTMLElement>('#update-progress-label')!
const trackOptionsDialog = document.querySelector<HTMLElement>('#track-options-dialog')!
const trackOptionsClose = document.querySelector<HTMLButtonElement>('#track-options-close')!
const tssIndicatorsToggle = document.querySelector<HTMLInputElement>('#tss-indicators-toggle')!
const strandedAutoLinkToggle = document.querySelector<HTMLInputElement>('#stranded-auto-link-toggle')!
const groupAutoscaleToggle = document.querySelector<HTMLInputElement>('#group-autoscale-toggle')!
const strandedAutoColorsToggle = document.querySelector<HTMLInputElement>('#stranded-auto-colors-toggle')!

const runtimeSources = new Map<string, TrackSource>()
const selectedTrackIds = new Set<string>()
let lastSelectedTrackId: string | undefined
let pendingRelinkTrackId: string | undefined
let pendingRelinkChannel: 'plus' | 'minus' | undefined
let pendingOpenGroupId: string | undefined
let pendingColorGroupId: string | undefined
let pendingColorChannel: SignalScaleChannel | undefined
let bottomPaneAutoFit = true
let colorHsv = { h: 250, s: 62, v: 88 }
let appUpdater: AppUpdateController | undefined
let appUpdaterPromise: Promise<AppUpdateController> | undefined

interface OpenedSource {
  source: TrackSource
  sourceSpec: TrackSourceSpec
  kind: 'signal' | 'interval' | 'interaction' | 'alignment'
}

const initialRegion = restoredDocument && restoredDocument.referenceId === activeReference.id
  && activeReference.chromosomes.has(restoredDocument.region.chr)
  ? restoredDocument.region
  : defaultRegion(activeReference)
const store = new TrackDocumentStore(restoredDocument && restoredDocument.referenceId === activeReference.id
  ? { ...restoredDocument, region: initialRegion }
  : createTrackDocument(activeReference.id, initialRegion))
const browser = new GenomeBrowser(headerCanvas, canvas, bottomCanvas, activeChromosomes, initialRegion, {
  onRegionChange(region) {
    locusInput.value = formatLocus(region)
    chromosomeSelect.value = region.chr
    updateZoomLevel(region)
    store.setViewport(activeReference.id, region)
    void ensureGeneDetails(region.chr)
  },
  onPerformance(sample) {
    document.querySelector('#fps-value')!.textContent = sample.fps.toFixed(0)
    document.querySelector('#render-value')!.textContent = sample.renderMs.toFixed(1)
    document.querySelector('#feature-value')!.textContent = sample.visibleFeatures.toLocaleString()
  },
  onTracksChange(nextTracks) {
    const runtimeByTrack = new Map<string, TrackRuntime[]>()
    for (const runtime of nextTracks) runtimeByTrack.set(runtime.trackId, [...runtimeByTrack.get(runtime.trackId) ?? [], runtime])
    const visualTracks = store.current.tracks.filter((track) => track.kind !== 'genes')
    const loading = visualTracks.filter((track) => runtimeByTrack.get(track.id)?.some((runtime) => runtime.status === 'loading')).length
    const attention = visualTracks.filter((track) => runtimeByTrack.get(track.id)?.some((runtime) => runtime.status === 'error' || runtime.status === 'offline')).length
    const ready = visualTracks.filter((track) => runtimeByTrack.get(track.id)?.length && runtimeByTrack.get(track.id)!.every((runtime) => runtime.status === 'ready')).length
    trackStatus.textContent = attention ? `${attention} track${attention === 1 ? ' needs' : 's need'} reopening or attention` : loading ? `Reading ${loading} track${loading === 1 ? '' : 's'}…` : `${ready} track${ready === 1 ? '' : 's'} loaded`
  },
  onTrackSelection(trackId, additive, extend) {
    selectTrack(trackId, additive, extend)
  },
  onGroupSelection(groupId, additive) {
    selectGroup(groupId, additive)
  },
  onClearSelection() {
    clearTrackSelection()
  },
  onTrackContextMenu(trackId, x, y) {
    if (!selectedTrackIds.has(trackId)) selectTrack(trackId, false, false)
    openTrackContextMenu(trackId, x, y)
  },
  onGroupContextMenu(groupId, x, y) {
    openGroupContextMenu(groupId, x, y)
  },
  onTracksReorder(trackIds, pane, insertionIndex, withinGroupId) {
    bottomPaneAutoFit = false
    store.edit((draft) => reorderTracks(draft, trackIds, pane, insertionIndex, withinGroupId))
  },
})
browser.setShowTssIndicators(savedTssIndicators())
updateTrackOptionsControls()
updateZoomLevel(initialRegion)

let persistTimer: number | undefined
store.subscribe((document, reason) => {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => localStorage.setItem(WORKSPACE_KEY, JSON.stringify(document)), 180)
  if (reason !== 'viewport') browser.syncDocument(document, runtimeSources)
  updateUndoControls()
  browser.setSelectedTracks(selectedTrackIds)
  if (bottomPaneAutoFit && reason !== 'viewport') requestAnimationFrame(fitBottomPaneToContent)
})
browser.syncDocument(store.current, runtimeSources)
if (isDesktopApp()) void restorePersistedSources()
browser.setSelectedTracks(selectedTrackIds)
fitBottomPaneToContent()
window.setTimeout(fitBottomPaneToContent, 0)

populateReferences()
populateChromosomes(activeChromosomes)
locusInput.value = formatLocus(initialRegion)
void activateGeneTrack(activeReference)

document.querySelector<HTMLFormElement>('#locus-form')!.addEventListener('submit', (event) => {
  event.preventDefault()
  const region = parseLocus(locusInput.value, activeChromosomes)
  if (region) return browser.setRegion(region)
  const gene = activeGeneSource?.find(locusInput.value)
  if (gene) {
    const geneSpan = gene.end - gene.start
    const padding = Math.max(5_000, Math.round(geneSpan * 0.25))
    browser.setRegion({ chr: gene.chr, start: gene.start - padding, end: gene.end + padding })
    showToast(`${gene.name} · ${formatLocus({ chr: gene.chr, start: gene.start, end: gene.end })}`)
    return
  }
  showToast(activeGeneSource
    ? `No gene or locus matched “${locusInput.value.trim()}”.`
    : `This reference has no gene-name index. Try a locus like ${exampleLocus(activeReference)}.`, true)
})

referenceButton.addEventListener('click', () => setReferenceMenu(referencePopup.hasAttribute('hidden')))
referencePopup.addEventListener('click', (event) => {
  const option = (event.target as Element).closest<HTMLButtonElement>('[data-reference-id]')
  if (!option) return
  setReferenceMenu(false)
  void switchReference(option.dataset.referenceId!)
})
document.querySelector<HTMLButtonElement>('#reference-import')!.addEventListener('click', () => referenceFileInput.click())
referenceFileInput.addEventListener('change', () => void importReference(referenceFileInput.files?.[0]))

document.querySelector<HTMLButtonElement>('#open-tracks-menu-item')!.addEventListener('click', () => {
  closeMenus()
  pendingOpenGroupId = undefined
  void openTrackPicker()
})
document.querySelector<HTMLButtonElement>('#new-workspace-menu-item')!.addEventListener('click', () => {
  closeMenus()
  bottomPaneAutoFit = true
  runtimeSources.clear()
  selectedTrackIds.clear()
  store.replace(createTrackDocument(activeReference.id, browser.getRegion()))
  showToast('Started a new workspace')
})
document.querySelector<HTMLButtonElement>('#open-workspace-menu-item')!.addEventListener('click', () => {
  closeMenus()
  workspaceFileInput.click()
})
document.querySelector<HTMLButtonElement>('#save-workspace-menu-item')!.addEventListener('click', () => {
  closeMenus()
  saveWorkspace()
})
document.querySelector<HTMLButtonElement>('#undo-menu-item')!.addEventListener('click', () => { closeMenus(); store.undo() })
document.querySelector<HTMLButtonElement>('#redo-menu-item')!.addEventListener('click', () => { closeMenus(); store.redo() })
document.querySelector<HTMLButtonElement>('#track-options-menu-item')!.addEventListener('click', () => { closeMenus(); openTrackOptionsDialog() })
tssIndicatorsToggle.addEventListener('change', () => {
  localStorage.setItem(TSS_INDICATORS_KEY, String(tssIndicatorsToggle.checked))
  browser.setShowTssIndicators(tssIndicatorsToggle.checked)
})
strandedAutoLinkToggle.addEventListener('change', () => {
  localStorage.setItem(STRANDED_AUTO_LINK_KEY, String(strandedAutoLinkToggle.checked))
  if (strandedAutoLinkToggle.checked) store.edit((draft) => { autoPairStrandedTracks(draft, { autoColors: savedStrandedAutoColors() }) })
})
groupAutoscaleToggle.addEventListener('change', () => localStorage.setItem(GROUP_AUTOSCALE_KEY, String(groupAutoscaleToggle.checked)))
strandedAutoColorsToggle.addEventListener('change', () => {
  localStorage.setItem(STRANDED_AUTO_COLORS_KEY, String(strandedAutoColorsToggle.checked))
  if (strandedAutoColorsToggle.checked) store.edit(applyAutomaticStrandedColors)
})
trackOptionsClose.addEventListener('click', closeTrackOptionsDialog)
document.querySelector<HTMLButtonElement>('#check-updates-menu-item')!.addEventListener('click', () => {
  closeMenus()
  openUpdateDialog()
  void checkForAppUpdates(true)
})
document.querySelector<HTMLButtonElement>('#about-menu-item')!.addEventListener('click', () => {
  closeMenus()
  openUpdateDialog()
})
for (const menu of document.querySelectorAll<HTMLElement>('.app-menu')) {
  const trigger = menu.querySelector<HTMLButtonElement>('.menu-trigger')!
  trigger.addEventListener('click', () => toggleMenu(menu))
}
document.addEventListener('pointerdown', (event) => {
  if (!(event.target as Element).closest?.('.app-menu')) closeMenus()
  if (!(event.target as Element).closest?.('.reference-picker')) setReferenceMenu(false)
  if (!(event.target as Element).closest?.('.track-context-menu')) closeTrackContextMenu()
  if (event.button === 0 && !(event.target as Element).closest?.('#genome-header, #genome-canvas, #bottom-canvas, .track-context-menu, #color-dialog, #update-dialog, #track-options-dialog')) clearTrackSelection()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeMenus(); setReferenceMenu(false); closeTrackContextMenu(); closeColorDialog(); closeUpdateDialog(); closeTrackOptionsDialog() }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'o') {
    event.preventDefault()
    closeMenus()
    pendingOpenGroupId = undefined
    void openTrackPicker()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
    event.preventDefault()
    saveWorkspace()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'a') {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement).isContentEditable) return
    event.preventDefault()
    selectedTrackIds.clear()
    const enabledTracks = store.current.tracks.filter((track) => track.enabled)
    for (const track of enabledTracks) selectedTrackIds.add(track.id)
    lastSelectedTrackId = enabledTracks[enabledTracks.length - 1]?.id
    browser.setSelectedTracks(selectedTrackIds)
    closeTrackContextMenu()
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLocaleLowerCase() === 'z') {
    event.preventDefault()
    store.undo()
  }
  if ((event.ctrlKey || event.metaKey) && (event.key.toLocaleLowerCase() === 'y' || (event.shiftKey && event.key.toLocaleLowerCase() === 'z'))) {
    event.preventDefault()
    store.redo()
  }
})

chromosomeSelect.addEventListener('change', () => {
  const chr = chromosomeSelect.value
  const length = activeChromosomes.get(chr)
  if (!length) return
  const current = browser.getRegion()
  const span = Math.min(current.end - current.start, length)
  browser.setRegion({ chr, start: Math.max(0, (length - span) / 2), end: Math.max(0, (length - span) / 2) + span })
})

document.querySelector('#zoom-in')!.addEventListener('click', () => browser.zoom(0.5))
document.querySelector('#zoom-out')!.addEventListener('click', () => browser.zoom(2))
document.querySelector('#fit-tracks')!.addEventListener('click', fitUpperTracks)
const themeToggle = document.querySelector<HTMLButtonElement>('#theme-toggle')!
updateThemeButton(themeToggle)
themeToggle.addEventListener('click', () => {
  const next: Theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  localStorage.setItem(THEME_KEY, next)
  updateThemeButton(themeToggle)
  browser.refresh()
})
fileInput.addEventListener('change', () => void loadFiles(fileInput.files))
fileInput.addEventListener('cancel', () => { pendingOpenGroupId = undefined })
workspaceFileInput.addEventListener('change', () => void openWorkspace(workspaceFileInput.files?.[0]))
relinkFileInput.addEventListener('change', () => void relinkTrack(relinkFileInput.files))
trackContextMenu.addEventListener('click', handleTrackContextAction)
bindColorPicker()
colorDialogForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const color = normalizedHexColor(trackColorInput.value)
  if (!color) return trackColorInput.focus()
  const groupId = pendingColorGroupId
  const channel = pendingColorChannel
  pendingColorGroupId = undefined
  pendingColorChannel = undefined
  const ids = groupId
    ? store.current.tracks.filter((track) => track.displayGroupId === groupId).map((track) => track.id)
    : [...selectedTrackIds]
  store.edit((draft) => {
    for (const track of draft.tracks) if (ids.includes(track.id)) setTrackChannelColor(track, channel, color)
    const group = draft.groups.find((item) => item.id === groupId)
    if (group) {
      if (channel === 'plus') group.positiveColor = color
      else if (channel === 'minus') group.negativeColor = color
      else group.color = color
    }
  })
  closeColorDialog()
})
document.querySelector('#color-cancel')!.addEventListener('click', closeColorDialog)
colorDialog.addEventListener('pointerdown', (event) => { if (event.target === colorDialog) closeColorDialog() })
updateDialogClose.addEventListener('click', closeUpdateDialog)
updateLater.addEventListener('click', closeUpdateDialog)
updateDialog.addEventListener('pointerdown', (event) => { if (event.target === updateDialog) closeUpdateDialog() })
updatePrimaryAction.addEventListener('click', () => void handleUpdatePrimaryAction())
app.addEventListener('contextmenu', (event) => event.preventDefault())
paneResizer.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  bottomPaneAutoFit = false
  paneResizer.setPointerCapture(event.pointerId)
  bottomPane.classList.add('is-resizing')
})
paneResizer.addEventListener('pointermove', (event) => {
  if (!paneResizer.hasPointerCapture(event.pointerId)) return
  const body = document.querySelector<HTMLElement>('.browser-body')!.getBoundingClientRect()
  setBottomPaneHeight(body.bottom - event.clientY)
})
const finishPaneResize = (event: PointerEvent) => {
  if (!paneResizer.hasPointerCapture(event.pointerId)) return
  paneResizer.releasePointerCapture(event.pointerId)
  bottomPane.classList.remove('is-resizing')
}
paneResizer.addEventListener('pointerup', finishPaneResize)
paneResizer.addEventListener('pointercancel', finishPaneResize)
window.addEventListener('resize', () => bottomPaneAutoFit ? fitBottomPaneToContent() : setBottomPaneHeight(bottomPane.getBoundingClientRect().height))

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropZone.classList.add('is-dropping')
  })
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropZone.classList.remove('is-dropping')
  })
}
dropZone.addEventListener('drop', (event) => {
  pendingOpenGroupId = undefined
  void loadFiles(event.dataTransfer?.files)
})
if (isDesktopApp()) void bindNativeFileDrop()
if (isDesktopApp()) window.setTimeout(() => void checkForAppUpdates(false), 1_800)

async function bindNativeFileDrop(): Promise<void> {
  await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'enter' || event.payload.type === 'over') dropZone.classList.add('is-dropping')
    else dropZone.classList.remove('is-dropping')
    if (event.payload.type === 'drop') {
      pendingOpenGroupId = undefined
      void loadNativePaths(event.payload.paths)
    }
  })
}

async function loadFiles(files: FileList | null | undefined): Promise<void> {
  if (!files?.length) return
  const selected = [...files]
  const destinationGroupId = pendingOpenGroupId
  pendingOpenGroupId = undefined
  for (const file of selected) {
    if (/\.(bai|csi)$/i.test(file.name)) continue
    try {
      const { source, sourceSpec, kind } = await sourceFromFile(file, selected)
      const trackId = crypto.randomUUID()
      runtimeSources.set(sourceSpec.id, source)
      store.edit((draft) => {
        const added = kind === 'interval' ? addIntervalTrack(draft, sourceSpec, { id: trackId })
          : kind === 'interaction' ? addInteractionTrack(draft, sourceSpec, { id: trackId })
            : kind === 'alignment' ? addAlignmentTrack(draft, sourceSpec, { id: trackId })
            : addSignalTrack(draft, sourceSpec, { id: trackId, displayGroupId: destinationGroupId, autoPair: savedStrandedAutoLink(), autoStrandColors: savedStrandedAutoColors() })
        if (destinationGroupId) addTracksToGroup(draft, destinationGroupId, [added.id])
      })
      await browser.attachSource(sourceSpec.id, source)
      showToast(`Opened ${file.name}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true)
    }
  }
  fileInput.value = ''
}

async function sourceFromFile(file: File, selected: readonly File[]): Promise<OpenedSource> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.bw') || name.endsWith('.bigwig')) return {
    source: await BigWigSource.fromFile(file),
    sourceSpec: makeSourceSpec(file, 'bigwig'),
    kind: 'signal',
  }
  if (name.endsWith('.bedgraph') || name.endsWith('.bedgraph.gz')) return {
    source: await BedGraphSource.fromFile(name.endsWith('.gz') ? gzipTextInput(file, () => file.arrayBuffer()) : file),
    sourceSpec: makeSourceSpec(file, 'bedgraph'),
    kind: 'signal',
  }
  if (name.endsWith('.tdf')) return {
    source: await TdfSource.fromFile(file, activeChromosomes),
    sourceSpec: makeSourceSpec(file, 'tdf'),
    kind: 'signal',
  }
  if (name.endsWith('.bed')) return {
    source: await BedSource.fromFile(file),
    sourceSpec: makeSourceSpec(file, 'bed'),
    kind: 'interval',
  }
  if (name.endsWith('.bedpe')) return {
    source: await BedPeSource.fromFile(file),
    sourceSpec: makeSourceSpec(file, 'bedpe'),
    kind: 'interaction',
  }
  if (name.endsWith('.bam')) {
    const index = findBamIndex(file, selected)
    if (!index) throw new Error(`${file.name}: select its .bai or .csi index at the same time.`)
    return {
      source: await BamAlignmentSource.fromFiles(file, index),
      sourceSpec: makeSourceSpec(file, 'bam', index),
      kind: 'alignment',
    }
  }
  throw new Error(`${file.name}: supported data files are .bw/.bigWig, .bedGraph/.bedGraph.gz, .tdf, indexed .bam, .bed, and .bedpe.`)
}

function makeSourceSpec(file: File | LocalFileDescriptor, format: SourceFormat, index?: File | LocalFileDescriptor): TrackSourceSpec {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    format,
    files: [
      { name: file.name, size: file.size, lastModified: file.lastModified, role: 'signal', path: 'path' in file ? file.path : undefined },
      ...(index ? [{ name: index.name, size: index.size, lastModified: index.lastModified, role: 'index' as const, path: 'path' in index ? index.path : undefined }] : []),
    ],
  }
}

async function openTrackPicker(): Promise<void> {
  if (!isDesktopApp()) {
    fileInput.click()
    return
  }
  try {
    const picked = await openDialog({
      title: 'Open genomics tracks',
      multiple: true,
      filters: [{ name: 'Genomics tracks', extensions: [...SUPPORTED_TRACK_DIALOG_EXTENSIONS] }],
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    if (paths.length) await loadNativePaths(paths)
    else pendingOpenGroupId = undefined
  } catch (error) {
    pendingOpenGroupId = undefined
    showToast(error instanceof Error ? error.message : String(error), true)
  }
}

async function loadNativePaths(paths: readonly string[]): Promise<void> {
  const selected = await Promise.all(paths.map(describeNativeFile))
  const destinationGroupId = pendingOpenGroupId
  pendingOpenGroupId = undefined
  for (const file of selected) {
    if (/\.(bai|csi)$/i.test(file.name)) continue
    try {
      const { source, sourceSpec, kind } = await sourceFromNativeFile(file, selected)
      const trackId = crypto.randomUUID()
      runtimeSources.set(sourceSpec.id, source)
      store.edit((draft) => {
        const added = kind === 'interval' ? addIntervalTrack(draft, sourceSpec, { id: trackId })
          : kind === 'interaction' ? addInteractionTrack(draft, sourceSpec, { id: trackId })
            : kind === 'alignment' ? addAlignmentTrack(draft, sourceSpec, { id: trackId })
            : addSignalTrack(draft, sourceSpec, { id: trackId, displayGroupId: destinationGroupId, autoPair: savedStrandedAutoLink(), autoStrandColors: savedStrandedAutoColors() })
        if (destinationGroupId) addTracksToGroup(draft, destinationGroupId, [added.id])
      })
      await browser.attachSource(sourceSpec.id, source)
      showToast(`Opened ${file.name}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true)
    }
  }
}

async function sourceFromNativeFile(file: LocalFileDescriptor, selected: readonly LocalFileDescriptor[]): Promise<OpenedSource> {
  const name = file.name.toLowerCase()
  const handle = new NativeFileHandle(file.path)
  if (name.endsWith('.bw') || name.endsWith('.bigwig')) return {
    source: await BigWigSource.fromFilehandle(file.name, handle),
    sourceSpec: makeSourceSpec(file, 'bigwig'),
    kind: 'signal',
  }
  if (name.endsWith('.bedgraph') || name.endsWith('.bedgraph.gz')) return {
    source: await sourceFromNativeBedGraph(file, handle),
    sourceSpec: makeSourceSpec(file, 'bedgraph'),
    kind: 'signal',
  }
  if (name.endsWith('.tdf')) return {
    source: await TdfSource.fromFilehandle(file.name, handle, activeChromosomes),
    sourceSpec: makeSourceSpec(file, 'tdf'),
    kind: 'signal',
  }
  if (name.endsWith('.bed')) return {
    source: await BedSource.fromFile(nativeTextInput(file, handle)),
    sourceSpec: makeSourceSpec(file, 'bed'),
    kind: 'interval',
  }
  if (name.endsWith('.bedpe')) return {
    source: await BedPeSource.fromFile(nativeTextInput(file, handle)),
    sourceSpec: makeSourceSpec(file, 'bedpe'),
    kind: 'interaction',
  }
  if (name.endsWith('.bam')) {
    const index = findNativeBamIndex(file, selected) ?? await findAdjacentNativeBamIndex(file)
    if (!index) throw new Error(`${file.name}: no adjacent .bai/.csi was found; select the BAM and its index together.`)
    return {
      source: await BamAlignmentSource.fromFilehandles(file.name, handle, index.name, new NativeFileHandle(index.path)),
      sourceSpec: makeSourceSpec(file, 'bam', index),
      kind: 'alignment',
    }
  }
  throw new Error(`${file.name}: supported data files are .bw/.bigWig, .bedGraph/.bedGraph.gz, .tdf, indexed .bam, .bed, and .bedpe.`)
}

async function sourceFromNativeBedGraph(file: LocalFileDescriptor, handle: NativeFileHandle): Promise<TrackSource> {
  const compressed = file.name.toLowerCase().endsWith('.gz')
  if (!compressed && file.size <= MAX_BEDGRAPH_BYTES) return BedGraphSource.fromFile(nativeTextInput(file, handle))
  showToast(`Building or checking the indexed cache for ${file.name}…`, false, 0)
  const cache = await prepareBedGraphCache(file.path, activeChromosomes)
  if (!cache.reused) showToast(`Indexed ${file.name}; opening the cached signal…`)
  return BigWigSource.fromFilehandle(file.name, new NativeFileHandle(cache.path))
}

function nativeTextInput(file: LocalFileDescriptor, handle: NativeFileHandle): { name: string; size: number; text(): Promise<string> } {
  return {
    name: file.name,
    size: file.size,
    async text() { return new TextDecoder().decode(await handle.readFile()) },
  }
}

function gzipTextInput(file: File | LocalFileDescriptor, read: () => Promise<ArrayBuffer | Uint8Array>): { name: string; size: number; text(): Promise<string> } {
  return { name: file.name, size: file.size, text: () => gzipText(read) }
}

function findNativeBamIndex(bam: LocalFileDescriptor, files: readonly LocalFileDescriptor[]): LocalFileDescriptor | undefined {
  const lower = bam.name.toLowerCase()
  const base = lower.endsWith('.bam') ? lower.slice(0, -4) : lower
  const accepted = new Set([`${lower}.bai`, `${base}.bai`, `${lower}.csi`, `${base}.csi`])
  return files.find((file) => accepted.has(file.name.toLowerCase()))
}

async function findAdjacentNativeBamIndex(bam: LocalFileDescriptor): Promise<LocalFileDescriptor | undefined> {
  const basePath = bam.path.toLowerCase().endsWith('.bam') ? bam.path.slice(0, -4) : bam.path
  const candidates = [`${bam.path}.bai`, `${basePath}.bai`, `${bam.path}.csi`, `${basePath}.csi`]
  for (const path of candidates) {
    try { return await describeNativeFile(path) } catch { /* try the next conventional index path */ }
  }
  return undefined
}

async function restorePersistedSources(): Promise<void> {
  let restored = 0
  const usedSourceIds = new Set(store.current.tracks.flatMap((track) => track.sourceIds))
  for (const sourceSpec of store.current.sources) {
    if (!usedSourceIds.has(sourceSpec.id)) continue
    if (!sourceSpec?.files.length || sourceSpec.files.some((file) => !file.path)) continue
    try {
      const descriptors = await Promise.all(sourceSpec.files.map(async (saved) => {
        const current = await describeNativeFile(saved.path!)
        if (current.size !== saved.size) throw new Error(`${saved.name} has changed size since it was opened.`)
        return current
      }))
      const primary = descriptors.find((_, index) => sourceSpec.files[index].role === 'signal')!
      const source = (await sourceFromNativeFile(primary, descriptors)).source
      runtimeSources.set(sourceSpec.id, source)
      restored += 1
    } catch (error) {
      console.warn(`Could not restore ${sourceSpec.name}`, error)
    }
  }
  if (!restored) return
  browser.syncDocument(store.current, runtimeSources)
  await Promise.all([...runtimeSources].map(([sourceId, source]) => browser.attachSource(sourceId, source)))
  showToast(`Reopened ${restored} saved track${restored === 1 ? '' : 's'}`)
}

function populateChromosomes(chromosomes: ReadonlyMap<string, number>): void {
  const current = browser.getRegion().chr
  chromosomeSelect.replaceChildren(...[...chromosomes.keys()].map((chr) => {
    const option = document.createElement('option')
    option.value = chr
    option.textContent = chr
    option.selected = chr === current
    return option
  }))
}

function populateReferences(): void {
  referenceLabel.textContent = activeReference.name
  referencePopup.replaceChildren(...[...references.values()].map((reference) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'reference-option'
    option.dataset.referenceId = reference.id
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(reference.id === activeReference.id))
    option.textContent = reference.name
    return option
  }))
}

function setReferenceMenu(open: boolean): void {
  referencePopup.hidden = !open
  referenceButton.setAttribute('aria-expanded', String(open))
  referencePicker.classList.toggle('is-open', open)
  if (open) referencePopup.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
}

function toggleMenu(menu: HTMLElement): void {
  const willOpen = menu.querySelector<HTMLElement>('.menu-popover')!.hasAttribute('hidden')
  closeMenus()
  if (!willOpen) return
  menu.classList.add('is-open')
  menu.querySelector<HTMLElement>('.menu-popover')!.hidden = false
  menu.querySelector<HTMLButtonElement>('.menu-trigger')!.setAttribute('aria-expanded', 'true')
}

function closeMenus(): void {
  for (const menu of document.querySelectorAll<HTMLElement>('.app-menu')) {
    menu.classList.remove('is-open')
    menu.querySelector<HTMLElement>('.menu-popover')!.hidden = true
    menu.querySelector<HTMLButtonElement>('.menu-trigger')!.setAttribute('aria-expanded', 'false')
  }
}

async function switchReference(id: string): Promise<void> {
  const reference = references.get(id)
  if (!reference) return
  activeReference = reference
  activeChromosomes = reference.chromosomes
  localStorage.setItem(REFERENCE_KEY, reference.id)
  populateReferences()
  browser.setChromosomes(activeChromosomes)
  populateChromosomes(activeChromosomes)

  const current = browser.getRegion()
  const chr = resolveChromosome(current.chr, activeChromosomes)
  if (chr) {
    const length = activeChromosomes.get(chr)!
    const span = Math.min(current.end - current.start, length)
    const start = Math.max(0, Math.min(current.start, length - span))
    browser.setRegion({ chr, start, end: start + span })
  } else browser.setRegion(defaultRegion(reference))
  await activateGeneTrack(reference)
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(store.current))
  showToast(`${reference.name} is now the default reference.`)
}

function selectTrack(trackId: string, additive: boolean, extend: boolean): void {
  const ordered = store.current.tracks.filter((track) => track.enabled).map((track) => track.id)
  if (extend && lastSelectedTrackId && ordered.includes(lastSelectedTrackId)) {
    if (!additive) selectedTrackIds.clear()
    const from = ordered.indexOf(lastSelectedTrackId)
    const to = ordered.indexOf(trackId)
    for (const id of ordered.slice(Math.min(from, to), Math.max(from, to) + 1)) selectedTrackIds.add(id)
  } else if (additive) {
    if (selectedTrackIds.has(trackId)) selectedTrackIds.delete(trackId)
    else selectedTrackIds.add(trackId)
  } else {
    selectedTrackIds.clear()
    selectedTrackIds.add(trackId)
  }
  lastSelectedTrackId = trackId
  browser.setSelectedTracks(selectedTrackIds)
}

function selectGroup(groupId: string, additive: boolean): void {
  const memberIds = store.current.tracks.filter((track) => track.enabled && track.displayGroupId === groupId).map((track) => track.id)
  if (!memberIds.length) return
  const allSelected = memberIds.every((id) => selectedTrackIds.has(id))
  if (!additive) selectedTrackIds.clear()
  for (const id of memberIds) {
    if (additive && allSelected) selectedTrackIds.delete(id)
    else selectedTrackIds.add(id)
  }
  lastSelectedTrackId = memberIds.at(-1)
  browser.setSelectedTracks(selectedTrackIds)
}

function clearTrackSelection(): void {
  if (!selectedTrackIds.size) return
  selectedTrackIds.clear()
  lastSelectedTrackId = undefined
  browser.setSelectedTracks(selectedTrackIds)
}

function openTrackContextMenu(trackId: string, x: number, y: number): void {
  const selected = store.current.tracks.filter((track) => selectedTrackIds.has(track.id))
  const target = store.current.tracks.find((track) => track.id === trackId)
  if (!target || !selected.length) return
  const signals = selected.filter((track) => track.kind === 'signal' || track.kind === 'stranded')
  const ordinarySignals = selected.filter((track) => track.kind === 'signal' && !track.signalStrand)
  const dataTracks = selected.filter((track) => track.kind !== 'genes')
  const one = selected.length === 1
  const pairable = selected.length === 2 && selected.every((track) => track.kind === 'signal') && canPairSelectedStrands(selected as TrackSpec[])
  const action = (id: string, label: string, detail = '', disabled = false, danger = false) =>
    `<button class="context-item${danger ? ' danger' : ''}" data-context-action="${id}" type="button" role="menuitem" ${disabled ? 'disabled' : ''}><span>${label}</span>${detail ? `<small>${detail}</small>` : ''}</button>`
  trackContextMenu.innerHTML = `
    <div class="context-heading"><strong>${one ? escapeHtml(target.label) : `${selected.length} tracks selected`}</strong><span>${one ? (target.kind === 'genes' ? 'Gene annotation' : target.kind === 'interval' ? 'Interval track' : target.kind === 'interaction' ? 'BEDPE interactions' : target.kind === 'alignment' ? 'BAM alignments' : target.kind === 'stranded' ? 'Linked stranded signal' : target.signalStrand ? `${target.signalStrand === 'plus' ? 'Positive' : 'Negative'}-strand signal` : 'Signal track') : 'Shared actions'}</span></div>
    ${one ? action('rename', 'Rename…') : ''}
    ${one && target.kind === 'stranded' ? action('color-plus', 'Set positive-strand color…') + action('color-minus', 'Set negative-strand color…') : action('color', one ? 'Set color…' : 'Set selected colors…')}
    ${action('height', one ? 'Set track height…' : 'Set selected heights…')}
    ${action('group', selected.length > 1 ? 'Group selected…' : 'Set visual group…')}
    ${selected.some((track) => track.displayGroupId) ? action('remove-from-group', selected.length > 1 ? 'Remove selected tracks from groups' : 'Remove from group') : ''}
    <span class="context-separator"></span>
    ${signals.length ? action('scale-auto', 'Scale automatically', 'visible window') : ''}
    ${ordinarySignals.length ? action('prevent-negative', 'Prevent negative values', ordinarySignals.every((track) => track.allowNegativeValues === false) ? 'current' : '') : ''}
    ${signals.length ? action('scale-fixed', 'Set fixed scale…') : ''}
    ${signals.length >= 2 ? action('link-scales', 'Link selected scales') : ''}
    ${signals.length ? action('unlink-scales', 'Unlink selected scales') : ''}
    ${pairable ? '<span class="context-separator"></span>' + action('strand-link', 'Link as stranded track') : ''}
    ${one && target.kind === 'stranded' ? '<span class="context-separator"></span>' + action('strand-unlink', 'Unlink stranded sources') : ''}
    ${one && (target.kind === 'signal' || target.kind === 'stranded') ? '<span class="context-separator"></span>' : ''}
    ${one && (target.kind === 'signal' || target.kind === 'stranded') ? action('duplicate', 'Duplicate track') : ''}
    ${one && target.kind === 'signal' ? action('relink', runtimeSources.has(target.sourceIds[0]) ? 'Replace source file…' : 'Relink source file…') : ''}
    ${one && target.kind === 'stranded' ? action('relink-plus', runtimeSources.has(target.sourceIds[0]) ? 'Replace positive source…' : 'Relink positive source…') : ''}
    ${one && target.kind === 'stranded' ? action('relink-minus', runtimeSources.has(target.sourceIds[1]) ? 'Replace negative source…' : 'Relink negative source…') : ''}
    ${one && target.kind === 'interval' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'interval' ? action('interval-collapsed', 'Collapsed interval view', target.intervalDisplayMode === 'collapsed' || !target.intervalDisplayMode ? 'current' : '') : ''}
    ${one && target.kind === 'interval' ? action('interval-expanded', 'Expanded interval view', target.intervalDisplayMode === 'expanded' ? 'current' : '') : ''}
    ${one && target.kind === 'interval' ? action('interval-squished', 'Squished interval view', target.intervalDisplayMode === 'squished' ? 'current' : '') : ''}
    ${one && target.kind === 'interval' ? action('duplicate', 'Duplicate track') : ''}
    ${one && target.kind === 'interval' ? action('relink', runtimeSources.has(target.sourceIds[0]) ? 'Replace source file…' : 'Relink source file…') : ''}
    ${one && target.kind === 'interaction' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'interaction' ? action('duplicate', 'Duplicate track') : ''}
    ${one && target.kind === 'interaction' ? action('relink', runtimeSources.has(target.sourceIds[0]) ? 'Replace source file…' : 'Relink source file…') : ''}
    ${one && target.kind === 'alignment' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'alignment' ? action('bam-view-both', 'Coverage and alignments', target.bamViewMode === 'both' || !target.bamViewMode ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-view-coverage', 'Coverage only', target.bamViewMode === 'coverage' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-view-alignments', 'Alignments only', target.bamViewMode === 'alignments' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'alignment' ? action('bam-display-expanded', 'Expanded reads', target.alignmentDisplayMode === 'expanded' || !target.alignmentDisplayMode ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-display-collapsed', 'Collapsed reads', target.alignmentDisplayMode === 'collapsed' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-display-squished', 'Squished reads', target.alignmentDisplayMode === 'squished' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-pairs', 'View as pairs', target.bamViewAsPairs ? 'on' : 'off') : ''}
    ${one && target.kind === 'alignment' ? action('bam-mismatches', 'Show mismatches', target.bamShowMismatches === false ? 'off' : 'on') : ''}
    ${one && target.kind === 'alignment' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'alignment' ? action('bam-color-track', 'Color by track', target.bamColorMode === 'track' || !target.bamColorMode ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-color-strand', 'Color by strand', target.bamColorMode === 'strand' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-color-pair-orientation', 'Color by pair orientation', target.bamColorMode === 'pair-orientation' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? action('bam-color-mapping-quality', 'Color by mapping quality', target.bamColorMode === 'mapping-quality' ? 'current' : '') : ''}
    ${one && target.kind === 'alignment' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'alignment' ? action('bam-mapq', 'Minimum mapping quality…', String(target.bamMinMapq ?? 0)) : ''}
    ${one && target.kind === 'alignment' ? action('bam-duplicates', 'Include duplicate reads', target.bamIncludeDuplicates ? 'on' : 'off') : ''}
    ${one && target.kind === 'alignment' ? action('bam-secondary', 'Include secondary alignments', target.bamIncludeSecondary ? 'on' : 'off') : ''}
    ${one && target.kind === 'alignment' ? action('bam-supplementary', 'Include supplementary alignments', target.bamIncludeSupplementary ? 'on' : 'off') : ''}
    ${one && target.kind === 'alignment' ? action('duplicate', 'Duplicate track') : ''}
    ${one && target.kind === 'alignment' ? action('relink', runtimeSources.has(target.sourceIds[0]) ? 'Replace BAM and index…' : 'Relink BAM and index…') : ''}
    ${one && target.kind === 'genes' ? '<span class="context-separator"></span>' : ''}
    ${one && target.kind === 'genes' ? action('genes-collapsed', 'Collapsed gene view', target.geneDisplayMode === 'collapsed' || !target.geneDisplayMode ? 'current' : '') : ''}
    ${one && target.kind === 'genes' ? action('genes-expanded', 'Expanded transcript view', target.geneDisplayMode === 'expanded' ? 'current' : '') : ''}
    ${one && target.kind === 'genes' ? action('genes-squished', 'Squished transcript view', target.geneDisplayMode === 'squished' ? 'current' : '') : ''}
    ${dataTracks.length ? '<span class="context-separator"></span>' + action('remove', dataTracks.length > 1 ? `Remove ${dataTracks.length} selected tracks` : 'Remove track', '', false, true) : ''}
  `
  trackContextMenu.dataset.trackId = trackId
  delete trackContextMenu.dataset.groupId
  positionContextMenu(x, y)
}

function canPairSelectedStrands(tracks: readonly TrackSpec[]): boolean {
  if (tracks.length !== 2 || tracks.some((track) => track.kind !== 'signal')) return false
  const roles = tracks.map((track) => track.signalStrand ?? inferSignalStrand(track.label)?.strand)
  const bases = tracks.map((track) => (track.strandBaseLabel ?? inferSignalStrand(track.label)?.baseLabel ?? '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ''))
  return Boolean(roles[0] && roles[1] && roles[0] !== roles[1] && bases[0] && bases[0] === bases[1])
}

function openGroupContextMenu(groupId: string, x: number, y: number): void {
  const group = store.current.groups.find((item) => item.id === groupId)
  if (!group) return
  const members = store.current.tracks.filter((track) => track.displayGroupId === groupId)
  const signalIds = members.filter((track) => track.kind === 'signal' || track.kind === 'stranded').map((track) => track.id)
  const hasOrdinaryColor = members.some((track) => track.kind !== 'stranded' && !(track.kind === 'signal' && track.signalStrand))
  const hasPlusColor = members.some((track) => track.kind === 'stranded' || (track.kind === 'signal' && track.signalStrand === 'plus'))
  const hasMinusColor = members.some((track) => track.kind === 'stranded' || (track.kind === 'signal' && track.signalStrand === 'minus'))
  const memberIds = new Set(members.map((track) => track.id))
  const selectedOutside = store.current.tracks.filter((track) => track.kind !== 'genes' && selectedTrackIds.has(track.id) && !memberIds.has(track.id))
  const action = (id: string, label: string, detail = '', disabled = false, danger = false) =>
    `<button class="context-item${danger ? ' danger' : ''}" data-context-action="${id}" type="button" role="menuitem" ${disabled ? 'disabled' : ''}><span>${label}</span>${detail ? `<small>${detail}</small>` : ''}</button>`
  trackContextMenu.innerHTML = `
    <div class="context-heading"><strong>${escapeHtml(group.label)}</strong><span>${members.length} track${members.length === 1 ? '' : 's'} · group options</span></div>
    ${action('group-select', 'Select tracks in group')}
    ${action('group-open', 'Open tracks into group…')}
    ${action('group-add-selected', 'Add selected tracks', selectedOutside.length ? `${selectedOutside.length} selected` : '', selectedOutside.length === 0)}
    <span class="context-separator"></span>
    ${hasOrdinaryColor ? action('group-color-ordinary', 'Set unstranded track color…') : ''}
    ${hasPlusColor ? action('group-color-plus', 'Set positive-strand color…') : ''}
    ${hasMinusColor ? action('group-color-minus', 'Set negative-strand color…') : ''}
    ${action('group-height', 'Set group track height…')}
    ${signalIds.length ? action('group-auto-linked', 'Autoscale group together', group.scaleBehavior === 'linked' ? 'current' : '') : ''}
    ${signalIds.length ? action('group-auto-independent', 'Use independent autoscaling', group.scaleBehavior === 'independent' ? 'current' : '') : ''}
    ${signalIds.length ? action('group-fixed', 'Set fixed group scale…') : ''}
    <span class="context-separator"></span>
    ${action('group-rename', 'Rename group…')}
    ${action('group-remove', 'Ungroup tracks')}
    ${action('group-remove-tracks', 'Remove all group tracks', `${members.length} track${members.length === 1 ? '' : 's'}`, false, true)}
  `
  trackContextMenu.dataset.groupId = groupId
  delete trackContextMenu.dataset.trackId
  positionContextMenu(x, y)
}

function positionContextMenu(x: number, y: number): void {
  trackContextMenu.hidden = false
  const menuWidth = trackContextMenu.offsetWidth
  const menuHeight = trackContextMenu.offsetHeight
  trackContextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8))}px`
  trackContextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))}px`
}

function closeTrackContextMenu(): void {
  trackContextMenu.hidden = true
}

function handleTrackContextAction(event: MouseEvent): void {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-context-action]')
  const groupId = trackContextMenu.dataset.groupId
  const targetId = trackContextMenu.dataset.trackId
  if (!button) return
  const command = button.dataset.contextAction
  if (groupId) {
    closeTrackContextMenu()
    handleGroupContextAction(command, groupId)
    return
  }
  if (!targetId) return
  const ids = [...selectedTrackIds]
  const signalIds = store.current.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && ids.includes(track.id)).map((track) => track.id)
  const dataIds = store.current.tracks.filter((track) => track.kind !== 'genes' && ids.includes(track.id)).map((track) => track.id)
  closeTrackContextMenu()
  if (command === 'rename') {
    const track = store.current.tracks.find((item) => item.id === targetId)
    const label = window.prompt('Track name:', track?.label ?? '')?.trim()
    if (label) store.edit((draft) => { const item = draft.tracks.find((track) => track.id === targetId); if (item) item.label = label })
  }
  if (command === 'color' || command === 'color-plus' || command === 'color-minus') {
    pendingColorGroupId = undefined
    pendingColorChannel = command === 'color-plus' ? 'plus' : command === 'color-minus' ? 'minus' : undefined
    const colorTrack = store.current.tracks.find((track) => track.id === targetId)
    const initial = command === 'color-minus' ? colorTrack?.negativeColor : colorTrack?.color
    openColorDialog(command === 'color-plus' ? 'Set positive-strand color' : command === 'color-minus' ? 'Set negative-strand color' : 'Set track color', initial ?? '#6d55e0')
  }
  if (command === 'height') setTrackHeights(ids)
  if (command === 'group') {
    const first = store.current.tracks.find((track) => ids.includes(track.id))
    const current = store.current.groups.find((group) => group.id === first?.displayGroupId)?.label ?? ''
    const label = window.prompt('Visual group name (leave blank to remove grouping):', current)
    if (label !== null) store.edit((draft) => assignDisplayGroup(draft, ids, label, { autoScale: savedGroupAutoscale() }))
  }
  if (command === 'remove-from-group') store.edit((draft) => {
    const groupedIds = draft.tracks.filter((track) => ids.includes(track.id) && track.displayGroupId).map((track) => track.id)
    assignDisplayGroup(draft, groupedIds, '')
  })
  if (command === 'scale-auto') store.edit((draft) => {
    const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
    for (const scale of draft.scales) if (scaleIds.has(scale.id)) scale.mode = 'auto-visible'
  })
  if (command === 'prevent-negative') store.edit((draft) => {
    const targets = draft.tracks.filter((track) => ids.includes(track.id) && track.kind === 'signal' && !track.signalStrand)
    const preventing = targets.length > 0 && targets.every((track) => track.allowNegativeValues === false)
    for (const track of targets) track.allowNegativeValues = preventing
  })
  if (command === 'scale-fixed') {
    const suggested = visibleLimits(targetId)
    const entered = window.prompt('Fixed y-axis range as min,max:', `${suggested.min},${suggested.max}`)
    const [min, max] = entered?.split(',').map((value) => Number(value.trim())) ?? []
    if (Number.isFinite(min) && Number.isFinite(max) && min !== max) store.edit((draft) => {
      const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
      for (const scale of draft.scales) if (scaleIds.has(scale.id)) {
        scale.mode = 'fixed'
        scale.limits = { min: Math.min(min, max), max: Math.max(min, max) }
      }
    })
  }
  if (command === 'link-scales') store.edit((draft) => linkScales(draft, signalIds))
  if (command === 'unlink-scales') store.edit((draft) => unlinkScales(draft, signalIds))
  if (command === 'strand-link') {
    let pairedId: string | undefined
    store.edit((draft) => { pairedId = pairStrandedTracks(draft, ids[0], ids[1], { autoColors: savedStrandedAutoColors() })?.id })
    if (pairedId) {
      selectedTrackIds.clear(); selectedTrackIds.add(pairedId); lastSelectedTrackId = pairedId
      browser.setSelectedTracks(selectedTrackIds)
    }
  }
  if (command === 'strand-unlink') {
    let unlinkedIds: string[] = []
    store.edit((draft) => { unlinkedIds = unlinkStrandedTrack(draft, targetId).map((track) => track.id) })
    selectedTrackIds.clear(); for (const id of unlinkedIds) selectedTrackIds.add(id)
    lastSelectedTrackId = unlinkedIds.at(-1)
    browser.setSelectedTracks(selectedTrackIds)
  }
  if (command?.startsWith('genes-')) {
    const mode = command.slice(6) as 'collapsed' | 'expanded' | 'squished'
    store.edit((draft) => { const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'genes'); if (track) track.geneDisplayMode = mode })
  }
  if (command?.startsWith('interval-')) {
    const mode = command.slice(9) as 'collapsed' | 'expanded' | 'squished'
    store.edit((draft) => { const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'interval'); if (track) track.intervalDisplayMode = mode })
  }
  if (command?.startsWith('bam-view-')) {
    const mode = command.slice(9) as 'coverage' | 'alignments' | 'both'
    store.edit((draft) => { const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'alignment'); if (track) track.bamViewMode = mode })
  }
  if (command?.startsWith('bam-display-')) {
    const mode = command.slice(12) as 'collapsed' | 'expanded' | 'squished'
    store.edit((draft) => { const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'alignment'); if (track) track.alignmentDisplayMode = mode })
  }
  if (command?.startsWith('bam-color-')) {
    const mode = command.slice(10) as 'track' | 'strand' | 'pair-orientation' | 'mapping-quality'
    store.edit((draft) => { const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'alignment'); if (track) track.bamColorMode = mode })
  }
  if (command === 'bam-pairs') store.edit((draft) => {
    const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'alignment')
    if (track) track.bamViewAsPairs = !track.bamViewAsPairs
  })
  if (command === 'bam-mismatches') store.edit((draft) => {
    const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'alignment')
    if (track) track.bamShowMismatches = track.bamShowMismatches === false
  })
  if (command === 'bam-mapq') {
    const track = store.current.tracks.find((item) => item.id === targetId && item.kind === 'alignment')
    const entered = window.prompt('Minimum mapping quality (0–255):', String(track?.bamMinMapq ?? 0))
    const minimum = Number(entered)
    if (entered !== null && Number.isFinite(minimum) && minimum >= 0 && minimum <= 255) store.edit((draft) => {
      const item = draft.tracks.find((candidate) => candidate.id === targetId && candidate.kind === 'alignment')
      if (item) item.bamMinMapq = Math.round(minimum)
    })
  }
  if (command === 'bam-duplicates' || command === 'bam-secondary' || command === 'bam-supplementary') store.edit((draft) => {
    const track = draft.tracks.find((item) => item.id === targetId && item.kind === 'alignment')
    if (!track) return
    if (command === 'bam-duplicates') track.bamIncludeDuplicates = !track.bamIncludeDuplicates
    if (command === 'bam-secondary') track.bamIncludeSecondary = !track.bamIncludeSecondary
    if (command === 'bam-supplementary') track.bamIncludeSupplementary = !track.bamIncludeSupplementary
  })
  if (command === 'duplicate') {
    let copyId: string | undefined
    store.edit((draft) => { copyId = duplicateTrack(draft, targetId)?.id })
    if (copyId) {
      browser.syncDocument(store.current, runtimeSources)
      const copy = store.current.tracks.find((track) => track.id === copyId)
      for (const sourceId of copy?.sourceIds ?? []) {
        const source = runtimeSources.get(sourceId)
        if (source) void browser.attachSource(sourceId, source)
      }
    }
  }
  if (command === 'relink' || command === 'relink-plus' || command === 'relink-minus') {
    pendingRelinkTrackId = targetId
    pendingRelinkChannel = command === 'relink-plus' ? 'plus' : command === 'relink-minus' ? 'minus' : undefined
    if (isDesktopApp()) void relinkTrackNative(targetId)
    else relinkFileInput.click()
  }
  if (command === 'remove') {
    for (const id of dataIds) selectedTrackIds.delete(id)
    store.edit((draft) => { for (const id of dataIds) removeTrack(draft, id) })
  }
}

function handleGroupContextAction(command: string | undefined, groupId: string): void {
  const group = store.current.groups.find((item) => item.id === groupId)
  if (!group) return
  const memberIds = store.current.tracks.filter((track) => track.displayGroupId === groupId).map((track) => track.id)
  const signalIds = store.current.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && track.displayGroupId === groupId).map((track) => track.id)
  if (command === 'group-select') {
    selectedTrackIds.clear()
    for (const id of memberIds) selectedTrackIds.add(id)
    lastSelectedTrackId = memberIds.at(-1)
    browser.setSelectedTracks(selectedTrackIds)
  }
  if (command === 'group-open') {
    pendingOpenGroupId = groupId
    void openTrackPicker()
  }
  if (command === 'group-add-selected') {
    const addIds = store.current.tracks.filter((track) => track.kind !== 'genes' && selectedTrackIds.has(track.id) && track.displayGroupId !== groupId).map((track) => track.id)
    store.edit((draft) => addTracksToGroup(draft, groupId, addIds))
  }
  if (command?.startsWith('group-color-')) {
    const channel = command.slice('group-color-'.length) as SignalScaleChannel
    pendingColorGroupId = groupId
    pendingColorChannel = channel
    const initial = channel === 'plus' ? group.positiveColor : channel === 'minus' ? group.negativeColor : group.color
    openColorDialog(`Set ${channel === 'ordinary' ? 'unstranded track' : `${channel}-strand`} group color`, initial ?? '#6d55e0')
  }
  if (command === 'group-height') setTrackHeights(memberIds)
  if (command === 'group-auto-linked') store.edit((draft) => {
    const draftGroup = draft.groups.find((item) => item.id === groupId)
    if (draftGroup) draftGroup.scaleBehavior = 'linked'
    linkScales(draft, signalIds)
    const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
    for (const scale of draft.scales) if (scaleIds.has(scale.id)) scale.mode = 'auto-visible'
  })
  if (command === 'group-auto-independent') store.edit((draft) => {
    const draftGroup = draft.groups.find((item) => item.id === groupId)
    if (draftGroup) draftGroup.scaleBehavior = 'independent'
    unlinkScales(draft, signalIds)
    const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
    for (const scale of draft.scales) if (scaleIds.has(scale.id)) scale.mode = 'auto-visible'
  })
  if (command === 'group-fixed') {
    const suggested = groupVisibleLimits(signalIds)
    const entered = window.prompt('Fixed group y-axis range as min,max:', `${suggested.min},${suggested.max}`)
    const [min, max] = entered?.split(',').map((value) => Number(value.trim())) ?? []
    if (Number.isFinite(min) && Number.isFinite(max) && min !== max) store.edit((draft) => {
      const draftGroup = draft.groups.find((item) => item.id === groupId)
      if (draftGroup) draftGroup.scaleBehavior = 'linked'
      linkScales(draft, signalIds)
      const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
      for (const scale of draft.scales) if (scaleIds.has(scale.id)) { scale.mode = 'fixed'; scale.limits = { min: Math.min(min, max), max: Math.max(min, max) } }
    })
  }
  if (command === 'group-rename') {
    const label = window.prompt('Group name:', group.label)?.trim()
    if (label) store.edit((draft) => { const item = draft.groups.find((group) => group.id === groupId); if (item) item.label = label })
  }
  if (command === 'group-remove') store.edit((draft) => assignDisplayGroup(draft, memberIds, ''))
  if (command === 'group-remove-tracks') {
    for (const id of memberIds) selectedTrackIds.delete(id)
    store.edit((draft) => { for (const id of memberIds) removeTrack(draft, id) })
  }
}

function addTracksToGroup(draft: TrackDocument, groupId: string, trackIds: readonly string[]): void {
  const group = draft.groups.find((item) => item.id === groupId)
  if (!group || !trackIds.length) return
  assignDisplayGroup(draft, trackIds, group.label, { autoScale: savedGroupAutoscale() })
}

function setTrackHeights(trackIds: readonly string[]): void {
  const current = store.current.tracks.find((track) => trackIds.includes(track.id))?.height ?? 1
  const entered = window.prompt('Track height (1–100):', String(Math.round(current)))
  const height = Number(entered)
  if (!Number.isFinite(height) || height < 1 || height > 100) return
  if (store.current.tracks.some((track) => trackIds.includes(track.id) && track.pane === 'bottom' && track.kind === 'genes')) bottomPaneAutoFit = true
  store.edit((draft) => {
    for (const track of draft.tracks) if (trackIds.includes(track.id)) track.height = Math.round(height)
  })
}

function fitUpperTracks(): void {
  const upperTracks = store.current.tracks.filter((track) => track.enabled && track.pane === 'main')
  if (!upperTracks.length) return showToast('There are no upper tracks to fit.')
  const visibleHeight = Math.max(40, mainTrackScroll.clientHeight - bottomPane.getBoundingClientRect().height - headerCanvas.getBoundingClientRect().height)
  // BED tracks deliberately keep their compact label-fitting height. Fit the
  // quantitative, alignment, and gene tracks into the remaining space.
  const fixedIntervals = upperTracks.filter((track) => track.kind === 'interval')
  const flexibleTracks = upperTracks.filter((track) => track.kind !== 'interval')
  const fixedHeight = fixedIntervals.reduce((sum, track) => sum + trackPixelHeight(track.kind, track.height), 0)
  const availableHeight = Math.max(0, visibleHeight - fixedHeight)
  const totalHeightUnits = flexibleTracks.reduce((sum, track) => sum + (track.kind === 'stranded' ? 2 : 1), 0)
  const pixelsPerUnit = totalHeightUnits ? availableHeight / totalHeightUnits : 0
  store.edit((draft) => {
    for (const track of draft.tracks) if (track.enabled && track.pane === 'main' && track.kind !== 'interval') {
      const units = track.kind === 'stranded' ? 2 : 1
      track.height = heightScoreForPixels(track.kind, pixelsPerUnit * units)
    }
    const fitted = draft.tracks.filter((track) => track.enabled && track.pane === 'main' && track.kind !== 'interval')
    while (fixedHeight + fitted.reduce((sum, track) => sum + trackPixelHeight(track.kind, track.height), 0) > visibleHeight) {
      const largest = fitted.filter((track) => track.height > 1).sort((a, b) => trackPixelHeight(b.kind, b.height) - trackPixelHeight(a.kind, a.height))[0]
      if (!largest) break
      largest.height -= 1
    }
  })
  mainTrackScroll.scrollTop = 0
  requestAnimationFrame(() => { mainTrackScroll.scrollTop = 0 })
  showToast(`Fit ${upperTracks.length} upper track${upperTracks.length === 1 ? '' : 's'} to the visible pane.`)
}

function openColorDialog(title: string, initialColor: string): void {
  colorDialog.querySelector('#color-dialog-title')!.textContent = title
  setColorPickerHex(initialColor)
  colorDialog.hidden = false
  window.setTimeout(() => trackColorInput.focus(), 0)
}

function setTrackChannelColor(track: TrackSpec, channel: SignalScaleChannel | undefined, color: string): void {
  if (channel === 'plus') {
    if (track.kind === 'stranded' || (track.kind === 'signal' && track.signalStrand === 'plus')) track.color = color
    return
  }
  if (channel === 'minus') {
    if (track.kind === 'stranded') track.negativeColor = color
    else if (track.kind === 'signal' && track.signalStrand === 'minus') track.color = color
    return
  }
  if (channel === 'ordinary') {
    if (track.kind !== 'stranded' && !(track.kind === 'signal' && track.signalStrand)) track.color = color
    return
  }
  track.color = color
}

function closeColorDialog(): void {
  colorDialog.hidden = true
  pendingColorGroupId = undefined
  pendingColorChannel = undefined
}

function openUpdateDialog(): void {
  updateDialog.hidden = false
  if (appUpdater) renderAppUpdateState(appUpdater.state)
  else renderAppUpdateState({ phase: 'idle', currentVersion: __GERAFE_VERSION__, downloadedBytes: 0 })
  window.setTimeout(() => updatePrimaryAction.focus(), 0)
}

function closeUpdateDialog(): void {
  const phase = appUpdater?.state.phase
  if (phase === 'downloading' || phase === 'restarting') return
  updateDialog.hidden = true
}

async function ensureAppUpdater(): Promise<AppUpdateController> {
  if (appUpdater) return appUpdater
  if (!isDesktopApp()) throw new Error('Updates are available only in the desktop application.')
  appUpdaterPromise ??= createTauriUpdateBackend().then((backend) => {
    const controller = new AppUpdateController(backend, __GERAFE_VERSION__)
    controller.subscribe(renderAppUpdateState)
    appUpdater = controller
    return controller
  })
  return appUpdaterPromise
}

async function checkForAppUpdates(manual: boolean): Promise<void> {
  try {
    const controller = await ensureAppUpdater()
    await controller.check()
    if (manual || controller.state.phase === 'available') openUpdateDialog()
  } catch (error) {
    console.error('Could not initialize GeRAFE updates', error)
    if (!manual) return
    updateStatusHeading.textContent = 'Updates unavailable'
    updateStatusMessage.textContent = isDesktopApp()
      ? 'GeRAFE could not initialize the update service. Restart the app and try again.'
      : 'Update checks are available in the installed desktop application.'
    updateReleaseNotes.hidden = true
    updateProgress.hidden = true
    updatePrimaryAction.textContent = isDesktopApp() ? 'Try again' : 'Desktop app only'
    updatePrimaryAction.disabled = !isDesktopApp()
  }
}

async function handleUpdatePrimaryAction(): Promise<void> {
  if (!isDesktopApp()) return
  const controller = await ensureAppUpdater()
  if (controller.state.phase === 'available' || (controller.state.phase === 'error' && controller.state.candidate)) {
    await controller.install(persistWorkspaceNow)
    return
  }
  await checkForAppUpdates(true)
}

function renderAppUpdateState(state: Readonly<AppUpdateState>): void {
  const candidate = state.candidate
  const busy = state.phase === 'downloading' || state.phase === 'restarting'
  updateDialogClose.disabled = busy
  updateLater.disabled = busy
  updateLater.textContent = state.phase === 'available' ? 'Later' : 'Close'
  updatePrimaryAction.disabled = state.phase === 'checking' || busy || !isDesktopApp()
  updateReleaseNotes.hidden = !candidate || !candidate.body
  updateReleaseNotesText.textContent = candidate?.body?.trim() || ''
  updateProgress.hidden = state.phase !== 'downloading' && state.phase !== 'restarting'

  if (state.phase === 'checking') {
    updateStatusHeading.textContent = 'Checking for updates…'
    updateStatusMessage.textContent = `Installed version ${state.currentVersion}`
    updatePrimaryAction.textContent = 'Checking…'
    return
  }
  if (state.phase === 'current') {
    updateStatusHeading.textContent = 'GeRAFE is up to date'
    updateStatusMessage.textContent = `Version ${state.currentVersion} is the newest published beta.`
    updatePrimaryAction.textContent = 'Check again'
    return
  }
  if (state.phase === 'available' && candidate) {
    updateStatusHeading.textContent = `GeRAFE ${candidate.version} is available`
    updateStatusMessage.textContent = `Installed version ${state.currentVersion} → beta ${candidate.version}`
    updatePrimaryAction.textContent = 'Update and restart'
    return
  }
  if (state.phase === 'downloading') {
    const percent = updateProgressPercent(state)
    updateStatusHeading.textContent = `Downloading GeRAFE ${candidate?.version ?? ''}…`.trim()
    updateStatusMessage.textContent = 'Your workspace has been saved. GeRAFE will restart after the signed update is installed.'
    if (percent === undefined) updateProgressBar.removeAttribute('value')
    else updateProgressBar.value = percent
    updateProgressLabel.textContent = percent === undefined
      ? `${formatByteCount(state.downloadedBytes)} downloaded`
      : `${Math.round(percent)}% · ${formatByteCount(state.downloadedBytes)} of ${formatByteCount(state.totalBytes ?? 0)}`
    updatePrimaryAction.textContent = 'Installing…'
    return
  }
  if (state.phase === 'restarting') {
    updateStatusHeading.textContent = 'Update installed'
    updateStatusMessage.textContent = 'Restarting GeRAFE…'
    updateProgressBar.value = 100
    updateProgressLabel.textContent = '100%'
    updatePrimaryAction.textContent = 'Restarting…'
    return
  }
  if (state.phase === 'error') {
    updateStatusHeading.textContent = 'Update could not be completed'
    updateStatusMessage.textContent = state.error ?? 'Try the update again.'
    updatePrimaryAction.textContent = candidate ? 'Retry update' : 'Try again'
    return
  }

  updateStatusHeading.textContent = `GeRAFE ${state.currentVersion}`
  updateStatusMessage.textContent = isDesktopApp()
    ? 'Genomic Renderer and Figure Editor · prerelease beta'
    : 'Update checks are available in the installed desktop application.'
  updatePrimaryAction.textContent = isDesktopApp() ? 'Check for updates' : 'Desktop app only'
}

function persistWorkspaceNow(): void {
  window.clearTimeout(persistTimer)
  persistTimer = undefined
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(store.current))
}

function formatByteCount(bytes: number): string {
  if (bytes < 1_024) return `${Math.max(0, bytes)} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function visibleLimits(trackId: string): { min: number; max: number } {
  const features = browser.getRuntime(trackId)?.features ?? []
  let min = 0
  let max = 0
  for (const feature of features) if ('score' in feature && feature.score !== undefined) {
    min = Math.min(min, feature.score)
    max = Math.max(max, feature.score)
  }
  return min === max ? { min, max: min + 1 } : { min, max }
}

function groupVisibleLimits(trackIds: readonly string[]): { min: number; max: number } {
  let min = 0
  let max = 0
  for (const id of trackIds) {
    const limits = visibleLimits(id)
    min = Math.min(min, limits.min)
    max = Math.max(max, limits.max)
  }
  return min === max ? { min, max: min + 1 } : { min, max }
}

async function relinkTrack(files: FileList | null): Promise<void> {
  const id = pendingRelinkTrackId
  const channel = pendingRelinkChannel
  pendingRelinkTrackId = undefined
  pendingRelinkChannel = undefined
  if (!id || !files?.length) return
  try {
    const selected = [...files]
    const primary = selected.find((file) => !/\.(bai|csi)$/i.test(file.name))
    if (!primary) throw new Error('Select the data file, and its index too if it is a BAM.')
    const opened = await sourceFromFile(primary, selected)
    await applyRelink(id, opened, channel)
    showToast(`Relinked ${primary.name}`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true)
  } finally {
    relinkFileInput.value = ''
  }
}

async function relinkTrackNative(id: string): Promise<void> {
  const channel = pendingRelinkChannel
  pendingRelinkTrackId = undefined
  pendingRelinkChannel = undefined
  try {
    const picked = await openDialog({
      title: 'Relink track source',
      multiple: true,
      filters: [{ name: 'Genomics tracks', extensions: [...SUPPORTED_TRACK_DIALOG_EXTENSIONS] }],
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    if (!paths.length) return
    const selected = await Promise.all(paths.map(describeNativeFile))
    const primary = selected.find((file) => !/\.(bai|csi)$/i.test(file.name))
    if (!primary) throw new Error('Select the data file, and its index too if it is a BAM.')
    const opened = await sourceFromNativeFile(primary, selected)
    await applyRelink(id, opened, channel)
    showToast(`Relinked ${primary.name}`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true)
  }
}

async function applyRelink(id: string, opened: OpenedSource, channel?: 'plus' | 'minus'): Promise<void> {
    const track = store.current.tracks.find((item) => item.id === id)
    if (!track || track.kind === 'genes') throw new Error('This track cannot be relinked.')
    const expectedKind = track.kind === 'stranded' ? 'signal' : track.kind
    if (expectedKind !== opened.kind) throw new Error(`Choose another ${track.kind === 'interval' ? 'BED interval' : track.kind === 'interaction' ? 'BEDPE interaction' : track.kind === 'alignment' ? 'BAM and matching index' : 'signal'} file for this track.`)
    const { source, sourceSpec } = opened
    const sourceIndex = track.kind === 'stranded' && channel === 'minus' ? 1 : 0
    const expectedSourceId = track.sourceIds[sourceIndex]
    if (!expectedSourceId) throw new Error('This track has no source to relink.')
    store.edit((draft) => {
      const index = draft.sources.findIndex((item) => item.id === expectedSourceId)
      if (index >= 0) draft.sources[index] = {
        ...sourceSpec,
        id: expectedSourceId,
        strand: track.kind === 'stranded' ? (channel ?? 'plus') : sourceSpec.strand,
        strandBaseLabel: track.kind === 'stranded' ? track.label : sourceSpec.strandBaseLabel,
      }
    })
    runtimeSources.set(expectedSourceId, source)
    browser.syncDocument(store.current, runtimeSources)
    await browser.attachSource(expectedSourceId, source)
}

function saveWorkspace(): void {
  const blob = new Blob([JSON.stringify(store.current, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `gerafe-${store.current.referenceId}.gerafe.json`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  showToast('Saved workspace layout')
}

async function openWorkspace(file: File | undefined): Promise<void> {
  if (!file) return
  try {
    const next = normalizeTrackDocument(JSON.parse(await file.text()))
    if (!references.has(next.referenceId)) throw new Error(`The workspace uses unavailable reference “${next.referenceId}”.`)
    bottomPaneAutoFit = true
    selectedTrackIds.clear()
    runtimeSources.clear()
    store.replace(next)
    await switchReference(next.referenceId)
    browser.setRegion(next.region)
    if (isDesktopApp()) await restorePersistedSources()
    showToast(`Opened ${file.name}${isDesktopApp() ? '' : '; relink local data files to draw them.'}`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true)
  } finally {
    workspaceFileInput.value = ''
  }
}

function updateUndoControls(): void {
  document.querySelector<HTMLButtonElement>('#undo-menu-item')!.disabled = !store.canUndo
  document.querySelector<HTMLButtonElement>('#redo-menu-item')!.disabled = !store.canRedo
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!)
}

async function importReference(file: File | undefined): Promise<void> {
  if (!file) return
  try {
    const chromosomes = parseChromosomeIndex(await file.text())
    const baseName = file.name.replace(/(?:\.fa)?\.fai$|\.genome$|\.chrom\.sizes$|\.sizes$|\.txt$/i, '') || 'Custom reference'
    const reference: ReferenceGenome = {
      id: `custom-${Date.now().toString(36)}`,
      name: baseName,
      chromosomes,
    }
    references.set(reference.id, reference)
    persistCustomReferences()
    populateReferences()
    await switchReference(reference.id)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true)
  } finally {
    referenceFileInput.value = ''
  }
}

async function activateGeneTrack(reference: ReferenceGenome): Promise<void> {
  activeGeneSource = undefined
  browser.setGeneSource(undefined)
  browser.setCytobands(undefined)
  if (reference.id !== 'hg38') return
  try {
    hg38CytobandsPromise ??= fetch(new URL('reference/hg38-cytobands.tsv', document.baseURI))
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load the bundled hg38 cytobands (${response.status}).`)
        return response.text()
      })
      .then(parseCytobands)
    hg38GenesPromise ??= fetch(new URL('reference/hg38-refseq-genes.tsv', document.baseURI))
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load the bundled RefSeq index (${response.status}).`)
        return response.text()
      })
      .then((text) => GeneSource.fromTsv(text))
    const [genes, cytobands] = await Promise.all([hg38GenesPromise, hg38CytobandsPromise])
    if (activeReference.id !== reference.id) return
    activeGeneSource = genes
    browser.setCytobands(cytobands)
    browser.setGeneSource(genes, 'hg38 · RefSeq 2022-10-28')
    await ensureGeneDetails(browser.getRegion().chr)
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true)
  }
}

async function ensureGeneDetails(chromosome: string): Promise<void> {
  if (activeReference.id !== 'hg38' || !activeGeneSource || hg38TranscriptLoaded.has(chromosome)) return
  try {
    let promise = hg38TranscriptPromises.get(chromosome)
    if (!promise) {
      promise = fetch(new URL(`reference/refseq/hg38-${encodeURIComponent(chromosome)}.tsv.gz`, document.baseURI))
        .then((response) => {
          if (!response.ok) throw new Error(`Could not load RefSeq transcript details for ${chromosome}.`)
          return response.arrayBuffer()
        })
        .then((buffer) => {
          const bytes = new Uint8Array(buffer)
          const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? ungzip(bytes, undefined) : bytes
          return new TextDecoder().decode(decoded)
        })
        .then((text) => GeneSource.fromTsv(text))
      hg38TranscriptPromises.set(chromosome, promise)
    }
    const details = await promise
    if (activeReference.id !== 'hg38' || !activeGeneSource) return
    if (hg38TranscriptLoaded.has(chromosome)) return
    activeGeneSource.replaceChromosome(chromosome, details)
    hg38TranscriptLoaded.add(chromosome)
    browser.refresh()
  } catch (error) {
    hg38TranscriptPromises.delete(chromosome)
    showToast(error instanceof Error ? error.message : String(error), true)
  }
}

function defaultRegion(reference: ReferenceGenome) {
  if (reference.id === 'hg38') return { chr: 'chr8', start: 127_700_000, end: 127_900_000 }
  const first = reference.chromosomes.entries().next().value as [string, number] | undefined
  if (!first) return { chr: 'chr1', start: 0, end: 1 }
  const span = Math.min(200_000, first[1])
  return { chr: first[0], start: 0, end: span }
}

function exampleLocus(reference: ReferenceGenome): string {
  const region = defaultRegion(reference)
  return formatLocus(region)
}

function loadStoredReferences(): ReferenceGenome[] {
  try {
    const values = JSON.parse(localStorage.getItem(CUSTOM_REFERENCES_KEY) ?? '[]') as StoredReferenceGenome[]
    return Array.isArray(values) ? values.map(restoreReference).filter((value): value is ReferenceGenome => Boolean(value)) : []
  } catch {
    return []
  }
}

function loadWorkspace(): TrackDocument | undefined {
  try {
    const saved = localStorage.getItem(WORKSPACE_KEY)
    return saved ? normalizeTrackDocument(JSON.parse(saved)) : undefined
  } catch {
    return undefined
  }
}

function persistCustomReferences(): void {
  const custom = [...references.values()].filter((reference) => !reference.builtIn).map(serializeReference)
  localStorage.setItem(CUSTOM_REFERENCES_KEY, JSON.stringify(custom))
}

let toastTimer: number | undefined
function showToast(message: string, isError = false, duration = 4200): void {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.toggle('is-error', isError)
  toast.classList.add('is-visible')
  if (duration > 0) toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), duration)
}

function savedTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111315' : '#f5f3ec')
}

function updateThemeButton(button: HTMLButtonElement): void {
  const dark = document.documentElement.dataset.theme === 'dark'
  button.textContent = dark ? '☀' : '☾'
  button.title = dark ? 'Use light mode' : 'Use dark mode'
  button.setAttribute('aria-label', button.title)
}

function savedTssIndicators(): boolean {
  return localStorage.getItem(TSS_INDICATORS_KEY) !== 'false'
}

function savedStrandedAutoLink(): boolean {
  return localStorage.getItem(STRANDED_AUTO_LINK_KEY) !== 'false'
}

function savedGroupAutoscale(): boolean {
  return localStorage.getItem(GROUP_AUTOSCALE_KEY) !== 'false'
}

function savedStrandedAutoColors(): boolean {
  return localStorage.getItem(STRANDED_AUTO_COLORS_KEY) !== 'false'
}

function updateTrackOptionsControls(): void {
  tssIndicatorsToggle.checked = savedTssIndicators()
  strandedAutoLinkToggle.checked = savedStrandedAutoLink()
  groupAutoscaleToggle.checked = savedGroupAutoscale()
  strandedAutoColorsToggle.checked = savedStrandedAutoColors()
}

function openTrackOptionsDialog(): void {
  updateTrackOptionsControls()
  trackOptionsDialog.hidden = false
  window.setTimeout(() => tssIndicatorsToggle.focus(), 0)
}

function closeTrackOptionsDialog(): void {
  trackOptionsDialog.hidden = true
}

function updateZoomLevel(region: { chr: string; start: number; end: number }): void {
  const chromosomeLength = activeChromosomes.get(region.chr)
  if (!chromosomeLength) return
  const span = Math.max(1, region.end - region.start)
  const percentage = chromosomeLength / span * 100
  const label = document.querySelector<HTMLElement>('#zoom-level')!
  const position = Math.max(0, Math.min(1, Math.log10(Math.max(100, percentage) / 100) / 5))
  label.style.setProperty('--zoom-position', String(position))
  label.setAttribute('aria-label', `Zoom: ${formatZoomPercentage(percentage)}`)
  label.title = `${percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}% zoom · ${formatBases(span)} visible · 100% shows the full chromosome`
}

function fitBottomPaneToContent(): void {
  const contentHeight = store.current.tracks
    .filter((track) => track.enabled && track.pane === 'bottom')
    .reduce((height, track) => height + trackPixelHeight(track.kind, track.height), 0)
  setBottomPaneHeight(contentHeight + 8)
}

function setBottomPaneHeight(requested: number): void {
  const measuredHeight = document.querySelector<HTMLElement>('.browser-body')?.clientHeight ?? 0
  const bodyHeight = measuredHeight > 0 ? measuredHeight : window.innerHeight
  const height = Math.max(86, Math.min(requested, bodyHeight * 0.78))
  bottomPane.style.height = `${height}px`
  mainTrackScroll.style.paddingBottom = `${height}px`
}

function bindColorPicker(): void {
  const choose = (event: PointerEvent) => {
    if (event.type === 'pointermove' && !trackColorField.hasPointerCapture(event.pointerId)) return
    const box = trackColorField.getBoundingClientRect()
    colorHsv.s = Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100))
    colorHsv.v = Math.max(0, Math.min(100, (1 - (event.clientY - box.top) / box.height) * 100))
    syncColorFromHsv()
  }
  trackColorField.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    trackColorField.setPointerCapture(event.pointerId)
    choose(event)
  })
  trackColorField.addEventListener('pointermove', choose)
  trackColorHue.addEventListener('input', () => {
    colorHsv.h = Number(trackColorHue.value)
    syncColorFromHsv()
  })
  trackColorInput.addEventListener('input', () => {
    const color = normalizedHexColor(trackColorInput.value)
    if (!color) return
    colorHsv = hexToHsv(color)
    trackColorHue.value = String(Math.round(colorHsv.h))
    drawColorField()
    trackColorPreview.style.background = color
  })
}

function setColorPickerHex(value: string): void {
  const color = normalizedHexColor(value) ?? '#6d55e0'
  colorHsv = hexToHsv(color)
  trackColorHue.value = String(Math.round(colorHsv.h))
  syncColorFromHsv()
}

function syncColorFromHsv(): void {
  const color = hsvToHex(colorHsv.h, colorHsv.s, colorHsv.v)
  trackColorInput.value = color
  trackColorPreview.style.background = color
  drawColorField()
}

function drawColorField(): void {
  const ctx = trackColorField.getContext('2d')!
  const width = trackColorField.width
  const height = trackColorField.height
  ctx.fillStyle = `hsl(${colorHsv.h} 100% 50%)`
  ctx.fillRect(0, 0, width, height)
  const white = ctx.createLinearGradient(0, 0, width, 0)
  white.addColorStop(0, '#fff')
  white.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = white
  ctx.fillRect(0, 0, width, height)
  const black = ctx.createLinearGradient(0, 0, 0, height)
  black.addColorStop(0, 'rgba(0,0,0,0)')
  black.addColorStop(1, '#000')
  ctx.fillStyle = black
  ctx.fillRect(0, 0, width, height)
  const x = colorHsv.s / 100 * width
  const y = (1 - colorHsv.v / 100) * height
  ctx.strokeStyle = colorHsv.v > 55 ? '#111' : '#fff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, 6, 0, Math.PI * 2)
  ctx.stroke()
}

function normalizedHexColor(value: string): string | undefined {
  const trimmed = value.trim()
  const expanded = /^#[0-9a-f]{3}$/i.test(trimmed)
    ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
    : trimmed
  return /^#[0-9a-f]{6}$/i.test(expanded) ? expanded.toLowerCase() : undefined
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const color = normalizedHexColor(hex) ?? '#6d55e0'
  const r = Number.parseInt(color.slice(1, 3), 16) / 255
  const g = Number.parseInt(color.slice(3, 5), 16) / 255
  const b = Number.parseInt(color.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6)
    else if (max === g) h = 60 * ((b - r) / delta + 2)
    else h = 60 * ((r - g) / delta + 4)
  }
  if (h < 0) h += 360
  return { h, s: max ? delta / max * 100 : 0, v: max * 100 }
}

function hsvToHex(h: number, s: number, v: number): string {
  const saturation = s / 100
  const value = v / 100
  const chroma = value * saturation
  const segment = ((h % 360) + 360) % 360 / 60
  const x = chroma * (1 - Math.abs(segment % 2 - 1))
  const [r1, g1, b1] = segment < 1 ? [chroma, x, 0]
    : segment < 2 ? [x, chroma, 0]
      : segment < 3 ? [0, chroma, x]
        : segment < 4 ? [0, x, chroma]
          : segment < 5 ? [x, 0, chroma]
            : [chroma, 0, x]
  const match = value - chroma
  return `#${[r1, g1, b1].map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('')}`
}
