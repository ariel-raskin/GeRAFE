import './style.css'
import { ungzip } from 'pako-esm2'
import { distributeFittedPixels, GenomeBrowser, heightScoreForPixels, MATRIX_BLUE_BLACK_COLORS, MATRIX_WARM_COLORS, trackPixelHeight } from './browser.ts'
import { BedGraphSource, MAX_BEDGRAPH_BYTES } from './data/bedgraph.ts'
import { gzipText } from './data/gzip.ts'
import { BedSource } from './data/bed.ts'
import { BedPeSource } from './data/bedpe.ts'
import { BigWigSource } from './data/bigwig.ts'
import { TdfSource } from './data/tdf.ts'
import { BamAlignmentSource, findBamIndex } from './data/bam.ts'
import { isNativeMatrixSource, NativeMatrixSource } from './data/matrix.ts'
import type { MatrixFormat } from './data/matrix.ts'
import { formatBases, formatLocus, formatZoomPercentage, hg38, parseLocus, resolveChromosome } from './genome.ts'
import { parseCytobands } from './cytoband.ts'
import { GeneSource, parseChromosomeIndex, restoreReference, serializeReference } from './reference.ts'
import type { ReferenceGenome, StoredReferenceGenome } from './reference.ts'
import {
  addSignalTrack,
  addIntervalTrack,
  addInteractionTrack,
  addMatrixTrack,
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
import type { MatrixPalette, SignalScaleChannel, SourceFormat, TrackDocument, TrackSourceSpec, TrackSpec } from './track-document.ts'
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
type ActionDialogRequest = {
  mode: 'input' | 'confirm' | 'notice'
  title: string
  message?: string
  label?: string
  initial?: string
  placeholder?: string
  submitLabel: string
  danger?: boolean
  validate?: (value: string) => string | undefined
  resolve: (value: string | boolean | undefined) => void
}
const {
  theme: THEME_KEY,
  reference: REFERENCE_KEY,
  customReferences: CUSTOM_REFERENCES_KEY,
  workspace: WORKSPACE_KEY,
  tssIndicators: TSS_INDICATORS_KEY,
  strandedAutoLink: STRANDED_AUTO_LINK_KEY,
  groupAutoscale: GROUP_AUTOSCALE_KEY,
  strandedAutoColors: STRANDED_AUTO_COLORS_KEY,
  upperPaneAutoFit: UPPER_PANE_AUTO_FIT_KEY,
  interactionGuideSeen: INTERACTION_GUIDE_SEEN_KEY,
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
            <button class="menu-item" id="undo-menu-item" type="button" role="menuitem" title="Undo the last track or workspace edit"><span>Undo</span><kbd>Ctrl+Z</kbd></button>
            <button class="menu-item" id="redo-menu-item" type="button" role="menuitem" title="Redo the last undone track or workspace edit"><span>Redo</span><kbd>Ctrl+Y</kbd></button>
          </div>
        </div>
        <div class="app-menu" id="settings-menu-root">
          <button class="menu-trigger" id="settings-menu-button" type="button" aria-haspopup="menu" aria-expanded="false">Settings</button>
          <div class="menu-popover" id="settings-menu-popup" role="menu" hidden>
            <button class="menu-item" id="track-options-menu-item" type="button" role="menuitem"><span>Track behavior…</span></button>
          </div>
        </div>
        <div class="app-menu" id="help-menu-root">
          <button class="menu-trigger" id="help-menu-button" type="button" aria-haspopup="menu" aria-expanded="false">Help</button>
          <div class="menu-popover" id="help-menu-popup" role="menu" hidden>
            <button class="menu-item" id="interaction-guide-menu-item" type="button" role="menuitem"><span>Track interactions…</span></button>
            <span class="menu-separator"></span>
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
        <input id="reference-file-input" type="file" accept=".fai,.genome,.sizes,.txt" />
      </div>
      <span class="toolbar-divider"></span>
      <input id="file-input" type="file" multiple />
      <input id="workspace-file-input" type="file" accept=".json,.gerafe.json,.locus.json" />
      <input id="relink-file-input" type="file" multiple />
      <form class="locus-form" id="locus-form">
        <div class="reference-picker chromosome-picker" id="chromosome-picker">
          <button class="reference-trigger chromosome-trigger" id="chromosome-button" type="button" aria-haspopup="listbox" aria-expanded="false" title="Choose a chromosome"><span id="chromosome-label"></span><i aria-hidden="true"></i></button>
          <div class="reference-popover chromosome-popover" id="chromosome-popup" role="listbox" hidden></div>
        </div>
        <input id="locus-input" aria-label="Gene name or genomic locus" placeholder="Gene or locus" spellcheck="false" />
        <button type="submit" aria-label="Go to locus">Go</button>
      </form>
      <div class="toolbar-spacer"></div>
      <div class="fit-tracks-control">
        <button class="fit-tracks-button" id="fit-tracks" type="button" title="Fit all upper tracks into the visible upper pane">Fit tracks</button>
        <button class="fit-tracks-auto" id="fit-tracks-auto" type="button" aria-pressed="false" title="Automatically keep upper tracks fitted"><i aria-hidden="true"></i></button>
      </div>
      <div class="zoom-controls" aria-label="Zoom controls">
        <button id="zoom-out" type="button" aria-label="Zoom out">−</button>
        <input class="zoom-meter" id="zoom-level" type="range" min="0" max="100" step="0.1" value="0" aria-label="Zoom level" title="Zoom level" />
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
      <div class="status-group"><span class="live-dot" data-state="idle"></span><span id="track-status">No tracks loaded</span></div>
      <div class="metrics" aria-label="Rendering performance">
        <span><b id="fps-value">60</b> fps</span>
        <span><b id="render-value">0.0</b> ms draw</span>
        <span><b id="feature-value">0</b> features</span>
      </div>
    </footer>
  </main>
  <div class="track-context-menu" id="track-context-menu" role="menu" hidden></div>
  <div class="track-context-menu track-context-flyout" id="track-context-flyout" role="menu" hidden></div>
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
      <header><strong id="track-options-title">Track behavior</strong><button class="update-dialog-close" id="track-options-close" type="button" aria-label="Close">×</button></header>
      <div class="track-options-content">
        <section><h3>Gene tracks</h3><label><span><strong>Show TSS indicators</strong><small>Draw transcription start site elbow arrows in gene tracks.</small></span><input id="tss-indicators-toggle" type="checkbox" /></label></section>
        <section><h3>Stranded signals</h3><label><span><strong>Automatically pair plus/minus tracks</strong><small>Pair matching positive- and negative-strand signal files when opened.</small></span><input id="stranded-auto-link-toggle" type="checkbox" /></label><label><span><strong>Apply red and blue strand colors</strong><small>Use red for positive and blue for negative strands when pairs are linked.</small></span><input id="stranded-auto-colors-toggle" type="checkbox" /></label></section>
        <section><h3>Groups</h3><label><span><strong>Share scales when tracks are grouped</strong><small>Link compatible signal or matrix scales when tracks are added to a group.</small></span><input id="group-autoscale-toggle" type="checkbox" /></label></section>
      </div>
    </section>
  </div>
  <div class="matrix-settings-dialog" id="matrix-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="matrix-settings-title" hidden>
    <form class="matrix-settings-card" id="matrix-settings-form">
      <header><div><strong id="matrix-settings-title">Matrix settings</strong><small id="matrix-settings-scope"></small></div><button class="update-dialog-close" id="matrix-settings-close" type="button" aria-label="Close">×</button></header>
      <div class="matrix-settings-content">
        <div class="matrix-settings-grid">
          <label><span>Intensity range</span><select id="matrix-scale-mode"><option value="auto">Automatic z-max</option><option value="fixed">Fixed z-max</option></select></label>
          <label><span>Fixed z-max</span><input id="matrix-scale-maximum" type="number" min="0.000001" step="any" /></label>
          <label><span>Intensity transform</span><select id="matrix-transform"><option value="log1p">Log</option><option value="linear">Linear</option></select></label>
          <label><span>Color palette</span><select id="matrix-palette"><option value="warm">Warm · yellow → red → black</option><option value="blue-black">Light blue → dark blue → black</option><option value="monochrome">Single-color gradient</option><option value="custom">Custom colors</option></select></label>
          <label id="matrix-group-scaling-row"><span>Matrix group scaling</span><select id="matrix-group-scaling"><option value="linked">Shared automatic scale</option><option value="independent">Independent automatic scales</option></select></label>
        </div>
        <section class="matrix-palette-editor" id="matrix-palette-editor" hidden>
          <header><span>Low-to-high colors</span><button id="matrix-add-color" type="button">Add color</button></header>
          <div id="matrix-palette-colors"></div>
          <small>Stops are interpolated in this low-to-high order.</small>
        </section>
        <label class="matrix-range-row"><span><strong>High-color threshold</strong><small>Start blending toward the highest color only above this fraction of z-max.</small></span><input id="matrix-high-color-start" type="range" min="50" max="99" step="1" /><output id="matrix-high-color-output"></output></label>
        <label class="matrix-check-row"><span><strong>Reverse score colors</strong><small>Map high scores to the low end of the selected palette.</small></span><input id="matrix-palette-reversed" type="checkbox" /></label>
      </div>
      <footer><button class="dialog-button secondary" id="matrix-settings-cancel" type="button">Cancel</button><button class="dialog-button primary" id="matrix-settings-apply" type="submit">Apply</button></footer>
    </form>
  </div>
  <div class="action-dialog" id="action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title" hidden>
    <form class="action-dialog-card" id="action-dialog-form">
      <header><strong id="action-dialog-title"></strong><button class="update-dialog-close" id="action-dialog-close" type="button" aria-label="Close">×</button></header>
      <div class="action-dialog-content">
        <p id="action-dialog-message" hidden></p>
        <label id="action-dialog-field"><span id="action-dialog-label"></span><input id="action-dialog-input" type="text" spellcheck="false" /><small id="action-dialog-error" role="alert"></small></label>
      </div>
      <footer><button class="dialog-button secondary" id="action-dialog-cancel" type="button">Cancel</button><button class="dialog-button primary" id="action-dialog-submit" type="submit">Apply</button></footer>
    </form>
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
const chromosomePicker = document.querySelector<HTMLElement>('#chromosome-picker')!
const chromosomeButton = document.querySelector<HTMLButtonElement>('#chromosome-button')!
const chromosomeLabel = document.querySelector<HTMLElement>('#chromosome-label')!
const chromosomePopup = document.querySelector<HTMLElement>('#chromosome-popup')!
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
const liveDot = document.querySelector<HTMLElement>('.live-dot')!
const trackContextMenu = document.querySelector<HTMLElement>('#track-context-menu')!
const trackContextFlyout = document.querySelector<HTMLElement>('#track-context-flyout')!
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
const matrixSettingsDialog = document.querySelector<HTMLElement>('#matrix-settings-dialog')!
const matrixSettingsContent = matrixSettingsDialog.querySelector<HTMLElement>('.matrix-settings-content')!
const matrixSettingsForm = document.querySelector<HTMLFormElement>('#matrix-settings-form')!
const matrixSettingsScope = document.querySelector<HTMLElement>('#matrix-settings-scope')!
const matrixScaleMode = document.querySelector<HTMLSelectElement>('#matrix-scale-mode')!
const matrixScaleMaximum = document.querySelector<HTMLInputElement>('#matrix-scale-maximum')!
const matrixTransform = document.querySelector<HTMLSelectElement>('#matrix-transform')!
const matrixPalette = document.querySelector<HTMLSelectElement>('#matrix-palette')!
const matrixGroupScalingRow = document.querySelector<HTMLElement>('#matrix-group-scaling-row')!
const matrixGroupScaling = document.querySelector<HTMLSelectElement>('#matrix-group-scaling')!
const matrixPaletteEditor = document.querySelector<HTMLElement>('#matrix-palette-editor')!
const matrixPaletteColors = document.querySelector<HTMLElement>('#matrix-palette-colors')!
const matrixHighColorStart = document.querySelector<HTMLInputElement>('#matrix-high-color-start')!
const matrixHighColorOutput = document.querySelector<HTMLOutputElement>('#matrix-high-color-output')!
const matrixPaletteReversed = document.querySelector<HTMLInputElement>('#matrix-palette-reversed')!
const matrixSettingsApply = document.querySelector<HTMLButtonElement>('#matrix-settings-apply')!
const actionDialog = document.querySelector<HTMLElement>('#action-dialog')!
const actionDialogForm = document.querySelector<HTMLFormElement>('#action-dialog-form')!
const actionDialogTitle = document.querySelector<HTMLElement>('#action-dialog-title')!
const actionDialogMessage = document.querySelector<HTMLElement>('#action-dialog-message')!
const actionDialogField = document.querySelector<HTMLElement>('#action-dialog-field')!
const actionDialogLabel = document.querySelector<HTMLElement>('#action-dialog-label')!
const actionDialogInput = document.querySelector<HTMLInputElement>('#action-dialog-input')!
const actionDialogError = document.querySelector<HTMLElement>('#action-dialog-error')!
const actionDialogClose = document.querySelector<HTMLButtonElement>('#action-dialog-close')!
const actionDialogCancel = document.querySelector<HTMLButtonElement>('#action-dialog-cancel')!
const actionDialogSubmit = document.querySelector<HTMLButtonElement>('#action-dialog-submit')!
const zoomLevel = document.querySelector<HTMLInputElement>('#zoom-level')!
const fitTracksAuto = document.querySelector<HTMLButtonElement>('#fit-tracks-auto')!

const runtimeSources = new Map<string, TrackSource>()
const selectedTrackIds = new Set<string>()
const contextSubmenuItems = new Map<string, string>()
let lastSelectedTrackId: string | undefined
let contextSubmenuCloseTimer: number | undefined
let pendingRelinkTrackId: string | undefined
let pendingRelinkChannel: 'plus' | 'minus' | undefined
let pendingOpenGroupId: string | undefined
let pendingColorGroupId: string | undefined
let pendingColorChannel: SignalScaleChannel | undefined
let pendingMatrixTrackIds: string[] = []
let pendingMatrixGroupId: string | undefined
let matrixDialogColors: string[] = []
let pendingActionDialog: ActionDialogRequest | undefined
let bottomPaneAutoFit = true
let upperPaneAutoFit = savedUpperPaneAutoFit()
let upperAutoFitFrame: number | undefined
let colorHsv = { h: 250, s: 62, v: 88 }
let appUpdater: AppUpdateController | undefined
let appUpdaterPromise: Promise<AppUpdateController> | undefined

interface OpenedSource {
  source: TrackSource
  sourceSpec: TrackSourceSpec
  kind: 'signal' | 'interval' | 'interaction' | 'matrix' | 'alignment'
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
    setActiveChromosome(region.chr)
    updateZoomLevel(region)
    store.setViewport(activeReference.id, region)
    void ensureGeneDetails(region.chr)
    if (bottomPaneAutoFit) requestAnimationFrame(fitBottomPaneToContent)
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
    liveDot.dataset.state = attention ? 'attention' : loading ? 'loading' : ready ? 'ready' : 'idle'
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
    selectGroup(groupId, false)
    openGroupContextMenu(groupId, x, y)
  },
  onTracksReorder(trackIds, pane, insertionIndex, withinGroupId) {
    bottomPaneAutoFit = false
    store.edit((draft) => reorderTracks(draft, trackIds, pane, insertionIndex, withinGroupId))
  },
  onTrackHeightsResize(updates) {
    const resizedIds = new Set(updates.map((update) => update.id))
    if (store.current.tracks.some((track) => resizedIds.has(track.id) && track.pane === 'main')) {
      upperPaneAutoFit = false
      localStorage.setItem(UPPER_PANE_AUTO_FIT_KEY, 'false')
      updateUpperAutoFitControl()
    }
    if (store.current.tracks.some((track) => resizedIds.has(track.id) && track.pane === 'bottom')) bottomPaneAutoFit = false
    store.edit((draft) => {
      for (const update of updates) {
        const track = draft.tracks.find((candidate) => candidate.id === update.id)
        if (!track) continue
        track.height = heightScoreForPixels(track.kind, update.pixels)
        track.manualPixelHeight = update.pixels
        delete track.fittedHeight
      }
    })
  },
})
browser.setShowTssIndicators(savedTssIndicators())
updateTrackOptionsControls()
updateZoomLevel(initialRegion)
window.setTimeout(showFirstRunInteractionHint, 450)

let persistTimer: number | undefined
store.subscribe((document, reason) => {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => localStorage.setItem(WORKSPACE_KEY, JSON.stringify(document)), 180)
  if (reason !== 'viewport') browser.syncDocument(document, runtimeSources)
  updateUndoControls()
  browser.setSelectedTracks(selectedTrackIds)
  if (bottomPaneAutoFit && reason !== 'viewport') requestAnimationFrame(fitBottomPaneToContent)
  if (reason !== 'viewport') scheduleUpperAutoFit()
})
browser.syncDocument(store.current, runtimeSources)
if (isDesktopApp()) void restorePersistedSources()
browser.setSelectedTracks(selectedTrackIds)
fitBottomPaneToContent()
window.setTimeout(fitBottomPaneToContent, 0)
updateUpperAutoFitControl()
scheduleUpperAutoFit()

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
  const importOption = (event.target as Element).closest<HTMLButtonElement>('[data-reference-import]')
  if (importOption) {
    setReferenceMenu(false)
    referenceFileInput.click()
    return
  }
  const option = (event.target as Element).closest<HTMLButtonElement>('[data-reference-id]')
  if (!option) return
  setReferenceMenu(false)
  void switchReference(option.dataset.referenceId!)
})
referenceFileInput.addEventListener('change', () => void importReference(referenceFileInput.files?.[0]))
chromosomeButton.addEventListener('click', () => setChromosomeMenu(chromosomePopup.hasAttribute('hidden')))
chromosomePopup.addEventListener('click', (event) => {
  const option = (event.target as Element).closest<HTMLButtonElement>('[data-chromosome]')
  if (!option) return
  setChromosomeMenu(false)
  switchChromosome(option.dataset.chromosome!)
})

document.querySelector<HTMLButtonElement>('#open-tracks-menu-item')!.addEventListener('click', () => {
  closeMenus()
  pendingOpenGroupId = undefined
  void openTrackPicker()
})
document.querySelector<HTMLButtonElement>('#new-workspace-menu-item')!.addEventListener('click', async () => {
  closeMenus()
  const loadedTracks = store.current.tracks.filter((track) => track.kind !== 'genes')
  if (loadedTracks.length && !await confirmAction({
    title: 'Start a new workspace?',
    message: `This will remove ${loadedTracks.length} loaded track${loadedTracks.length === 1 ? '' : 's'} from the current workspace. You can undo this change afterward.`,
    submitLabel: 'Start new workspace',
    danger: true,
  })) return
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
document.querySelector<HTMLButtonElement>('#interaction-guide-menu-item')!.addEventListener('click', () => {
  closeMenus()
  void showInteractionGuide()
})
tssIndicatorsToggle.addEventListener('change', () => {
  localStorage.setItem(TSS_INDICATORS_KEY, String(tssIndicatorsToggle.checked))
  browser.setShowTssIndicators(tssIndicatorsToggle.checked)
  if (bottomPaneAutoFit) requestAnimationFrame(fitBottomPaneToContent)
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
document.querySelector<HTMLButtonElement>('#matrix-settings-close')!.addEventListener('click', closeMatrixSettingsDialog)
document.querySelector<HTMLButtonElement>('#matrix-settings-cancel')!.addEventListener('click', closeMatrixSettingsDialog)
matrixScaleMode.addEventListener('change', updateMatrixSettingsVisibility)
matrixPalette.addEventListener('change', () => {
  if (matrixPalette.value === 'custom' && matrixDialogColors.length < 2) matrixDialogColors = [...MATRIX_WARM_COLORS]
  updateMatrixSettingsVisibility()
  renderMatrixPaletteColors()
})
matrixHighColorStart.addEventListener('input', updateMatrixHighColorOutput)
document.querySelector<HTMLButtonElement>('#matrix-add-color')!.addEventListener('click', () => {
  if (matrixDialogColors.length >= 8) return
  matrixDialogColors.push(matrixDialogColors.at(-1) ?? '#111111')
  renderMatrixPaletteColors()
})
matrixPaletteColors.addEventListener('input', (event) => {
  const input = (event.target as Element).closest<HTMLInputElement>('[data-matrix-color-index]')
  if (!input) return
  matrixDialogColors[Number(input.dataset.matrixColorIndex)] = input.value
  const code = input.nextElementSibling
  if (code) code.textContent = input.value
})
matrixPaletteColors.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-remove-matrix-color]')
  if (!button || matrixDialogColors.length <= 2) return
  matrixDialogColors.splice(Number(button.dataset.removeMatrixColor), 1)
  renderMatrixPaletteColors()
})
matrixSettingsForm.addEventListener('submit', (event) => {
  event.preventDefault()
  applyMatrixSettingsDialog()
})
matrixSettingsDialog.addEventListener('pointerdown', (event) => { if (event.target === matrixSettingsDialog) closeMatrixSettingsDialog() })
actionDialogForm.addEventListener('submit', handleActionDialogSubmit)
actionDialogClose.addEventListener('click', () => closeActionDialog(undefined))
actionDialogCancel.addEventListener('click', () => closeActionDialog(undefined))
actionDialog.addEventListener('pointerdown', (event) => { if (event.target === actionDialog) closeActionDialog(undefined) })
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
  if (!(event.target as Element).closest?.('#reference-picker')) setReferenceMenu(false)
  if (!(event.target as Element).closest?.('#chromosome-picker')) setChromosomeMenu(false)
  if (!(event.target as Element).closest?.('.track-context-menu')) closeTrackContextMenu()
  if (event.button === 0 && !(event.target as Element).closest?.('#genome-header, #genome-canvas, #bottom-canvas, .track-context-menu, #color-dialog, #update-dialog, #track-options-dialog, #matrix-settings-dialog, #action-dialog')) clearTrackSelection()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeMenus(); setReferenceMenu(false); setChromosomeMenu(false); closeTrackContextMenu(); closeColorDialog(); closeUpdateDialog(); closeTrackOptionsDialog(); closeMatrixSettingsDialog(); closeActionDialog(undefined) }
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

function switchChromosome(chr: string): void {
  const length = activeChromosomes.get(chr)
  if (!length) return
  const current = browser.getRegion()
  const span = Math.min(current.end - current.start, length)
  browser.setRegion({ chr, start: Math.max(0, (length - span) / 2), end: Math.max(0, (length - span) / 2) + span })
}

document.querySelector('#zoom-in')!.addEventListener('click', () => browser.zoom(0.5))
document.querySelector('#zoom-out')!.addEventListener('click', () => browser.zoom(2))
zoomLevel.addEventListener('input', () => zoomFromSlider(Number(zoomLevel.value)))
document.querySelector('#fit-tracks')!.addEventListener('click', () => fitUpperTracks())
fitTracksAuto.addEventListener('click', () => {
  upperPaneAutoFit = !upperPaneAutoFit
  localStorage.setItem(UPPER_PANE_AUTO_FIT_KEY, String(upperPaneAutoFit))
  updateUpperAutoFitControl()
  if (upperPaneAutoFit) scheduleUpperAutoFit()
})
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
trackContextFlyout.addEventListener('click', handleTrackContextAction)
trackContextMenu.addEventListener('click', (event) => {
  const trigger = (event.target as Element).closest<HTMLButtonElement>('[data-context-submenu]')
  if (!trigger) return
  openContextSubmenu(trigger)
  trackContextFlyout.querySelector<HTMLButtonElement>('.context-item')?.focus()
})
trackContextMenu.addEventListener('pointerover', (event) => {
  const trigger = (event.target as Element).closest<HTMLButtonElement>('[data-context-submenu]')
  if (trigger) openContextSubmenu(trigger)
  else if ((event.target as Element).closest('[data-context-action]')) closeContextSubmenu()
})
trackContextMenu.addEventListener('focusin', (event) => {
  const trigger = (event.target as Element).closest<HTMLButtonElement>('[data-context-submenu]')
  if (trigger) openContextSubmenu(trigger)
})
trackContextMenu.addEventListener('pointerleave', scheduleContextSubmenuClose)
trackContextFlyout.addEventListener('pointerleave', scheduleContextSubmenuClose)
trackContextMenu.addEventListener('pointerenter', cancelContextSubmenuClose)
trackContextFlyout.addEventListener('pointerenter', cancelContextSubmenuClose)
trackContextMenu.addEventListener('keydown', (event) => {
  const trigger = (event.target as Element).closest<HTMLButtonElement>('[data-context-submenu]')
  if (!trigger || !['ArrowRight', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  openContextSubmenu(trigger)
  trackContextFlyout.querySelector<HTMLButtonElement>('.context-item')?.focus()
})
trackContextFlyout.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft') return
  event.preventDefault()
  const trigger = trackContextMenu.querySelector<HTMLButtonElement>('[data-context-submenu][aria-expanded="true"]')
  closeContextSubmenu()
  trigger?.focus()
})
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
  scheduleUpperAutoFit()
}
paneResizer.addEventListener('pointerup', finishPaneResize)
paneResizer.addEventListener('pointercancel', finishPaneResize)
window.addEventListener('resize', () => {
  bottomPaneAutoFit ? fitBottomPaneToContent() : setBottomPaneHeight(bottomPane.getBoundingClientRect().height)
  scheduleUpperAutoFit()
})

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
            : kind === 'matrix' ? addMatrixTrack(draft, sourceSpec, { id: trackId, defaultNormalization: isNativeMatrixSource(source) ? source.matrixMetadata.defaultNormalization : undefined })
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
  if (matrixFormatForName(name)) throw new Error(`${file.name}: contact matrices are opened directly from disk; use the GeRAFE desktop app's Open tracks command.`)
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
  throw new Error(`${file.name}: this file type is not currently supported.`)
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
            : kind === 'matrix' ? addMatrixTrack(draft, sourceSpec, { id: trackId, defaultNormalization: isNativeMatrixSource(source) ? source.matrixMetadata.defaultNormalization : undefined })
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
  const matrixFormat = matrixFormatForName(name)
  if (matrixFormat) return {
    source: await NativeMatrixSource.open(file.name, file.path, matrixFormat),
    sourceSpec: makeSourceSpec(file, matrixFormat),
    kind: 'matrix',
  }
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
  throw new Error(`${file.name}: this file type is not currently supported.`)
}

function matrixFormatForName(name: string): MatrixFormat | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.hic')) return 'hic'
  if (lower.endsWith('.mcool')) return 'mcool'
  if (lower.endsWith('.cool')) return 'cool'
  return undefined
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
  chromosomePopup.replaceChildren(...[...chromosomes.keys()].map((chr) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'reference-option chromosome-option'
    option.dataset.chromosome = chr
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(chr === current))
    option.textContent = chr
    return option
  }))
  setActiveChromosome(current)
}

function setActiveChromosome(chr: string): void {
  chromosomeLabel.textContent = chr
  for (const option of chromosomePopup.querySelectorAll<HTMLElement>('[data-chromosome]')) {
    option.setAttribute('aria-selected', String(option.dataset.chromosome === chr))
  }
}

function populateReferences(): void {
  referenceLabel.textContent = activeReference.name
  const options = [...references.values()].map((reference) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'reference-option'
    option.dataset.referenceId = reference.id
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(reference.id === activeReference.id))
    option.textContent = reference.name
    return option
  })
  const separator = document.createElement('span')
  separator.className = 'reference-option-separator'
  const importOption = document.createElement('button')
  importOption.type = 'button'
  importOption.className = 'reference-option reference-import-option'
  importOption.dataset.referenceImport = 'true'
  importOption.setAttribute('role', 'option')
  importOption.setAttribute('aria-selected', 'false')
  importOption.textContent = 'Add reference…'
  importOption.title = 'Import .fai, .genome, or chromosome-sizes file'
  referencePopup.replaceChildren(...options, separator, importOption)
}

function setReferenceMenu(open: boolean): void {
  if (open) setChromosomeMenu(false)
  referencePopup.hidden = !open
  referenceButton.setAttribute('aria-expanded', String(open))
  referencePicker.classList.toggle('is-open', open)
  if (open) referencePopup.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
}

function setChromosomeMenu(open: boolean): void {
  if (open) {
    referencePopup.hidden = true
    referenceButton.setAttribute('aria-expanded', 'false')
    referencePicker.classList.remove('is-open')
  }
  chromosomePopup.hidden = !open
  chromosomeButton.setAttribute('aria-expanded', String(open))
  chromosomePicker.classList.toggle('is-open', open)
  if (open) chromosomePopup.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
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
  const one = selected.length === 1
  const sameKind = selected.every((track) => track.kind === target.kind)
  const signalsOnly = selected.every((track) => track.kind === 'signal' || track.kind === 'stranded')
  const ordinarySignalsOnly = selected.every((track) => track.kind === 'signal' && !track.signalStrand)
  const strandedOnly = selected.every((track) => track.kind === 'stranded')
  const dataOnly = selected.every((track) => track.kind !== 'genes')
  const allResizable = selected.every((track) => track.kind !== 'genes' || track.pane !== 'bottom')
  const allFittable = selected.every((track) => track.pane === 'main')
  const intervalTracks = sameKind && target.kind === 'interval' ? selected : []
  const interactionTracks = sameKind && target.kind === 'interaction' ? selected : []
  const alignmentTracks = sameKind && target.kind === 'alignment' ? selected : []
  const geneTracks = sameKind && target.kind === 'genes' ? selected : []
  const pairable = selected.length === 2 && selected.every((track) => track.kind === 'signal') && canPairSelectedStrands(selected as TrackSpec[])
  const matrixTracks = selected.filter((track) => track.kind === 'matrix')
  const matricesOnly = matrixTracks.length > 0 && matrixTracks.length === selected.length
  const selectedGroupId = selected[0]?.displayGroupId
  const exactExistingGroupSelection = Boolean(selectedGroupId)
    && selected.every((track) => track.displayGroupId === selectedGroupId)
    && store.current.tracks.filter((track) => track.displayGroupId === selectedGroupId).every((track) => selectedTrackIds.has(track.id))
  const samePane = selected.every((track) => track.pane === target.pane)
  const signalScaleIds = signalsOnly ? selected.flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter((id): id is string => Boolean(id)) : []
  const signalScales = store.current.scales.filter((scale) => signalScaleIds.includes(scale.id))
  const scaleModeLabel = signalScales.length && signalScales.every((scale) => scale.mode === 'auto-visible') ? 'Automatic'
    : signalScales.length && signalScales.every((scale) => scale.mode === 'fixed') ? 'Fixed' : 'Mixed'
  const canShareSignalScales = signalsOnly && signalTracksCanShareScales(selected)
  const sharedSignalScales = signalsOnly && selected.length > 1 && signalTracksShareScales(selected)
  const selectedTrackSharesOutsideSelection = one && signalsOnly && signalScaleIds.some((scaleId) => store.current.tracks.some((track) => track.id !== target.id && [track.scaleBindingId, track.negativeScaleBindingId].includes(scaleId)))
  const interactionGeneDetail = interactionTracks.length && interactionTracks.every((track) => track.interactionFilterMode === 'genes')
    && sameValue(interactionTracks.map((track) => (track.interactionFilterGenes ?? []).join(', ')))
    ? escapeHtml((interactionTracks[0].interactionFilterGenes ?? []).join(', '))
    : interactionTracks.some((track) => track.interactionFilterMode === 'genes') ? 'Mixed' : ''
  const action = (id: string, label: string, detail = '', disabled = false, danger = false) => {
    const current = detail === 'current' || detail === 'on'
    const visibleDetail = current || detail === 'off' ? '' : detail
    return `<button class="context-item${current ? ' is-current' : ''}${danger ? ' danger' : ''}" data-context-action="${id}" type="button" role="menuitem" ${current ? 'aria-current="true"' : ''} ${disabled ? 'disabled' : ''}><span>${label}</span>${visibleDetail ? `<small>${visibleDetail}</small>` : ''}</button>`
  }
  contextSubmenuItems.clear()
  const submenu = (id: string, label: string, detail: string, items: string) => {
    if ((items.match(/data-context-action=/g) ?? []).length <= 1) return items
    contextSubmenuItems.set(id, items)
    return `<button class="context-item context-submenu-trigger" data-context-submenu="${id}" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false"><span>${label}</span><small>${detail}</small></button>`
  }
  const appearanceItems = [
    strandedOnly
      ? action('color-plus', 'Set positive-strand color…') + action('color-minus', 'Set negative-strand color…')
      : selected.every((track) => track.kind !== 'stranded') ? action('color', one ? 'Set color…' : 'Set color for selected tracks…') : '',
    allResizable ? action('height', one ? 'Set track height…' : 'Set selected track heights…') : '',
    allFittable ? action('height-lock', 'Lock track height', selected.every((track) => track.heightLocked) ? 'current' : '') : '',
  ].join('')
  const groupingItems = (selected.length > 1 && !exactExistingGroupSelection ? action('group', 'Group selected…') : '')
    + (selected.every((track) => track.displayGroupId) ? action('remove-from-group', one ? 'Remove from group' : 'Remove selected tracks from groups') : '')
  let typeItems = ''
  if (signalsOnly) {
    const scaleItems = action('scale-auto', 'Autoscale to visible data', signalScales.every((scale) => scale.mode === 'auto-visible') ? 'current' : '')
      + action('scale-fixed', 'Set fixed range…', signalScales.length > 0 && signalScales.every((scale) => scale.mode === 'fixed') ? 'current' : '')
      + (canShareSignalScales ? action('scale-toggle-sharing', 'Share y-axis scale', sharedSignalScales ? 'current' : '') : '')
      + (selectedTrackSharesOutsideSelection ? action('unlink-scales', 'Unlink from shared scale') : '')
      + (ordinarySignalsOnly ? action('prevent-negative', 'Clamp negative values to zero', selected.every((track) => track.allowNegativeValues === false) ? 'current' : '') : '')
    typeItems += submenu('signal-scale', 'Y-axis scale', scaleModeLabel, scaleItems)
    if (pairable) typeItems += action('strand-link', 'Link as stranded track')
    if (strandedOnly) typeItems += action('strand-unlink', one ? 'Separate stranded pair' : 'Separate stranded pairs')
  }
  if (intervalTracks.length) {
    const mode = sameValue(intervalTracks.map((track) => track.intervalDisplayMode ?? 'collapsed')) ? intervalTracks[0].intervalDisplayMode ?? 'collapsed' : 'mixed'
    typeItems += submenu('interval-display', 'Display mode', capitalize(mode),
      action('interval-collapsed', 'Collapsed', intervalTracks.every((track) => track.intervalDisplayMode === 'collapsed' || !track.intervalDisplayMode) ? 'current' : '')
      + action('interval-expanded', 'Expanded', intervalTracks.every((track) => track.intervalDisplayMode === 'expanded') ? 'current' : '')
      + action('interval-squished', 'Squished', intervalTracks.every((track) => track.intervalDisplayMode === 'squished') ? 'current' : ''))
  }
  if (interactionTracks.length) {
    typeItems += action('interaction-flip', 'Draw arcs downward', interactionTracks.every((track) => track.interactionDirection === 'down') ? 'current' : '')
    const filterLabel = interactionTracks.every((track) => track.interactionFilterMode === 'visible-genes') ? 'Visible genes'
      : interactionTracks.every((track) => track.interactionFilterMode === 'genes') ? 'Gene symbols'
        : interactionTracks.every((track) => !track.interactionFilterMode || track.interactionFilterMode === 'all') ? 'All' : 'Mixed'
    typeItems += submenu('interaction-filter', 'Interactions shown', filterLabel,
      action('interaction-filter-all', 'All interactions', interactionTracks.every((track) => !track.interactionFilterMode || track.interactionFilterMode === 'all') ? 'current' : '')
      + action('interaction-filter-genes', 'Matching gene symbols…', interactionGeneDetail)
      + action('interaction-filter-visible', 'Interactions involving visible genes', interactionTracks.every((track) => track.interactionFilterMode === 'visible-genes') ? 'current' : ''))
  }
  if (matricesOnly) typeItems += matrixContextMenuMarkup(matrixTracks, action, submenu)
  if (alignmentTracks.length) {
    const viewMode = sameValue(alignmentTracks.map((track) => track.bamViewMode ?? 'both')) ? alignmentTracks[0].bamViewMode ?? 'both' : 'mixed'
    const displayMode = sameValue(alignmentTracks.map((track) => track.alignmentDisplayMode ?? 'expanded')) ? alignmentTracks[0].alignmentDisplayMode ?? 'expanded' : 'mixed'
    const colorMode = sameValue(alignmentTracks.map((track) => track.bamColorMode ?? 'track')) ? alignmentTracks[0].bamColorMode ?? 'track' : 'mixed'
    typeItems += submenu('bam-content', 'Content', bamViewModeLabel(viewMode),
      action('bam-view-both', 'Coverage and alignments', alignmentTracks.every((track) => track.bamViewMode === 'both' || !track.bamViewMode) ? 'current' : '')
      + action('bam-view-coverage', 'Coverage only', alignmentTracks.every((track) => track.bamViewMode === 'coverage') ? 'current' : '')
      + action('bam-view-alignments', 'Alignments only', alignmentTracks.every((track) => track.bamViewMode === 'alignments') ? 'current' : ''))
    typeItems += submenu('bam-layout', 'Read layout', capitalize(displayMode),
      action('bam-display-expanded', 'Expanded', alignmentTracks.every((track) => track.alignmentDisplayMode === 'expanded' || !track.alignmentDisplayMode) ? 'current' : '')
      + action('bam-display-collapsed', 'Collapsed', alignmentTracks.every((track) => track.alignmentDisplayMode === 'collapsed') ? 'current' : '')
      + action('bam-display-squished', 'Squished', alignmentTracks.every((track) => track.alignmentDisplayMode === 'squished') ? 'current' : ''))
    typeItems += action('bam-pairs', 'View as pairs', alignmentTracks.every((track) => track.bamViewAsPairs) ? 'current' : '')
      + action('bam-mismatches', 'Show mismatches', alignmentTracks.every((track) => track.bamShowMismatches !== false) ? 'current' : '')
    typeItems += submenu('bam-color', 'Color by', bamColorModeLabel(colorMode),
      action('bam-color-track', 'Track', alignmentTracks.every((track) => track.bamColorMode === 'track' || !track.bamColorMode) ? 'current' : '')
      + action('bam-color-strand', 'Strand', alignmentTracks.every((track) => track.bamColorMode === 'strand') ? 'current' : '')
      + action('bam-color-pair-orientation', 'Pair orientation', alignmentTracks.every((track) => track.bamColorMode === 'pair-orientation') ? 'current' : '')
      + action('bam-color-mapping-quality', 'Mapping quality', alignmentTracks.every((track) => track.bamColorMode === 'mapping-quality') ? 'current' : ''))
    typeItems += submenu('bam-filters', 'Read filters', sameValue(alignmentTracks.map((track) => track.bamMinMapq ?? 0)) ? `MAPQ ≥ ${alignmentTracks[0].bamMinMapq ?? 0}` : 'Mixed',
      action('bam-mapq', 'Minimum mapping quality…', sameValue(alignmentTracks.map((track) => track.bamMinMapq ?? 0)) ? String(alignmentTracks[0].bamMinMapq ?? 0) : 'Mixed')
      + action('bam-duplicates', 'Include duplicate reads', alignmentTracks.every((track) => track.bamIncludeDuplicates) ? 'current' : '')
      + action('bam-secondary', 'Include secondary alignments', alignmentTracks.every((track) => track.bamIncludeSecondary) ? 'current' : '')
      + action('bam-supplementary', 'Include supplementary alignments', alignmentTracks.every((track) => track.bamIncludeSupplementary) ? 'current' : ''))
  }
  if (geneTracks.length) {
    const mode = sameValue(geneTracks.map((track) => track.geneDisplayMode ?? 'collapsed')) ? geneTracks[0].geneDisplayMode ?? 'collapsed' : 'mixed'
    typeItems += submenu('genes-display', 'Display mode', capitalize(mode),
      action('genes-collapsed', 'Collapsed', geneTracks.every((track) => track.geneDisplayMode === 'collapsed' || !track.geneDisplayMode) ? 'current' : '')
      + action('genes-expanded', 'Expanded transcripts', geneTracks.every((track) => track.geneDisplayMode === 'expanded') ? 'current' : '')
      + action('genes-squished', 'Squished transcripts', geneTracks.every((track) => track.geneDisplayMode === 'squished') ? 'current' : ''))
  }
  let sourceItems = ''
  if (one && target.kind !== 'genes') {
    sourceItems = action('duplicate', 'Duplicate track')
    if (target.kind === 'stranded') {
      sourceItems += action('relink-plus', runtimeSources.has(target.sourceIds[0]) ? 'Replace positive-strand source…' : 'Relink positive-strand source…')
        + action('relink-minus', runtimeSources.has(target.sourceIds[1]) ? 'Replace negative-strand source…' : 'Relink negative-strand source…')
    } else sourceItems += action('relink', target.kind === 'alignment'
      ? runtimeSources.has(target.sourceIds[0]) ? 'Replace BAM and index…' : 'Relink BAM and index…'
      : runtimeSources.has(target.sourceIds[0]) ? 'Replace source file…' : 'Relink source file…')
  }
  const sections = [
    one ? action('rename', 'Rename…') : '',
    samePane ? action(target.pane === 'main' ? 'move-pane-bottom' : 'move-pane-main', target.pane === 'main' ? 'Move to lower area' : 'Move to upper area') : '',
    appearanceItems ? submenu('appearance', 'Appearance', '', appearanceItems) : '',
    typeItems,
    groupingItems ? submenu('grouping', 'Grouping', '', groupingItems) : '',
    sourceItems ? submenu('source', 'Source', '', sourceItems) : '',
    dataOnly ? action('remove', one ? 'Remove track' : `Remove ${selected.length} selected tracks`, '', false, true) : '',
  ].filter(Boolean)
  trackContextMenu.innerHTML = `
    <div class="context-heading"><strong>${one ? escapeHtml(target.label) : `${selected.length} tracks selected`}</strong><span>${one ? trackKindLabel(target) : 'Actions shared by the selection'}</span></div>
    ${sections.join('<span class="context-separator"></span>')}
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

function trackKindLabel(track: TrackSpec): string {
  if (track.kind === 'genes') return 'Gene annotation'
  if (track.kind === 'interval') return 'Interval track'
  if (track.kind === 'interaction') return 'BEDPE interactions'
  if (track.kind === 'matrix') return 'Contact matrix'
  if (track.kind === 'alignment') return 'BAM alignments'
  if (track.kind === 'stranded') return 'Stranded signal pair'
  if (track.signalStrand) return `${track.signalStrand === 'plus' ? 'Positive' : 'Negative'}-strand signal`
  return 'Signal track'
}

function capitalize(value: string): string {
  return value ? value[0].toLocaleUpperCase() + value.slice(1) : value
}

function bamViewModeLabel(mode: string): string {
  if (mode === 'both') return 'Coverage + alignments'
  if (mode === 'coverage') return 'Coverage only'
  if (mode === 'alignments') return 'Alignments only'
  return capitalize(mode)
}

function bamColorModeLabel(mode: string): string {
  if (mode === 'pair-orientation') return 'Pair orientation'
  if (mode === 'mapping-quality') return 'Mapping quality'
  return capitalize(mode)
}

function signalTracksShareScales(tracks: readonly TrackSpec[]): boolean {
  let comparableChannel = false
  for (const channel of ['ordinary', 'plus', 'minus'] as const) {
    const ids = tracks.flatMap((track) => {
      if (track.kind === 'stranded') return channel === 'plus' ? [track.scaleBindingId] : channel === 'minus' ? [track.negativeScaleBindingId] : []
      if (track.kind !== 'signal' || (track.signalStrand ?? 'ordinary') !== channel) return []
      return [track.scaleBindingId]
    }).filter((id): id is string => Boolean(id))
    if (ids.length < 2) continue
    comparableChannel = true
    if (!ids.every((id) => id === ids[0])) return false
  }
  return comparableChannel
}

function signalTracksCanShareScales(tracks: readonly TrackSpec[]): boolean {
  for (const channel of ['ordinary', 'plus', 'minus'] as const) {
    const count = tracks.filter((track) => track.kind === 'stranded'
      ? channel !== 'ordinary'
      : track.kind === 'signal' && (track.signalStrand ?? 'ordinary') === channel).length
    if (count >= 2) return true
  }
  return false
}

function sameValue<T>(values: readonly T[]): boolean {
  return values.length > 0 && values.every((value) => Object.is(value, values[0]))
}

function requiredName(value: string): string | undefined {
  return value.trim() ? undefined : 'Enter a name.'
}

function parseRange(value: string): { min: number; max: number } | undefined {
  const parts = value.split(',').map((item) => Number(item.trim()))
  if (parts.length !== 2 || !parts.every(Number.isFinite) || parts[0] === parts[1]) return undefined
  return { min: Math.min(parts[0], parts[1]), max: Math.max(parts[0], parts[1]) }
}

function validateRange(value: string): string | undefined {
  return parseRange(value) ? undefined : 'Enter two different numbers separated by a comma.'
}

function validatePositiveNumber(value: string): string | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? undefined : 'Enter a number greater than zero.'
}

function validateMapq(value: string): string | undefined {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= 255 ? undefined : 'Enter a whole number from 0 to 255.'
}

function validateTrackHeight(value: string): string | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 20 && number <= 4_000 ? undefined : 'Enter a pixel height from 20 to 4000.'
}

function commonValues<T>(sets: readonly (readonly T[])[]): T[] {
  if (!sets.length) return []
  return sets[0].filter((value, index) => sets[0].indexOf(value) === index && sets.slice(1).every((items) => items.includes(value)))
}

type ContextActionRenderer = (id: string, label: string, detail?: string, disabled?: boolean, danger?: boolean) => string
type ContextSubmenuRenderer = (id: string, label: string, detail: string, items: string) => string

function matrixContextMenuMarkup(
  matrixTracks: readonly TrackSpec[],
  action: ContextActionRenderer,
  submenu: ContextSubmenuRenderer,
): string {
  if (!matrixTracks.length) return ''
  const metadata = matrixTracks.map((track) => {
    const source = runtimeSources.get(track.sourceIds[0])
    return isNativeMatrixSource(source) ? source.matrixMetadata : undefined
  })
  const commonResolutions = commonValues(metadata.map((item) => item?.resolutions ?? []))
  const commonNormalizations = commonValues(metadata.map((item) => item?.normalizations ?? []))
  const resolutionLabel = sameValue(matrixTracks.map((track) => track.matrixResolution))
    ? matrixTracks[0].matrixResolution ? formatBases(matrixTracks[0].matrixResolution) : 'Automatic'
    : 'Mixed'
  const normalizationLabel = sameValue(matrixTracks.map((track) => track.matrixNormalization))
    ? matrixTracks[0].matrixNormalization ?? metadata[0]?.defaultNormalization ?? 'raw'
    : 'Mixed'
  return [
    action('matrix-flip', 'Draw matrix downward', matrixTracks.every((track) => track.matrixDirection === 'down') ? 'current' : ''),
    submenu('matrix-resolution', 'Resolution', resolutionLabel,
      action('matrix-resolution-auto', 'Automatic', matrixTracks.every((track) => track.matrixResolution === undefined) ? 'current' : '')
      + commonResolutions.map((resolution) => action(`matrix-resolution-value-${resolution}`, formatBases(resolution), matrixTracks.every((track) => track.matrixResolution === resolution) ? 'current' : '')).join('')),
    commonNormalizations.length ? submenu('matrix-normalization', 'Normalization', escapeHtml(normalizationLabel),
      commonNormalizations.map((normalization) => action(`matrix-normalization-value-${encodeURIComponent(normalization)}`, escapeHtml(normalization), matrixTracks.every((track) => track.matrixNormalization === normalization) ? 'current' : '')).join('')) : '',
    action('matrix-settings', 'Matrix settings…', matrixTracks.length > 1 ? `${matrixTracks.length} tracks` : ''),
  ].join('')
}

function openGroupContextMenu(groupId: string, x: number, y: number): void {
  const group = store.current.groups.find((item) => item.id === groupId)
  if (!group) return
  const members = store.current.tracks.filter((track) => track.displayGroupId === groupId)
  const signalIds = members.filter((track) => track.kind === 'signal' || track.kind === 'stranded').map((track) => track.id)
  const matrixTracks = members.filter((track) => track.kind === 'matrix')
  const matricesOnly = matrixTracks.length > 0 && matrixTracks.length === members.length
  const hasOrdinaryColor = members.some((track) => track.kind !== 'stranded' && !(track.kind === 'signal' && track.signalStrand))
  const hasLinkedStranded = members.some((track) => track.kind === 'stranded')
  const hasPlusColor = members.some((track) => track.kind === 'stranded' || (track.kind === 'signal' && track.signalStrand === 'plus'))
  const hasMinusColor = members.some((track) => track.kind === 'stranded' || (track.kind === 'signal' && track.signalStrand === 'minus'))
  const memberIds = new Set(members.map((track) => track.id))
  const selectedOutside = store.current.tracks.filter((track) => track.kind !== 'genes' && selectedTrackIds.has(track.id) && !memberIds.has(track.id))
  const action = (id: string, label: string, detail = '', disabled = false, danger = false) => {
    const current = detail === 'current' || detail === 'on'
    const visibleDetail = current || detail === 'off' ? '' : detail
    return `<button class="context-item${current ? ' is-current' : ''}${danger ? ' danger' : ''}" data-context-action="${id}" type="button" role="menuitem" ${current ? 'aria-current="true"' : ''} ${disabled ? 'disabled' : ''}><span>${label}</span>${visibleDetail ? `<small>${visibleDetail}</small>` : ''}</button>`
  }
  contextSubmenuItems.clear()
  const submenu = (id: string, label: string, detail: string, items: string) => {
    if ((items.match(/data-context-action=/g) ?? []).length <= 1) return items
    contextSubmenuItems.set(id, items)
    return `<button class="context-item context-submenu-trigger" data-context-submenu="${id}" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false"><span>${label}</span><small>${detail}</small></button>`
  }
  trackContextMenu.innerHTML = `
    <div class="context-heading"><strong>${escapeHtml(group.label)}</strong><span>${members.length} track${members.length === 1 ? '' : 's'} · group options</span></div>
    ${[
      submenu('group-add', 'Add tracks', '',
        action('group-open', 'Add files…')
        + action('group-add-selected', 'Add selected tracks', selectedOutside.length ? `${selectedOutside.length} selected` : '', selectedOutside.length === 0)),
      submenu('group-appearance', 'Appearance', '',
        (hasOrdinaryColor ? action(hasLinkedStranded ? 'group-color-ordinary' : 'group-color-all', hasLinkedStranded ? 'Set unstranded track color…' : 'Set group track color…') : '')
        + (hasPlusColor ? action('group-color-plus', 'Set positive-strand color…') : '')
        + (hasMinusColor ? action('group-color-minus', 'Set negative-strand color…') : '')
        + action('group-height', 'Set group track height…')),
      signalIds.length ? submenu('group-scaling', 'Signal scaling', group.scaleBehavior === 'independent' ? 'Independent' : 'Shared',
        action('group-auto-linked', 'Share automatic scales', group.scaleBehavior === 'linked' ? 'current' : '')
        + action('group-auto-independent', 'Scale tracks independently', group.scaleBehavior === 'independent' ? 'current' : '')
        + action('group-fixed', 'Set shared fixed range…')) : '',
      matricesOnly ? matrixContextMenuMarkup(matrixTracks, action, submenu) : '',
      action('group-rename', 'Rename group…'),
      action('group-remove', 'Ungroup tracks'),
      action('group-remove-tracks', 'Remove all tracks in group', `${members.length} track${members.length === 1 ? '' : 's'}`, false, true),
    ].filter(Boolean).join('<span class="context-separator"></span>')}
  `
  trackContextMenu.dataset.groupId = groupId
  delete trackContextMenu.dataset.trackId
  positionContextMenu(x, y)
}

function positionContextMenu(x: number, y: number): void {
  closeContextSubmenu()
  trackContextMenu.hidden = false
  const menuWidth = trackContextMenu.offsetWidth
  const menuHeight = trackContextMenu.offsetHeight
  trackContextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8))}px`
  trackContextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))}px`
}

function openContextSubmenu(trigger: HTMLButtonElement): void {
  cancelContextSubmenuClose()
  const items = contextSubmenuItems.get(trigger.dataset.contextSubmenu ?? '')
  if (!items) return
  for (const candidate of trackContextMenu.querySelectorAll<HTMLElement>('[data-context-submenu]')) candidate.setAttribute('aria-expanded', String(candidate === trigger))
  trackContextFlyout.innerHTML = items
  trackContextFlyout.hidden = false
  const rect = trigger.getBoundingClientRect()
  const flyoutWidth = trackContextFlyout.offsetWidth
  const flyoutHeight = trackContextFlyout.offsetHeight
  const right = rect.right + 4
  const left = rect.left - flyoutWidth - 4
  trackContextFlyout.style.left = `${right + flyoutWidth <= window.innerWidth - 8 ? right : Math.max(8, left)}px`
  trackContextFlyout.style.top = `${Math.max(8, Math.min(rect.top - 6, window.innerHeight - flyoutHeight - 8))}px`
}

function scheduleContextSubmenuClose(): void {
  cancelContextSubmenuClose()
  contextSubmenuCloseTimer = window.setTimeout(closeContextSubmenu, 100)
}

function cancelContextSubmenuClose(): void {
  if (contextSubmenuCloseTimer !== undefined) window.clearTimeout(contextSubmenuCloseTimer)
  contextSubmenuCloseTimer = undefined
}

function closeContextSubmenu(): void {
  cancelContextSubmenuClose()
  trackContextFlyout.hidden = true
  for (const trigger of trackContextMenu.querySelectorAll<HTMLElement>('[data-context-submenu]')) trigger.setAttribute('aria-expanded', 'false')
}

function closeTrackContextMenu(): void {
  trackContextMenu.hidden = true
  closeContextSubmenu()
}

async function handleTrackContextAction(event: MouseEvent): Promise<void> {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-context-action]')
  const groupId = trackContextMenu.dataset.groupId
  const targetId = trackContextMenu.dataset.trackId
  if (!button) return
  const command = button.dataset.contextAction
  if (groupId) {
    closeTrackContextMenu()
    await handleGroupContextAction(command, groupId)
    return
  }
  if (!targetId) return
  const ids = [...selectedTrackIds]
  const signalIds = store.current.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && ids.includes(track.id)).map((track) => track.id)
  const dataIds = store.current.tracks.filter((track) => track.kind !== 'genes' && ids.includes(track.id)).map((track) => track.id)
  const intervalIds = store.current.tracks.filter((track) => track.kind === 'interval' && ids.includes(track.id)).map((track) => track.id)
  const interactionIds = store.current.tracks.filter((track) => track.kind === 'interaction' && ids.includes(track.id)).map((track) => track.id)
  const matrixIds = store.current.tracks.filter((track) => track.kind === 'matrix' && ids.includes(track.id)).map((track) => track.id)
  const alignmentIds = store.current.tracks.filter((track) => track.kind === 'alignment' && ids.includes(track.id)).map((track) => track.id)
  const geneIds = store.current.tracks.filter((track) => track.kind === 'genes' && ids.includes(track.id)).map((track) => track.id)
  closeTrackContextMenu()
  if (command === 'rename') {
    const track = store.current.tracks.find((item) => item.id === targetId)
    const label = (await requestText({ title: 'Rename track', label: 'Track name', initial: track?.label ?? '', submitLabel: 'Rename', validate: requiredName }))?.trim()
    if (label) store.edit((draft) => { const item = draft.tracks.find((track) => track.id === targetId); if (item) item.label = label })
  }
  if (command === 'color' || command === 'color-plus' || command === 'color-minus') {
    pendingColorGroupId = undefined
    pendingColorChannel = command === 'color-plus' ? 'plus' : command === 'color-minus' ? 'minus' : undefined
    const colorTrack = store.current.tracks.find((track) => track.id === targetId)
    const initial = command === 'color-minus' ? colorTrack?.negativeColor : colorTrack?.color
    openColorDialog(command === 'color-plus' ? 'Set positive-strand color' : command === 'color-minus' ? 'Set negative-strand color' : 'Set track color', initial ?? '#6d55e0')
  }
  if (command === 'height') await setTrackHeights(ids)
  if (command === 'move-pane-main' || command === 'move-pane-bottom') {
    const pane = command === 'move-pane-main' ? 'main' : 'bottom'
    const insertionIndex = store.current.tracks.filter((track) => track.pane === pane && !ids.includes(track.id)).length
    bottomPaneAutoFit = false
    store.edit((draft) => reorderTracks(draft, ids, pane, insertionIndex))
  }
  if (command === 'height-lock') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => ids.includes(track.id) && track.pane === 'main')
    const locked = !tracks.every((track) => track.heightLocked)
    for (const track of tracks) track.heightLocked = locked || undefined
  })
  if (command === 'group') {
    const first = store.current.tracks.find((track) => ids.includes(track.id))
    const current = store.current.groups.find((group) => group.id === first?.displayGroupId)?.label ?? ''
    const label = await requestText({ title: 'Group selected tracks', label: 'Group name', initial: current, submitLabel: 'Group tracks', validate: requiredName })
    if (label !== undefined) store.edit((draft) => assignDisplayGroup(draft, ids, label, { autoScale: savedGroupAutoscale() }))
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
    const entered = await requestText({ title: 'Set fixed y-axis range', label: 'Minimum, maximum', initial: `${suggested.min}, ${suggested.max}`, placeholder: '0, 100', submitLabel: 'Set range', validate: validateRange })
    const range = entered === undefined ? undefined : parseRange(entered)
    if (range) store.edit((draft) => {
      const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
      for (const scale of draft.scales) if (scaleIds.has(scale.id)) {
        scale.mode = 'fixed'
        scale.limits = range
      }
    })
  }
  if (command === 'scale-toggle-sharing') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => signalIds.includes(track.id))
    if (signalTracksShareScales(tracks)) unlinkScales(draft, signalIds)
    else linkScales(draft, signalIds)
  })
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
    store.edit((draft) => { for (const track of draft.tracks) if (geneIds.includes(track.id) && track.kind === 'genes') track.geneDisplayMode = mode })
  }
  if (command?.startsWith('interval-')) {
    const mode = command.slice(9) as 'collapsed' | 'expanded' | 'squished'
    store.edit((draft) => { for (const track of draft.tracks) if (intervalIds.includes(track.id) && track.kind === 'interval') track.intervalDisplayMode = mode })
  }
  if (command === 'interaction-flip') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => interactionIds.includes(track.id) && track.kind === 'interaction')
    const direction = tracks.length && tracks.every((track) => track.interactionDirection === 'down') ? 'up' : 'down'
    for (const track of tracks) track.interactionDirection = direction
  })
  if (command === 'interaction-filter-all' || command === 'interaction-filter-visible') store.edit((draft) => {
    for (const track of draft.tracks) if (interactionIds.includes(track.id) && track.kind === 'interaction') {
      track.interactionFilterMode = command === 'interaction-filter-visible' ? 'visible-genes' : 'all'
    }
  })
  if (command === 'interaction-filter-genes') {
    const tracks = store.current.tracks.filter((item) => interactionIds.includes(item.id) && item.kind === 'interaction')
    const initial = sameValue(tracks.map((track) => (track.interactionFilterGenes ?? []).join(', '))) ? (tracks[0]?.interactionFilterGenes ?? []).join(', ') : ''
    const entered = await requestText({ title: 'Filter interactions by gene', label: 'Gene symbols', initial, placeholder: 'RUNX1, MYC', submitLabel: 'Apply filter', message: 'Separate multiple symbols with commas or spaces. Leave blank to clear the filter.' })
    if (entered !== undefined) {
      const genes = [...new Set(entered.split(/[\s,;]+/).map((gene) => gene.trim().toLocaleUpperCase()).filter(Boolean))].slice(0, 100)
      store.edit((draft) => {
        for (const track of draft.tracks) if (interactionIds.includes(track.id) && track.kind === 'interaction') {
          track.interactionFilterGenes = genes
          track.interactionFilterMode = genes.length ? 'genes' : 'all'
        }
      })
      const unresolved = activeGeneSource ? genes.filter((gene) => !activeGeneSource?.find(gene)) : genes
      if (unresolved.length) showToast(`${unresolved.join(', ')} ${unresolved.length === 1 ? 'was' : 'were'} not found in the active annotation; matching BEDPE names instead.`)
    }
  }
  await applyMatrixContextAction(command, matrixIds)
  if (command?.startsWith('bam-view-')) {
    const mode = command.slice(9) as 'coverage' | 'alignments' | 'both'
    store.edit((draft) => { for (const track of draft.tracks) if (alignmentIds.includes(track.id) && track.kind === 'alignment') track.bamViewMode = mode })
  }
  if (command?.startsWith('bam-display-')) {
    const mode = command.slice(12) as 'collapsed' | 'expanded' | 'squished'
    store.edit((draft) => { for (const track of draft.tracks) if (alignmentIds.includes(track.id) && track.kind === 'alignment') track.alignmentDisplayMode = mode })
  }
  if (command?.startsWith('bam-color-')) {
    const mode = command.slice(10) as 'track' | 'strand' | 'pair-orientation' | 'mapping-quality'
    store.edit((draft) => { for (const track of draft.tracks) if (alignmentIds.includes(track.id) && track.kind === 'alignment') track.bamColorMode = mode })
  }
  if (command === 'bam-pairs') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => alignmentIds.includes(track.id) && track.kind === 'alignment')
    const enabled = !tracks.every((track) => track.bamViewAsPairs)
    for (const track of tracks) track.bamViewAsPairs = enabled
  })
  if (command === 'bam-mismatches') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => alignmentIds.includes(track.id) && track.kind === 'alignment')
    const enabled = !tracks.every((track) => track.bamShowMismatches !== false)
    for (const track of tracks) track.bamShowMismatches = enabled
  })
  if (command === 'bam-mapq') {
    const tracks = store.current.tracks.filter((item) => alignmentIds.includes(item.id) && item.kind === 'alignment')
    const initial = sameValue(tracks.map((track) => track.bamMinMapq ?? 0)) ? tracks[0]?.bamMinMapq ?? 0 : 0
    const entered = await requestText({ title: 'Minimum mapping quality', label: 'MAPQ threshold (0–255)', initial: String(initial), submitLabel: 'Apply filter', validate: validateMapq })
    const minimum = Number(entered)
    if (entered !== undefined && Number.isFinite(minimum) && minimum >= 0 && minimum <= 255) store.edit((draft) => {
      for (const track of draft.tracks) if (alignmentIds.includes(track.id) && track.kind === 'alignment') track.bamMinMapq = Math.round(minimum)
    })
  }
  if (command === 'bam-duplicates' || command === 'bam-secondary' || command === 'bam-supplementary') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => alignmentIds.includes(track.id) && track.kind === 'alignment')
    const enabled = command === 'bam-duplicates' ? !tracks.every((track) => track.bamIncludeDuplicates)
      : command === 'bam-secondary' ? !tracks.every((track) => track.bamIncludeSecondary)
        : !tracks.every((track) => track.bamIncludeSupplementary)
    for (const track of tracks) {
      if (command === 'bam-duplicates') track.bamIncludeDuplicates = enabled
      if (command === 'bam-secondary') track.bamIncludeSecondary = enabled
      if (command === 'bam-supplementary') track.bamIncludeSupplementary = enabled
    }
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

async function applyMatrixContextAction(command: string | undefined, matrixIds: readonly string[]): Promise<void> {
  if (!command?.startsWith('matrix-') || !matrixIds.length) return
  if (command === 'matrix-settings') {
    openMatrixSettingsDialog(matrixIds)
    return
  }
  if (command === 'matrix-flip') store.edit((draft) => {
    const tracks = draft.tracks.filter((item) => matrixIds.includes(item.id) && item.kind === 'matrix')
    const direction = tracks.length && tracks.every((track) => track.matrixDirection === 'down') ? 'up' : 'down'
    for (const track of tracks) track.matrixDirection = direction
  })
  if (command === 'matrix-resolution-auto') store.edit((draft) => {
    for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') track.matrixResolution = undefined
  })
  if (command.startsWith('matrix-resolution-value-')) {
    const resolution = Number(command.slice('matrix-resolution-value-'.length))
    if (resolution) store.edit((draft) => {
      for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') track.matrixResolution = resolution
    })
  }
  if (command.startsWith('matrix-normalization-value-')) {
    const normalization = decodeURIComponent(command.slice('matrix-normalization-value-'.length))
    if (normalization) store.edit((draft) => {
      for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') track.matrixNormalization = normalization
    })
  }
  if (command === 'matrix-transform-log' || command === 'matrix-transform-linear') store.edit((draft) => {
    for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') track.matrixTransform = command === 'matrix-transform-linear' ? 'linear' : 'log1p'
  })
  if (command === 'matrix-scale-auto') store.edit((draft) => {
    for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') track.matrixScaleMax = undefined
  })
  if (command === 'matrix-scale-fixed') {
    const tracks = store.current.tracks.filter((item) => matrixIds.includes(item.id) && item.kind === 'matrix')
    const initial = sameValue(tracks.map((track) => track.matrixScaleMax)) ? tracks[0]?.matrixScaleMax : undefined
    const entered = await requestText({ title: 'Set matrix intensity maximum', label: 'Maximum contact intensity (z-max)', initial: initial ? String(initial) : '', submitLabel: 'Set maximum', validate: validatePositiveNumber })
    const maximum = Number(entered)
    if (entered !== undefined && Number.isFinite(maximum) && maximum > 0) store.edit((draft) => {
      for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') track.matrixScaleMax = maximum
    })
  }
  if (command === 'matrix-palette-monochrome' || command === 'matrix-palette-warm' || command === 'matrix-palette-blue-black') store.edit((draft) => {
    for (const track of draft.tracks) if (matrixIds.includes(track.id) && track.kind === 'matrix') {
      track.matrixPalette = command === 'matrix-palette-warm' ? 'warm' : command === 'matrix-palette-blue-black' ? 'blue-black' : 'monochrome'
    }
  })
  if (command === 'matrix-palette-reverse') store.edit((draft) => {
    const tracks = draft.tracks.filter((track) => matrixIds.includes(track.id) && track.kind === 'matrix')
    const reversed = !tracks.every((track) => track.matrixPaletteReversed)
    for (const track of tracks) track.matrixPaletteReversed = reversed || undefined
  })
}

async function handleGroupContextAction(command: string | undefined, groupId: string): Promise<void> {
  const group = store.current.groups.find((item) => item.id === groupId)
  if (!group) return
  const members = store.current.tracks.filter((track) => track.displayGroupId === groupId)
  const memberIds = members.map((track) => track.id)
  const matrixIds = members.filter((track) => track.kind === 'matrix').map((track) => track.id)
  const matricesOnly = matrixIds.length > 0 && matrixIds.length === memberIds.length
  const hasLinkedStranded = store.current.tracks.some((track) => track.displayGroupId === groupId && track.kind === 'stranded')
  const signalIds = store.current.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && track.displayGroupId === groupId).map((track) => track.id)
  if (command === 'group-open') {
    pendingOpenGroupId = groupId
    void openTrackPicker()
  }
  if (command === 'group-add-selected') {
    const addIds = store.current.tracks.filter((track) => track.kind !== 'genes' && selectedTrackIds.has(track.id) && track.displayGroupId !== groupId).map((track) => track.id)
    store.edit((draft) => addTracksToGroup(draft, groupId, addIds))
  }
  if (command?.startsWith('group-color-')) {
    const requestedChannel = command.slice('group-color-'.length)
    const channel = requestedChannel === 'all' ? undefined : requestedChannel as SignalScaleChannel
    pendingColorGroupId = groupId
    pendingColorChannel = channel
    const initial = channel === 'plus' ? group.positiveColor : channel === 'minus' ? group.negativeColor : group.color
    const title = channel === undefined ? 'Set group track color' : channel === 'ordinary'
      ? hasLinkedStranded ? 'Set unstranded track group color' : 'Set group track color'
      : `Set ${channel}-strand group color`
    openColorDialog(title, initial ?? '#6d55e0')
  }
  if (command === 'group-height') await setTrackHeights(memberIds)
  if (matricesOnly) await applyMatrixContextAction(command, matrixIds)
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
    const entered = await requestText({ title: 'Set shared group range', label: 'Minimum, maximum', initial: `${suggested.min}, ${suggested.max}`, placeholder: '0, 100', submitLabel: 'Set range', validate: validateRange })
    const range = entered === undefined ? undefined : parseRange(entered)
    if (range) store.edit((draft) => {
      const draftGroup = draft.groups.find((item) => item.id === groupId)
      if (draftGroup) draftGroup.scaleBehavior = 'linked'
      linkScales(draft, signalIds)
      const scaleIds = new Set(draft.tracks.filter((track) => signalIds.includes(track.id)).flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
      for (const scale of draft.scales) if (scaleIds.has(scale.id)) { scale.mode = 'fixed'; scale.limits = range }
    })
  }
  if (command === 'group-rename') {
    const label = (await requestText({ title: 'Rename group', label: 'Group name', initial: group.label, submitLabel: 'Rename', validate: requiredName }))?.trim()
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

async function setTrackHeights(trackIds: readonly string[]): Promise<void> {
  const resizableTracks = store.current.tracks
    .filter((track) => trackIds.includes(track.id) && (track.kind !== 'genes' || track.pane !== 'bottom'))
  if (!resizableTracks.length) return
  const current = browser.getRenderedTrackHeight(resizableTracks[0])
  const entered = await requestText({ title: resizableTracks.length === 1 ? 'Set track height' : 'Set track heights', label: 'Height in pixels (20–4000)', initial: String(Math.round(current)), submitLabel: 'Set height', validate: validateTrackHeight })
  const pixels = Number(entered)
  if (entered === undefined || !Number.isFinite(pixels) || pixels < 20 || pixels > 4_000) return
  store.edit((draft) => {
    for (const track of draft.tracks) if (resizableTracks.some((candidate) => candidate.id === track.id)) {
      track.height = heightScoreForPixels(track.kind, pixels)
      delete track.fittedHeight
      track.manualPixelHeight = Math.round(pixels)
    }
  })
}

function fitUpperTracks(announce = true): void {
  const upperTracks = store.current.tracks.filter((track) => track.enabled && track.pane === 'main')
  if (!upperTracks.length) {
    if (announce) showToast('There are no upper tracks to fit.')
    return
  }
  const visibleHeight = Math.max(40, mainTrackScroll.clientHeight - bottomPane.getBoundingClientRect().height - headerCanvas.getBoundingClientRect().height)
  // BED tracks keep their compact label-fitting height. Locked tracks retain
  // their exact current height while the remaining flexible tracks share what is left.
  const lockedTracks = upperTracks.filter((track) => track.heightLocked)
  const fixedIntervals = upperTracks.filter((track) => track.kind === 'interval' && !track.heightLocked)
  const flexibleTracks = upperTracks.filter((track) => track.kind !== 'interval' && !track.heightLocked)
  if (lockedTracks.length === upperTracks.length) {
    if (announce) showToast('All upper tracks have locked heights.')
    return
  }
  const fixedHeight = fixedIntervals.reduce((sum, track) => sum + trackPixelHeight(track.kind, track.height), 0)
    + lockedTracks.reduce((sum, track) => sum + browser.getRenderedTrackHeight(track), 0)
  const availableHeight = Math.max(0, Math.floor(visibleHeight - fixedHeight))
  const fittedPixels = distributeFittedPixels(
    flexibleTracks.map((track) => browser.getFittedMinimumHeight(track)),
    flexibleTracks.map((track) => track.kind === 'stranded' ? 2 : 1),
    availableHeight,
  )
  const fittedById = new Map(flexibleTracks.map((track, index) => [track.id, fittedPixels[index]]))
  store.edit((draft) => {
    for (const track of draft.tracks) if (track.enabled && track.pane === 'main') {
      if (track.heightLocked) continue
      delete track.manualPixelHeight
      if (track.kind === 'interval') {
        delete track.fittedHeight
        continue
      }
      const pixels = fittedById.get(track.id)
      if (!pixels) continue
      track.height = heightScoreForPixels(track.kind, pixels)
      track.fittedHeight = pixels
    }
  })
  mainTrackScroll.scrollTop = 0
  requestAnimationFrame(() => { mainTrackScroll.scrollTop = 0 })
  if (announce) showToast(`Fit ${upperTracks.length - lockedTracks.length} upper track${upperTracks.length - lockedTracks.length === 1 ? '' : 's'}${lockedTracks.length ? `; kept ${lockedTracks.length} height lock${lockedTracks.length === 1 ? '' : 's'}` : ''}.`)
}

function scheduleUpperAutoFit(): void {
  if (!upperPaneAutoFit) return
  if (upperAutoFitFrame !== undefined) cancelAnimationFrame(upperAutoFitFrame)
  upperAutoFitFrame = requestAnimationFrame(() => {
    upperAutoFitFrame = undefined
    fitUpperTracks(false)
  })
}

function updateUpperAutoFitControl(): void {
  fitTracksAuto.classList.toggle('is-active', upperPaneAutoFit)
  fitTracksAuto.setAttribute('aria-pressed', String(upperPaneAutoFit))
  fitTracksAuto.title = upperPaneAutoFit ? 'Auto-fit is on · click to turn off' : 'Auto-fit is off · click to keep upper tracks fitted'
  fitTracksAuto.setAttribute('aria-label', fitTracksAuto.title)
}

function openMatrixSettingsDialog(trackIds: readonly string[]): void {
  const tracks = store.current.tracks.filter((track) => trackIds.includes(track.id) && track.kind === 'matrix')
  if (!tracks.length) return
  pendingMatrixTrackIds = tracks.map((track) => track.id)
  const candidateGroupId = tracks[0].displayGroupId
  const groupMembers = candidateGroupId ? store.current.tracks.filter((track) => track.displayGroupId === candidateGroupId) : []
  pendingMatrixGroupId = candidateGroupId && tracks.every((track) => track.displayGroupId === candidateGroupId)
    && groupMembers.length === tracks.length && groupMembers.every((track) => track.kind === 'matrix')
    ? candidateGroupId
    : undefined
  const first = tracks[0]
  matrixSettingsScope.textContent = tracks.length === 1 ? first.label : `${tracks.length} matrix tracks`
  matrixSettingsApply.textContent = tracks.length === 1 ? 'Apply' : `Apply to ${tracks.length} tracks`
  matrixScaleMode.value = first.matrixScaleMax === undefined ? 'auto' : 'fixed'
  matrixScaleMaximum.value = first.matrixScaleMax === undefined ? '' : String(first.matrixScaleMax)
  matrixTransform.value = first.matrixTransform ?? 'log1p'
  matrixPalette.value = first.matrixPalette ?? 'monochrome'
  matrixDialogColors = first.matrixPalette === 'custom' && (first.matrixPaletteColors?.length ?? 0) >= 2
    ? [...first.matrixPaletteColors!]
    : [...matrixPresetColors(first.matrixPalette ?? 'monochrome', first.color)]
  matrixHighColorStart.value = String(Math.round((first.matrixHighColorStart ?? 0.9) * 100))
  matrixPaletteReversed.checked = first.matrixPaletteReversed === true
  matrixGroupScalingRow.hidden = !pendingMatrixGroupId
  const group = store.current.groups.find((item) => item.id === pendingMatrixGroupId)
  matrixGroupScaling.value = group?.scaleBehavior === 'independent' ? 'independent' : 'linked'
  renderMatrixPaletteColors()
  updateMatrixSettingsVisibility()
  updateMatrixHighColorOutput()
  matrixSettingsContent.scrollTop = 0
  matrixSettingsDialog.hidden = false
  window.setTimeout(() => matrixScaleMode.focus(), 0)
}

function matrixPresetColors(palette: MatrixPalette, trackColor: string): readonly string[] {
  if (palette === 'blue-black') return MATRIX_BLUE_BLACK_COLORS
  if (palette === 'monochrome') return [trackColor, trackColor]
  return MATRIX_WARM_COLORS
}

function renderMatrixPaletteColors(): void {
  matrixPaletteColors.innerHTML = matrixDialogColors.map((color, index) => `
    <label><span>${index === 0 ? 'Low' : index === matrixDialogColors.length - 1 ? 'High' : `Stop ${index + 1}`}</span><input type="color" value="${escapeHtml(normalizedHexColor(color) ?? '#111111')}" data-matrix-color-index="${index}" /><code>${escapeHtml(normalizedHexColor(color) ?? '#111111')}</code><button type="button" data-remove-matrix-color="${index}" ${matrixDialogColors.length <= 2 ? 'disabled' : ''} aria-label="Remove color">×</button></label>
  `).join('')
}

function updateMatrixSettingsVisibility(): void {
  matrixScaleMaximum.disabled = matrixScaleMode.value !== 'fixed'
  matrixPaletteEditor.hidden = matrixPalette.value !== 'custom'
  matrixHighColorStart.disabled = matrixPalette.value === 'monochrome'
}

function updateMatrixHighColorOutput(): void {
  matrixHighColorOutput.value = `${matrixHighColorStart.value}%`
}

function applyMatrixSettingsDialog(): void {
  const fixedMaximum = Number(matrixScaleMaximum.value)
  if (matrixScaleMode.value === 'fixed' && (!Number.isFinite(fixedMaximum) || fixedMaximum <= 0)) {
    matrixScaleMaximum.focus()
    return
  }
  const palette = matrixPalette.value as MatrixPalette
  const colors = matrixDialogColors.map((color) => normalizedHexColor(color)).filter((color): color is string => Boolean(color)).slice(0, 8)
  if (palette === 'custom' && colors.length < 2) return
  const highColorStart = Math.max(0.5, Math.min(0.99, Number(matrixHighColorStart.value) / 100))
  store.edit((draft) => {
    for (const track of draft.tracks) {
      if (!pendingMatrixTrackIds.includes(track.id) || track.kind !== 'matrix') continue
      track.matrixScaleMax = matrixScaleMode.value === 'fixed' ? fixedMaximum : undefined
      track.matrixTransform = matrixTransform.value === 'linear' ? 'linear' : 'log1p'
      track.matrixPalette = palette
      track.matrixPaletteColors = palette === 'custom' ? [...colors] : undefined
      track.matrixHighColorStart = highColorStart
      track.matrixPaletteReversed = matrixPaletteReversed.checked || undefined
    }
    const group = draft.groups.find((item) => item.id === pendingMatrixGroupId)
    if (group) group.scaleBehavior = matrixGroupScaling.value === 'independent' ? 'independent' : 'linked'
  })
  closeMatrixSettingsDialog()
}

function closeMatrixSettingsDialog(): void {
  matrixSettingsDialog.hidden = true
  pendingMatrixTrackIds = []
  pendingMatrixGroupId = undefined
}

function openColorDialog(title: string, initialColor: string): void {
  colorDialog.querySelector('#color-dialog-title')!.textContent = title
  setColorPickerHex(initialColor)
  colorDialog.hidden = false
  window.setTimeout(() => trackColorInput.focus(), 0)
}

function requestText(options: {
  title: string
  label: string
  initial?: string
  placeholder?: string
  submitLabel?: string
  message?: string
  validate?: (value: string) => string | undefined
}): Promise<string | undefined> {
  return new Promise((resolve) => openActionDialog({
    mode: 'input',
    submitLabel: options.submitLabel ?? 'Apply',
    ...options,
    resolve: (value) => resolve(typeof value === 'string' ? value : undefined),
  }))
}

function confirmAction(options: { title: string; message: string; submitLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => openActionDialog({
    mode: 'confirm',
    ...options,
    resolve: (value) => resolve(value === true),
  }))
}

function showNotice(title: string, message: string): Promise<void> {
  return new Promise((resolve) => openActionDialog({
    mode: 'notice',
    title,
    message,
    submitLabel: 'Close',
    resolve: () => resolve(),
  }))
}

function openActionDialog(request: ActionDialogRequest): void {
  if (pendingActionDialog) closeActionDialog(undefined)
  pendingActionDialog = request
  actionDialogTitle.textContent = request.title
  actionDialogMessage.textContent = request.message ?? ''
  actionDialogMessage.hidden = !request.message
  actionDialogField.hidden = request.mode !== 'input'
  actionDialogLabel.textContent = request.label ?? ''
  actionDialogInput.value = request.initial ?? ''
  actionDialogInput.placeholder = request.placeholder ?? ''
  actionDialogError.textContent = ''
  actionDialogCancel.hidden = request.mode === 'notice'
  actionDialogSubmit.textContent = request.submitLabel
  actionDialogSubmit.classList.toggle('danger', request.danger === true)
  actionDialog.hidden = false
  window.setTimeout(() => request.mode === 'input' ? actionDialogInput.select() : actionDialogSubmit.focus(), 0)
}

function handleActionDialogSubmit(event: SubmitEvent): void {
  event.preventDefault()
  const request = pendingActionDialog
  if (!request) return
  if (request.mode === 'input') {
    const error = request.validate?.(actionDialogInput.value)
    actionDialogError.textContent = error ?? ''
    if (error) return actionDialogInput.focus()
    closeActionDialog(actionDialogInput.value)
    return
  }
  closeActionDialog(true)
}

function closeActionDialog(value: string | boolean | undefined): void {
  const request = pendingActionDialog
  if (!request) return
  pendingActionDialog = undefined
  actionDialog.hidden = true
  actionDialogSubmit.classList.remove('danger')
  request.resolve(value)
}

function showInteractionGuide(): Promise<void> {
  return showNotice('Track interactions', 'Hold the left mouse button on a track to select it. Use Ctrl+click to select additional tracks and Shift+click to select a range; clicking or right-clicking a group card adds all of its tracks. Drag selected tracks or use their context menu to move them between the upper and lower areas. Hover over a track’s bottom line for a quarter second before dragging its height. The mouse wheel scrolls; Ctrl+wheel zooms. Right-click a track or group card for options.')
}

function showFirstRunInteractionHint(): void {
  if (localStorage.getItem(INTERACTION_GUIDE_SEEN_KEY) === 'true') return
  localStorage.setItem(INTERACTION_GUIDE_SEEN_KEY, 'true')
  showToast('Tip: hold a track to select it, Ctrl+click to select more, and right-click track labels for options.', false, 8_000)
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
    if (expectedKind !== opened.kind) throw new Error(`Choose another ${track.kind === 'interval' ? 'BED interval' : track.kind === 'interaction' ? 'BEDPE interaction' : track.kind === 'matrix' ? 'contact matrix' : track.kind === 'alignment' ? 'BAM and matching index' : 'signal'} file for this track.`)
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
      const draftTrack = draft.tracks.find((item) => item.id === id)
      if (draftTrack?.kind === 'matrix' && isNativeMatrixSource(source)) {
        draftTrack.matrixResolution = undefined
        draftTrack.matrixNormalization = source.matrixMetadata.defaultNormalization
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
  if (bottomPaneAutoFit) fitBottomPaneToContent()
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
    if (bottomPaneAutoFit) fitBottomPaneToContent()
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
    if (bottomPaneAutoFit) fitBottomPaneToContent()
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

function savedUpperPaneAutoFit(): boolean {
  return localStorage.getItem(UPPER_PANE_AUTO_FIT_KEY) === 'true'
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
  const minimumSpan = Math.min(10, chromosomeLength)
  const position = chromosomeLength === minimumSpan
    ? 0
    : Math.log(chromosomeLength / Math.min(chromosomeLength, span)) / Math.log(chromosomeLength / minimumSpan)
  zoomLevel.value = String(Math.max(0, Math.min(100, position * 100)))
  zoomLevel.setAttribute('aria-label', `Zoom: ${formatZoomPercentage(percentage)}`)
  zoomLevel.title = `${percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}% zoom · ${formatBases(span)} visible · 100% shows the full chromosome`
}

function zoomFromSlider(value: number): void {
  const current = browser.getRegion()
  const chromosomeLength = activeChromosomes.get(current.chr)
  if (!chromosomeLength) return
  const minimumSpan = Math.min(10, chromosomeLength)
  const position = Math.max(0, Math.min(1, value / 100))
  const targetSpan = chromosomeLength * Math.pow(minimumSpan / chromosomeLength, position)
  browser.zoom(targetSpan / Math.max(1, current.end - current.start))
}

function fitBottomPaneToContent(): void {
  setBottomPaneHeight(browser.getPaneContentHeight('bottom') + 1)
}

function setBottomPaneHeight(requested: number): void {
  const measuredHeight = document.querySelector<HTMLElement>('.browser-body')?.clientHeight ?? 0
  const bodyHeight = measuredHeight > 0 ? measuredHeight : window.innerHeight
  const height = Math.max(44, Math.min(requested, bodyHeight * 0.78))
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
