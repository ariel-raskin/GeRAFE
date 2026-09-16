import { clampRegion, formatBases, formatLocus } from './genome.ts'
import type { Cytoband } from './cytoband.ts'
import type { GeneFeature, GeneSource, TranscriptFeature } from './reference.ts'
import { computeScaleDomains, createTrackDocument, signalFeatureKey } from './track-document.ts'
import type { TrackDocument, TrackSpec } from './track-document.ts'
import type { AlignmentCoverageFeature, AlignmentFeature, InteractionFeature, IntervalFeature, MatrixFeature, Region, SignalFeature, TrackSource, TrackRuntime } from './types.ts'
import { SUPPORTED_TRACK_EXTENSION_LABEL } from './supported-formats.ts'

const RULER_HEIGHT = 108
const TRACK_HEIGHT = 132
const GROUP_RAIL_WIDTH = 24
const LABEL_WIDTH = 176
const PLOT_LEFT = LABEL_WIDTH
const SCALE_LANE_MIN_WIDTH = 34
const LABEL_CONTENT_LEFT = GROUP_RAIL_WIDTH + 8
const LABEL_CONTENT_RIGHT = LABEL_WIDTH - 8
const OVERSCAN_FACTOR = 1
const MATRIX_OVERSCAN_FACTOR = 0.5
const GENE_CONTENT_PADDING = 6
const MIN_BOTTOM_GENE_HEIGHT = 44

export interface BrowserCallbacks {
  onRegionChange(region: Region): void
  onPerformance(sample: { renderMs: number; fps: number; visibleFeatures: number }): void
  onTracksChange(tracks: readonly TrackRuntime[]): void
  onTrackSelection(trackId: string, additive: boolean, extend: boolean): void
  onGroupSelection(groupId: string, additive: boolean): void
  onClearSelection(): void
  onTrackContextMenu(trackId: string, x: number, y: number): void
  onGroupContextMenu(groupId: string, x: number, y: number): void
  onTracksReorder(trackIds: readonly string[], pane: 'main' | 'bottom', insertionIndex: number, withinGroupId?: string): void
  onTrackHeightsResize(updates: readonly { id: string; pixels: number }[]): void
}

interface GeneRenderBlock {
  gene: GeneFeature
  transcripts: readonly TranscriptFeature[]
  firstSlot: number
  geneX1: number
  geneX2: number
  labelX?: number
  labelLane?: number
}

interface GeneRenderLayout {
  blocks: readonly GeneRenderBlock[]
  slotHeight: number
  contentHeight: number
  transcriptCount: number
}

export class GenomeBrowser {
  private context: CanvasRenderingContext2D
  private readonly mainContext: CanvasRenderingContext2D
  private readonly bottomContext: CanvasRenderingContext2D
  private readonly headerContext: CanvasRenderingContext2D
  private region: Region
  private chromosomes: ReadonlyMap<string, number>
  private document: TrackDocument
  private runtimes = new Map<string, TrackRuntime>()
  private geneSource?: GeneSource
  private cytobands?: ReadonlyMap<string, readonly Cytoband[]>
  private geneAssembly = ''
  private frame?: number
  private dragging?: { x: number; region: Region; canvas: HTMLCanvasElement }
  private trackDrag?: {
    sourceCanvas: HTMLCanvasElement
    draggedIds: string[]
    startX: number
    startY: number
    clientX: number
    clientY: number
    active: boolean
    wholeGroup: boolean
    withinGroupId?: string
    targetPane?: 'main' | 'bottom'
    insertionIndex?: number
  }
  private trackResize?: {
    canvas: HTMLCanvasElement
    pane: 'main' | 'bottom'
    edge: 'top' | 'bottom'
    trackIds: string[]
    startClientY: number
    boundaryY: number
    guideY: number
    initialPixels: Map<string, number>
    minimumPixels: Map<string, number>
  }
  private trackResizeHover?: { canvas: HTMLCanvasElement; pane: 'main' | 'bottom'; y: number }
  private readonly resizePreviewPixels = new Map<string, number>()
  private readonly trackDragGhost: HTMLDivElement
  private mainResizeObserver: ResizeObserver
  private bottomResizeObserver: ResizeObserver
  private lastFrameTime = performance.now()
  private smoothedFps = 60
  private abortControllers = new Map<string, AbortController>()
  private selectedTrackIds = new Set<string>()
  private geneScrollOffsets = new Map<string, number>()
  private showTssIndicators = true
  private trackBodyHold?: { canvas: HTMLCanvasElement; startX: number; startY: number; timer: number }

  constructor(
    private readonly headerCanvas: HTMLCanvasElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly bottomCanvas: HTMLCanvasElement,
    chromosomes: ReadonlyMap<string, number>,
    initialRegion: Region,
    private readonly callbacks: BrowserCallbacks,
  ) {
    const context = canvas.getContext('2d', { alpha: false })
    const bottomContext = bottomCanvas.getContext('2d', { alpha: false })
    const headerContext = headerCanvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('Canvas 2D is not available in this browser.')
    if (!bottomContext) throw new Error('Canvas 2D is not available in this browser.')
    if (!headerContext) throw new Error('Canvas 2D is not available in this browser.')
    this.context = context
    this.mainContext = context
    this.bottomContext = bottomContext
    this.headerContext = headerContext
    this.chromosomes = chromosomes
    this.region = initialRegion
    this.document = createTrackDocument('unknown', initialRegion)
    this.mainResizeObserver = new ResizeObserver(() => this.resize())
    this.bottomResizeObserver = new ResizeObserver(() => this.resize())
    this.mainResizeObserver.observe(canvas.parentElement ?? canvas)
    this.bottomResizeObserver.observe(bottomCanvas.parentElement ?? bottomCanvas)
    this.trackDragGhost = document.createElement('div')
    this.trackDragGhost.className = 'track-drag-ghost'
    this.trackDragGhost.hidden = true
    document.body.append(this.trackDragGhost)
    this.bindEvents(canvas, 'main')
    this.bindEvents(bottomCanvas, 'bottom')
    this.bindNavigationEvents(headerCanvas)
    this.resize()
  }

  destroy(): void {
    this.mainResizeObserver.disconnect()
    this.bottomResizeObserver.disconnect()
    if (this.frame) cancelAnimationFrame(this.frame)
    for (const controller of this.abortControllers.values()) controller.abort()
    document.body.classList.remove('is-track-dragging')
    document.body.classList.remove('is-track-resizing')
    this.cancelTrackBodyHold()
    this.trackDragGhost.remove()
  }

  setRegion(region: Region): void {
    const length = this.chromosomes.get(region.chr)
    if (!length) return
    this.region = clampRegion(region, length)
    this.callbacks.onRegionChange(this.region)
    this.scheduleRender()
    void this.ensureData()
  }

  setChromosomes(chromosomes: ReadonlyMap<string, number>): void {
    this.chromosomes = chromosomes
  }

  setGeneSource(source: GeneSource | undefined, assembly = ''): void {
    this.geneSource = source
    this.geneAssembly = assembly
    this.geneScrollOffsets.clear()
    this.resize()
  }

  setShowTssIndicators(show: boolean): void {
    this.showTssIndicators = show
    this.scheduleRender()
  }

  setCytobands(cytobands: ReadonlyMap<string, readonly Cytoband[]> | undefined): void {
    this.cytobands = cytobands
    this.resize()
  }

  getRegion(): Region {
    return { ...this.region }
  }

  getPaneContentHeight(pane: 'main' | 'bottom'): number {
    return this.paneStackHeight(pane)
  }

  getRenderedTrackHeight(spec: TrackSpec): number {
    return this.trackHeight(spec)
  }

  getFittedMinimumHeight(spec: TrackSpec): number {
    const ctx = spec.pane === 'bottom' ? this.bottomContext : this.mainContext
    ctx.save()
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const scaleLaneWidth = spec.kind === 'signal' || spec.kind === 'stranded' ? 48 : 0
    const lineCount = wrappedLines(ctx, spec.label, trackLabelBounds(scaleLaneWidth).width, 2).length
    ctx.restore()
    if (spec.kind === 'stranded') return (lineCount > 1 ? 50 : 20) * 2
    if (spec.kind === 'alignment' || spec.kind === 'genes') return lineCount > 1 ? 60 : 36
    if (spec.kind === 'matrix') return lineCount > 1 ? 64 : 48
    return lineCount > 1 ? (spec.kind === 'signal' ? 50 : 46) : 20
  }

  refresh(): void {
    this.scheduleRender()
  }

  syncDocument(document: TrackDocument, sources: ReadonlyMap<string, TrackSource>): void {
    for (const spec of document.tracks) {
      const previous = this.document.tracks.find((track) => track.id === spec.id)
      if (spec.kind === 'genes' && previous?.geneDisplayMode !== spec.geneDisplayMode) this.geneScrollOffsets.delete(spec.id)
      if (spec.kind === 'alignment' && previous?.kind === 'alignment' && alignmentQueryChanged(previous, spec)) {
        for (const runtime of this.runtimesForTrack(spec.id)) {
          this.abortControllers.get(runtime.id)?.abort()
          Object.assign(runtime, { features: [], loadedRegion: undefined, status: runtime.source ? 'idle' : 'offline' })
        }
      }
      if (spec.kind === 'matrix' && previous?.kind === 'matrix' && matrixQueryChanged(previous, spec)) {
        for (const runtime of this.runtimesForTrack(spec.id)) {
          this.abortControllers.get(runtime.id)?.abort()
          Object.assign(runtime, { features: [], loadedRegion: undefined, loadedMatrixMaxDistance: undefined, status: runtime.source ? 'idle' : 'offline' })
        }
      }
    }
    this.document = document
    const descriptors = document.tracks.flatMap(runtimeDescriptors)
    const validIds = new Set(descriptors.map((descriptor) => descriptor.id))
    for (const [id] of this.runtimes) {
      if (validIds.has(id)) continue
      this.abortControllers.get(id)?.abort()
      this.abortControllers.delete(id)
      this.runtimes.delete(id)
    }
    for (const descriptor of descriptors) {
      const source = sources.get(descriptor.sourceId)
      const runtime = this.runtimes.get(descriptor.id)
      if (!runtime) {
        this.runtimes.set(descriptor.id, {
          ...descriptor,
          source,
          features: [],
          status: source ? 'idle' : 'offline',
          error: source ? undefined : 'Source needs reopening',
          requestVersion: 0,
        })
      } else if (source && runtime.source !== source) {
        this.abortControllers.get(descriptor.id)?.abort()
        Object.assign(runtime, { source, features: [], loadedRegion: undefined, status: 'idle', error: undefined })
      } else if (!source && runtime.source) {
        Object.assign(runtime, { source: undefined, features: [], loadedRegion: undefined, status: 'offline', error: 'Source needs reopening' })
      }
    }
    this.resize()
    this.emitTracks()
  }

  async attachSource(sourceId: string, source: TrackSource): Promise<void> {
    const runtimes = [...this.runtimes.values()].filter((runtime) => runtime.sourceId === sourceId)
    await Promise.all(runtimes.map(async (runtime) => {
      runtime.source = source
      runtime.status = 'idle'
      runtime.error = undefined
      runtime.loadedRegion = undefined
      await this.loadTrack(runtime)
    }))
  }

  getRuntime(trackId: string, channel?: 'plus' | 'minus'): TrackRuntime | undefined {
    return this.runtimes.get(signalFeatureKey(trackId, channel)) ?? this.runtimesForTrack(trackId)[0]
  }

  private runtimesForTrack(trackId: string): TrackRuntime[] {
    return [...this.runtimes.values()].filter((runtime) => runtime.trackId === trackId)
  }

  setSelectedTracks(trackIds: ReadonlySet<string>): void {
    this.selectedTrackIds = new Set(trackIds)
    this.scheduleRender()
  }

  zoom(factor: number, anchor = 0.5): void {
    const length = this.chromosomes.get(this.region.chr)
    if (!length) return
    const span = this.region.end - this.region.start
    const nextSpan = Math.max(10, Math.min(length, span * factor))
    const coordinate = this.region.start + span * anchor
    this.setRegion({
      chr: this.region.chr,
      start: coordinate - nextSpan * anchor,
      end: coordinate + nextSpan * (1 - anchor),
    })
  }

  private bindEvents(canvas: HTMLCanvasElement, pane: 'main' | 'bottom'): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const resizeHit = this.resizeBoundaryAt(pane, event.offsetY)
      if (resizeHit) {
        const tracks = this.document.tracks.filter((track) => resizeHit.trackIds.includes(track.id))
        canvas.setPointerCapture(event.pointerId)
        this.trackResize = {
          canvas,
          pane,
          edge: resizeHit.edge,
          trackIds: resizeHit.trackIds,
          startClientY: event.clientY,
          boundaryY: resizeHit.y,
          guideY: resizeHit.y,
          initialPixels: new Map(tracks.map((track) => [track.id, this.trackHeight(track)])),
          minimumPixels: new Map(tracks.map((track) => [track.id, this.getFittedMinimumHeight(track)])),
        }
        canvas.classList.add('is-track-resizing')
        document.body.classList.add('is-track-resizing')
        return
      }
      if (event.offsetX < LABEL_WIDTH) {
        const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
        if (!hit) {
          this.callbacks.onClearSelection()
          return
        }
        if (hit.kind === 'track') this.callbacks.onTrackSelection(hit.id, event.ctrlKey || event.metaKey, event.shiftKey)
        else this.callbacks.onGroupSelection(hit.id, event.ctrlKey || event.metaKey)
        const targetTrack = hit.kind === 'track' ? this.document.tracks.find((track) => track.id === hit.id) : undefined
        const withinGroupId = hit.kind === 'track' ? targetTrack?.displayGroupId : undefined
        const draggedIds = hit.kind === 'group'
          ? this.document.tracks.filter((track) => track.displayGroupId === hit.id).map((track) => track.id)
          : withinGroupId
            ? (this.selectedTrackIds.has(hit.id)
                ? [...this.selectedTrackIds].filter((id) => this.document.tracks.find((track) => track.id === id)?.displayGroupId === withinGroupId)
                : [hit.id])
            : this.selectedTrackIds.has(hit.id) ? [...this.selectedTrackIds] : [hit.id]
        canvas.setPointerCapture(event.pointerId)
        this.trackDrag = {
          sourceCanvas: canvas, draggedIds, startX: event.clientX, startY: event.clientY,
          clientX: event.clientX, clientY: event.clientY, active: false,
          wholeGroup: hit.kind === 'group', withinGroupId,
        }
        return
      }
      if (event.offsetX < PLOT_LEFT) return
      const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) this.callbacks.onClearSelection()
      if (hit?.kind === 'track') {
        const hold = {
          canvas,
          startX: event.clientX,
          startY: event.clientY,
          timer: window.setTimeout(() => {
            if (this.trackBodyHold !== hold) return
            this.callbacks.onTrackSelection(hit.id, event.ctrlKey || event.metaKey, event.shiftKey)
            this.trackBodyHold = undefined
          }, 320),
        }
        this.trackBodyHold = hold
      }
      canvas.setPointerCapture(event.pointerId)
      this.dragging = { x: event.clientX, region: { ...this.region }, canvas }
      canvas.classList.add('is-dragging')
    })
    canvas.addEventListener('pointermove', (event) => {
      if (this.trackResize?.canvas === canvas) {
        const dragPixels = event.clientY - this.trackResize.startClientY
        const requestedDelta = this.trackResize.edge === 'bottom' ? dragPixels : -dragPixels
        const resized = resizedTrackPixels(this.trackResize.initialPixels, this.trackResize.minimumPixels, requestedDelta)
        this.resizePreviewPixels.clear()
        for (const [id, pixels] of resized) this.resizePreviewPixels.set(id, pixels)
        this.trackResize.guideY = this.trackResize.boundaryY + dragPixels
        this.resizeCanvas(canvas, pane === 'main' ? this.mainContext : this.bottomContext, pane)
        this.scheduleRender()
        return
      }
      if (this.trackDrag?.sourceCanvas === canvas) {
        this.trackDrag.clientX = event.clientX
        this.trackDrag.clientY = event.clientY
        if (!this.trackDrag.active && Math.hypot(event.clientX - this.trackDrag.startX, event.clientY - this.trackDrag.startY) >= 5) {
          this.trackDrag.active = true
          canvas.classList.add('is-track-dragging')
          document.body.classList.add('is-track-dragging')
          this.showTrackDragGhost()
        }
        if (this.trackDrag.active) {
          this.positionTrackDragGhost(event.clientX, event.clientY)
          const target = this.dropTarget(event.clientX, event.clientY, this.trackDrag.draggedIds)
          this.trackDrag.targetPane = target?.pane
          this.trackDrag.insertionIndex = target?.insertionIndex
          this.scheduleRender()
        }
        return
      }
      if (this.trackBodyHold?.canvas === canvas && Math.hypot(event.clientX - this.trackBodyHold.startX, event.clientY - this.trackBodyHold.startY) >= 5) this.cancelTrackBodyHold()
      if (!this.dragging || this.dragging.canvas !== canvas) {
        const hit = this.resizeBoundaryAt(pane, event.offsetY)
        const next = hit ? { canvas, pane, y: hit.y } : undefined
        if (this.trackResizeHover?.canvas !== next?.canvas || this.trackResizeHover?.y !== next?.y) {
          this.trackResizeHover = next
          canvas.classList.toggle('is-track-resize-hover', Boolean(hit))
          this.scheduleRender()
        }
        return
      }
      const plotWidth = Math.max(1, this.cssWidth(canvas) - PLOT_LEFT)
      const bpPerPixel = (this.dragging.region.end - this.dragging.region.start) / plotWidth
      const shift = (this.dragging.x - event.clientX) * bpPerPixel
      const chromosomeLength = this.chromosomes.get(this.dragging.region.chr)
      if (!chromosomeLength) return
      this.region = clampRegion({
        chr: this.dragging.region.chr,
        start: this.dragging.region.start + shift,
        end: this.dragging.region.end + shift,
      }, chromosomeLength)
      this.callbacks.onRegionChange(this.region)
      this.scheduleRender()
      if (!this.hasOverscanCoverage()) void this.ensureData()
    })
    const finishPointer = (event: PointerEvent) => {
      this.cancelTrackBodyHold()
      if (this.trackResize?.canvas === canvas) {
        const resize = this.trackResize
        const updates = resize.trackIds.map((id) => ({ id, pixels: this.resizePreviewPixels.get(id) ?? resize.initialPixels.get(id)! }))
        this.trackResize = undefined
        this.resizePreviewPixels.clear()
        canvas.classList.remove('is-track-resizing')
        document.body.classList.remove('is-track-resizing')
        if (event.type === 'pointerup') this.callbacks.onTrackHeightsResize(updates)
        else {
          this.resizeCanvas(canvas, pane === 'main' ? this.mainContext : this.bottomContext, pane)
          this.scheduleRender()
        }
        return
      }
      if (this.trackDrag?.sourceCanvas === canvas) {
        const drag = this.trackDrag
        this.trackDrag = undefined
        canvas.classList.remove('is-track-dragging')
        document.body.classList.remove('is-track-dragging')
        this.trackDragGhost.hidden = true
        if (drag.active && drag.targetPane && drag.insertionIndex !== undefined) this.callbacks.onTracksReorder(drag.draggedIds, drag.targetPane, drag.insertionIndex, drag.withinGroupId)
        this.scheduleRender()
        return
      }
      if (!this.dragging || this.dragging.canvas !== canvas) return
      this.dragging = undefined
      canvas.classList.remove('is-dragging')
      void this.ensureData()
    }
    canvas.addEventListener('pointerup', finishPointer)
    canvas.addEventListener('pointercancel', finishPointer)
    canvas.addEventListener('pointerleave', () => {
      if (this.trackResize?.canvas === canvas) return
      this.trackResizeHover = undefined
      canvas.classList.remove('is-track-resize-hover')
      this.scheduleRender()
    })
    canvas.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        if (event.deltaX !== 0) {
          event.preventDefault()
          this.panHorizontally(canvas, event.deltaX)
          return
        }
        const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
        const spec = hit?.kind === 'track' ? this.document.tracks.find((track) => track.id === hit.id && track.kind === 'genes') : undefined
        if (spec && this.scrollGeneTrack(spec, event.deltaY, this.cssWidth(canvas))) event.preventDefault()
        return
      }
      event.preventDefault()
      const anchor = Math.max(0, Math.min(1, (event.offsetX - PLOT_LEFT) / Math.max(1, this.cssWidth(canvas) - PLOT_LEFT)))
      this.zoom(Math.exp(event.deltaY * 0.0015), anchor)
    }, { passive: false })
    canvas.addEventListener('dblclick', (event) => {
      if (event.offsetX < PLOT_LEFT) return
      const anchor = (event.offsetX - PLOT_LEFT) / Math.max(1, this.cssWidth(canvas) - PLOT_LEFT)
      this.zoom(0.5, anchor)
    })
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (event.offsetX >= LABEL_WIDTH) return
      const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
      if (hit?.kind === 'track') this.callbacks.onTrackContextMenu(hit.id, event.clientX, event.clientY)
      if (hit?.kind === 'group') this.callbacks.onGroupContextMenu(hit.id, event.clientX, event.clientY)
    })
  }

  private bindNavigationEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      this.callbacks.onClearSelection()
      if (event.offsetX < PLOT_LEFT) return
      canvas.setPointerCapture(event.pointerId)
      this.dragging = { x: event.clientX, region: { ...this.region }, canvas }
      canvas.classList.add('is-dragging')
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging || this.dragging.canvas !== canvas) return
      const plotWidth = Math.max(1, this.cssWidth(canvas) - PLOT_LEFT)
      const shift = (this.dragging.x - event.clientX) * ((this.dragging.region.end - this.dragging.region.start) / plotWidth)
      const chromosomeLength = this.chromosomes.get(this.dragging.region.chr)
      if (!chromosomeLength) return
      this.region = clampRegion({ chr: this.dragging.region.chr, start: this.dragging.region.start + shift, end: this.dragging.region.end + shift }, chromosomeLength)
      this.callbacks.onRegionChange(this.region)
      this.scheduleRender()
      if (!this.hasOverscanCoverage()) void this.ensureData()
    })
    const finish = () => {
      if (!this.dragging || this.dragging.canvas !== canvas) return
      this.dragging = undefined
      canvas.classList.remove('is-dragging')
      void this.ensureData()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', finish)
    canvas.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        if (event.deltaX !== 0) {
          event.preventDefault()
          this.panHorizontally(canvas, event.deltaX)
        }
        return
      }
      event.preventDefault()
      this.zoom(Math.exp(event.deltaY * 0.0015), Math.max(0, Math.min(1, (event.offsetX - PLOT_LEFT) / Math.max(1, this.cssWidth(canvas) - PLOT_LEFT))))
    }, { passive: false })
    canvas.addEventListener('dblclick', (event) => {
      if (event.offsetX >= PLOT_LEFT) this.zoom(0.5, (event.offsetX - PLOT_LEFT) / Math.max(1, this.cssWidth(canvas) - PLOT_LEFT))
    })
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
  }

  private panHorizontally(canvas: HTMLCanvasElement, deltaPixels: number): void {
    const chromosomeLength = this.chromosomes.get(this.region.chr)
    if (!chromosomeLength) return
    const plotWidth = Math.max(1, this.cssWidth(canvas) - PLOT_LEFT)
    const shift = deltaPixels * (this.region.end - this.region.start) / plotWidth
    this.region = clampRegion({ chr: this.region.chr, start: this.region.start + shift, end: this.region.end + shift }, chromosomeLength)
    this.callbacks.onRegionChange(this.region)
    this.scheduleRender()
    if (!this.hasOverscanCoverage()) void this.ensureData()
  }

  private cancelTrackBodyHold(): void {
    if (this.trackBodyHold) window.clearTimeout(this.trackBodyHold.timer)
    this.trackBodyHold = undefined
  }

  private resize(): void {
    this.resizeHeaderCanvas()
    this.resizeCanvas(this.canvas, this.mainContext, 'main')
    this.resizeCanvas(this.bottomCanvas, this.bottomContext, 'bottom')
    this.scheduleRender()
    void this.ensureData()
  }

  private resizeHeaderCanvas(): void {
    const parentWidth = this.headerCanvas.parentElement?.clientWidth ?? 900
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.headerCanvas.width = Math.floor(parentWidth * ratio)
    this.headerCanvas.height = Math.floor(RULER_HEIGHT * ratio)
    this.headerCanvas.style.width = `${parentWidth}px`
    this.headerCanvas.style.height = `${RULER_HEIGHT}px`
    this.headerContext.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  private resizeCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, pane: 'main' | 'bottom'): void {
    const parentWidth = canvas.parentElement?.clientWidth ?? 900
    const minimum = pane === 'main' ? TRACK_HEIGHT : MIN_BOTTOM_GENE_HEIGHT
    const contentHeight = this.paneStackHeight(pane)
    const cssHeight = Math.max(minimum, contentHeight)
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(parentWidth * ratio)
    canvas.height = Math.floor(cssHeight * ratio)
    canvas.style.width = `${parentWidth}px`
    canvas.style.height = `${cssHeight}px`
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  private cssWidth(canvas = this.canvas): number {
    return Number.parseFloat(canvas.style.width) || canvas.clientWidth
  }

  private cssHeight(canvas = this.canvas): number {
    return Number.parseFloat(canvas.style.height) || canvas.clientHeight
  }

  private scheduleRender(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame((now) => {
      this.frame = undefined
      const started = performance.now()
      const visibleFeatures = this.render()
      const renderMs = performance.now() - started
      const frameDelta = now - this.lastFrameTime
      this.lastFrameTime = now
      if (frameDelta > 0 && frameDelta < 250) this.smoothedFps = this.smoothedFps * 0.8 + (1000 / frameDelta) * 0.2
      this.callbacks.onPerformance({ renderMs, fps: Math.min(60, this.smoothedFps), visibleFeatures })
    })
  }

  private render(): number {
    const palette = canvasPalette()
    this.context = this.headerContext
    this.drawRuler(this.cssWidth(this.headerCanvas), palette)
    const visibleByTrack = new Map<string, readonly SignalFeature[]>()
    for (const spec of this.visibleSignalSpecs()) {
      for (const runtime of this.runtimesForTrack(spec.id)) {
        visibleByTrack.set(signalFeatureKey(spec.id, runtime.channel), (runtime.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) ?? []) as SignalFeature[])
      }
    }
    const domains = computeScaleDomains(this.document, visibleByTrack)
    return this.renderPane('main', palette, domains) + this.renderPane('bottom', palette, domains)
  }

  private renderPane(
    pane: 'main' | 'bottom',
    palette: CanvasPalette,
    domains: ReadonlyMap<string, { min: number; max: number }>,
  ): number {
    const canvas = pane === 'main' ? this.canvas : this.bottomCanvas
    this.context = pane === 'main' ? this.mainContext : this.bottomContext
    const ctx = this.context
    const width = this.cssWidth(canvas)
    const height = this.cssHeight(canvas)
    ctx.fillStyle = palette.background
    ctx.fillRect(0, 0, width, height)
    const specs = this.visibleSpecs(pane)
    const movingIds = this.trackDrag?.active ? this.movingIds(this.trackDrag.draggedIds) : undefined
    let visibleFeatures = 0
    let top = 0
    let groupRun: { id: string; top: number; bottom: number } | undefined
    specs.forEach((spec, index) => {
      if (groupRun && groupRun.id !== spec.displayGroupId) {
        this.drawGroupRail(groupRun.id, groupRun.top, groupRun.bottom, palette)
        groupRun = undefined
      }
      const rowHeight = this.trackHeight(spec)
      if (spec.kind === 'signal') {
        const runtime = this.runtimes.get(signalFeatureKey(spec.id, spec.signalStrand))!
        const domain = spec.scaleBindingId ? domains.get(spec.scaleBindingId) : undefined
        visibleFeatures += this.drawTrack(spec, runtime, index, top, rowHeight, width, palette, domain)
      } else if (spec.kind === 'stranded') {
        const plus = this.runtimes.get(signalFeatureKey(spec.id, 'plus'))!
        const minus = this.runtimes.get(signalFeatureKey(spec.id, 'minus'))!
        const plusDomain = spec.scaleBindingId ? domains.get(spec.scaleBindingId) : undefined
        const minusDomain = spec.negativeScaleBindingId ? domains.get(spec.negativeScaleBindingId) : undefined
        visibleFeatures += this.drawStrandedTrack(spec, plus, minus, index, top, rowHeight, width, palette, plusDomain, minusDomain)
      } else if (spec.kind === 'interval') {
        visibleFeatures += this.drawIntervalTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette)
      } else if (spec.kind === 'interaction') {
        visibleFeatures += this.drawInteractionTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette)
      } else if (spec.kind === 'matrix') {
        visibleFeatures += this.drawMatrixTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette)
      } else if (spec.kind === 'alignment') {
        visibleFeatures += this.drawAlignmentTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette)
      } else visibleFeatures += this.drawGeneTrack(spec, width, top, rowHeight, palette)
      if (movingIds?.has(spec.id)) {
        ctx.fillStyle = palette.dragFill
        ctx.fillRect(0, top, width, rowHeight)
        ctx.strokeStyle = palette.selection
        ctx.setLineDash([6, 4])
        ctx.strokeRect(3.5, top + 3.5, width - 7, rowHeight - 7)
        ctx.setLineDash([])
      }
      if (spec.displayGroupId) groupRun ??= { id: spec.displayGroupId, top, bottom: top + rowHeight }
      if (groupRun) groupRun.bottom = top + rowHeight
      top += rowHeight
    })
    if (groupRun) this.drawGroupRail(groupRun.id, groupRun.top, groupRun.bottom, palette)
    if (pane === 'main' && specs.length === 0) this.drawEmptyState(width, height, palette)
    if (this.trackDrag?.active && this.trackDrag.targetPane === pane && this.trackDrag.insertionIndex !== undefined) {
      const y = this.insertionY(pane, this.trackDrag.insertionIndex)
      ctx.fillStyle = palette.selectionFill
      ctx.fillRect(0, Math.max(0, y - 6), width, 12)
      ctx.strokeStyle = palette.selection
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(4, y + 0.5)
      ctx.lineTo(width, y + 0.5)
      ctx.stroke()
      ctx.fillStyle = palette.selection
      ctx.beginPath()
      ctx.moveTo(6, y)
      ctx.lineTo(15, y - 6)
      ctx.lineTo(15, y + 6)
      ctx.closePath()
      ctx.fill()
      ctx.lineWidth = 1
    }
    const resizeLine = this.trackResize?.pane === pane
      ? this.trackResize.guideY
      : this.trackResizeHover?.pane === pane ? this.trackResizeHover.y : undefined
    if (resizeLine !== undefined) {
      ctx.fillStyle = palette.selection
      ctx.fillRect(0, Math.max(0, Math.round(resizeLine) - 1), width, 2)
    }
    return visibleFeatures
  }

  private drawRuler(width: number, palette: CanvasPalette): void {
    const ctx = this.context
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, 0, LABEL_WIDTH, RULER_HEIGHT)
    ctx.fillStyle = palette.ruler
    ctx.fillRect(LABEL_WIDTH, 0, width - LABEL_WIDTH, RULER_HEIGHT)
    ctx.strokeStyle = palette.line
    ctx.beginPath()
    ctx.moveTo(0, RULER_HEIGHT - 0.5)
    ctx.lineTo(width, RULER_HEIGHT - 0.5)
    ctx.stroke()
    const plotWidth = width - PLOT_LEFT
    const span = this.region.end - this.region.start
    const chromosomeLength = this.chromosomes.get(this.region.chr)
    if (chromosomeLength) this.drawIdeogram(PLOT_LEFT + 4, Math.max(1, plotWidth - 8), chromosomeLength, palette)
    const spanY = 51
    ctx.strokeStyle = palette.label
    ctx.beginPath()
    ctx.moveTo(PLOT_LEFT, spanY + 0.5)
    ctx.lineTo(width, spanY + 0.5)
    ctx.stroke()
    ctx.fillStyle = palette.label
    ctx.beginPath()
    ctx.moveTo(PLOT_LEFT, spanY)
    ctx.lineTo(PLOT_LEFT + 8, spanY - 4)
    ctx.lineTo(PLOT_LEFT + 8, spanY + 4)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(width, spanY)
    ctx.lineTo(width - 8, spanY - 4)
    ctx.lineTo(width - 8, spanY + 4)
    ctx.closePath()
    ctx.fill()
    const spanLabel = formatBases(span)
    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    const labelWidth = ctx.measureText(spanLabel).width
    ctx.fillStyle = palette.ruler
    ctx.fillRect(PLOT_LEFT + plotWidth / 2 - labelWidth / 2 - 7, spanY - 9, labelWidth + 14, 18)
    ctx.fillStyle = palette.ink
    ctx.fillText(spanLabel, PLOT_LEFT + plotWidth / 2, spanY + 4)
    const step = niceStep(span / Math.max(2, Math.floor(plotWidth / 150)))
    const first = Math.ceil(this.region.start / step) * step
    ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace'
    ctx.textAlign = 'center'
    for (let coordinate = first; coordinate < this.region.end; coordinate += step) {
      const x = PLOT_LEFT + ((coordinate - this.region.start) / span) * plotWidth
      ctx.strokeStyle = palette.tick
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, 86)
      ctx.lineTo(Math.round(x) + 0.5, RULER_HEIGHT)
      ctx.stroke()
      ctx.fillStyle = palette.label
      ctx.fillText(formatCoordinate(coordinate, step, Math.max(Math.abs(this.region.start), Math.abs(this.region.end))), x, 79)
    }
    ctx.textAlign = 'start'
  }

  private drawIdeogram(x: number, width: number, chromosomeLength: number, palette: CanvasPalette): void {
    const ctx = this.context
    const top = 8
    const height = 13
    const bands = this.cytobands?.get(this.region.chr)
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, top, width, height, 5)
    ctx.clip()
    if (bands?.length) {
      for (const band of bands) {
        const bandX = x + (band.start / chromosomeLength) * width
        const bandWidth = Math.max(1, ((band.end - band.start) / chromosomeLength) * width)
        ctx.fillStyle = cytobandColor(band.stain, palette)
        if (band.stain === 'acen') {
          ctx.beginPath()
          if (band.name.startsWith('p')) {
            ctx.moveTo(bandX, top)
            ctx.lineTo(bandX + bandWidth, top + height / 2)
            ctx.lineTo(bandX, top + height)
          } else {
            ctx.moveTo(bandX + bandWidth, top)
            ctx.lineTo(bandX, top + height / 2)
            ctx.lineTo(bandX + bandWidth, top + height)
          }
          ctx.closePath()
          ctx.fill()
        } else ctx.fillRect(bandX, top, bandWidth + 0.5, height)
      }
    } else {
      ctx.fillStyle = palette.ideogramEmpty
      ctx.fillRect(x, top, width, height)
    }
    ctx.restore()
    const centromereBands = bands?.filter((band) => band.stain === 'acen') ?? []
    ctx.strokeStyle = palette.ideogramOutline
    ctx.beginPath()
    if (centromereBands.length >= 2) {
      const pBand = centromereBands.find((band) => band.name.startsWith('p')) ?? centromereBands[0]
      const qBand = centromereBands.find((band) => band.name.startsWith('q')) ?? centromereBands[1]
      const pOuter = x + (pBand.start / chromosomeLength) * width
      const pinch = x + (pBand.end / chromosomeLength) * width
      const qOuter = x + (qBand.end / chromosomeLength) * width
      ctx.moveTo(x + 5, top + 0.5)
      ctx.lineTo(pOuter, top + 0.5)
      ctx.lineTo(pinch, top + height / 2)
      ctx.lineTo(pOuter, top + height - 0.5)
      ctx.lineTo(x + 5, top + height - 0.5)
      ctx.moveTo(pinch, top + height / 2)
      ctx.lineTo(qOuter, top + 0.5)
      ctx.lineTo(x + width - 5, top + 0.5)
      ctx.moveTo(pinch, top + height / 2)
      ctx.lineTo(qOuter, top + height - 0.5)
      ctx.lineTo(x + width - 5, top + height - 0.5)
    } else ctx.roundRect(x + 0.5, top + 0.5, width - 1, height - 1, 5)
    ctx.stroke()

    if (bands?.length) {
      ctx.font = '9px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      let lastLabelEnd = x - 1
      for (const band of bands) {
        if (band.stain === 'acen' || band.name.length > 6) continue
        const center = x + (((band.start + band.end) / 2) / chromosomeLength) * width
        const labelWidth = ctx.measureText(band.name).width
        if (center - labelWidth / 2 <= lastLabelEnd + 5) continue
        ctx.fillStyle = palette.muted
        ctx.fillText(band.name, center, 37)
        lastLabelEnd = center + labelWidth / 2
      }
      ctx.textAlign = 'start'
    }

    const viewportX = x + (this.region.start / chromosomeLength) * width
    const viewportWidth = Math.max(3, ((this.region.end - this.region.start) / chromosomeLength) * width)
    ctx.strokeStyle = '#f04455'
    ctx.lineWidth = 2
    ctx.strokeRect(Math.max(x, Math.min(x + width - viewportWidth, viewportX)), top - 2, viewportWidth, height + 4)
    ctx.lineWidth = 1
  }

  private drawTrack(
    spec: TrackSpec,
    track: TrackRuntime,
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
    domain?: { min: number; max: number },
  ): number {
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    ctx.fillStyle = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillRect(LABEL_WIDTH, top, width - LABEL_WIDTH, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) {
      ctx.fillStyle = palette.selectionFill
      ctx.fillRect(0, top, LABEL_WIDTH, height)
    }
    ctx.strokeStyle = palette.line
    ctx.beginPath()
    ctx.moveTo(0, bottom - 0.5)
    ctx.lineTo(width, bottom - 0.5)
    ctx.stroke()

    const rawVisible = track.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as SignalFeature[]
    const visible = spec.signalStrand
      ? rawVisible.map((feature) => ({ ...feature, score: Math.abs(feature.score) }))
      : spec.allowNegativeValues === false
        ? rawVisible.map((feature) => ({ ...feature, score: Math.max(0, feature.score) }))
        : rawVisible
    let previewMin = domain?.min ?? 0
    let previewMax = domain?.max ?? 0
    if (!domain) for (const feature of visible) { previewMin = Math.min(previewMin, feature.score); previewMax = Math.max(previewMax, feature.score) }
    const previewScaleValue = previewMax !== 0 ? previewMax : previewMin !== 0 ? Math.abs(previewMin) : 0
    const previewMaxLabel = visible.length && previewScaleValue !== 0 ? formatScore(previewScaleValue) : undefined
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
    const scaleLaneWidth = previewMaxLabel ? Math.max(SCALE_LANE_MIN_WIDTH, Math.ceil(ctx.measureText(previewMaxLabel).width) + 12) : 0

    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const maxLabelLines = track.status === 'error' || track.status === 'offline' ? 2 : Math.max(1, Math.floor((height - 20) / 15))
    const labelBounds = trackLabelBounds(scaleLaneWidth)
    const labelLayout = wrappedLines(ctx, spec.label, labelBounds.width, maxLabelLines)
    const labelTop = verticallyCenteredBaseline(top, height, labelLayout.length, 15)
    drawCenteredTextLines(ctx, labelLayout, labelBounds.center, labelTop, 15)
    if (track.status === 'error' || track.status === 'offline') {
      ctx.fillStyle = palette.error
      ctx.font = '11px Inter, system-ui, sans-serif'
      wrapText(ctx, track.error ?? 'Could not load track', 24, labelTop + labelLayout.length * 15 + 6, 136, 15, Math.max(1, Math.floor((bottom - labelTop - labelLayout.length * 15 - 8) / 15)))
      return 0
    }

    if (visible.length === 0) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText(track.status === 'loading' ? 'Loading indexed data…' : 'No signal in this window', PLOT_LEFT + 22, top + height / 2)
      return 0
    }

    const bins = binFeatures(visible, this.region, Math.floor(plotWidth))
    let min = domain?.min ?? 0
    let max = domain?.max ?? 0
    if (!domain) for (const bin of bins) {
      if (!bin) continue
      min = Math.min(min, bin.min)
      max = Math.max(max, bin.max)
    }
    const amplitude = Math.max(1e-9, max - min)
    const chartTop = top + 18
    const chartBottom = bottom - 0.5
    const chartHeight = chartBottom - chartTop
    const rawZeroY = chartBottom - ((0 - min) / amplitude) * chartHeight
    const zeroY = spec.signalStrand === 'minus' ? chartTop : Math.max(chartTop, Math.min(chartBottom, rawZeroY))

    if (min <= 0 && max >= 0) {
      ctx.strokeStyle = palette.zero
      ctx.beginPath()
      ctx.moveTo(PLOT_LEFT, zeroY)
      ctx.lineTo(width, zeroY)
      ctx.stroke()
    }
    drawSignalBins(
      ctx,
      bins,
      PLOT_LEFT,
      chartTop,
      chartBottom,
      zeroY,
      (value) => spec.signalStrand === 'minus'
        ? chartTop + (value / Math.max(1e-9, max)) * chartHeight
        : chartBottom - ((value - min) / amplitude) * chartHeight,
      spec.color,
    )
    const scaleValue = max !== 0 ? max : min !== 0 ? Math.abs(min) : 0
    if (scaleValue !== 0) {
      const maxLabel = formatScore(scaleValue)
      ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
      const laneWidth = Math.max(SCALE_LANE_MIN_WIDTH, Math.ceil(ctx.measureText(maxLabel).width) + 12)
      const dividerX = LABEL_WIDTH - laneWidth
      ctx.strokeStyle = palette.axisLine
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(dividerX + 0.5, top + 7)
      ctx.lineTo(dividerX + 0.5, bottom - 7)
      ctx.stroke()
      ctx.fillStyle = palette.axisInk
      ctx.textAlign = 'right'
      const scaleAtBottom = spec.signalStrand === 'minus' || (max === 0 && min < 0)
      ctx.fillText(maxLabel, LABEL_WIDTH - 8, scaleAtBottom ? chartBottom - 3 : chartTop + 3)
      ctx.textAlign = 'start'
      ctx.beginPath()
      const tickY = scaleAtBottom ? chartBottom - 0.5 : chartTop + 0.5
      ctx.moveTo(LABEL_WIDTH - 7, tickY)
      ctx.lineTo(LABEL_WIDTH + 7, tickY)
      ctx.stroke()
    }
    return visible.length
  }

  private drawStrandedTrack(
    spec: TrackSpec,
    plus: TrackRuntime,
    minus: TrackRuntime,
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
    plusDomain?: { min: number; max: number },
    minusDomain?: { min: number; max: number },
  ): number {
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    ctx.fillStyle = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillRect(LABEL_WIDTH, top, width - LABEL_WIDTH, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) { ctx.fillStyle = palette.selectionFill; ctx.fillRect(0, top, LABEL_WIDTH, height) }
    ctx.strokeStyle = palette.line
    ctx.beginPath(); ctx.moveTo(0, bottom - 0.5); ctx.lineTo(width, bottom - 0.5); ctx.stroke()

    const plusVisible = (plus.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as SignalFeature[])
      .map((feature) => ({ ...feature, score: Math.abs(feature.score) }))
    const minusVisible = (minus.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as SignalFeature[])
      .map((feature) => ({ ...feature, score: Math.abs(feature.score) }))
    const plusMax = plusDomain?.max ?? maximumMagnitude(plusVisible)
    const minusMax = minusDomain?.max ?? maximumMagnitude(minusVisible)
    const labels = [plusMax, minusMax].filter((value) => value > 0).map(formatScore)
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
    const scaleLaneWidth = labels.length ? Math.max(SCALE_LANE_MIN_WIDTH, ...labels.map((label) => Math.ceil(ctx.measureText(label).width) + 12)) : 0
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds(scaleLaneWidth)
    const labelLayout = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 20) / 15)))
    drawCenteredTextLines(ctx, labelLayout, labelBounds.center, verticallyCenteredBaseline(top, height, labelLayout.length, 15), 15)

    const chartTop = top + 12
    const chartBottom = bottom - 10
    const zeroY = chartTop + (chartBottom - chartTop) / 2
    ctx.strokeStyle = palette.zero
    ctx.beginPath(); ctx.moveTo(PLOT_LEFT, zeroY + 0.5); ctx.lineTo(width, zeroY + 0.5); ctx.stroke()
    if (scaleLaneWidth) {
      const dividerX = LABEL_WIDTH - scaleLaneWidth
      ctx.strokeStyle = palette.axisLine
      ctx.beginPath(); ctx.moveTo(dividerX + 0.5, top + 7); ctx.lineTo(dividerX + 0.5, bottom - 7); ctx.stroke()
      ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
      ctx.fillStyle = palette.axisInk
      ctx.textAlign = 'right'
      if (plusMax > 0) ctx.fillText(formatScore(plusMax), LABEL_WIDTH - 8, chartTop + 3)
      if (minusMax > 0) ctx.fillText(formatScore(minusMax), LABEL_WIDTH - 8, chartBottom)
      ctx.textAlign = 'start'
      ctx.beginPath()
      if (plusMax > 0) { ctx.moveTo(LABEL_WIDTH - 7, chartTop + 0.5); ctx.lineTo(LABEL_WIDTH + 7, chartTop + 0.5) }
      if (minusMax > 0) { ctx.moveTo(LABEL_WIDTH - 7, chartBottom - 0.5); ctx.lineTo(LABEL_WIDTH + 7, chartBottom - 0.5) }
      ctx.stroke()
    }
    drawMagnitudeBins(ctx, binFeatures(plusVisible, this.region, Math.floor(plotWidth)), PLOT_LEFT, chartTop, zeroY, Math.max(1e-9, plusMax), spec.color, false)
    drawMagnitudeBins(ctx, binFeatures(minusVisible, this.region, Math.floor(plotWidth)), PLOT_LEFT, zeroY, chartBottom, Math.max(1e-9, minusMax), spec.negativeColor ?? spec.color, true)

    const problems = [plus, minus].filter((runtime) => runtime.status === 'offline' || runtime.status === 'error')
    if (problems.length) {
      ctx.fillStyle = palette.error
      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.fillText(problems.map((runtime) => `${runtime.channel === 'plus' ? '+' : '−'} ${runtime.error ?? 'source unavailable'}`).join(' · '), PLOT_LEFT + 12, bottom - 4)
    } else if (!plusVisible.length && !minusVisible.length) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText(plus.status === 'loading' || minus.status === 'loading' ? 'Loading stranded signal…' : 'No signal in this window', PLOT_LEFT + 22, zeroY - 8)
    }
    return plusVisible.length + minusVisible.length
  }

  private drawIntervalTrack(
    spec: TrackSpec,
    track: TrackRuntime,
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
  ): number {
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    ctx.fillStyle = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillRect(LABEL_WIDTH, top, width - LABEL_WIDTH, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) {
      ctx.fillStyle = palette.selectionFill
      ctx.fillRect(0, top, LABEL_WIDTH, height)
    }
    ctx.strokeStyle = palette.line
    ctx.beginPath()
    ctx.moveTo(0, bottom - 0.5)
    ctx.lineTo(width, bottom - 0.5)
    ctx.stroke()
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds()
    const labelLines = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 16) / 15)))
    drawCenteredTextLines(ctx, labelLines, labelBounds.center, verticallyCenteredBaseline(top, height, labelLines.length, 15), 15)
    if (track.status === 'error' || track.status === 'offline') {
      ctx.fillStyle = palette.error
      ctx.font = '11px Inter, system-ui, sans-serif'
      wrapText(ctx, track.error ?? 'Could not load track', 24, bottom - 25, 136, 15, 2)
      return 0
    }
    const visible = track.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as IntervalFeature[]
    if (!visible.length) {
      if (track.status === 'loading') {
        ctx.fillStyle = palette.muted
        ctx.font = '12px Inter, system-ui, sans-serif'
        ctx.fillText('Loading intervals…', PLOT_LEFT + 22, top + height / 2)
      }
      return 0
    }

    const mode = spec.intervalDisplayMode ?? 'collapsed'
    const rowHeight = mode === 'squished' ? 7 : 15
    const featureHeight = mode === 'squished' ? 3 : 7
    const scale = plotWidth / (this.region.end - this.region.start)
    const laneEnds: number[] = []
    ctx.save()
    ctx.beginPath()
    ctx.rect(PLOT_LEFT, top, plotWidth, height)
    ctx.clip()
    ctx.font = mode === 'squished' ? '9px Inter, system-ui, sans-serif' : '10px Inter, system-ui, sans-serif'
    for (const feature of visible) {
      const rawX1 = PLOT_LEFT + (feature.start - this.region.start) * scale
      const rawX2 = PLOT_LEFT + (feature.end - this.region.start) * scale
      const x1 = Math.max(PLOT_LEFT, rawX1)
      const x2 = Math.min(width, rawX2)
      const labelWidth = feature.name && mode !== 'squished' ? ctx.measureText(feature.name).width + 7 : 0
      let lane = 0
      if (mode !== 'collapsed') {
        while (rawX1 <= (laneEnds[lane] ?? Number.NEGATIVE_INFINITY)) lane += 1
        laneEnds[lane] = rawX2 + labelWidth + 5
      }
      const centerY = mode === 'collapsed' ? top + height / 2 : top + 9 + lane * rowHeight
      if (centerY + featureHeight > bottom) continue
      const color = feature.itemRgb ?? spec.color
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x1, centerY)
      ctx.lineTo(Math.max(x1 + 1, x2), centerY)
      ctx.stroke()
      const blocks = feature.blocks?.length ? feature.blocks : [{ start: feature.start, end: feature.end }]
      for (const block of blocks) {
        const blockX1 = Math.max(PLOT_LEFT, PLOT_LEFT + (block.start - this.region.start) * scale)
        const blockX2 = Math.min(width, PLOT_LEFT + (block.end - this.region.start) * scale)
        if (blockX2 > blockX1) ctx.fillRect(blockX1, centerY - featureHeight / 2, Math.max(1, blockX2 - blockX1), featureHeight)
      }
      if (feature.thickStart !== undefined && feature.thickEnd !== undefined) {
        const thickX1 = Math.max(PLOT_LEFT, PLOT_LEFT + (feature.thickStart - this.region.start) * scale)
        const thickX2 = Math.min(width, PLOT_LEFT + (feature.thickEnd - this.region.start) * scale)
        if (thickX2 > thickX1) ctx.fillRect(thickX1, centerY - Math.max(4, featureHeight) / 2, thickX2 - thickX1, Math.max(4, featureHeight))
      }
      if (feature.strand) {
        const direction = feature.strand === '+' ? 1 : -1
        const origin = rawX1 + 11
        const first = Math.max(0, Math.ceil((PLOT_LEFT + 3 - origin) / 28))
        for (let arrowX = origin + first * 28; arrowX < Math.min(width, rawX2) - 3; arrowX += 28) {
          ctx.beginPath()
          ctx.moveTo(arrowX - direction * 2.5, centerY - 1.5)
          ctx.lineTo(arrowX + direction * 2, centerY)
          ctx.lineTo(arrowX - direction * 2.5, centerY + 1.5)
          ctx.stroke()
        }
      }
      if (feature.name && mode !== 'squished' && x2 + labelWidth < width) {
        ctx.fillStyle = palette.ink
        ctx.fillText(feature.name, x2 + 4, centerY + 3)
      }
    }
    ctx.restore()
    return visible.length
  }

  private drawInteractionTrack(
    spec: TrackSpec,
    track: TrackRuntime,
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
  ): number {
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    ctx.fillStyle = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillRect(LABEL_WIDTH, top, plotWidth, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) { ctx.fillStyle = palette.selectionFill; ctx.fillRect(0, top, LABEL_WIDTH, height) }
    ctx.strokeStyle = palette.line
    ctx.beginPath(); ctx.moveTo(0, bottom - 0.5); ctx.lineTo(width, bottom - 0.5); ctx.stroke()
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds()
    const labelLines = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 16) / 15)))
    drawCenteredTextLines(ctx, labelLines, labelBounds.center, verticallyCenteredBaseline(top, height, labelLines.length, 15), 15)
    if (track.status === 'error' || track.status === 'offline') {
      ctx.fillStyle = palette.error
      ctx.font = '11px Inter, system-ui, sans-serif'
      wrapText(ctx, track.error ?? 'Could not load interactions', 24, bottom - 25, 136, 15, 2)
      return 0
    }
    const inWindow = track.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as InteractionFeature[]
    if (!inWindow.length) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText(track.status === 'loading' ? 'Loading interactions…' : 'No interactions in this window', PLOT_LEFT + 22, top + height / 2)
      return 0
    }

    const filterMode = spec.interactionFilterMode ?? 'all'
    const geneTargets: InteractionGeneTarget[] = filterMode === 'genes'
      ? (spec.interactionFilterGenes ?? []).map((name) => ({ name, gene: this.geneSource?.find(name) }))
      : filterMode === 'visible-genes'
        ? (this.geneSource?.featuresFor(this.region) ?? []).map((gene) => ({ name: gene.name, gene }))
        : []
    const visible = filterMode === 'all' ? inWindow : filterInteractionsForGenes(inWindow, geneTargets)
    if (!visible.length) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      const unavailable = filterMode === 'visible-genes' && !this.geneSource
      ctx.fillText(unavailable ? 'No gene annotation is available for this reference' : 'No interactions match the gene filter', PLOT_LEFT + 22, top + height / 2)
      return 0
    }

    const shown = selectInteractionFeatures(visible)
    const scored = shown.map((feature) => feature.score).filter((score): score is number => Number.isFinite(score))
    const scoreMin = scored.length ? Math.min(...scored) : 0
    const scoreMax = scored.length ? Math.max(...scored) : 0
    const scale = plotWidth / (this.region.end - this.region.start)
    const arcDirection = spec.interactionDirection === 'down' ? 1 : -1
    const baseline = arcDirection > 0 ? top + 7 : bottom - 7
    ctx.save()
    ctx.beginPath(); ctx.rect(PLOT_LEFT, top + 2, plotWidth, height - 3); ctx.clip()
    for (const feature of shown) {
      const emphasis = interactionEmphasis(feature.score, scoreMin, scoreMax)
      const color = feature.itemRgb ?? spec.color
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 0.8 + emphasis * 2.2
      ctx.globalAlpha = 0.3 + emphasis * 0.62
      if (feature.chrom1 === this.region.chr && feature.chrom2 === this.region.chr) {
        const x1 = PLOT_LEFT + (((feature.start1 + feature.end1) / 2) - this.region.start) * scale
        const x2 = PLOT_LEFT + (((feature.start2 + feature.end2) / 2) - this.region.start) * scale
        const arcHeight = interactionArcHeight(Math.abs(x2 - x1), height)
        ctx.beginPath()
        ctx.moveTo(x1, baseline)
        ctx.bezierCurveTo(x1, baseline + arcDirection * arcHeight * 1.35, x2, baseline + arcDirection * arcHeight * 1.35, x2, baseline)
        ctx.stroke()
        drawInteractionAnchor(ctx, feature.start1, feature.end1, this.region, scale, baseline, width)
        drawInteractionAnchor(ctx, feature.start2, feature.end2, this.region, scale, baseline, width)
      } else {
        const firstIsVisible = feature.chrom1 === this.region.chr
        const anchorStart = firstIsVisible ? feature.start1 : feature.start2
        const anchorEnd = firstIsVisible ? feature.end1 : feature.end2
        const otherChromosome = firstIsVisible ? feature.chrom2 : feature.chrom1
        const x = PLOT_LEFT + (((anchorStart + anchorEnd) / 2) - this.region.start) * scale
        drawInteractionAnchor(ctx, anchorStart, anchorEnd, this.region, scale, baseline, width)
        ctx.setLineDash([3, 3])
        const markerEnd = arcDirection > 0 ? bottom - 16 : top + 16
        ctx.beginPath(); ctx.moveTo(x, baseline + arcDirection * 3); ctx.lineTo(x, markerEnd); ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = Math.max(ctx.globalAlpha, 0.75)
        ctx.font = '9px Inter, system-ui, sans-serif'
        ctx.fillText(otherChromosome, x + 3, arcDirection > 0 ? bottom - 6 : top + 12)
      }
    }
    ctx.restore()
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    if (shown.length < visible.length) {
      ctx.fillStyle = palette.muted
      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.fillText(`Showing ${shown.length.toLocaleString()} of ${visible.length.toLocaleString()} interactions`, PLOT_LEFT + 8, arcDirection > 0 ? bottom - 5 : top + 13)
    }
    return shown.length
  }

  private drawMatrixTrack(
    spec: TrackSpec,
    track: TrackRuntime,
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
  ): number {
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    ctx.fillStyle = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillRect(LABEL_WIDTH, top, plotWidth, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) { ctx.fillStyle = palette.selectionFill; ctx.fillRect(0, top, LABEL_WIDTH, height) }
    ctx.strokeStyle = palette.line
    ctx.beginPath(); ctx.moveTo(0, bottom - 0.5); ctx.lineTo(width, bottom - 0.5); ctx.stroke()

    const matrix = track.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds()
    const labelLines = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 30) / 15)))
    drawCenteredTextLines(ctx, labelLines, labelBounds.center, top + Math.max(15, (height - labelLines.length * 15) / 2), 15)
    ctx.fillStyle = palette.muted
    ctx.font = '9px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    const resolution = matrix?.resolution ?? spec.matrixResolution
    const normalization = spec.matrixNormalization ?? 'raw'
    const scaleLabel = spec.matrixScaleMax ? `z≤${formatScore(spec.matrixScaleMax)}` : 'auto z'
    ctx.fillText(`${resolution ? formatBases(resolution) : 'auto'} · ${normalization} · ${spec.matrixTransform === 'linear' ? 'linear' : 'log'} · ${scaleLabel}`, labelBounds.center, bottom - 8)
    ctx.textAlign = 'start'
    if (track.status === 'error' || track.status === 'offline') {
      ctx.fillStyle = palette.error
      ctx.font = '11px Inter, system-ui, sans-serif'
      wrapText(ctx, track.error ?? 'Could not load contact matrix', 24, bottom - 38, 136, 15, 2)
      return 0
    }
    if (!matrix) {
      if (track.status === 'loading') {
        ctx.fillStyle = palette.muted
        ctx.font = '12px Inter, system-ui, sans-serif'
        ctx.fillText('Loading contacts…', PLOT_LEFT + 22, top + height / 2)
      }
      return 0
    }

    const offDiagonalValues = matrix.cells
      .filter((cell) => cell.bin2 - cell.bin1 > matrix.resolution * 2)
      .map((cell) => cell.value)
      .filter((value) => Number.isFinite(value) && value > 0)
    const values = (offDiagonalValues.length >= 20 ? offDiagonalValues : matrix.cells.map((cell) => cell.value).filter((value) => Number.isFinite(value) && value > 0)).sort((a, b) => a - b)
    const automaticMaximum = values[Math.min(values.length - 1, Math.floor(values.length * 0.99))] ?? 1
    const maximum = Math.max(Number.EPSILON, spec.matrixScaleMax ?? automaticMaximum)
    const transform = spec.matrixTransform === 'linear'
      ? (value: number) => value / maximum
      : (value: number) => Math.log1p(value) / Math.log1p(maximum)
    const scale = plotWidth / Math.max(1, this.region.end - this.region.start)
    const direction = spec.matrixDirection === 'down' ? 1 : -1
    const baseline = direction > 0 ? top + 3 : bottom - 3
    const halfCell = Math.max(0.55, matrix.resolution * scale / 2)
    const matrixPalette = spec.matrixPalette ?? 'monochrome'
    ctx.save()
    ctx.beginPath(); ctx.rect(PLOT_LEFT, top + 1, plotWidth, height - 2); ctx.clip()
    for (const cell of matrix.cells) {
      if (!(cell.value > 0) || cell.bin2 + matrix.resolution <= this.region.start || cell.bin1 >= this.region.end) continue
      const firstCenter = cell.bin1 + matrix.resolution / 2
      const secondCenter = cell.bin2 + matrix.resolution / 2
      const x = PLOT_LEFT + (((firstCenter + secondCenter) / 2) - this.region.start) * scale
      const y = baseline + direction * ((secondCenter - firstCenter) / 2) * scale
      if (x + halfCell < PLOT_LEFT || x - halfCell > width || y + halfCell < top || y - halfCell > bottom) continue
      const intensity = Math.max(0, Math.min(1, transform(cell.value)))
      if (!Number.isFinite(intensity) || intensity <= 0) continue
      const warmPalette = matrixPalette !== 'monochrome'
      ctx.fillStyle = matrixPalette === 'warm-dark' ? matrixDarkWarmPaletteColor(intensity)
        : warmPalette ? matrixWarmPaletteColor(intensity) : spec.color
      ctx.globalAlpha = warmPalette ? 1 : 0.08 + Math.pow(intensity, 0.72) * 0.92
      ctx.beginPath()
      ctx.moveTo(x - halfCell, y)
      ctx.lineTo(x, y + halfCell)
      ctx.lineTo(x + halfCell, y)
      ctx.lineTo(x, y - halfCell)
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.axisLine
    ctx.beginPath(); ctx.moveTo(PLOT_LEFT, baseline + 0.5); ctx.lineTo(width, baseline + 0.5); ctx.stroke()
    ctx.restore()
    return matrix.cells.length
  }

  private drawAlignmentTrack(
    spec: TrackSpec,
    track: TrackRuntime,
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
  ): number {
    const ctx = this.context
    const bottom = top + height
    ctx.fillStyle = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillRect(LABEL_WIDTH, top, width - LABEL_WIDTH, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) { ctx.fillStyle = palette.selectionFill; ctx.fillRect(0, top, LABEL_WIDTH, height) }
    ctx.strokeStyle = palette.line
    ctx.beginPath(); ctx.moveTo(0, bottom - 0.5); ctx.lineTo(width, bottom - 0.5); ctx.stroke()
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds()
    const labelLines = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 30) / 15)))
    drawCenteredTextLines(ctx, labelLines, labelBounds.center, top + Math.max(15, (height - labelLines.length * 15) / 2), 15)
    ctx.fillStyle = palette.muted
    ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`BAM · MAPQ ≥ ${spec.bamMinMapq ?? 0}`, labelBounds.center, bottom - 10)
    ctx.textAlign = 'start'
    if (track.status === 'error' || track.status === 'offline') {
      ctx.fillStyle = palette.error
      ctx.font = '11px Inter, system-ui, sans-serif'
      wrapText(ctx, track.error ?? 'Could not load alignments', 24, bottom - 42, 136, 15, 2)
      return 0
    }
    const visible = track.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end)
    const coverage = visible.filter((feature): feature is AlignmentCoverageFeature => 'featureType' in feature && feature.featureType === 'coverage')
    const alignments = visible.filter((feature): feature is AlignmentFeature => 'featureType' in feature && feature.featureType === 'alignment')
    if (!visible.length) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText(track.status === 'loading' ? 'Loading alignments…' : 'No passing reads in this window', PLOT_LEFT + 22, top + height / 2)
      return 0
    }
    const viewMode = spec.bamViewMode ?? 'both'
    const coverageHeight = viewMode === 'both' ? Math.min(54, Math.max(28, height * 0.28)) : viewMode === 'coverage' ? height - 8 : 0
    if (coverageHeight > 0 && coverage.length) this.drawBamCoverage(coverage, spec.color, top + 4, coverageHeight, width, palette)
    const readsTop = top + coverageHeight + (coverageHeight ? 7 : 4)
    if (viewMode !== 'coverage') {
      if (alignments.length) this.drawBamReads(alignments, spec, readsTop, bottom - 3, width, palette)
      else {
        ctx.fillStyle = palette.muted
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.fillText('Zoom below 250 kb to draw individual reads', PLOT_LEFT + 22, Math.min(bottom - 10, readsTop + 18))
      }
    }
    return alignments.length + coverage.length
  }

  private drawBamCoverage(features: AlignmentCoverageFeature[], color: string, top: number, height: number, width: number, palette: CanvasPalette): void {
    const ctx = this.context
    const max = Math.max(1, ...features.map((feature) => feature.score))
    const scaleX = (width - PLOT_LEFT) / (this.region.end - this.region.start)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.76
    for (const feature of features) {
      if (feature.score <= 0) continue
      const x1 = Math.max(PLOT_LEFT, PLOT_LEFT + (feature.start - this.region.start) * scaleX)
      const x2 = Math.min(width, PLOT_LEFT + (feature.end - this.region.start) * scaleX)
      const barHeight = (feature.score / max) * (height - 11)
      ctx.fillRect(x1, top + height - barHeight, Math.max(1, x2 - x1), barHeight)
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.axisLine
    ctx.beginPath(); ctx.moveTo(PLOT_LEFT, top + height + 0.5); ctx.lineTo(width, top + height + 0.5); ctx.stroke()
    ctx.fillStyle = palette.axisInk
    ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
    ctx.fillText(formatScore(max), PLOT_LEFT + 4, top + 9)
  }

  private drawBamReads(features: AlignmentFeature[], spec: TrackSpec, top: number, bottom: number, width: number, palette: CanvasPalette): void {
    const ctx = this.context
    const mode = spec.alignmentDisplayMode ?? 'expanded'
    const rowHeight = mode === 'squished' ? 5 : mode === 'collapsed' ? 8 : 13
    const readHeight = Math.max(3, rowHeight - 3)
    const scale = (width - PLOT_LEFT) / (this.region.end - this.region.start)
    const groups = alignmentRenderGroups(features, spec.bamViewAsPairs === true)
    const laneEnds: number[] = []
    ctx.save()
    ctx.beginPath(); ctx.rect(PLOT_LEFT, top, width - PLOT_LEFT, Math.max(0, bottom - top)); ctx.clip()
    for (const group of groups) {
      const rawX1 = PLOT_LEFT + (group.start - this.region.start) * scale
      const rawX2 = PLOT_LEFT + (group.end - this.region.start) * scale
      let lane = 0
      while (rawX1 <= (laneEnds[lane] ?? Number.NEGATIVE_INFINITY)) lane += 1
      laneEnds[lane] = rawX2 + 2
      const centerY = top + lane * rowHeight + rowHeight / 2
      if (centerY + readHeight / 2 > bottom) continue
      if (group.reads.length > 1) {
        ctx.strokeStyle = bamReadColor(group.reads[0], spec, palette)
        ctx.globalAlpha = 0.65
        ctx.beginPath(); ctx.moveTo(Math.max(PLOT_LEFT, rawX1), centerY); ctx.lineTo(Math.min(width, rawX2), centerY); ctx.stroke()
        ctx.globalAlpha = 1
      }
      for (const read of group.reads) {
        const color = bamReadColor(read, spec, palette)
        ctx.fillStyle = color
        ctx.strokeStyle = color
        ctx.globalAlpha = Math.max(0.28, Math.min(1, 0.32 + read.mapq / 70))
        for (const block of read.blocks) {
          const x1 = Math.max(PLOT_LEFT, PLOT_LEFT + (block.start - this.region.start) * scale)
          const x2 = Math.min(width, PLOT_LEFT + (block.end - this.region.start) * scale)
          if (x2 <= x1) continue
          drawDirectionalReadBlock(ctx, x1, x2, centerY, readHeight, read.strand)
        }
        ctx.globalAlpha = 1
        if (spec.bamShowMismatches !== false) for (const difference of read.differences) {
          const x = PLOT_LEFT + (difference.position - this.region.start) * scale
          if (x < PLOT_LEFT || x > width) continue
          if (difference.kind === 'substitution') {
            const base = difference.bases?.[0]?.toUpperCase() ?? 'N'
            ctx.fillStyle = bamBaseColor(base)
            ctx.fillRect(x, centerY - readHeight / 2, Math.max(1.5, scale), readHeight)
            if (scale >= 7 && readHeight >= 9) {
              ctx.fillStyle = '#ffffff'; ctx.font = 'bold 8px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillText(base, x + scale / 2, centerY + 3); ctx.textAlign = 'start'
            }
          } else if (difference.kind === 'insertion') {
            ctx.strokeStyle = '#9b59e6'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, centerY - readHeight / 2 - 1); ctx.lineTo(x, centerY + readHeight / 2 + 1); ctx.stroke(); ctx.lineWidth = 1
          } else if (difference.kind === 'deletion') {
            ctx.strokeStyle = palette.ink; ctx.beginPath(); ctx.moveTo(x, centerY); ctx.lineTo(x + Math.max(1, difference.length * scale), centerY); ctx.stroke()
          } else if (difference.kind === 'skip') {
            ctx.strokeStyle = palette.muted; ctx.beginPath(); ctx.moveTo(x, centerY); ctx.lineTo(x + Math.max(1, difference.length * scale), centerY); ctx.stroke()
          } else if (difference.kind === 'soft-clip') {
            ctx.strokeStyle = palette.axisInk; ctx.setLineDash([2, 1]); ctx.beginPath(); ctx.moveTo(x, centerY - readHeight / 2); ctx.lineTo(x, centerY + readHeight / 2); ctx.stroke(); ctx.setLineDash([])
          }
        }
      }
    }
    ctx.restore()
    if (laneEnds.length * rowHeight > bottom - top) {
      ctx.fillStyle = palette.muted
      ctx.font = '9px Inter, system-ui, sans-serif'
      ctx.textAlign = 'right'; ctx.fillText(`${laneEnds.length} rows · increase track height`, width - 8, bottom - 3); ctx.textAlign = 'start'
    }
  }

  private drawGroupRail(groupId: string, top: number, bottom: number, palette: CanvasPalette): void {
    const group = this.document.groups.find((item) => item.id === groupId)
    if (!group) return
    const ctx = this.context
    const members = this.document.tracks.filter((track) => track.displayGroupId === groupId)
    const memberIds = members.map((track) => track.id)
    const selected = memberIds.length > 0 && memberIds.every((id) => this.selectedTrackIds.has(id))
    const memberColors = members.flatMap((track) => track.kind === 'stranded' ? [track.color, track.negativeColor ?? track.color] : [track.color])
    const color = memberColors.length > 0 && memberColors.every((memberColor) => memberColor === memberColors[0])
      ? memberColors[0]
      : palette.axisLine
    const cardTop = top + 3.5
    const cardHeight = Math.max(5, bottom - top - 7)
    ctx.save()
    if (selected) {
      ctx.fillStyle = palette.selectionFill
      ctx.beginPath()
      ctx.roundRect(0.5, cardTop - 2, 23, cardHeight + 4, 6)
      ctx.fill()
      ctx.strokeStyle = palette.selection
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.fillStyle = color
    ctx.globalAlpha = 0.12
    ctx.beginPath()
    ctx.roundRect(2.5, cardTop, 19, cardHeight, 5)
    ctx.fill()
    ctx.globalAlpha = 0.7
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(2.5, cardTop, 4, cardHeight, [5, 0, 0, 5])
    ctx.fill()
    if (selected && cardHeight >= 18) {
      ctx.fillStyle = palette.selection
      ctx.beginPath()
      ctx.arc(13, cardTop + 7, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ctx.save()
    ctx.translate(13, top + (bottom - top) / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.font = '600 10px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = palette.ink
    ctx.fillText(ellipsize(ctx, group.label, Math.max(30, bottom - top - 18)), 0, 0)
    ctx.restore()
  }

  private drawGeneTrack(spec: TrackSpec, width: number, top: number, height: number, palette: CanvasPalette): number {
    const source = this.geneSource
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    ctx.fillStyle = palette.geneTrack
    ctx.fillRect(LABEL_WIDTH, top, width - LABEL_WIDTH, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) {
      ctx.fillStyle = palette.selectionFill
      ctx.fillRect(0, top, LABEL_WIDTH, height)
    }
    ctx.strokeStyle = palette.line
    ctx.beginPath()
    ctx.moveTo(0, top + 0.5)
    ctx.lineTo(width, top + 0.5)
    ctx.moveTo(0, bottom - 0.5)
    ctx.lineTo(width, bottom - 0.5)
    ctx.stroke()

    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds()
    const labelLines = wrappedLines(ctx, spec.label || source?.name || 'Genes', labelBounds.width, Math.max(1, Math.min(2, Math.floor((height - 8) / 15))))
    const labelTop = verticallyCenteredBaseline(top, height, labelLines.length, 15)
    drawCenteredTextLines(ctx, labelLines, labelBounds.center, labelTop, 15)
    ctx.fillStyle = palette.muted
    ctx.font = '8px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(ellipsize(ctx, source ? this.geneAssembly : 'No annotation source for this reference', labelBounds.width), labelBounds.center, bottom - 5)
    ctx.textAlign = 'start'
    if (!source) return 0

    const layout = this.buildGeneLayout(spec, width, ctx)
    if (layout.blocks.length === 0) {
      ctx.fillStyle = palette.muted
      ctx.fillText('No annotated genes in this window', PLOT_LEFT + 22, top + height / 2)
      return 0
    }
    const mode = spec.geneDisplayMode ?? 'collapsed'
    if (mode !== 'collapsed' && layout.transcriptCount > 2_000) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText(`${layout.transcriptCount.toLocaleString()} transcripts · zoom in to see structures`, PLOT_LEFT + 22, top + height / 2)
      return layout.blocks.length
    }

    const span = this.region.end - this.region.start
    const scale = plotWidth / span
    const maxOffset = Math.max(0, layout.contentHeight - height)
    const offset = Math.max(0, Math.min(maxOffset, this.geneScrollOffsets.get(spec.id) ?? 0))
    if (offset) this.geneScrollOffsets.set(spec.id, offset)
    else this.geneScrollOffsets.delete(spec.id)
    const contentTop = top + GENE_CONTENT_PADDING - offset
    let drawn = 0
    ctx.font = mode === 'squished' ? '600 9px Inter, system-ui, sans-serif' : '600 10px Inter, system-ui, sans-serif'
    ctx.save()
    ctx.beginPath()
    ctx.rect(PLOT_LEFT, top, plotWidth, height)
    ctx.clip()
    for (const block of layout.blocks) {
      const { gene, transcripts, firstSlot, geneX1, geneX2 } = block
      const geneCenterX = (geneX1 + geneX2) / 2
      if (block.labelX !== undefined) {
        const labelY = mode === 'collapsed'
          ? contentTop + 9 + (block.labelLane ?? 0) * 11
          : contentTop + firstSlot * layout.slotHeight + layout.slotHeight - 1
        ctx.fillStyle = palette.ink
        ctx.textAlign = 'center'
        ctx.fillText(gene.name, block.labelX, labelY)
        if (mode === 'collapsed') {
          ctx.strokeStyle = palette.axisLine
          ctx.globalAlpha = 0.55
          ctx.lineWidth = 0.75
          ctx.beginPath()
          ctx.moveTo(block.labelX, labelY + 2)
          ctx.lineTo(geneCenterX, contentTop + 33)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
        ctx.textAlign = 'start'
      }

      transcripts.forEach((transcript, transcriptIndex) => {
        const centerY = mode === 'collapsed'
          ? contentTop + 39
          : contentTop + (firstSlot + transcriptIndex + 1) * layout.slotHeight + layout.slotHeight / 2
        const rawTxX1 = PLOT_LEFT + (transcript.start - this.region.start) * scale
        const rawTxX2 = PLOT_LEFT + (transcript.end - this.region.start) * scale
        const txX1 = Math.max(PLOT_LEFT, rawTxX1)
        const txX2 = Math.min(width, rawTxX2)
        const color = spec.color || palette.gene
        const direction = gene.strand === '+' ? 1 : -1
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.lineWidth = mode === 'squished' ? 0.8 : 1.25
        ctx.beginPath()
        ctx.moveTo(txX1, centerY)
        ctx.lineTo(Math.max(txX1 + 1, txX2), centerY)
        ctx.stroke()
        const exonPixels: Array<{ start: number; end: number }> = []
        for (const exon of transcript.exons) {
          const exonX1 = Math.max(PLOT_LEFT, PLOT_LEFT + (exon.start - this.region.start) * scale)
          const exonX2 = Math.min(width, PLOT_LEFT + (exon.end - this.region.start) * scale)
          if (exonX2 <= exonX1) continue
          exonPixels.push({ start: exonX1, end: exonX2 })
          const utrHeight = mode === 'squished' ? 3 : 5
          ctx.fillRect(exonX1, centerY - utrHeight / 2, Math.max(1, exonX2 - exonX1), utrHeight)
        }
        for (const cds of transcript.cds) {
          const cdsX1 = Math.max(PLOT_LEFT, PLOT_LEFT + (cds.start - this.region.start) * scale)
          const cdsX2 = Math.min(width, PLOT_LEFT + (cds.end - this.region.start) * scale)
          if (cdsX2 <= cdsX1) continue
          const cdsHeight = mode === 'squished' ? 6 : 10
          ctx.fillRect(cdsX1, centerY - cdsHeight / 2, Math.max(1, cdsX2 - cdsX1), cdsHeight)
        }
        const arrowHalfHeight = mode === 'squished' ? 0.8 : 1.7
        ctx.lineWidth = mode === 'squished' ? 0.75 : 1
        for (const arrowX of phasedArrowPositions(rawTxX1, PLOT_LEFT + 3, Math.min(width, rawTxX2) - 4, 36, 14)) {
          const exonOverlap = chevronExonOverlap(arrowX, exonPixels, 3)
          if (exonOverlap === 'partial') continue
          ctx.strokeStyle = exonOverlap === 'inside' ? palette.geneTrack : color
          ctx.beginPath()
          ctx.moveTo(arrowX - direction * 3, centerY - arrowHalfHeight)
          ctx.lineTo(arrowX + direction * 2, centerY)
          ctx.lineTo(arrowX - direction * 3, centerY + arrowHalfHeight)
          ctx.stroke()
        }
        if (this.showTssIndicators && mode === 'collapsed' && transcriptIndex === 0 && txX2 - txX1 >= 25) {
          const rawTss = gene.strand === '+' ? transcript.start : transcript.end
          if (rawTss > this.region.start && rawTss < this.region.end) drawTssElbow(ctx, PLOT_LEFT + (rawTss - this.region.start) * scale, centerY, direction, color)
        }
        drawn += 1
      })
    }
    ctx.restore()
    if (maxOffset > 0) drawVerticalScrollIndicator(ctx, width - 6, top + 4, height - 8, offset, maxOffset, layout.contentHeight, palette)
    ctx.lineWidth = 1
    ctx.textAlign = 'start'
    return drawn
  }

  private buildGeneLayout(spec: TrackSpec, width: number, ctx: CanvasRenderingContext2D): GeneRenderLayout {
    const mode = spec.geneDisplayMode ?? 'collapsed'
    const slotHeight = mode === 'squished' ? 9 : mode === 'expanded' ? 15 : 15
    const genes = this.geneSource?.featuresFor(this.region) ?? []
    const transcriptCount = genes.reduce((sum, gene) => sum + gene.transcriptModels.length, 0)
    const plotWidth = width - PLOT_LEFT
    const scale = plotWidth / (this.region.end - this.region.start)
    const slotEnds: number[] = []
    const blocks: GeneRenderBlock[] = []
    ctx.save()
    ctx.font = mode === 'squished' ? '600 9px Inter, system-ui, sans-serif' : '600 10px Inter, system-ui, sans-serif'
    if (mode === 'collapsed') {
      const candidates = genes.flatMap((gene) => {
        const transcript = preferredTranscript(gene)
        if (!transcript) return []
        const geneX1 = Math.max(PLOT_LEFT, PLOT_LEFT + (gene.start - this.region.start) * scale)
        const geneX2 = Math.min(width, PLOT_LEFT + (gene.end - this.region.start) * scale)
        return [{ gene, transcript, geneX1, geneX2, labelWidth: ctx.measureText(gene.name).width }]
      }).sort((a, b) => a.geneX1 - b.geneX1 || a.geneX2 - b.geneX2)
      const placements = placeCollapsedGeneLabels(candidates.map((candidate) => ({
        preferredX: (candidate.geneX1 + candidate.geneX2) / 2,
        width: candidate.labelWidth,
      })), PLOT_LEFT, width)
      ctx.restore()
      return {
        blocks: candidates.map((candidate, index) => ({
          gene: candidate.gene,
          transcripts: [candidate.transcript],
          firstSlot: 0,
          geneX1: candidate.geneX1,
          geneX2: candidate.geneX2,
          labelX: placements[index]?.x,
          labelLane: placements[index]?.lane,
        })),
        slotHeight,
        contentHeight: 64,
        transcriptCount,
      }
    }
    if (transcriptCount > 2_000) {
      ctx.restore()
      return { blocks: genes.map((gene) => ({ gene, transcripts: [], firstSlot: 0, geneX1: PLOT_LEFT, geneX2: width })), slotHeight, contentHeight: slotHeight + GENE_CONTENT_PADDING * 2, transcriptCount }
    }
    for (const gene of genes) {
      const transcripts = gene.transcriptModels
      if (!transcripts.length) continue
      const requiredSlots = transcripts.length + 1
      const geneX1 = Math.max(PLOT_LEFT, PLOT_LEFT + (gene.start - this.region.start) * scale)
      const geneX2 = Math.min(width, PLOT_LEFT + (gene.end - this.region.start) * scale)
      const occupiedEnd = Math.max(geneX2, geneX1 + ctx.measureText(gene.name).width) + 8
      let firstSlot = 0
      while (true) {
        let available = true
        for (let slot = firstSlot; slot < firstSlot + requiredSlots; slot += 1) {
          if (geneX1 <= (slotEnds[slot] ?? PLOT_LEFT - 1)) { available = false; break }
        }
        if (available) break
        firstSlot += 1
      }
      for (let slot = firstSlot; slot < firstSlot + requiredSlots; slot += 1) slotEnds[slot] = occupiedEnd
      const labelWidth = ctx.measureText(gene.name).width
      blocks.push({
        gene, transcripts, firstSlot, geneX1, geneX2,
        labelX: Math.max(PLOT_LEFT + labelWidth / 2, Math.min(width - labelWidth / 2, (geneX1 + geneX2) / 2)),
      })
    }
    ctx.restore()
    return { blocks, slotHeight, contentHeight: Math.max(slotHeight, slotEnds.length * slotHeight) + GENE_CONTENT_PADDING * 2, transcriptCount }
  }

  private scrollGeneTrack(spec: TrackSpec, deltaY: number, width: number): boolean {
    const height = this.trackHeight(spec)
    const context = spec.pane === 'main' ? this.mainContext : this.bottomContext
    const layout = this.buildGeneLayout(spec, width, context)
    const maxOffset = Math.max(0, layout.contentHeight - height)
    if (!maxOffset) return false
    const current = Math.max(0, Math.min(maxOffset, this.geneScrollOffsets.get(spec.id) ?? 0))
    const next = Math.max(0, Math.min(maxOffset, current + deltaY))
    if (Math.abs(next - current) < 0.1) return false
    this.geneScrollOffsets.set(spec.id, next)
    this.scheduleRender()
    return true
  }

  private drawEmptyState(width: number, bottom: number, palette: CanvasPalette): void {
    const ctx = this.context
    const y = Math.max(70, bottom) / 2
    ctx.fillStyle = palette.label
    ctx.font = '600 14px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Open or drop genomics files', PLOT_LEFT + (width - PLOT_LEFT) / 2, y - 7)
    ctx.fillStyle = palette.muted
    ctx.font = '12px Inter, system-ui, sans-serif'
    ctx.fillText(SUPPORTED_TRACK_EXTENSION_LABEL, PLOT_LEFT + (width - PLOT_LEFT) / 2, y + 15)
    ctx.textAlign = 'start'
  }

  private hasOverscanCoverage(): boolean {
    return this.visibleSourceSpecs().every((spec) => {
      return this.runtimesForTrack(spec.id).every((track) => !track.source || this.hasSuitableData(track))
    })
  }

  /**
   * Overscan makes ordinary pans inexpensive, but it must not keep a coarse
   * summary after zooming in. Sources choose their indexed summary level from
   * the requested bases-per-pixel value, so refresh once the viewport asks for
   * materially finer detail.
   */
  private hasSuitableData(track: TrackRuntime): boolean {
    if (!track.loadedRegion || !contains(track.loadedRegion, this.region)) return false
    if (!track.loadedBasesPerPixel) return false
    const plotWidth = Math.max(1, this.cssWidth() - PLOT_LEFT)
    // The query requests three times as many pixels for a three-times-wider
    // overscan region, so its effective resolution is viewport span / width.
    const requestedBasesPerPixel = (this.region.end - this.region.start) / plotWidth
    if (track.loadedBasesPerPixel > requestedBasesPerPixel * 1.25) return false
    const spec = this.document.tracks.find((candidate) => candidate.id === track.trackId)
    if (spec?.kind === 'matrix') {
      const requiredDistance = matrixMaximumDistance(this.trackHeight(spec), this.region.end - this.region.start, plotWidth)
      if ((track.loadedMatrixMaxDistance ?? 0) < requiredDistance) return false
    }
    return true
  }

  private async ensureData(): Promise<void> {
    await Promise.all(this.visibleSourceSpecs().flatMap((spec) => this.runtimesForTrack(spec.id)).map(async (track) => {
      if (track?.source && track.status !== 'loading' && !this.hasSuitableData(track)) await this.loadTrack(track)
    }))
  }

  private async loadTrack(track: TrackRuntime): Promise<void> {
    const source = track.source
    if (!source) return
    const spec = this.document.tracks.find((item) => item.id === track.trackId)
    const chromosomeLength = this.chromosomes.get(this.region.chr) ?? source.chromosomes.get(this.region.chr)
    if (!chromosomeLength) {
      track.status = 'error'
      track.error = `No chromosome named ${this.region.chr} in this file.`
      this.emitTracks()
      this.scheduleRender()
      return
    }
    const span = this.region.end - this.region.start
    const overscanFactor = spec?.kind === 'matrix' ? MATRIX_OVERSCAN_FACTOR : OVERSCAN_FACTOR
    const queryRegion = clampRegion({
      chr: this.region.chr,
      start: this.region.start - span * overscanFactor,
      end: this.region.end + span * overscanFactor,
    }, chromosomeLength)
    const version = ++track.requestVersion
    this.abortControllers.get(track.id)?.abort()
    const controller = new AbortController()
    this.abortControllers.set(track.id, controller)
    track.status = 'loading'
    track.error = undefined
    this.emitTracks()
    this.scheduleRender()
    try {
      const plotWidth = Math.max(1, this.cssWidth() - PLOT_LEFT)
      const options = spec?.kind === 'alignment' ? {
        bamViewMode: spec.bamViewMode,
        bamViewAsPairs: spec.bamViewAsPairs,
        bamMinMapq: spec.bamMinMapq,
        bamIncludeDuplicates: spec.bamIncludeDuplicates,
        bamIncludeSecondary: spec.bamIncludeSecondary,
        bamIncludeSupplementary: spec.bamIncludeSupplementary,
      } : spec?.kind === 'matrix' ? {
        matrixResolution: spec.matrixResolution,
        matrixNormalization: spec.matrixNormalization,
        matrixMaxDistance: matrixMaximumDistance(this.trackHeight(spec), queryRegion.end - queryRegion.start, plotWidth * (1 + overscanFactor * 2)),
      } : undefined
      const queryPixelWidth = plotWidth * (1 + overscanFactor * 2)
      const features = await source.getFeatures(queryRegion, queryPixelWidth, controller.signal, options)
      if (version !== track.requestVersion) return
      track.features = features
      track.loadedRegion = queryRegion
      track.loadedBasesPerPixel = (queryRegion.end - queryRegion.start) / Math.max(1, queryPixelWidth)
      track.loadedMatrixMaxDistance = spec?.kind === 'matrix' ? options?.matrixMaxDistance : undefined
      track.status = 'ready'
    } catch (error) {
      if (version !== track.requestVersion || isAbortError(error)) return
      track.status = 'error'
      track.error = error instanceof Error ? error.message : String(error)
    }
    this.emitTracks()
    this.scheduleRender()
    if (track.status === 'ready' && track.source && !this.hasSuitableData(track)) void this.loadTrack(track)
  }

  private visibleSignalSpecs(): TrackSpec[] {
    return this.document.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && track.enabled)
  }

  private visibleSourceSpecs(): TrackSpec[] {
    return this.document.tracks.filter((track) => track.kind !== 'genes' && track.enabled)
  }

  private visibleSpecs(pane: 'main' | 'bottom'): TrackSpec[] {
    return this.document.tracks.filter((track) => track.enabled && track.pane === pane)
  }

  private trackHeight(track: TrackSpec): number {
    const preview = this.resizePreviewPixels.get(track.id)
    if (preview !== undefined) return preview
    if (track.kind !== 'genes' || track.pane !== 'bottom') return trackSpecHeight(track)
    const width = this.bottomCanvas.parentElement?.clientWidth || this.cssWidth(this.bottomCanvas)
    const layoutHeight = this.geneSource ? this.buildGeneLayout(track, width, this.bottomContext).contentHeight : 0
    return Math.max(MIN_BOTTOM_GENE_HEIGHT, Math.ceil(layoutHeight))
  }

  private resizeBoundaryAt(pane: 'main' | 'bottom', pointerY: number): { trackIds: string[]; edge: 'top' | 'bottom'; y: number } | undefined {
    const specs = this.visibleSpecs(pane)
    let top = 0
    const candidates: Array<{ trackIds: string[]; edge: 'top' | 'bottom'; y: number }> = []
    for (let index = 0; index < specs.length;) {
      const track = specs[index]
      const height = this.trackHeight(track)
      if (!this.selectedTrackIds.has(track.id) || (track.kind === 'genes' && track.pane === 'bottom')) {
        top += height
        index += 1
        continue
      }
      const runTop = top
      const trackIds: string[] = []
      while (index < specs.length) {
        const candidate = specs[index]
        if (!this.selectedTrackIds.has(candidate.id) || (candidate.kind === 'genes' && candidate.pane === 'bottom')) break
        trackIds.push(candidate.id)
        top += this.trackHeight(candidate)
        index += 1
      }
      candidates.push({ trackIds, edge: 'top', y: runTop }, { trackIds, edge: 'bottom', y: top })
    }
    return candidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.y - pointerY) }))
      .filter(({ distance }) => distance <= 5)
      .sort((a, b) => a.distance - b.distance)[0]?.candidate
  }

  private itemAt(_canvas: HTMLCanvasElement, pane: 'main' | 'bottom', x: number, y: number): { kind: 'track' | 'group'; id: string } | undefined {
    let top = 0
    for (const track of this.visibleSpecs(pane)) {
      const bottom = top + this.trackHeight(track)
      if (y >= top && y < bottom) return x < GROUP_RAIL_WIDTH && track.displayGroupId
        ? { kind: 'group', id: track.displayGroupId }
        : { kind: 'track', id: track.id }
      top = bottom
    }
    return undefined
  }

  private paneStackHeight(pane: 'main' | 'bottom'): number {
    return this.visibleSpecs(pane).reduce((height, track) => height + this.trackHeight(track), 0)
  }

  private dropTarget(clientX: number, clientY: number, draggedIds: readonly string[]): { pane: 'main' | 'bottom'; insertionIndex: number } | undefined {
    const panes: Array<{ pane: 'main' | 'bottom'; canvas: HTMLCanvasElement }> = [
      { pane: 'bottom', canvas: this.bottomCanvas },
      { pane: 'main', canvas: this.canvas },
    ]
    const movingIds = this.movingIds(draggedIds)
    for (const entry of panes) {
      if (this.trackDrag?.withinGroupId) {
        const groupPane = this.document.tracks.find((track) => track.displayGroupId === this.trackDrag?.withinGroupId)?.pane
        if (entry.pane !== groupPane) continue
      }
      const viewport = entry.canvas.parentElement?.getBoundingClientRect()
      if (!viewport || clientX < viewport.left || clientX > viewport.right || clientY < viewport.top || clientY > viewport.bottom) continue
      const localY = clientY - entry.canvas.getBoundingClientRect().top
      const specs = this.visibleSpecs(entry.pane).filter((track) => !movingIds.has(track.id))
      let y = 0
      let index = 0
      if (this.trackDrag?.withinGroupId) {
        for (const spec of specs) {
          const rowHeight = this.trackHeight(spec)
          if (spec.displayGroupId === this.trackDrag.withinGroupId && localY < y + rowHeight / 2) return { pane: entry.pane, insertionIndex: index }
          y += rowHeight
          index += 1
          if (spec.displayGroupId === this.trackDrag.withinGroupId && specs[index]?.displayGroupId !== this.trackDrag.withinGroupId) return { pane: entry.pane, insertionIndex: index }
        }
        return undefined
      }
      for (const block of trackBlocks(specs)) {
        const height = block.reduce((sum, track) => sum + this.trackHeight(track), 0)
        if (localY < y + height / 2) return { pane: entry.pane, insertionIndex: index }
        y += height
        index += block.length
      }
      return { pane: entry.pane, insertionIndex: specs.length }
    }
    return undefined
  }

  private insertionY(pane: 'main' | 'bottom', insertionIndex: number): number {
    const movingIds = this.movingIds(this.trackDrag?.draggedIds ?? [])
    const fullSpecs = this.visibleSpecs(pane)
    const remainingSpecs = fullSpecs.filter((track) => !movingIds.has(track.id))
    const trackAfterInsertion = remainingSpecs[insertionIndex]
    if (!trackAfterInsertion) return fullSpecs.reduce((sum, track) => sum + this.trackHeight(track), 0)
    const originalIndex = fullSpecs.findIndex((track) => track.id === trackAfterInsertion.id)
    return fullSpecs.slice(0, originalIndex).reduce((sum, track) => sum + this.trackHeight(track), 0)
  }

  private movingIds(trackIds: readonly string[]): Set<string> {
    const ids = new Set(trackIds)
    if (this.trackDrag?.withinGroupId) return ids
    for (const track of this.document.tracks) {
      if (!ids.has(track.id) || !track.displayGroupId) continue
      for (const member of this.document.tracks) if (member.displayGroupId === track.displayGroupId) ids.add(member.id)
    }
    return ids
  }

  private showTrackDragGhost(): void {
    const drag = this.trackDrag
    if (!drag) return
    const tracks = this.document.tracks.filter((track) => drag.draggedIds.includes(track.id))
    const group = drag.wholeGroup ? this.document.groups.find((item) => item.id === tracks[0]?.displayGroupId) : undefined
    const title = group?.label ?? (tracks.length === 1 ? tracks[0]?.label : `${tracks.length} selected tracks`)
    const detail = group ? `${tracks.length} tracks · moving group` : tracks.length === 1 && drag.withinGroupId ? 'Reordering within group' : 'Drag to the new position'
    this.trackDragGhost.innerHTML = `<i style="background:${escapeAttribute(group?.color ?? tracks[0]?.color ?? '#684ee0')}"></i><span><strong>${escapeAttribute(title ?? 'Track')}</strong><small>${detail}</small></span>`
    this.trackDragGhost.hidden = false
    this.positionTrackDragGhost(drag.clientX, drag.clientY)
  }

  private positionTrackDragGhost(x: number, y: number): void {
    this.trackDragGhost.style.transform = `translate3d(${Math.round(x + 16)}px, ${Math.round(y + 12)}px, 0)`
  }

  private emitTracks(): void {
    const ordered = this.document.tracks
      .filter((track) => track.kind !== 'genes')
      .flatMap((track) => this.runtimesForTrack(track.id))
      .filter((track): track is TrackRuntime => Boolean(track))
    this.callbacks.onTracksChange(ordered)
  }
}

interface CanvasPalette {
  background: string
  gutter: string
  ruler: string
  line: string
  ink: string
  muted: string
  tick: string
  label: string
  track: string
  trackAlternate: string
  error: string
  zero: string
  gene: string
  geneTrack: string
  selection: string
  selectionFill: string
  dragFill: string
  axisInk: string
  axisLine: string
  ideogramEmpty: string
  ideogramOutline: string
}

function runtimeDescriptors(track: TrackSpec): Array<Pick<TrackRuntime, 'id' | 'trackId' | 'sourceId' | 'channel'>> {
  if (track.kind === 'genes') return []
  if (track.kind === 'stranded') return [
    { id: signalFeatureKey(track.id, 'plus'), trackId: track.id, sourceId: track.sourceIds[0], channel: 'plus' },
    { id: signalFeatureKey(track.id, 'minus'), trackId: track.id, sourceId: track.sourceIds[1], channel: 'minus' },
  ]
  return track.sourceIds[0] ? [{
    id: signalFeatureKey(track.id, track.kind === 'signal' ? track.signalStrand : undefined),
    trackId: track.id,
    sourceId: track.sourceIds[0],
    channel: track.kind === 'signal' ? track.signalStrand : undefined,
  }] : []
}

function maximumMagnitude(features: readonly SignalFeature[]): number {
  let maximum = 0
  for (const feature of features) maximum = Math.max(maximum, Math.abs(feature.score))
  return maximum
}

const MAX_VISIBLE_INTERACTIONS = 2_000

export interface InteractionGeneTarget {
  name: string
  gene?: GeneFeature
}

export function filterInteractionsForGenes(features: readonly InteractionFeature[], targets: readonly InteractionGeneTarget[]): InteractionFeature[] {
  if (!targets.length) return []
  const intervalsByChromosome = new Map<string, Array<{ start: number; end: number }>>()
  const unresolvedNames = new Set<string>()
  for (const target of targets) {
    if (!target.gene) {
      const normalized = target.name.trim().toLocaleUpperCase()
      if (normalized) unresolvedNames.add(normalized)
      continue
    }
    const intervals = intervalsByChromosome.get(target.gene.chr) ?? []
    intervals.push({ start: target.gene.start, end: target.gene.end })
    intervalsByChromosome.set(target.gene.chr, intervals)
  }
  for (const [chromosome, intervals] of intervalsByChromosome) intervalsByChromosome.set(chromosome, mergeIntervals(intervals))
  return features.filter((feature) => overlapsAnyInterval(intervalsByChromosome.get(feature.chrom1), feature.start1, feature.end1)
    || overlapsAnyInterval(intervalsByChromosome.get(feature.chrom2), feature.start2, feature.end2)
    || interactionNameContainsAnyGene(feature.name, unresolvedNames))
}

function mergeIntervals(intervals: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = intervals.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const interval of sorted) {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

function overlapsAnyInterval(intervals: readonly { start: number; end: number }[] | undefined, start: number, end: number): boolean {
  if (!intervals?.length) return false
  let low = 0
  let high = intervals.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (intervals[middle].end <= start) low = middle + 1
    else high = middle
  }
  return low < intervals.length && intervals[low].start < end
}

function interactionNameContainsAnyGene(interactionName: string | undefined, genes: ReadonlySet<string>): boolean {
  if (!genes.size || !interactionName) return false
  const tokens: string[] = interactionName.toLocaleUpperCase().match(/[A-Z0-9][A-Z0-9.-]*/g) ?? []
  return tokens.some((token) => genes.has(token))
}

export function selectInteractionFeatures(features: readonly InteractionFeature[], limit = MAX_VISIBLE_INTERACTIONS): InteractionFeature[] {
  if (features.length <= limit) return [...features]
  return features.map((feature, order) => ({ feature, order }))
    .sort((a, b) => (b.feature.score ?? Number.NEGATIVE_INFINITY) - (a.feature.score ?? Number.NEGATIVE_INFINITY) || a.order - b.order)
    .slice(0, Math.max(0, limit))
    .sort((a, b) => a.order - b.order)
    .map(({ feature }) => feature)
}

export function interactionArcHeight(pixelSpan: number, trackHeight: number): number {
  return Math.min(Math.max(8, trackHeight - 14), Math.max(8, Math.sqrt(Math.max(0, pixelSpan)) * 4.2))
}

export function placeCollapsedGeneLabels(
  labels: readonly { preferredX: number; width: number }[],
  left: number,
  right: number,
  gap = 6,
): Array<{ x: number; lane: number } | undefined> {
  const laneEnds = [left - gap, left - gap]
  return labels.map((label) => {
    const halfWidth = Math.max(0, label.width) / 2
    const minimumCenter = left + halfWidth
    const maximumCenter = right - halfWidth
    if (minimumCenter > maximumCenter) return undefined
    const preferred = Math.max(minimumCenter, Math.min(maximumCenter, label.preferredX))
    const choices = laneEnds.flatMap((laneEnd, lane) => {
      const x = Math.max(preferred, laneEnd + gap + halfWidth)
      return x <= maximumCenter ? [{ x, lane, shift: Math.abs(x - preferred) }] : []
    }).sort((a, b) => a.shift - b.shift || a.lane - b.lane)
    const choice = choices[0]
    if (!choice) return undefined
    laneEnds[choice.lane] = choice.x + halfWidth
    return { x: choice.x, lane: choice.lane }
  })
}

/** Low-to-high contact intensity palette adapted from the figure workflow. */
export function matrixWarmPaletteColor(intensity: number): string {
  const value = Math.max(0, Math.min(1, intensity))
  const stops = [
    { at: 0, color: [255, 247, 188] },
    { at: 0.5, color: [253, 174, 97] },
    { at: 0.82, color: [215, 25, 28] },
    { at: 1, color: [17, 17, 17] },
  ] as const
  const upperIndex = Math.max(1, stops.findIndex((stop) => value <= stop.at))
  const lower = stops[upperIndex - 1]
  const upper = stops[upperIndex]
  const mix = (value - lower.at) / Math.max(Number.EPSILON, upper.at - lower.at)
  const channels = lower.color.map((channel, index) => Math.round(channel + (upper.color[index] - channel) * mix))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** Dark-canvas adaptation that preserves the warm progression without losing the maximum into black. */
export function matrixDarkWarmPaletteColor(intensity: number): string {
  const value = Math.max(0, Math.min(1, intensity))
  const stops = [
    { at: 0, color: [31, 27, 22] },
    { at: 0.42, color: [255, 211, 82] },
    { at: 0.8, color: [232, 48, 43] },
    { at: 1, color: [255, 248, 231] },
  ] as const
  const upperIndex = Math.max(1, stops.findIndex((stop) => value <= stop.at))
  const lower = stops[upperIndex - 1]
  const upper = stops[upperIndex]
  const mix = (value - lower.at) / Math.max(Number.EPSILON, upper.at - lower.at)
  const channels = lower.color.map((channel, index) => Math.round(channel + (upper.color[index] - channel) * mix))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function matrixMaximumDistance(trackHeight: number, genomicSpan: number, plotWidth: number): number {
  return Math.ceil(2 * (Math.max(1, trackHeight) + 6) * Math.max(1, genomicSpan) / Math.max(1, plotWidth))
}

function interactionEmphasis(score: number | undefined, minimum: number, maximum: number): number {
  if (!Number.isFinite(score) || maximum <= minimum) return 0.55
  return Math.max(0, Math.min(1, (score! - minimum) / (maximum - minimum)))
}

function drawInteractionAnchor(
  ctx: CanvasRenderingContext2D,
  start: number,
  end: number,
  region: Region,
  scale: number,
  baseline: number,
  width: number,
): void {
  const x1 = Math.max(PLOT_LEFT, PLOT_LEFT + (start - region.start) * scale)
  const x2 = Math.min(width, PLOT_LEFT + (end - region.start) * scale)
  if (x2 > x1) ctx.fillRect(x1, baseline - 3, Math.max(1, x2 - x1), 6)
}

function drawMagnitudeBins(
  ctx: CanvasRenderingContext2D,
  bins: readonly ({ min: number; max: number } | undefined)[],
  left: number,
  top: number,
  bottom: number,
  maximum: number,
  color: string,
  downward: boolean,
): void {
  const height = bottom - top
  ctx.fillStyle = color
  ctx.globalAlpha = 0.84
  ctx.save()
  ctx.beginPath(); ctx.rect(left, top, bins.length, height); ctx.clip()
  for (let start = 0; start < bins.length;) {
    while (start < bins.length && !bins[start]) start += 1
    if (start >= bins.length) break
    let end = start
    while (end + 1 < bins.length && bins[end + 1]) end += 1
    const baseline = downward ? top : bottom
    ctx.beginPath()
    ctx.moveTo(left + start, baseline)
    for (let x = start; x <= end; x += 1) {
      const bin = bins[x]!
      const magnitude = Math.max(Math.abs(bin.min), Math.abs(bin.max))
      const y = downward ? top + (magnitude / maximum) * height : bottom - (magnitude / maximum) * height
      ctx.lineTo(left + x, y)
      ctx.lineTo(left + x + 1, y)
    }
    ctx.lineTo(left + end + 1, baseline)
    ctx.closePath()
    ctx.fill()
    start = end + 1
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

function drawSignalBins(
  ctx: CanvasRenderingContext2D,
  bins: readonly (Bin | undefined)[],
  left: number,
  top: number,
  bottom: number,
  zeroY: number,
  valueToY: (value: number) => number,
  color: string,
): void {
  ctx.fillStyle = color
  ctx.globalAlpha = 0.84
  ctx.save()
  ctx.beginPath(); ctx.rect(left, top, bins.length, bottom - top); ctx.clip()
  for (let start = 0; start < bins.length;) {
    while (start < bins.length && !bins[start]) start += 1
    if (start >= bins.length) break
    let end = start
    while (end + 1 < bins.length && bins[end + 1]) end += 1
    ctx.beginPath()
    ctx.moveTo(left + start, zeroY)
    for (let x = start; x <= end; x += 1) {
      const y = valueToY(Math.max(0, bins[x]!.max))
      ctx.lineTo(left + x, y)
      ctx.lineTo(left + x + 1, y)
    }
    for (let x = end; x >= start; x -= 1) {
      const y = valueToY(Math.min(0, bins[x]!.min))
      ctx.lineTo(left + x + 1, y)
      ctx.lineTo(left + x, y)
    }
    ctx.closePath()
    ctx.fill()
    start = end + 1
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

interface AlignmentRenderGroup {
  start: number
  end: number
  reads: AlignmentFeature[]
}

function alignmentRenderGroups(features: readonly AlignmentFeature[], viewAsPairs: boolean): AlignmentRenderGroup[] {
  if (!viewAsPairs) return [...features]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((read) => ({ start: read.start, end: read.end, reads: [read] }))
  const byName = new Map<string, AlignmentFeature[]>()
  for (const read of features) {
    const key = read.paired ? read.name : `${read.name}\u0000${read.start}\u0000${read.flags}`
    const group = byName.get(key)
    if (group) group.push(read)
    else byName.set(key, [read])
  }
  return [...byName.values()].map((reads) => ({
    start: Math.min(...reads.map((read) => read.start)),
    end: Math.max(...reads.map((read) => read.end)),
    reads: reads.sort((a, b) => a.start - b.start || (a.readNumber ?? 0) - (b.readNumber ?? 0)),
  })).sort((a, b) => a.start - b.start || a.end - b.end)
}

function drawDirectionalReadBlock(
  ctx: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  centerY: number,
  height: number,
  strand: '+' | '-',
): void {
  const width = x2 - x1
  const tip = Math.min(4, Math.max(0, width / 2))
  const top = centerY - height / 2
  const bottom = centerY + height / 2
  ctx.beginPath()
  if (strand === '+' && width >= 3) {
    ctx.moveTo(x1, top); ctx.lineTo(x2 - tip, top); ctx.lineTo(x2, centerY); ctx.lineTo(x2 - tip, bottom); ctx.lineTo(x1, bottom)
  } else if (strand === '-' && width >= 3) {
    ctx.moveTo(x2, top); ctx.lineTo(x1 + tip, top); ctx.lineTo(x1, centerY); ctx.lineTo(x1 + tip, bottom); ctx.lineTo(x2, bottom)
  } else {
    ctx.rect(x1, top, Math.max(1, width), height)
  }
  ctx.closePath()
  ctx.fill()
}

function bamReadColor(read: AlignmentFeature, spec: TrackSpec, palette: CanvasPalette): string {
  const mode = spec.bamColorMode ?? 'track'
  if (mode === 'strand') return read.strand === '+' ? '#477ed1' : '#d65b70'
  if (mode === 'pair-orientation') {
    if (!read.paired || !read.mateOnSameChromosome) return palette.muted
    const orientation = read.pairOrientation?.toUpperCase() ?? ''
    if (orientation === 'FR') return '#477ed1'
    if (orientation === 'RF') return '#159c8d'
    if (orientation === 'FF') return '#d88928'
    if (orientation === 'RR') return '#c052a8'
    return read.properPair ? '#477ed1' : '#d65b70'
  }
  if (mode === 'mapping-quality') {
    const value = Math.max(0, Math.min(60, read.mapq)) / 60
    const lightness = document.documentElement.dataset.theme === 'dark' ? 38 + value * 34 : 76 - value * 38
    return `hsl(252 58% ${lightness}%)`
  }
  return spec.color
}

function bamBaseColor(base: string): string {
  if (base === 'A') return '#39a85a'
  if (base === 'C') return '#3e83d1'
  if (base === 'G') return '#d89625'
  if (base === 'T') return '#d55362'
  return '#858b92'
}

function alignmentQueryChanged(previous: TrackSpec, next: TrackSpec): boolean {
  return previous.bamViewMode !== next.bamViewMode
    || previous.bamViewAsPairs !== next.bamViewAsPairs
    || previous.bamMinMapq !== next.bamMinMapq
    || previous.bamIncludeDuplicates !== next.bamIncludeDuplicates
    || previous.bamIncludeSecondary !== next.bamIncludeSecondary
    || previous.bamIncludeSupplementary !== next.bamIncludeSupplementary
}

function matrixQueryChanged(previous: TrackSpec, next: TrackSpec): boolean {
  return previous.matrixResolution !== next.matrixResolution
    || previous.matrixNormalization !== next.matrixNormalization
    || previous.height !== next.height
    || previous.fittedHeight !== next.fittedHeight
    || previous.manualPixelHeight !== next.manualPixelHeight
}

function canvasPalette(): CanvasPalette {
  if (document.documentElement.dataset.theme === 'dark') {
    return {
      background: '#111315',
      gutter: '#1b1e21',
      ruler: '#17191c',
      line: '#34383d',
      ink: '#eef0f2',
      muted: '#9ba2a9',
      tick: '#555b62',
      label: '#c8cdd2',
      track: '#131517',
      trackAlternate: '#16191b',
      error: '#ff8294',
      zero: '#3b4046',
      gene: '#a99cff',
      geneTrack: '#15171a',
      selection: '#8d7aff',
      selectionFill: '#29263b',
      dragFill: 'rgba(141,122,255,.13)',
      axisInk: '#c7cbd0',
      axisLine: '#747a82',
      ideogramEmpty: '#50555b',
      ideogramOutline: '#858b92',
    }
  }
  return {
    background: '#fbfaf7',
    gutter: '#f3f1eb',
    ruler: '#f7f5f0',
    line: '#d9d5cb',
    ink: '#24231f',
    muted: '#817c72',
    tick: '#bdb8ad',
    label: '#625e56',
    track: '#fffefa',
    trackAlternate: '#fbfaf6',
    error: '#9b3b4a',
    zero: '#d8d3c9',
    gene: '#5f48cc',
    geneTrack: '#faf8f3',
    selection: '#684ee0',
    selectionFill: '#e9e4fb',
    dragFill: 'rgba(104,78,224,.10)',
    axisInk: '#625e56',
    axisLine: '#9d978c',
    ideogramEmpty: '#d5d1c8',
    ideogramOutline: '#777269',
  }
}

interface Bin { min: number; max: number }

function binFeatures(features: SignalFeature[], region: Region, width: number): Array<Bin | undefined> {
  const bins: Array<Bin | undefined> = new Array(Math.max(1, width))
  const scale = width / (region.end - region.start)
  for (const feature of features) {
    const from = Math.max(0, Math.floor((feature.start - region.start) * scale))
    const to = Math.min(width - 1, Math.max(from, Math.ceil((feature.end - region.start) * scale)))
    for (let x = from; x <= to; x += 1) {
      const bin = bins[x]
      if (bin) {
        bin.min = Math.min(bin.min, feature.score)
        bin.max = Math.max(bin.max, feature.score)
      } else {
        bins[x] = { min: feature.score, max: feature.score }
      }
    }
  }
  return bins
}

function contains(outer: Region, inner: Region): boolean {
  return outer.chr === inner.chr && outer.start <= inner.start && outer.end >= inner.end
}

function niceStep(roughStep: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const fraction = roughStep / power
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return niceFraction * power
}

export function formatCoordinate(value: number, step = 1, referenceValue = value): string {
  const referenceMagnitude = Math.abs(referenceValue)
  const factor = referenceMagnitude >= 1_000_000 ? 1_000_000 : referenceMagnitude >= 1_000 ? 1_000 : 1
  const suffix = factor === 1_000_000 ? 'm' : factor === 1_000 ? 'k' : ''
  const scaledStep = Math.abs(step) / factor
  const decimals = factor === 1 ? 0 : Math.max(0, Math.min(4, Math.ceil(-Math.log10(Math.max(Number.EPSILON, scaledStep)))))
  if (factor > 1) return `${(value / factor).toFixed(decimals)}${suffix}`
  return Math.round(value).toString()
}

export function formatScore(value: number): string {
  if (Math.abs(value) >= 1000) return Math.round(value).toString()
  return Number(value.toPrecision(3)).toString()
}

/** Pixel positions whose phase remains tied to the feature start as the viewport pans. */
export function phasedArrowPositions(rawFeatureStart: number, visibleStart: number, visibleEnd: number, spacing: number, offset: number): number[] {
  const origin = rawFeatureStart + offset
  const first = Math.max(0, Math.ceil((visibleStart - origin) / spacing))
  const positions: number[] = []
  for (let position = origin + first * spacing; position < visibleEnd; position += spacing) positions.push(position)
  return positions
}

/** Keeps directional chevrons fully inside a visible exon, or omits them when none can hold one. */
export function chevronExonOverlap(position: number, exons: readonly { start: number; end: number }[], halfWidth: number): 'outside' | 'inside' | 'partial' {
  const left = position - halfWidth
  const right = position + halfWidth
  if (exons.some((exon) => left >= exon.start && right <= exon.end)) return 'inside'
  return exons.some((exon) => right > exon.start && left < exon.end) ? 'partial' : 'outside'
}

function cytobandColor(stain: string, palette: CanvasPalette): string {
  if (stain === 'acen') return '#c92f3d'
  if (stain === 'stalk') return '#8fa2b8'
  if (stain === 'gvar') return palette.ideogramEmpty
  if (stain === 'gneg') return document.documentElement.dataset.theme === 'dark' ? '#d9dde1' : '#fafafa'
  const strength = Number(stain.match(/^gpos(\d+)$/)?.[1] ?? 50)
  const lightness = document.documentElement.dataset.theme === 'dark'
    ? Math.round(78 - strength * 0.58)
    : Math.round(96 - strength * 0.78)
  return `hsl(220 3% ${lightness}%)`
}

function trackSpecHeight(track: TrackSpec): number {
  if (Number.isFinite(track.fittedHeight)) return Math.max(20, Math.round(track.fittedHeight!))
  if (Number.isFinite(track.manualPixelHeight)) return Math.max(20, Math.round(track.manualPixelHeight!))
  return trackPixelHeight(track.kind, track.height)
}

export function resizedTrackPixels(
  initialPixels: ReadonlyMap<string, number>,
  minimumPixels: ReadonlyMap<string, number>,
  requestedDelta: number,
): Map<string, number> {
  const lowerDelta = Math.max(...[...initialPixels].map(([id, pixels]) => (minimumPixels.get(id) ?? 20) - pixels))
  const upperDelta = Math.min(...[...initialPixels.values()].map((pixels) => 4_000 - pixels))
  const delta = Math.max(lowerDelta, Math.min(upperDelta, Math.round(requestedDelta)))
  return new Map([...initialPixels].map(([id, pixels]) => [id, pixels + delta]))
}

export function trackPixelHeight(kind: TrackSpec['kind'], score: number): number {
  const safeScore = Math.max(1, Math.min(100, score))
  const regularHeight = 16 + safeScore * (kind === 'genes' ? 3.2 : 3.6)
  return Math.round(kind === 'stranded' ? regularHeight * 2 : regularHeight)
}

export function heightScoreForPixels(kind: TrackSpec['kind'], pixels: number): number {
  const channelPixels = kind === 'stranded' ? pixels / 2 : pixels
  return Math.max(1, Math.min(100, Math.round((channelPixels - 16) / (kind === 'genes' ? 3.2 : 3.6))))
}

export function distributeFittedPixels(minimums: readonly number[], weights: readonly number[], total: number): number[] {
  if (minimums.length !== weights.length) throw new Error('Fit minimums and weights must have the same length.')
  const floors = minimums.map((value) => Math.max(1, Math.ceil(value)))
  const minimumTotal = floors.reduce((sum, value) => sum + value, 0)
  const target = Math.max(minimumTotal, Math.floor(total))
  const extra = target - minimumTotal
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(0, value), 0)
  if (!extra || !weightTotal) return floors
  const shares = weights.map((weight) => extra * Math.max(0, weight) / weightTotal)
  const result = floors.map((value, index) => value + Math.floor(shares[index]))
  let remainder = target - result.reduce((sum, value) => sum + value, 0)
  const order = shares.map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let index = 0; remainder > 0; index = (index + 1) % order.length) {
    result[order[index].index] += 1
    remainder -= 1
  }
  return result
}

function trackBlocks(tracks: readonly TrackSpec[]): TrackSpec[][] {
  const blocks: TrackSpec[][] = []
  for (const track of tracks) {
    const previous = blocks[blocks.length - 1]
    if (track.displayGroupId && previous?.[0].displayGroupId === track.displayGroupId) previous.push(track)
    else blocks.push([track])
  }
  return blocks
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let shortened = text
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1)
  return `${shortened}…`
}

function wrappedLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/(\s+|(?<=[_\-.]))/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = `${line}${word}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate
      continue
    }
    if (line) lines.push(line.trim())
    line = word.trim()
    if (lines.length === maxLines - 1) break
  }
  if (line && lines.length < maxLines) lines.push(line)
  if (!lines.length) lines.push(text)
  const consumed = lines.join(' ').replace(/\s/g, '')
  const original = text.replace(/\s/g, '')
  if (consumed.length < original.length) {
    let last = lines[lines.length - 1]
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last}…`
  } else if (ctx.measureText(lines[lines.length - 1]).width > maxWidth) {
    lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], maxWidth)
  }
  return lines.slice(0, maxLines)
}

function drawTextLines(ctx: CanvasRenderingContext2D, lines: readonly string[], x: number, y: number, lineHeight: number): void {
  lines.forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight))
}

function drawCenteredTextLines(ctx: CanvasRenderingContext2D, lines: readonly string[], centerX: number, y: number, lineHeight: number): void {
  ctx.textAlign = 'center'
  drawTextLines(ctx, lines, centerX, y, lineHeight)
  ctx.textAlign = 'start'
}

/** First baseline that visually centers a line block for the canvas text metrics used here. */
export function verticallyCenteredBaseline(top: number, height: number, lineCount: number, lineHeight: number): number {
  return top + height / 2 - (Math.max(1, lineCount) - 1) * lineHeight / 2 + 4
}

function trackLabelBounds(scaleLaneWidth = 0): { width: number; center: number } {
  const right = scaleLaneWidth ? LABEL_WIDTH - scaleLaneWidth - 8 : LABEL_CONTENT_RIGHT
  const width = Math.max(48, right - LABEL_CONTENT_LEFT)
  return { width, center: LABEL_CONTENT_LEFT + width / 2 }
}

function preferredTranscript(gene: GeneFeature): TranscriptFeature | undefined {
  return [...gene.transcriptModels].sort((a, b) => exonLength(b) - exonLength(a) || codingLength(b) - codingLength(a) || (b.end - b.start) - (a.end - a.start))[0]
}

function codingLength(transcript: TranscriptFeature): number {
  return transcript.cds.reduce((sum, interval) => sum + interval.end - interval.start, 0)
}

function exonLength(transcript: TranscriptFeature): number {
  return transcript.exons.reduce((sum, interval) => sum + interval.end - interval.start, 0)
}

function drawTssElbow(ctx: CanvasRenderingContext2D, x: number, y: number, direction: 1 | -1, color: string): void {
  const elbowY = y + 11
  const endX = x + direction * 12
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x, elbowY)
  ctx.lineTo(endX, elbowY)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(endX, elbowY)
  ctx.lineTo(endX - direction * 4, elbowY - 2.5)
  ctx.lineTo(endX - direction * 4, elbowY + 2.5)
  ctx.closePath()
  ctx.fill()
}

function drawVerticalScrollIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number,
  offset: number,
  maxOffset: number,
  contentHeight: number,
  palette: CanvasPalette,
): void {
  const thumbHeight = Math.max(18, height * Math.min(1, height / contentHeight))
  const thumbY = y + (height - thumbHeight) * (offset / maxOffset)
  ctx.strokeStyle = palette.line
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x, y + height)
  ctx.stroke()
  ctx.strokeStyle = palette.axisLine
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(x, thumbY)
  ctx.lineTo(x, thumbY + thumbHeight)
  ctx.stroke()
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number, maxLines: number): void {
  const words = text.split(/\s+/)
  let line = ''
  let lineIndex = 0
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width > width && line) {
      ctx.fillText(line, x, y + lineIndex * lineHeight)
      lineIndex += 1
      if (lineIndex >= maxLines) return
      line = word
    } else line = candidate
  }
  if (lineIndex < maxLines) ctx.fillText(line, x, y + lineIndex * lineHeight)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function describeRegion(region: Region): string {
  return formatLocus(region)
}
