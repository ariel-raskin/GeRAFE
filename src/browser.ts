import { clampRegion, formatBases, formatLocus } from './genome.ts'
import { MatrixTileRenderer, matrixTileCacheKey } from './matrix-tiles.ts'
import type { Cytoband } from './cytoband.ts'
import type { GeneFeature, GeneSource, TranscriptFeature } from './reference.ts'
import { computeScaleDomains, computeSegmentScaleDomains, createTrackDocument, signalFeatureKey } from './track-document.ts'
import type { ComparisonDivider, DisplayGroup, MatrixOutline, SavedRegion, ScaleDomainSegment, SignalStackDifferentiation, TrackDocument, TrackSpec } from './track-document.ts'
import type { AlignmentCoverageFeature, AlignmentFeature, InteractionFeature, IntervalFeature, MatrixCellPosition, MatrixFeature, Region, SignalFeature, TrackSource, TrackRuntime } from './types.ts'

const RULER_HEIGHT = 70
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
const TRACK_RESIZE_HOVER_DELAY_MS = 250
const BAM_READS_MAX_VISIBLE_SPAN = 150_000

export interface BrowserCallbacks {
  onRegionChange(region: Region): void
  onRegionSelected(region: Region): void
  onSavedRegionResize(id: string, region: Region): void
  onMatrixOutlineSelected(selection: { sourceTrackId: string; axis1: Region; axis2: Region; resolution: number }): void
  onMatrixOutlineResize(id: string, axis1: Region, axis2: Region): void
  onComparisonDividerCreate(position: number): void
  onComparisonDividerMove(id: string, position: number): void
  onRegionToolModeChange(mode?: RegionToolMode): void
  onMatrixAxisChange(trackId: string, region: Region): void
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

export type RegionToolMode = 'select' | 'divider' | 'matrix-outline'
export type MatrixOutlineCorner = 0 | 1 | 2 | 3
type ScaleDomain = { min: number; max: number }
interface TrackScaleSegment { start: number; end: number; domain?: ScaleDomain }

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

export type MatrixCellState = 'value' | 'zero' | 'missing' | 'masked'

export interface MatrixCellInspection {
  bin1: number
  bin2: number
  separation: number
  state: MatrixCellState
  value?: number
}

export function matrixInspectionHeading(inspection: MatrixCellInspection): string {
  return inspection.state === 'value' ? formatScore(inspection.value!)
    : inspection.state === 'zero' ? 'Zero contact'
      : inspection.state === 'masked' ? 'Masked by normalization' : 'Missing / NaN'
}

export interface MatrixDisplayPreferences {
  inspector: boolean
  inspectorValue: boolean
  inspectorBins: boolean
  inspectorDetails: boolean
  legend: boolean
}

export interface MatrixRuntimeDiagnostics {
  status: TrackRuntime['status']
  error?: string
  matrix?: MatrixFeature
  rendererMode?: 'direct' | 'tiled'
  tileMemoryBytes: number
  queryRegion?: Region
  queryMs?: number
}

export interface TrackOpeningProgress {
  message: string
  percent?: number
  basis?: 'local' | 'read'
}

interface MatrixHover extends MatrixCellInspection {
  trackId: string
  pane: 'main' | 'bottom'
  x: number
  y: number
}
interface MatrixOverlaySelection {
  interactionSpec: TrackSpec
  features: InteractionFeature[]
  total: number
  scoreMin: number
  scoreMax: number
}
interface BamHover { trackId: string; read: AlignmentFeature }

export class GenomeBrowser {
  private context: CanvasRenderingContext2D
  private readonly mainContext: CanvasRenderingContext2D
  private readonly bottomContext: CanvasRenderingContext2D
  private readonly headerContext: CanvasRenderingContext2D
  private region: Region
  private chromosomes: ReadonlyMap<string, number>
  private document: TrackDocument
  private runtimes = new Map<string, TrackRuntime>()
  private readonly openingProgress = new Map<string, TrackOpeningProgress>()
  private geneSource?: GeneSource
  private cytobands?: ReadonlyMap<string, readonly Cytoband[]>
  private geneAssembly = ''
  private frame?: number
  private dragging?: { x: number; region: Region; canvas: HTMLCanvasElement }
  private regionToolMode?: RegionToolMode
  private regionSelection?: { canvas: HTMLCanvasElement; startX: number; currentX: number }
  private regionBoundaryDrag?: { canvas: HTMLCanvasElement; id: string; edge: 'start' | 'end'; region: Region; coordinateOffset: number }
  private dividerDrag?: { canvas: HTMLCanvasElement; id: string; position: number; color: string }
  private matrixOutlineSelection?: {
    canvas: HTMLCanvasElement
    pane: 'main' | 'bottom'
    trackId: string
    resolution: number
    axis1Chr: string
    axis2Chr: string
    startBin1: number
    startBin2: number
    currentBin1: number
    currentBin2: number
  }
  private matrixOutlineCornerDrag?: {
    canvas: HTMLCanvasElement
    pane: 'main' | 'bottom'
    id: string
    trackId: string
    resolution: number
    corner: MatrixOutlineCorner
    axis1: Region
    axis2: Region
  }
  private readonly regionShadePreviews = new Map<string, number>()
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
    trackIds: string[]
    startClientY: number
    boundaryY: number
    guideY: number
    initialPixels: Map<string, number>
    minimumPixels: Map<string, number>
  }
  private trackResizeHover?: { canvas: HTMLCanvasElement; pane: 'main' | 'bottom'; y: number }
  private trackResizeHoverCandidate?: { canvas: HTMLCanvasElement; pane: 'main' | 'bottom'; y: number; timer: number }
  private readonly resizePreviewPixels = new Map<string, number>()
  private readonly trackDragGhost: HTMLDivElement
  private readonly matrixInspector: HTMLDivElement
  private readonly matrixTiles = new MatrixTileRenderer()
  private readonly matrixRendererModes = new Map<string, 'direct' | 'tiled'>()
  private mainResizeObserver: ResizeObserver
  private bottomResizeObserver: ResizeObserver
  private lastFrameTime = performance.now()
  private smoothedFps = 60
  private abortControllers = new Map<string, AbortController>()
  private selectedTrackIds = new Set<string>()
  private geneScrollOffsets = new Map<string, number>()
  private showTssIndicators = true
  private matrixDisplayPreferences: MatrixDisplayPreferences = {
    inspector: true,
    inspectorValue: true,
    inspectorBins: false,
    inspectorDetails: false,
    legend: true,
  }
  private trackBodyHold?: { canvas: HTMLCanvasElement; startX: number; startY: number; timer: number }
  private matrixHover?: MatrixHover
  private bamHover?: BamHover
  private bamReadHitboxes: Array<{ trackId: string; read: AlignmentFeature; x1: number; x2: number; y1: number; y2: number }> = []

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
    this.matrixInspector = document.createElement('div')
    this.matrixInspector.className = 'matrix-inspector'
    this.matrixInspector.hidden = true
    document.body.append(this.matrixInspector)
    this.bindEvents(canvas, 'main')
    this.bindEvents(bottomCanvas, 'bottom')
    this.bindNavigationEvents(headerCanvas)
    this.resize()
  }

  destroy(): void {
    this.matrixTiles.clear()
    this.mainResizeObserver.disconnect()
    this.bottomResizeObserver.disconnect()
    if (this.frame) cancelAnimationFrame(this.frame)
    for (const controller of this.abortControllers.values()) controller.abort()
    document.body.classList.remove('is-track-dragging')
    document.body.classList.remove('is-track-resizing')
    this.cancelTrackBodyHold()
    this.trackDragGhost.remove()
    this.matrixInspector.remove()
  }

  setRegion(region: Region): void {
    const length = this.chromosomes.get(region.chr)
    if (!length) return
    this.region = clampRegion(region, length)
    this.clearMatrixHover()
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

  setMatrixDisplayPreferences(preferences: MatrixDisplayPreferences): void {
    this.matrixDisplayPreferences = { ...preferences }
    if (!preferences.inspector) this.clearMatrixHover()
    else this.scheduleRender()
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

  getMatrixSnapResolution(): number | undefined {
    const resolutions = this.document.tracks.flatMap((spec): number[] => {
      if (!spec.enabled || spec.kind !== 'matrix') return []
      const matrix = this.runtimes.get(spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
      const resolution = matrix?.resolution ?? spec.matrixResolution
      return resolution && Number.isFinite(resolution) && resolution > 0 ? [resolution] : []
    })
    return resolutions.length ? Math.min(...resolutions) : undefined
  }

  previewSavedRegionShade(id: string, shadeOpacity?: number): void {
    if (shadeOpacity === undefined) this.regionShadePreviews.delete(id)
    else this.regionShadePreviews.set(id, Math.max(0.01, Math.min(0.5, shadeOpacity)))
    this.scheduleRender()
  }

  setRegionToolMode(mode?: RegionToolMode): void {
    this.regionToolMode = mode
    for (const canvas of [this.headerCanvas, this.canvas, this.bottomCanvas]) {
      canvas.classList.toggle('is-region-selecting', mode === 'select')
      canvas.classList.toggle('is-divider-placing', mode === 'divider')
      canvas.classList.toggle('is-matrix-outline-selecting', mode === 'matrix-outline')
      canvas.classList.remove('is-region-line-hover')
      canvas.classList.remove('is-matrix-outline-corner-hover')
    }
    this.callbacks.onRegionToolModeChange(mode)
    this.scheduleRender()
  }

  syncDocument(document: TrackDocument, sources: ReadonlyMap<string, TrackSource>): void {
    for (const id of this.openingProgress.keys()) if (!document.tracks.some((track) => track.id === id)) this.openingProgress.delete(id)
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
          Object.assign(runtime, { features: [], loadedRegion: undefined, status: runtime.source ? 'idle' : 'offline' })
        }
      }
    }
    this.document = document
    for (const id of this.regionShadePreviews.keys()) if (!document.savedRegions.some((saved) => saved.id === id)) this.regionShadePreviews.delete(id)
    const matrixIds = new Set(document.tracks.filter((track) => track.kind === 'matrix').map((track) => track.id))
    this.matrixTiles.retain(matrixIds)
    for (const id of this.matrixRendererModes.keys()) if (!matrixIds.has(id)) this.matrixRendererModes.delete(id)
    if (this.matrixHover) {
      const hovered = document.tracks.find((track) => track.id === this.matrixHover?.trackId)
      if (hovered?.kind !== 'matrix' || !this.matrixDisplayPreferences.inspector) this.clearMatrixHover()
    }
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

  setOpeningProgress(trackId: string, progress?: TrackOpeningProgress): void {
    if (progress) this.openingProgress.set(trackId, progress)
    else this.openingProgress.delete(trackId)
    this.scheduleRender()
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

  getMatrixDiagnostics(trackId: string): MatrixRuntimeDiagnostics | undefined {
    const runtime = this.getRuntime(trackId)
    if (!runtime) return
    return {
      status: runtime.status,
      error: runtime.error,
      matrix: runtime.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix'),
      rendererMode: this.matrixRendererModes.get(trackId),
      tileMemoryBytes: this.matrixTiles.memoryBytes,
      queryRegion: runtime.lastQueryRegion ? { ...runtime.lastQueryRegion } : undefined,
      queryMs: runtime.queryStartedAt !== undefined ? performance.now() - runtime.queryStartedAt : runtime.lastQueryMs,
    }
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

  private plotCoordinate(canvas: HTMLCanvasElement, offsetX: number): number {
    const plotWidth = Math.max(1, this.cssWidth(canvas) - PLOT_LEFT)
    const fraction = Math.max(0, Math.min(1, (offsetX - PLOT_LEFT) / plotWidth))
    return this.region.start + fraction * (this.region.end - this.region.start)
  }

  private plotX(canvas: HTMLCanvasElement, coordinate: number): number {
    return PLOT_LEFT + ((coordinate - this.region.start) / Math.max(1, this.region.end - this.region.start)) * (this.cssWidth(canvas) - PLOT_LEFT)
  }

  private visibleComparisonDividers(): ComparisonDivider[] {
    return this.document.comparisonDividers
      .filter((divider) => divider.chr === this.region.chr)
      .map((divider) => this.dividerDrag?.id === divider.id ? { ...divider, position: this.dividerDrag.position } : divider)
      .filter((divider) => divider.position > this.region.start && divider.position < this.region.end)
      .sort((a, b) => a.position - b.position)
  }

  private trackGeometryAt(pane: 'main' | 'bottom', offsetY: number): { spec: TrackSpec; top: number; bottom: number } | undefined {
    let top = 0
    for (const spec of this.visibleSpecs(pane)) {
      const bottom = top + this.trackHeight(spec)
      if (offsetY >= top && offsetY < bottom) return { spec, top, bottom }
      top = bottom
    }
    return undefined
  }

  private savedRegionBoundaryAt(canvas: HTMLCanvasElement, pane: 'main' | 'bottom' | undefined, offsetX: number, offsetY: number): { saved: SavedRegion; edge: 'start' | 'end' } | undefined {
    if (canvas === this.headerCanvas) return undefined
    const track = pane ? this.trackGeometryAt(pane, offsetY) : undefined
    const matrix = track?.spec.kind === 'matrix'
      ? this.runtimes.get(track.spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
      : undefined
    const triangularMatrix = track?.spec.kind === 'matrix' && !track.spec.matrixSecondaryRegion && !matrix?.axis2
    return this.document.savedRegions
      .filter((saved) => saved.highlighted && saved.boundaryStyle !== 'none' && saved.region.chr === this.region.chr)
      .flatMap((saved) => {
        if (!triangularMatrix || !track) return (['start', 'end'] as const).map((edge) => ({
          saved, edge, distance: Math.abs(offsetX - this.plotX(canvas, saved.region[edge])),
        }))
        const width = this.cssWidth(canvas)
        const left = this.plotX(canvas, saved.region.start)
        const right = this.plotX(canvas, saved.region.end)
        if (right <= left) return []
        const geometry = matrixVerticalGeometry(track.top, track.bottom, track.spec.matrixDirection ?? 'up')
        const direction = track.spec.matrixDirection === 'down' ? 1 : -1
        const scale = (width - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
        const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, track.spec.matrixDepthMode ?? 'full', track.spec.matrixMaxDistance)
        const depth = Math.min((right - left) / 2, maximumDistance * scale / 2, Math.abs(geometry.clipBottom - geometry.clipTop))
        return matrixRegionBoundarySegments(left, right, geometry.baseline, direction, depth).map((segment) => ({
          saved, edge: segment.edge, distance: pointToLineSegmentDistance({ x: offsetX, y: offsetY }, segment.start, segment.end),
        }))
      })
      .filter(({ saved, edge, distance }) => saved.region[edge] >= this.region.start && saved.region[edge] <= this.region.end && distance <= 6)
      .sort((a, b) => a.distance - b.distance)[0]
  }

  private dividerAt(canvas: HTMLCanvasElement, offsetX: number): ComparisonDivider | undefined {
    return this.visibleComparisonDividers()
      .map((candidate) => ({ candidate, distance: Math.abs(offsetX - this.plotX(canvas, candidate.position)) }))
      .filter(({ distance }) => distance <= 6)
      .sort((a, b) => a.distance - b.distance)[0]?.candidate
  }

  private matrixOutlineCornerAt(canvas: HTMLCanvasElement, pane: 'main' | 'bottom', offsetX: number, offsetY: number): { outline: MatrixOutline; corner: MatrixOutlineCorner; spec: TrackSpec; matrix: MatrixFeature } | undefined {
    if (offsetX < PLOT_LEFT) return undefined
    const track = this.trackGeometryAt(pane, offsetY)
    if (!track || track.spec.kind !== 'matrix') return undefined
    const matrix = this.runtimes.get(track.spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
    if (!matrix) return undefined
    const width = this.cssWidth(canvas)
    const scaleX = (width - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
    const outlines = this.document.matrixOutlines.filter((outline) => matrixOutlineTargetsTrack(outline, track.spec.id, this.region.chr, matrix.axis2?.chr ?? this.region.chr))
    const candidates = outlines.flatMap((outline) => {
      let points: Array<{ x: number; y: number }>
      let visible: (point: { x: number; y: number }) => boolean
      if (matrix.axis2) {
        const scaleY = (track.bottom - track.top) / Math.max(1, matrix.axis2.end - matrix.axis2.start)
        points = rectangularMatrixOutlinePolygon(outline.axis1, outline.axis2, this.region, matrix.axis2, scaleX, scaleY, track.top)
        visible = (point) => point.x >= PLOT_LEFT && point.x <= width && point.y >= track.top && point.y <= track.bottom
      } else {
        const geometry = matrixVerticalGeometry(track.top, track.bottom, track.spec.matrixDirection ?? 'up')
        const direction = track.spec.matrixDirection === 'down' ? 1 : -1
        const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, track.spec.matrixDepthMode ?? 'full', track.spec.matrixMaxDistance)
        const depth = Math.min((width - PLOT_LEFT) / 2, maximumDistance * scaleX / 2)
        points = matrixOutlinePolygon(outline.axis1, outline.axis2, this.region, scaleX, geometry.baseline, direction)
        const clip = matrixDepthClipBounds(PLOT_LEFT, width, geometry.baseline, direction, depth)
        visible = (point) => point.x >= clip.left && point.x <= clip.right
          && point.y >= Math.max(clip.top, geometry.clipTop)
          && point.y <= Math.min(clip.bottom, geometry.clipBottom)
      }
      return points.flatMap((point, corner) => visible(point) ? [{
        outline, corner: corner as MatrixOutlineCorner, spec: track.spec, matrix,
        distance: Math.hypot(offsetX - point.x, offsetY - point.y),
      }] : [])
    })
    const hit = candidates.filter((candidate) => candidate.distance <= 7).sort((a, b) => a.distance - b.distance)[0]
    return hit && { outline: hit.outline, corner: hit.corner, spec: hit.spec, matrix: hit.matrix }
  }

  private updateRegionLineHover(canvas: HTMLCanvasElement, pane: 'main' | 'bottom' | undefined, event: PointerEvent): boolean {
    const corner = !this.regionToolMode && pane ? this.matrixOutlineCornerAt(canvas, pane, event.offsetX, event.offsetY) : undefined
    const hovered = !corner && !this.regionToolMode && event.offsetX >= PLOT_LEFT
      && Boolean(this.dividerAt(canvas, event.offsetX) || this.savedRegionBoundaryAt(canvas, pane, event.offsetX, event.offsetY))
    canvas.classList.toggle('is-matrix-outline-corner-hover', Boolean(corner))
    canvas.classList.toggle('is-region-line-hover', hovered)
    return Boolean(corner) || hovered
  }

  private matrixInspectionAt(canvas: HTMLCanvasElement, pane: 'main' | 'bottom', event: PointerEvent, trackId?: string): { spec: TrackSpec; matrix: MatrixFeature; inspection: MatrixCellInspection } | undefined {
    if (event.offsetX < PLOT_LEFT) return undefined
    const track = this.trackGeometryAt(pane, event.offsetY)
    const spec = track?.spec.kind === 'matrix' ? track.spec : undefined
    if (!spec || !track || (trackId && spec.id !== trackId)) return undefined
    const matrix = this.runtimes.get(spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
    if (!matrix) return undefined
    const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance)
    const inspection = matrix.axis2
      ? inspectRectangularMatrixPoint(matrix, this.region, event.offsetX, event.offsetY, PLOT_LEFT, this.cssWidth(canvas), track.top, track.bottom)
      : inspectMatrixPoint(matrix, this.region, event.offsetX, event.offsetY, PLOT_LEFT, this.cssWidth(canvas), track.top, track.bottom, spec.matrixDirection ?? 'up', maximumDistance)
    return inspection ? { spec, matrix, inspection } : undefined
  }

  private beginRegionInteraction(canvas: HTMLCanvasElement, event: PointerEvent, pane?: 'main' | 'bottom'): boolean {
    if (event.offsetX < PLOT_LEFT) return false
    if (this.regionToolMode === 'matrix-outline') {
      if (!pane) return true
      const hit = this.matrixInspectionAt(canvas, pane, event)
      if (!hit) return true
      canvas.setPointerCapture(event.pointerId)
      this.matrixOutlineSelection = {
        canvas, pane, trackId: hit.spec.id, resolution: hit.matrix.resolution,
        axis1Chr: this.region.chr, axis2Chr: hit.matrix.axis2?.chr ?? this.region.chr,
        startBin1: hit.inspection.bin1, startBin2: hit.inspection.bin2,
        currentBin1: hit.inspection.bin1, currentBin2: hit.inspection.bin2,
      }
      canvas.classList.add('is-matrix-outline-dragging')
      this.clearMatrixHover()
      this.clearBamHover()
      this.scheduleRender()
      return true
    }
    const outlineCorner = !this.regionToolMode && pane ? this.matrixOutlineCornerAt(canvas, pane, event.offsetX, event.offsetY) : undefined
    if (outlineCorner) {
      canvas.setPointerCapture(event.pointerId)
      this.matrixOutlineCornerDrag = {
        canvas, pane: pane!, id: outlineCorner.outline.id, trackId: outlineCorner.spec.id,
        resolution: outlineCorner.matrix.resolution, corner: outlineCorner.corner,
        axis1: { ...outlineCorner.outline.axis1 }, axis2: { ...outlineCorner.outline.axis2 },
      }
      canvas.classList.remove('is-matrix-outline-corner-hover')
      canvas.classList.add('is-matrix-outline-corner-dragging')
      this.clearMatrixHover()
      this.clearBamHover()
      return true
    }
    const divider = this.dividerAt(canvas, event.offsetX)
    if (!this.regionToolMode && divider) {
      canvas.setPointerCapture(event.pointerId)
      this.dividerDrag = { canvas, id: divider.id, position: divider.position, color: divider.color }
      canvas.classList.add('is-divider-dragging')
      this.clearMatrixHover()
      this.clearBamHover()
      return true
    }
    const boundary = this.savedRegionBoundaryAt(canvas, pane, event.offsetX, event.offsetY)
    if (!this.regionToolMode && boundary) {
      canvas.setPointerCapture(event.pointerId)
      this.regionBoundaryDrag = {
        canvas, id: boundary.saved.id, edge: boundary.edge, region: { ...boundary.saved.region },
        coordinateOffset: boundary.saved.region[boundary.edge] - this.plotCoordinate(canvas, event.offsetX),
      }
      canvas.classList.add('is-region-boundary-dragging')
      this.clearMatrixHover()
      this.clearBamHover()
      return true
    }
    if (this.regionToolMode === 'select' || event.ctrlKey) {
      canvas.setPointerCapture(event.pointerId)
      const x = Math.max(PLOT_LEFT, Math.min(this.cssWidth(canvas), event.offsetX))
      this.regionSelection = { canvas, startX: x, currentX: x }
      canvas.classList.add('is-region-dragging')
      this.clearMatrixHover()
      this.clearBamHover()
      this.scheduleRender()
      return true
    }
    if (this.regionToolMode === 'divider') {
      this.callbacks.onComparisonDividerCreate(Math.round(this.plotCoordinate(canvas, event.offsetX)))
      this.setRegionToolMode(undefined)
      return true
    }
    return false
  }

  private updateRegionInteraction(canvas: HTMLCanvasElement, event: PointerEvent): boolean {
    if (this.matrixOutlineSelection?.canvas === canvas) {
      const hit = this.matrixInspectionAt(canvas, this.matrixOutlineSelection.pane, event, this.matrixOutlineSelection.trackId)
      if (hit) {
        this.matrixOutlineSelection.currentBin1 = hit.inspection.bin1
        this.matrixOutlineSelection.currentBin2 = hit.inspection.bin2
        this.scheduleRender()
      }
      return true
    }
    if (this.matrixOutlineCornerDrag?.canvas === canvas) {
      const drag = this.matrixOutlineCornerDrag
      const hit = this.matrixInspectionAt(canvas, drag.pane, event, drag.trackId)
      if (hit) {
        const resized = resizeMatrixOutlineCorner(drag.axis1, drag.axis2, drag.corner, hit.inspection.bin1, hit.inspection.bin2, drag.resolution)
        drag.axis1 = resized.axis1
        drag.axis2 = resized.axis2
        this.scheduleRender()
      }
      return true
    }
    if (this.regionSelection?.canvas === canvas) {
      this.regionSelection.currentX = Math.max(PLOT_LEFT, Math.min(this.cssWidth(canvas), event.offsetX))
      this.scheduleRender()
      return true
    }
    if (this.dividerDrag?.canvas === canvas) {
      this.dividerDrag.position = Math.round(this.plotCoordinate(canvas, event.offsetX))
      this.scheduleRender()
      return true
    }
    if (this.regionBoundaryDrag?.canvas === canvas) {
      const chromosomeLength = this.chromosomes.get(this.regionBoundaryDrag.region.chr) ?? Number.MAX_SAFE_INTEGER
      const snapResolution = this.document.regionSnapToMatrixBins ? this.getMatrixSnapResolution() : undefined
      this.regionBoundaryDrag.region = resizeRegionBoundary(
        this.regionBoundaryDrag.region,
        this.regionBoundaryDrag.edge,
        this.plotCoordinate(canvas, event.offsetX) + this.regionBoundaryDrag.coordinateOffset,
        snapResolution,
        chromosomeLength,
      )
      this.scheduleRender()
      return true
    }
    return false
  }

  private finishRegionInteraction(canvas: HTMLCanvasElement, event: PointerEvent): boolean {
    if (this.matrixOutlineSelection?.canvas === canvas) {
      const selection = this.matrixOutlineSelection
      this.matrixOutlineSelection = undefined
      canvas.classList.remove('is-matrix-outline-dragging')
      if (event.type === 'pointerup') this.callbacks.onMatrixOutlineSelected({
        sourceTrackId: selection.trackId,
        axis1: { chr: selection.axis1Chr, start: Math.min(selection.startBin1, selection.currentBin1), end: Math.max(selection.startBin1, selection.currentBin1) + selection.resolution },
        axis2: { chr: selection.axis2Chr, start: Math.min(selection.startBin2, selection.currentBin2), end: Math.max(selection.startBin2, selection.currentBin2) + selection.resolution },
        resolution: selection.resolution,
      })
      this.setRegionToolMode(undefined)
      this.scheduleRender()
      return true
    }
    if (this.matrixOutlineCornerDrag?.canvas === canvas) {
      const drag = this.matrixOutlineCornerDrag
      this.matrixOutlineCornerDrag = undefined
      canvas.classList.remove('is-matrix-outline-corner-dragging')
      if (event.type === 'pointerup') this.callbacks.onMatrixOutlineResize(drag.id, drag.axis1, drag.axis2)
      this.scheduleRender()
      return true
    }
    if (this.regionSelection?.canvas === canvas) {
      const selection = this.regionSelection
      this.regionSelection = undefined
      canvas.classList.remove('is-region-dragging')
      this.setRegionToolMode(undefined)
      if (event.type === 'pointerup' && Math.abs(selection.currentX - selection.startX) >= 3) {
        const first = this.plotCoordinate(canvas, Math.min(selection.startX, selection.currentX))
        const second = this.plotCoordinate(canvas, Math.max(selection.startX, selection.currentX))
        const snapResolution = this.document.regionSnapToMatrixBins ? this.getMatrixSnapResolution() : undefined
        const chromosomeLength = this.chromosomes.get(this.region.chr) ?? Number.MAX_SAFE_INTEGER
        this.callbacks.onRegionSelected(snapRegionToMatrixBins({ chr: this.region.chr, start: first, end: second }, snapResolution, chromosomeLength))
      }
      this.scheduleRender()
      return true
    }
    if (this.dividerDrag?.canvas === canvas) {
      const id = this.dividerDrag.id
      const position = this.dividerDrag.position
      this.dividerDrag = undefined
      canvas.classList.remove('is-divider-dragging')
      if (event.type === 'pointerup') this.callbacks.onComparisonDividerMove(id, position)
      this.scheduleRender()
      return true
    }
    if (this.regionBoundaryDrag?.canvas === canvas) {
      const drag = this.regionBoundaryDrag
      this.regionBoundaryDrag = undefined
      canvas.classList.remove('is-region-boundary-dragging')
      if (event.type === 'pointerup') this.callbacks.onSavedRegionResize(drag.id, drag.region)
      this.scheduleRender()
      return true
    }
    return false
  }

  private bindEvents(canvas: HTMLCanvasElement, pane: 'main' | 'bottom'): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      this.clearMatrixHover()
      if (this.beginRegionInteraction(canvas, event, pane)) return
      const resizeHit = this.resizeBoundaryAt(pane, event.offsetY)
      const resizeIsArmed = resizeHit
        && this.trackResizeHover?.canvas === canvas
        && this.trackResizeHover.pane === pane
        && this.trackResizeHover.y === resizeHit.y
      if (resizeHit && resizeIsArmed) {
        const tracks = this.document.tracks.filter((track) => resizeHit.trackIds.includes(track.id))
        canvas.setPointerCapture(event.pointerId)
        this.trackResize = {
          canvas,
          pane,
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
      if (resizeHit) this.clearTrackResizeHover(canvas)
      if (event.offsetX < LABEL_WIDTH) {
        const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
        if (!hit) {
          this.callbacks.onClearSelection()
          return
        }
        if (hit.kind === 'track') this.callbacks.onTrackSelection(hit.id, event.ctrlKey || event.metaKey, event.shiftKey)
        else this.callbacks.onGroupSelection(hit.id, event.ctrlKey || event.metaKey)
        const targetTrack = hit.kind === 'track' ? this.document.tracks.find((track) => track.id === hit.id) : undefined
        const draggedIds = hit.kind === 'group'
          ? this.document.tracks.filter((track) => track.displayGroupId === hit.id).map((track) => track.id)
          : this.selectedTrackIds.has(hit.id) ? [...this.selectedTrackIds] : [hit.id]
        const withinGroupId = hit.kind === 'track' && draggedIds.every((id) => this.document.tracks.find((track) => track.id === id)?.displayGroupId === targetTrack?.displayGroupId)
          ? targetTrack?.displayGroupId
          : undefined
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
      if (this.updateRegionInteraction(canvas, event)) return
      if (this.trackResize?.canvas === canvas) {
        const dragPixels = event.clientY - this.trackResize.startClientY
        const resized = resizedTrackPixels(this.trackResize.initialPixels, this.trackResize.minimumPixels, dragPixels)
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
        if (this.updateRegionLineHover(canvas, pane, event)) {
          this.clearTrackResizeHover(canvas)
          this.clearMatrixHover()
          this.clearBamHover()
          return
        }
        const hit = this.resizeBoundaryAt(pane, event.offsetY)
        this.updateTrackResizeHover(canvas, pane, hit?.y)
        if (hit) { this.clearMatrixHover(); this.clearBamHover() }
        else { this.updateMatrixHover(canvas, pane, event); this.updateBamHover(canvas, pane, event) }
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
      if (this.finishRegionInteraction(canvas, event)) return
      this.cancelTrackBodyHold()
      if (this.trackResize?.canvas === canvas) {
        const resize = this.trackResize
        const updates = resize.trackIds.map((id) => ({ id, pixels: this.resizePreviewPixels.get(id) ?? resize.initialPixels.get(id)! }))
        this.trackResize = undefined
        this.resizePreviewPixels.clear()
        canvas.classList.remove('is-track-resizing')
        document.body.classList.remove('is-track-resizing')
        if (event.type === 'pointerup') {
          this.callbacks.onTrackHeightsResize(updates)
          void this.ensureData()
        }
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
      canvas.classList.remove('is-region-line-hover')
      canvas.classList.remove('is-matrix-outline-corner-hover')
      this.clearTrackResizeHover(canvas)
      this.clearMatrixHover()
    })
    canvas.addEventListener('wheel', (event) => {
      if (event.shiftKey && this.scrollMatrixAxis(canvas, pane, event)) { event.preventDefault(); return }
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
      if (this.beginRegionInteraction(canvas, event)) return
      if (event.offsetX < PLOT_LEFT) return
      canvas.setPointerCapture(event.pointerId)
      this.dragging = { x: event.clientX, region: { ...this.region }, canvas }
      canvas.classList.add('is-dragging')
    })
    canvas.addEventListener('pointermove', (event) => {
      if (this.updateRegionInteraction(canvas, event)) return
      if (!this.dragging || this.dragging.canvas !== canvas) this.updateRegionLineHover(canvas, undefined, event)
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
    const finish = (event: PointerEvent) => {
      if (this.finishRegionInteraction(canvas, event)) return
      if (!this.dragging || this.dragging.canvas !== canvas) return
      this.dragging = undefined
      canvas.classList.remove('is-dragging')
      void this.ensureData()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', finish)
    canvas.addEventListener('pointerleave', () => {
      if (!this.dragging) canvas.classList.remove('is-region-line-hover')
      canvas.classList.remove('is-matrix-outline-corner-hover')
    })
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
    this.clearMatrixHover()
    this.callbacks.onRegionChange(this.region)
    this.scheduleRender()
    if (!this.hasOverscanCoverage()) void this.ensureData()
  }

  private scrollMatrixAxis(canvas: HTMLCanvasElement, pane: 'main' | 'bottom', event: WheelEvent): boolean {
    const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
    const spec = hit?.kind === 'track' ? this.document.tracks.find((track) => track.id === hit.id && track.kind === 'matrix') : undefined
    const axis = spec?.matrixSecondaryRegion
    if (!spec || !axis) return false
    const size = this.runtimes.get(spec.id)?.source?.chromosomes.get(axis.chr) ?? this.chromosomes.get(axis.chr)
    if (!size) return false
    const span = axis.end - axis.start
    const scroll = event.deltaY || event.deltaX
    const delta = scroll * span / Math.max(1, this.trackHeight(spec))
    const next = event.ctrlKey || event.metaKey
      ? { chr: axis.chr, start: axis.start + span * 0.5 * (1 - Math.exp(scroll * 0.0015)), end: axis.end - span * 0.5 * (1 - Math.exp(scroll * 0.0015)) }
      : { chr: axis.chr, start: axis.start + delta, end: axis.end + delta }
    this.callbacks.onMatrixAxisChange(spec.id, clampRegion(next, size))
    return true
  }

  private cancelTrackBodyHold(): void {
    if (this.trackBodyHold) window.clearTimeout(this.trackBodyHold.timer)
    this.trackBodyHold = undefined
  }

  private updateMatrixHover(canvas: HTMLCanvasElement, pane: 'main' | 'bottom', event: PointerEvent): void {
    if (event.offsetX < PLOT_LEFT) {
      this.clearMatrixHover()
      return
    }
    const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
    const spec = hit?.kind === 'track' ? this.document.tracks.find((track) => track.id === hit.id && track.kind === 'matrix') : undefined
    if (!spec || !this.matrixDisplayPreferences.inspector) {
      this.clearMatrixHover()
      return
    }
    const matrix = this.runtimes.get(spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
    if (!matrix) {
      this.clearMatrixHover()
      return
    }
    const specs = this.visibleSpecs(pane)
    const top = specs.slice(0, specs.findIndex((track) => track.id === spec.id)).reduce((sum, track) => sum + this.trackHeight(track), 0)
    const bottom = top + this.trackHeight(spec)
    const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance)
    const inspection = matrix.axis2
      ? inspectRectangularMatrixPoint(matrix, this.region, event.offsetX, event.offsetY, PLOT_LEFT, this.cssWidth(canvas), top, bottom)
      : inspectMatrixPoint(matrix, this.region, event.offsetX, event.offsetY, PLOT_LEFT, this.cssWidth(canvas), top, bottom, spec.matrixDirection ?? 'up', maximumDistance)
    if (!inspection) {
      this.clearMatrixHover()
      return
    }
    const scale = (this.cssWidth(canvas) - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
    const geometry = matrixVerticalGeometry(top, bottom, spec.matrixDirection ?? 'up')
    const center1 = inspection.bin1 + matrix.resolution / 2
    const center2 = inspection.bin2 + matrix.resolution / 2
    const x = PLOT_LEFT + ((matrix.axis2 ? center1 : (center1 + center2) / 2) - this.region.start) * scale
    const direction = spec.matrixDirection === 'down' ? 1 : -1
    const y = matrix.axis2 ? top + (center2 - matrix.axis2.start) * (bottom - top) / (matrix.axis2.end - matrix.axis2.start)
      : geometry.baseline + direction * ((center2 - center1) / 2) * scale
    const changed = !this.matrixHover
      || this.matrixHover.trackId !== spec.id
      || this.matrixHover.bin1 !== inspection.bin1
      || this.matrixHover.bin2 !== inspection.bin2
      || this.matrixHover.state !== inspection.state
      || this.matrixHover.value !== inspection.value
    this.matrixHover = { ...inspection, trackId: spec.id, pane, x, y }
    this.showMatrixInspector(spec, matrix, inspection, event.clientX, event.clientY)
    if (changed) this.scheduleRender()
  }

  private showMatrixInspector(spec: TrackSpec, matrix: MatrixFeature, inspection: MatrixCellInspection, clientX: number, clientY: number): void {
    const heading = document.createElement('strong')
    heading.textContent = matrixInspectionHeading(inspection)
    const bins = document.createElement('span')
    bins.textContent = `${formatLocus({ chr: this.region.chr, start: inspection.bin1, end: inspection.bin1 + matrix.resolution })} × ${formatLocus({ chr: matrix.axis2?.chr ?? this.region.chr, start: inspection.bin2, end: inspection.bin2 + matrix.resolution })}`
    const details = document.createElement('small')
    const valueMode = spec.matrixValueMode ?? 'observed'
    const comparisonLabel = spec.matrixComparisonMode ? `${spec.matrixComparisonMode} · ` : ''
    details.textContent = `${matrix.axis2 ? 'two-axis view' : `${formatBases(inspection.separation)} separation`} · ${formatBases(matrix.resolution)} bins · ${spec.matrixNormalization ?? 'raw'} · ${comparisonLabel}${valueMode === 'observed' ? 'observed' : valueMode === 'observed-expected' ? 'observed/expected' : 'log2(observed/expected)'}`
    const content: HTMLElement[] = []
    if (this.matrixDisplayPreferences.inspectorValue) content.push(heading)
    if (this.matrixDisplayPreferences.inspectorBins) content.push(bins)
    if (this.matrixDisplayPreferences.inspectorDetails) content.push(details)
    this.matrixInspector.replaceChildren(...content)
    if (!content.length) {
      this.matrixInspector.hidden = true
      return
    }
    this.matrixInspector.hidden = false
    const width = this.matrixInspector.offsetWidth
    const height = this.matrixInspector.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, clientX + 15))
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, clientY + 15))
    this.matrixInspector.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
  }

  private clearMatrixHover(): void {
    if (!this.matrixHover && this.matrixInspector.hidden) return
    this.matrixHover = undefined
    this.matrixInspector.hidden = true
    this.scheduleRender()
  }

  private updateBamHover(canvas: HTMLCanvasElement, pane: 'main' | 'bottom', event: PointerEvent): void {
    const hit = this.itemAt(canvas, pane, event.offsetX, event.offsetY)
    const spec = hit?.kind === 'track' ? this.document.tracks.find((track) => track.id === hit.id && track.kind === 'alignment') : undefined
    if (!spec || event.offsetX < PLOT_LEFT || this.region.end - this.region.start > BAM_READS_MAX_VISIBLE_SPAN) return this.clearBamHover()
    const read = this.bamReadHitboxes.find((box) => box.trackId === spec.id && event.offsetX >= box.x1 && event.offsetX <= box.x2 && event.offsetY >= box.y1 && event.offsetY <= box.y2)?.read
    if (!read) return this.clearBamHover()
    const changed = this.bamHover?.trackId !== spec.id || this.bamHover.read !== read
    this.bamHover = { trackId: spec.id, read }
    const heading = document.createElement('strong'); heading.textContent = read.name
    const detail = document.createElement('span'); detail.textContent = `${read.strand} · MAPQ ${read.mapq} · ${read.cigar}`
    const mate = document.createElement('small'); mate.textContent = read.mateOnSameChromosome && read.mateStart !== undefined ? `Mate at ${Math.round(read.mateStart).toLocaleString()}` : read.paired ? 'Mate on another chromosome' : 'Unpaired read'
    const content: HTMLElement[] = [heading, detail, mate]
    if (read.mateOnSameChromosome && read.mateStart !== undefined) {
      const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = 'Go to mate'
      jump.addEventListener('click', () => { const span = this.region.end - this.region.start; this.setRegion({ chr: this.region.chr, start: read.mateStart! - span / 2, end: read.mateStart! + span / 2 }) })
      content.push(jump)
    }
    this.matrixInspector.replaceChildren(...content)
    this.matrixInspector.hidden = false
    const left = Math.max(8, Math.min(window.innerWidth - this.matrixInspector.offsetWidth - 8, event.clientX + 15))
    const top = Math.max(8, Math.min(window.innerHeight - this.matrixInspector.offsetHeight - 8, event.clientY + 15))
    this.matrixInspector.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
    if (changed) this.scheduleRender()
  }

  private clearBamHover(): void {
    if (!this.bamHover) return
    this.bamHover = undefined
    this.matrixInspector.hidden = true
    this.scheduleRender()
  }

  private updateTrackResizeHover(canvas: HTMLCanvasElement, pane: 'main' | 'bottom', y: number | undefined): void {
    if (this.trackResizeHover?.canvas === canvas && this.trackResizeHover.y === y) return
    if (this.trackResizeHoverCandidate?.canvas === canvas && this.trackResizeHoverCandidate.y === y) return
    this.clearTrackResizeHover(canvas)
    if (y === undefined) return
    const candidate = {
      canvas,
      pane,
      y,
      timer: window.setTimeout(() => {
        if (this.trackResizeHoverCandidate !== candidate) return
        this.trackResizeHoverCandidate = undefined
        this.trackResizeHover = { canvas, pane, y }
        canvas.classList.add('is-track-resize-hover')
        this.scheduleRender()
      }, TRACK_RESIZE_HOVER_DELAY_MS),
    }
    this.trackResizeHoverCandidate = candidate
  }

  private clearTrackResizeHover(canvas?: HTMLCanvasElement): void {
    if (this.trackResizeHoverCandidate && (!canvas || this.trackResizeHoverCandidate.canvas === canvas)) {
      window.clearTimeout(this.trackResizeHoverCandidate.timer)
      this.trackResizeHoverCandidate = undefined
    }
    if (this.trackResizeHover && (!canvas || this.trackResizeHover.canvas === canvas)) {
      this.trackResizeHover.canvas.classList.remove('is-track-resize-hover')
      this.trackResizeHover = undefined
      this.scheduleRender()
    } else canvas?.classList.remove('is-track-resize-hover')
  }

  private resize(): void {
    const sharedWidth = this.sharedCanvasWidth()
    this.resizeHeaderCanvas(sharedWidth)
    this.resizeCanvas(this.canvas, this.mainContext, 'main', sharedWidth)
    this.resizeCanvas(this.bottomCanvas, this.bottomContext, 'bottom', sharedWidth)
    this.scheduleRender()
    void this.ensureData()
  }

  private sharedCanvasWidth(): number {
    const widths = [this.headerCanvas.parentElement?.clientWidth, this.canvas.parentElement?.clientWidth, this.bottomCanvas.parentElement?.clientWidth]
      .filter((width): width is number => Boolean(width && width > 0))
    return widths.length ? Math.min(...widths) : 900
  }

  private resizeHeaderCanvas(parentWidth: number): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.headerCanvas.width = Math.floor(parentWidth * ratio)
    this.headerCanvas.height = Math.floor(RULER_HEIGHT * ratio)
    this.headerCanvas.style.width = `${parentWidth}px`
    this.headerCanvas.style.height = `${RULER_HEIGHT}px`
    this.headerContext.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  private resizeCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, pane: 'main' | 'bottom', parentWidth = this.sharedCanvasWidth()): void {
    const minimum = pane === 'main' ? TRACK_HEIGHT : MIN_BOTTOM_GENE_HEIGHT
    const contentHeight = this.paneStackHeight(pane)
    const availableHeight = Math.max(0, (canvas.parentElement?.clientHeight ?? 0) - (pane === 'main' ? RULER_HEIGHT : 0))
    const cssHeight = Math.max(minimum, contentHeight, availableHeight)
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
    const dividers = this.visibleComparisonDividers()
    const segmentDomains = dividers.length ? computeSegmentScaleDomains(this.document, visibleByTrack, this.region, dividers.map((divider) => divider.position)) : undefined
    this.drawComparisonDividers(this.headerCanvas, this.cssWidth(this.headerCanvas), this.cssHeight(this.headerCanvas), true)
    return this.renderPane('main', palette, domains, segmentDomains) + this.renderPane('bottom', palette, domains, segmentDomains)
  }

  private renderPane(
    pane: 'main' | 'bottom',
    palette: CanvasPalette,
    domains: ReadonlyMap<string, { min: number; max: number }>,
    segmentDomains?: readonly ScaleDomainSegment[],
  ): number {
    const canvas = pane === 'main' ? this.canvas : this.bottomCanvas
    this.context = pane === 'main' ? this.mainContext : this.bottomContext
    const ctx = this.context
    const width = this.cssWidth(canvas)
    const height = this.cssHeight(canvas)
    ctx.fillStyle = palette.background
    ctx.fillRect(0, 0, width, height)
    const specs = this.visibleSpecs(pane)
    const matrixMaximums = this.matrixMaximums(specs)
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
      const opening = this.openingProgress.get(spec.id)
      if (opening) this.drawOpeningTrack(spec, opening, index, top, rowHeight, width, palette)
      else if (spec.kind === 'signal') {
        const stack = this.signalStackForRepresentative(spec)
        if (stack) visibleFeatures += this.drawSignalStack(stack.group, stack.members, index, top, rowHeight, width, palette, domains, segmentDomains)
        else {
          const runtime = this.runtimes.get(signalFeatureKey(spec.id, spec.signalStrand))!
          const domain = spec.scaleBindingId ? domains.get(spec.scaleBindingId) : undefined
          const segments = spec.scaleBindingId && segmentDomains ? segmentDomains.map((segment) => ({ start: segment.start, end: segment.end, domain: segment.domains.get(spec.scaleBindingId!) })) : undefined
          visibleFeatures += this.drawTrack(spec, runtime, index, top, rowHeight, width, palette, domain, segments)
        }
      } else if (spec.kind === 'stranded') {
        const plus = this.runtimes.get(signalFeatureKey(spec.id, 'plus'))!
        const minus = this.runtimes.get(signalFeatureKey(spec.id, 'minus'))!
        const plusDomain = spec.scaleBindingId ? domains.get(spec.scaleBindingId) : undefined
        const minusDomain = spec.negativeScaleBindingId ? domains.get(spec.negativeScaleBindingId) : undefined
        const segments = segmentDomains ? segmentDomains.map((segment) => ({
          start: segment.start, end: segment.end,
          plus: spec.scaleBindingId ? segment.domains.get(spec.scaleBindingId) : undefined,
          minus: spec.negativeScaleBindingId ? segment.domains.get(spec.negativeScaleBindingId) : undefined,
        })) : undefined
        visibleFeatures += this.drawStrandedTrack(spec, plus, minus, index, top, rowHeight, width, palette, plusDomain, minusDomain, segments)
      } else if (spec.kind === 'interval') {
        visibleFeatures += this.drawIntervalTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette)
      } else if (spec.kind === 'interaction') {
        visibleFeatures += this.drawInteractionTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette)
      } else if (spec.kind === 'matrix') {
        visibleFeatures += this.drawMatrixTrack(spec, this.runtimes.get(spec.id)!, index, top, rowHeight, width, palette, matrixMaximums.get(spec.id))
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
    this.drawRegionOverlays(pane, specs, width, height, palette)
    this.drawComparisonDividers(canvas, width, height, false)
    return visibleFeatures
  }

  private drawRegionOverlays(pane: 'main' | 'bottom', specs: readonly TrackSpec[], width: number, height: number, palette: CanvasPalette): void {
    const ctx = this.context
    const canvas = pane === 'main' ? this.canvas : this.bottomCanvas
    const regions: Array<Pick<SavedRegion, 'id' | 'region' | 'color' | 'boundaryStyle' | 'fill' | 'shadeOpacity'>> = this.document.savedRegions
      .filter((saved) => saved.highlighted && saved.region.chr === this.region.chr)
      .map((saved) => ({
        ...saved,
        region: this.regionBoundaryDrag?.id === saved.id ? this.regionBoundaryDrag.region : saved.region,
        shadeOpacity: this.regionShadePreviews.get(saved.id) ?? saved.shadeOpacity,
      }))
    if (this.regionSelection) {
      const first = this.plotCoordinate(this.regionSelection.canvas, Math.min(this.regionSelection.startX, this.regionSelection.currentX))
      const second = this.plotCoordinate(this.regionSelection.canvas, Math.max(this.regionSelection.startX, this.regionSelection.currentX))
      regions.push({ id: '', region: { chr: this.region.chr, start: first, end: second }, color: palette.selection, boundaryStyle: 'dashed', fill: true, shadeOpacity: 0.09 })
    }
    const stripRanges: Array<{ top: number; bottom: number }> = []
    const triangleRanges: Array<{ spec: TrackSpec; top: number; bottom: number }> = []
    let top = 0
    for (const spec of specs) {
      const bottom = top + this.trackHeight(spec)
      const matrix = spec.kind === 'matrix' ? this.runtimes.get(spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix') : undefined
      if (spec.kind === 'matrix' && !spec.matrixSecondaryRegion && !matrix?.axis2) triangleRanges.push({ spec, top, bottom })
      else if (stripRanges.at(-1)?.bottom === top) stripRanges.at(-1)!.bottom = bottom
      else stripRanges.push({ top, bottom })
      top = bottom
    }
    if (top < height && stripRanges.at(-1)?.bottom === top) stripRanges.at(-1)!.bottom = height
    else if (top < height) stripRanges.push({ top, bottom: height })
    ctx.save()
    ctx.beginPath()
    ctx.rect(PLOT_LEFT, 0, Math.max(0, width - PLOT_LEFT), height)
    ctx.clip()
    for (const saved of regions) {
      if (saved.region.end <= this.region.start || saved.region.start >= this.region.end) continue
      // Keep the annotation in genomic coordinates and let the canvas clip it.
      // Clamping first would continuously shrink and reshape it while panning.
      const x1 = this.plotX(canvas, saved.region.start)
      const x2 = this.plotX(canvas, saved.region.end)
      if (x2 <= x1) continue
      for (const range of stripRanges) {
        if (range.bottom <= range.top) continue
        if (saved.fill) {
          ctx.fillStyle = saved.color
          ctx.globalAlpha = saved.shadeOpacity
          ctx.fillRect(x1, range.top, Math.max(1, x2 - x1), range.bottom - range.top)
        }
        if (saved.boundaryStyle !== 'none') {
          ctx.globalAlpha = 0.7
          ctx.strokeStyle = saved.color
          ctx.setLineDash(saved.boundaryStyle === 'dashed' ? [4, 3] : [])
          ctx.beginPath()
          for (const line of verticalRegionBoundaryLines(x1, x2, [range])) {
            ctx.moveTo(line.x1, line.y1); ctx.lineTo(line.x2, line.y2)
          }
          ctx.stroke()
        }
      }
      for (const range of triangleRanges) {
        const geometry = matrixVerticalGeometry(range.top, range.bottom, range.spec.matrixDirection ?? 'up')
        const direction = range.spec.matrixDirection === 'down' ? 1 : -1
        const scale = (width - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
        const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, range.spec.matrixDepthMode ?? 'full', range.spec.matrixMaxDistance)
        const depth = Math.min((x2 - x1) / 2, maximumDistance * scale / 2, Math.abs(geometry.clipBottom - geometry.clipTop))
        if (saved.fill) {
          ctx.fillStyle = saved.color
          ctx.globalAlpha = saved.shadeOpacity
          matrixDomainPath(ctx, x1, x2, geometry.baseline, direction, depth)
          ctx.fill()
        }
        if (saved.boundaryStyle !== 'none') {
          ctx.globalAlpha = 0.7
          ctx.strokeStyle = saved.color
          ctx.setLineDash(saved.boundaryStyle === 'dashed' ? [4, 3] : [])
          matrixDomainPath(ctx, x1, x2, geometry.baseline, direction, depth)
          ctx.stroke()
        }
      }
    }
    ctx.restore()
  }

  private drawComparisonDividers(canvas: HTMLCanvasElement, width: number, height: number, header: boolean): void {
    const ctx = this.context
    const dividers = this.visibleComparisonDividers()
    if (!dividers.length) return
    ctx.save()
    ctx.beginPath(); ctx.rect(PLOT_LEFT, 0, Math.max(0, width - PLOT_LEFT), height); ctx.clip()
    for (const divider of dividers) {
      const x = this.plotX(canvas, divider.position)
      ctx.globalAlpha = 0.95
      ctx.strokeStyle = divider.color
      ctx.lineWidth = 1.5
      ctx.setLineDash(divider.lineStyle === 'dashed' ? [6, 4] : [])
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); ctx.stroke()
      ctx.setLineDash([])
      if (header) {
        ctx.fillStyle = divider.color
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill()
      }
    }
    if (header) {
      ctx.globalAlpha = 0.9
      ctx.fillStyle = dividers[0]!.color
      ctx.font = '9px Inter, system-ui, sans-serif'
      ctx.fillText(dividers.length === 1 ? 'independent scale' : `${dividers.length + 1} scale sections`, Math.min(width - 92, this.plotX(canvas, dividers[0]!.position) + 7), 10)
    }
    ctx.restore()
  }

  private matrixMaximums(specs: readonly TrackSpec[]): ReadonlyMap<string, number> {
    const maxima = new Map<string, number>()
    for (const spec of specs) {
      if (spec.kind !== 'matrix') continue
      const matrix = this.runtimes.get(spec.id)?.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
      const automaticPercentile = spec.matrixScaleMode === 'maximum' ? 1 : spec.matrixScalePercentile ?? 0.99
      const automaticMaximum = spec.matrixValueMode === 'log2-observed-expected' || spec.matrixComparisonMode === 'difference' || spec.matrixComparisonMode === 'log2-ratio'
        ? matrixAutomaticMagnitude(matrix, automaticPercentile, spec.matrixIgnoreDiagonals ?? 3)
        : matrixAutomaticMaximum(matrix, automaticPercentile, spec.matrixIgnoreDiagonals ?? 3)
      maxima.set(spec.id, spec.matrixScaleMode === 'fixed' && spec.matrixScaleMax !== undefined ? spec.matrixScaleMax : automaticMaximum)
    }
    return resolveMatrixMaximums(specs, this.document.groups, maxima)
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
    const spanY = 36
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
      ctx.moveTo(Math.round(x) + 0.5, 58)
      ctx.lineTo(Math.round(x) + 0.5, RULER_HEIGHT)
      ctx.stroke()
      ctx.fillStyle = palette.label
      ctx.fillText(formatCoordinate(coordinate, step, Math.max(Math.abs(this.region.start), Math.abs(this.region.end))), x, 53)
    }
    ctx.textAlign = 'start'
  }

  private drawIdeogram(x: number, width: number, chromosomeLength: number, palette: CanvasPalette): void {
    const ctx = this.context
    const top = 4
    const height = 10
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
        ctx.fillText(band.name, center, 24)
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

  private drawOpeningTrack(spec: TrackSpec, progress: TrackOpeningProgress, index: number, top: number, height: number, width: number, palette: CanvasPalette): void {
    const ctx = this.context
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
    ctx.moveTo(0, top + height - 0.5)
    ctx.lineTo(width, top + height - 0.5)
    ctx.stroke()
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const lines = wrappedLines(ctx, spec.label, trackLabelBounds().width, Math.max(1, Math.floor((height - 8) / 15)))
    drawCenteredTextLines(ctx, lines, trackLabelBounds().center, verticallyCenteredBaseline(top, height, lines.length, 15), 15)
    const x = PLOT_LEFT + 18
    const barWidth = Math.max(40, Math.min(360, width - x - 18))
    const barY = top + Math.min(24, Math.max(19, height - 9))
    ctx.fillStyle = palette.muted
    ctx.font = '11px Inter, system-ui, sans-serif'
    const percentLabel = progress.percent === undefined ? '' : ` · ${Math.round(progress.percent)}%${progress.basis === 'local' ? ' local' : progress.basis === 'read' ? ' prepared' : ''}`
    ctx.fillText(`${progress.message}${percentLabel}`, x, Math.min(top + 14, barY - 6), Math.max(40, width - x - 18))
    ctx.fillStyle = palette.line
    ctx.fillRect(x, barY, barWidth, 5)
    ctx.fillStyle = palette.selection
    if (progress.percent !== undefined) ctx.fillRect(x, barY, barWidth * Math.max(0, Math.min(100, progress.percent)) / 100, 5)
    else ctx.fillRect(x, barY, Math.min(52, barWidth / 4), 5)
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
    segments?: readonly TrackScaleSegment[],
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
    const previewDomains = segments ? segments.map((segment) => segment.domain).filter((item): item is ScaleDomain => Boolean(item)) : domain ? [domain] : []
    let previewMin = previewDomains.length ? Math.min(...previewDomains.map((item) => item.min)) : 0
    let previewMax = previewDomains.length ? Math.max(...previewDomains.map((item) => item.max)) : 0
    if (!previewDomains.length) for (const feature of visible) { previewMin = Math.min(previewMin, feature.score); previewMax = Math.max(previewMax, feature.score) }
    const previewScaleValues = previewDomains.length ? previewDomains.map(signalDomainScaleValue) : [previewMax !== 0 ? previewMax : previewMin !== 0 ? Math.abs(previewMin) : 0]
    const previewMaxLabels = visible.length ? previewScaleValues.filter((value) => value !== 0).map(formatScore) : []
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
    const scaleLaneWidth = previewMaxLabels.length ? Math.max(SCALE_LANE_MIN_WIDTH, ...previewMaxLabels.map((label) => Math.ceil(ctx.measureText(label).width) + 12)) : 0

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
      if (track.status === 'loading') {
        ctx.fillStyle = palette.muted
        ctx.font = '12px Inter, system-ui, sans-serif'
        ctx.fillText('Loading indexed data…', PLOT_LEFT + 22, top + height / 2)
      }
      return 0
    }

    const bins = binFeatures(visible, this.region, Math.floor(plotWidth))
    const binding = spec.scaleBindingId ? this.document.scales.find((scale) => scale.id === spec.scaleBindingId) : undefined
    const transform = binding?.transform ?? 'linear'
    const fallbackDomain = resolvedSignalDomain(bins, domain)
    const canvas = this.context === this.bottomContext ? this.bottomCanvas : this.canvas
    const activeDomains = !segments?.length
      ? [{ domain: fallbackDomain, x1: PLOT_LEFT, x2: width, side: '' }]
      : segments.map((segment, index) => ({
          domain: segment.domain ?? fallbackDomain,
          x1: this.plotX(canvas, segment.start),
          x2: this.plotX(canvas, segment.end),
          side: segments.length === 2 ? index === 0 ? 'L' : 'R' : String(index + 1),
        }))
    const allNonnegative = activeDomains.every((item) => item.domain.min >= 0)
    const { top: chartTop, bottom: chartBottom } = signalChartBounds(top, bottom, allNonnegative && spec.signalStrand !== 'minus')
    for (const item of activeDomains) paintSignalDomain(ctx, bins, spec, item.domain, transform, chartTop, chartBottom, item.x1, item.x2, palette)
    if (segments?.length) {
      ctx.fillStyle = palette.axisInk
      ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
      for (const item of activeDomains) {
        const value = signalDomainScaleValue(item.domain)
        const signedValue = spec.signalStrand === 'minus' ? `−${formatScore(Math.abs(value))}` : formatScore(value)
        const labelY = spec.signalStrand === 'minus' ? chartBottom - 3 : chartTop + 10
        if (value && item.x2 - item.x1 >= 48) ctx.fillText(`${item.side} ${signedValue}`, item.x1 + 5, labelY)
      }
    }
    const scaleValue = signalDomainScaleValue(fallbackDomain)
    if (!segments?.length && scaleValue !== 0) {
      const maxLabel = formatScore(scaleValue)
      ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
      ctx.strokeStyle = palette.axisLine
      ctx.lineWidth = 1
      ctx.fillStyle = palette.axisInk
      ctx.textAlign = 'right'
      const scaleAtBottom = spec.signalStrand === 'minus' || (fallbackDomain.max === 0 && fallbackDomain.min < 0)
      const tickY = scaleAtBottom ? chartBottom - 0.5 : chartTop + 0.5
      ctx.textBaseline = 'middle'
      ctx.fillText(maxLabel, LABEL_WIDTH - 8, tickY)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'start'
      ctx.beginPath()
      ctx.moveTo(LABEL_WIDTH - 7, tickY)
      ctx.lineTo(LABEL_WIDTH + 7, tickY)
      ctx.stroke()
    }
    return visible.length
  }

  private drawSignalStack(
    group: DisplayGroup,
    members: readonly TrackSpec[],
    index: number,
    top: number,
    height: number,
    width: number,
    palette: CanvasPalette,
    domains: ReadonlyMap<string, ScaleDomain>,
    segmentDomains?: readonly ScaleDomainSegment[],
  ): number {
    const visibleMembers = members.filter((track) => track.enabled && !(group.signalStackHiddenTrackIds ?? []).includes(track.id))
    const first = visibleMembers[0]
    if (!first) return 0
    const differentiation = group.signalStackDifferentiation ?? 'patterns'
    const legendEntries = signalStackLegendEntries(members, visibleMembers, differentiation, group.signalStackHiddenTrackIds ?? [], group.signalStackStyleTrackIds)
    const styles = new Map(legendEntries.map((entry) => [entry.id, entry]))
    const firstStyle = styles.get(first.id)!
    const firstSpec: TrackSpec = {
      ...first,
      label: '',
      color: firstStyle.color,
      signalRenderStyle: 'line',
      signalOpacity: 0,
    }
    const domain = first.scaleBindingId ? domains.get(first.scaleBindingId) : undefined
    const segments = first.scaleBindingId && segmentDomains ? segmentDomains.map((segment) => ({ start: segment.start, end: segment.end, domain: segment.domains.get(first.scaleBindingId!) })) : undefined
    let count = this.drawTrack(firstSpec, this.runtimes.get(signalFeatureKey(first.id, first.signalStrand))!, index, top, height, width, palette, domain, segments)
    this.drawSignalStackMember(first, firstStyle.color, firstStyle.dash, top, height, width, domain, segments)
    for (let memberIndex = 1; memberIndex < visibleMembers.length; memberIndex += 1) {
      const member = visibleMembers[memberIndex]!
      const memberDomain = member.scaleBindingId ? domains.get(member.scaleBindingId) : domain
      const memberSegments = member.scaleBindingId && segmentDomains ? segmentDomains.map((segment) => ({ start: segment.start, end: segment.end, domain: segment.domains.get(member.scaleBindingId!) })) : segments
      const style = styles.get(member.id)!
      count += this.drawSignalStackMember(member, style.color, style.dash, top, height, width, memberDomain, memberSegments)
    }
    this.drawSignalStackLegend(legendEntries, top, height, palette)
    return count
  }

  private drawSignalStackLegend(entries: ReturnType<typeof signalStackLegendEntries>, top: number, height: number, palette: CanvasPalette): void {
    const ctx = this.context
    const lineHeight = Math.max(7, Math.min(14, (height - 10) / Math.max(1, entries.length)))
    let fontSize = Math.max(5, Math.min(10, lineHeight - 3))
    const sampleLeft = GROUP_RAIL_WIDTH + 6
    const sampleRight = sampleLeft + 16
    const labelLeft = sampleRight + 4
    const labelWidth = Math.max(18, LABEL_WIDTH - SCALE_LANE_MIN_WIDTH - labelLeft - 3)
    const startY = top + (height - lineHeight * entries.length) / 2 + lineHeight / 2
    ctx.save()
    ctx.beginPath(); ctx.rect(GROUP_RAIL_WIDTH, top, LABEL_WIDTH - GROUP_RAIL_WIDTH, height); ctx.clip()
    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`
    const longestLabel = Math.max(1, ...entries.map((entry) => ctx.measureText(entry.label).width))
    fontSize = Math.max(5, Math.min(fontSize, fontSize * labelWidth / longestLabel))
    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`
    ctx.textBaseline = 'middle'
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      const color = entry.hidden ? palette.muted : entry.color
      const dash = entry.hidden ? [2, 3] : entry.dash
      const y = startY + index * lineHeight
      ctx.globalAlpha = entry.hidden ? 0.42 : 1
      ctx.strokeStyle = color
      ctx.lineWidth = 1.7
      ctx.lineCap = 'round'
      ctx.setLineDash(dash)
      ctx.beginPath(); ctx.moveTo(sampleLeft, y); ctx.lineTo(sampleRight, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = entry.hidden ? palette.muted : palette.ink
      ctx.fillText(ellipsize(ctx, entry.label, labelWidth), labelLeft, y)
    }
    ctx.restore()
  }

  private visibleSignalFeatures(spec: TrackSpec): SignalFeature[] {
    const runtime = this.runtimes.get(signalFeatureKey(spec.id, spec.signalStrand))
    const raw = (runtime?.features ?? []).filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as SignalFeature[]
    return spec.allowNegativeValues === false ? raw.map((feature) => ({ ...feature, score: Math.max(0, feature.score) })) : raw
  }

  private drawSignalStackMember(
    spec: TrackSpec,
    color: string,
    dash: readonly number[],
    top: number,
    height: number,
    width: number,
    domain: ScaleDomain | undefined,
    segments: readonly TrackScaleSegment[] | undefined,
  ): number {
    const visible = this.visibleSignalFeatures(spec)
    if (!visible.length) return 0
    const bins = binFeatures(visible, this.region, Math.floor(width - PLOT_LEFT))
    const fallbackDomain = resolvedSignalDomain(bins, domain)
    const binding = spec.scaleBindingId ? this.document.scales.find((scale) => scale.id === spec.scaleBindingId) : undefined
    const canvas = this.context === this.bottomContext ? this.bottomCanvas : this.canvas
    const activeDomains = !segments?.length
      ? [{ domain: fallbackDomain, x1: PLOT_LEFT, x2: width }]
      : segments.map((segment) => ({ domain: segment.domain ?? fallbackDomain, x1: this.plotX(canvas, segment.start), x2: this.plotX(canvas, segment.end) }))
    const allNonnegative = activeDomains.every((item) => item.domain.min >= 0)
    const chart = signalChartBounds(top, top + height, allNonnegative)
    for (const item of activeDomains) paintSmoothSignalDomain(this.context, bins, item.domain, binding?.transform ?? 'linear', chart.top, chart.bottom, item.x1, item.x2, color, dash)
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
    segments?: readonly { start: number; end: number; plus?: ScaleDomain; minus?: ScaleDomain }[],
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
    const segmentMagnitudes = segments?.map((segment) => ({
      ...segment,
      plusMax: segment.plus?.max ?? plusMax,
      minusMax: segment.minus?.max ?? minusMax,
    }))
    const plusBinding = spec.scaleBindingId ? this.document.scales.find((scale) => scale.id === spec.scaleBindingId) : undefined
    const minusBinding = spec.negativeScaleBindingId ? this.document.scales.find((scale) => scale.id === spec.negativeScaleBindingId) : undefined
    const labels = (segmentMagnitudes
      ? segmentMagnitudes.flatMap((segment) => [segment.plusMax, segment.minusMax])
      : [plusMax, minusMax]).filter((value) => value > 0).map(formatScore)
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace'
    const scaleLaneWidth = labels.length ? Math.max(SCALE_LANE_MIN_WIDTH, ...labels.map((label) => Math.ceil(ctx.measureText(label).width) + 12)) : 0
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds(scaleLaneWidth)
    const labelLayout = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 20) / 15)))
    drawCenteredTextLines(ctx, labelLayout, labelBounds.center, verticallyCenteredBaseline(top, height, labelLayout.length, 15), 15)

    const { top: chartTop, bottom: chartBottom } = signalChartBounds(top, bottom)
    const zeroY = chartTop + (chartBottom - chartTop) / 2
    ctx.strokeStyle = palette.zero
    ctx.beginPath(); ctx.moveTo(PLOT_LEFT, zeroY + 0.5); ctx.lineTo(width, zeroY + 0.5); ctx.stroke()
    if (scaleLaneWidth && !segmentMagnitudes?.length) {
      ctx.strokeStyle = palette.axisLine
      ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
      ctx.fillStyle = palette.axisInk
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      if (plusMax > 0) ctx.fillText(formatScore(plusMax), LABEL_WIDTH - 8, chartTop + 0.5)
      if (minusMax > 0) ctx.fillText(formatScore(minusMax), LABEL_WIDTH - 8, chartBottom - 0.5)
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'start'
      ctx.beginPath()
      if (plusMax > 0) { ctx.moveTo(LABEL_WIDTH - 7, chartTop + 0.5); ctx.lineTo(LABEL_WIDTH + 7, chartTop + 0.5) }
      if (minusMax > 0) { ctx.moveTo(LABEL_WIDTH - 7, chartBottom - 0.5); ctx.lineTo(LABEL_WIDTH + 7, chartBottom - 0.5) }
      ctx.stroke()
    }
    const plusBins = binFeatures(plusVisible, this.region, Math.floor(plotWidth))
    const minusBins = binFeatures(minusVisible, this.region, Math.floor(plotWidth))
    if (!segmentMagnitudes?.length) {
      drawMagnitudeBins(ctx, plusBins, PLOT_LEFT, chartTop, zeroY, Math.max(1e-9, plusMax), spec.color, false, spec.signalRenderStyle ?? 'fill', (spec.signalOpacity ?? 100) / 100, plusBinding?.transform ?? 'linear')
      drawMagnitudeBins(ctx, minusBins, PLOT_LEFT, zeroY, chartBottom, Math.max(1e-9, minusMax), spec.negativeColor ?? spec.color, true, spec.signalRenderStyle ?? 'fill', (spec.signalOpacity ?? 100) / 100, minusBinding?.transform ?? 'linear')
    } else {
      const canvas = this.context === this.bottomContext ? this.bottomCanvas : this.canvas
      ctx.fillStyle = palette.axisInk
      ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
      segmentMagnitudes.forEach((segment, index) => {
        const x1 = this.plotX(canvas, segment.start)
        const x2 = this.plotX(canvas, segment.end)
        paintMagnitudeSide(ctx, plusBins, minusBins, spec, chartTop, zeroY, chartBottom, x1, x2,
          { plus: segment.plusMax, minus: segment.minusMax }, plusBinding?.transform ?? 'linear', minusBinding?.transform ?? 'linear')
        if (x2 - x1 < 64) return
        const section = segmentMagnitudes.length === 2 ? index === 0 ? 'L' : 'R' : String(index + 1)
        ctx.fillText(`${section} +${formatScore(segment.plusMax)}`, x1 + 5, chartTop + 10)
        ctx.fillText(`${section} −${formatScore(segment.minusMax)}`, x1 + 5, chartBottom - 3)
      })
    }

    const problems = [plus, minus].filter((runtime) => runtime.status === 'offline' || runtime.status === 'error')
    if (problems.length) {
      ctx.fillStyle = palette.error
      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.fillText(problems.map((runtime) => `${runtime.channel === 'plus' ? '+' : '−'} ${runtime.error ?? 'source unavailable'}`).join(' · '), PLOT_LEFT + 12, bottom - 4)
    } else if (!plusVisible.length && !minusVisible.length && (plus.status === 'loading' || minus.status === 'loading')) {
      ctx.fillStyle = palette.muted
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText('Loading stranded signal…', PLOT_LEFT + 22, zeroY - 8)
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
    const visible = (track.features.filter((feature) => feature.end > this.region.start && feature.start < this.region.end) as IntervalFeature[])
      .filter((feature) => spec.intervalMinScore === undefined || (feature.score ?? Number.NEGATIVE_INFINITY) >= spec.intervalMinScore)
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
    const intervalScores = visible.map((feature) => feature.score).filter((score): score is number => Number.isFinite(score))
    const scoreMin = intervalScores.length ? Math.min(...intervalScores) : 0
    const scoreMax = intervalScores.length ? Math.max(...intervalScores) : 0
    for (const feature of visible) {
      const rawX1 = PLOT_LEFT + (feature.start - this.region.start) * scale
      const rawX2 = PLOT_LEFT + (feature.end - this.region.start) * scale
      const x1 = Math.max(PLOT_LEFT, rawX1)
      const x2 = Math.min(width, rawX2)
      const labelWidth = feature.name && spec.intervalShowLabels !== false && mode !== 'squished' ? ctx.measureText(feature.name).width + 7 : 0
      let lane = 0
      if (mode !== 'collapsed') {
        while (rawX1 <= (laneEnds[lane] ?? Number.NEGATIVE_INFINITY)) lane += 1
        if (spec.intervalMaxRows && lane >= spec.intervalMaxRows) continue
        laneEnds[lane] = rawX2 + labelWidth + 5
      }
      const centerY = mode === 'collapsed' ? top + height / 2 : top + 9 + lane * rowHeight
      if (centerY + featureHeight > bottom) continue
      const color = spec.intervalColorMode === 'item-rgb' ? feature.itemRgb ?? spec.color
        : spec.intervalColorMode === 'strand' ? feature.strand === '+' ? '#d95d74' : feature.strand === '-' ? '#3478c9' : spec.color
          : spec.intervalColorMode === 'score' && feature.score !== undefined ? scoreColor(feature.score, scoreMin, scoreMax) : spec.color
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
      if (feature.name && spec.intervalShowLabels !== false && mode !== 'squished' && x2 + labelWidth < width) {
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
      if (track.status === 'loading') {
        ctx.fillStyle = palette.muted
        ctx.font = '12px Inter, system-ui, sans-serif'
        ctx.fillText('Loading interactions…', PLOT_LEFT + 22, top + height / 2)
      }
      return 0
    }

    const filterMode = spec.interactionFilterMode ?? 'all'
    const geneTargets: InteractionGeneTarget[] = filterMode === 'genes'
      ? (spec.interactionFilterGenes ?? []).map((name) => ({ name, gene: this.geneSource?.find(name) }))
      : filterMode === 'visible-genes'
        ? (this.geneSource?.featuresFor(this.region) ?? []).map((gene) => ({ name: gene.name, gene }))
        : []
    const geneFiltered = filterMode === 'all' ? inWindow : filterInteractionsForGenes(inWindow, geneTargets)
    const visible = filterInteractionFeatures(geneFiltered, spec.interactionMinScore, spec.interactionMaxDistance)
    if (!visible.length) {
      const unavailable = filterMode === 'visible-genes' && !this.geneSource
      if (unavailable) {
        ctx.fillStyle = palette.error
        ctx.font = '12px Inter, system-ui, sans-serif'
        ctx.fillText('No gene annotation is available for this reference', PLOT_LEFT + 22, top + height / 2)
      }
      return 0
    }

    const shown = selectInteractionFeatures(visible, spec.interactionMaxFeatures ?? MAX_VISIBLE_INTERACTIONS)
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
      const color = interactionFeatureColor(feature, spec, scoreMin, scoreMax)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = (spec.interactionLineWidth ?? 1) * (0.8 + emphasis * 2.2)
      ctx.globalAlpha = ((spec.interactionOpacity ?? 92) / 100) * (0.3 + emphasis * 0.62)
      if (feature.chrom1 === this.region.chr && feature.chrom2 === this.region.chr) {
        const x1 = PLOT_LEFT + (((feature.start1 + feature.end1) / 2) - this.region.start) * scale
        const x2 = PLOT_LEFT + (((feature.start2 + feature.end2) / 2) - this.region.start) * scale
        const arcHeight = spec.interactionArcHeightMode === 'fixed' ? Math.max(8, (height - 14) * 0.55) : interactionArcHeight(Math.abs(x2 - x1), height)
        ctx.beginPath()
        ctx.moveTo(x1, baseline)
        ctx.bezierCurveTo(x1, baseline + arcDirection * arcHeight * 1.35, x2, baseline + arcDirection * arcHeight * 1.35, x2, baseline)
        ctx.stroke()
        if (spec.interactionShowAnchors !== false) {
          drawInteractionAnchor(ctx, feature.start1, feature.end1, this.region, scale, baseline, width)
          drawInteractionAnchor(ctx, feature.start2, feature.end2, this.region, scale, baseline, width)
        }
        if (spec.interactionShowNames && feature.name) {
          ctx.font = '9px Inter, system-ui, sans-serif'
          ctx.fillText(feature.name, Math.min(width - 4, Math.max(PLOT_LEFT + 3, (x1 + x2) / 2 + 3)), baseline + arcDirection * arcHeight * 0.7)
        }
      } else {
        const firstIsVisible = feature.chrom1 === this.region.chr
        const anchorStart = firstIsVisible ? feature.start1 : feature.start2
        const anchorEnd = firstIsVisible ? feature.end1 : feature.end2
        const otherChromosome = firstIsVisible ? feature.chrom2 : feature.chrom1
        const x = PLOT_LEFT + (((anchorStart + anchorEnd) / 2) - this.region.start) * scale
        if (spec.interactionShowAnchors !== false) drawInteractionAnchor(ctx, anchorStart, anchorEnd, this.region, scale, baseline, width)
        ctx.setLineDash([3, 3])
        const markerEnd = arcDirection > 0 ? bottom - 16 : top + 16
        ctx.beginPath(); ctx.moveTo(x, baseline + arcDirection * 3); ctx.lineTo(x, markerEnd); ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = Math.max(ctx.globalAlpha, 0.75)
        ctx.font = '9px Inter, system-ui, sans-serif'
        ctx.fillText(spec.interactionShowNames && feature.name ? `${feature.name} · ${otherChromosome}` : otherChromosome, x + 3, arcDirection > 0 ? bottom - 6 : top + 12)
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
    matrixMaximum?: number,
  ): number {
    const ctx = this.context
    const bottom = top + height
    const plotWidth = width - PLOT_LEFT
    const trackBackground = index % 2 === 0 ? palette.track : palette.trackAlternate
    ctx.fillStyle = trackBackground
    ctx.fillRect(LABEL_WIDTH, top, plotWidth, height)
    ctx.fillStyle = palette.gutter
    ctx.fillRect(0, top, LABEL_WIDTH, height)
    if (this.selectedTrackIds.has(spec.id)) { ctx.fillStyle = palette.selectionFill; ctx.fillRect(0, top, LABEL_WIDTH, height) }
    ctx.strokeStyle = palette.line
    ctx.beginPath(); ctx.moveTo(0, bottom - 0.5); ctx.lineTo(width, bottom - 0.5); ctx.stroke()

    const matrix = track.features.find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
    const signed = spec.matrixValueMode === 'log2-observed-expected' || spec.matrixComparisonMode === 'difference' || spec.matrixComparisonMode === 'log2-ratio'
    const minimum = signed ? 0 : Math.max(0, spec.matrixScaleMin ?? 0)
    const minimumRange = Math.max(1e-9, Math.abs(minimum) * 1e-9)
    const automaticPercentile = spec.matrixScaleMode === 'maximum' ? 1 : spec.matrixScalePercentile ?? 0.99
    const maximum = Math.max(minimum + minimumRange, matrixMaximum
      ?? (spec.matrixScaleMode === 'fixed' ? spec.matrixScaleMax : undefined)
      ?? (signed ? matrixAutomaticMagnitude(matrix, automaticPercentile, spec.matrixIgnoreDiagonals ?? 3) : matrixAutomaticMaximum(matrix, automaticPercentile, spec.matrixIgnoreDiagonals ?? 3)))
    const legendValues = matrix && this.matrixDisplayPreferences.legend ? signed ? [maximum, 0, -maximum] : matrixLegendValues(minimum, maximum, spec.matrixTransform ?? 'log1p') : []
    ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
    const legendLabels = legendValues.map(formatScore)
    const scaleLaneWidth = legendLabels.length
      ? Math.max(58, Math.ceil(Math.max(...legendLabels.map((label) => ctx.measureText(label).width))) + 27)
      : 0
    ctx.fillStyle = palette.ink
    ctx.font = '600 12px Inter, system-ui, sans-serif'
    const labelBounds = trackLabelBounds(scaleLaneWidth)
    const labelLines = wrappedLines(ctx, spec.label, labelBounds.width, Math.max(1, Math.floor((height - 12) / 15)))
    const labelTop = verticallyCenteredBaseline(top, height, labelLines.length, 15)
    drawCenteredTextLines(ctx, labelLines, labelBounds.center, labelTop, 15)
    ctx.textAlign = 'start'
    if (track.status === 'error' || track.status === 'offline') {
      ctx.fillStyle = palette.error
      ctx.font = '11px Inter, system-ui, sans-serif'
      wrapText(ctx, track.error ?? 'Could not load contact matrix', 24, bottom - 38, 136, 15, 2)
      this.drawMatrixOutlinesWithoutData(spec, top, bottom, width, palette)
      return 0
    }
    if (!matrix) {
      if (track.status === 'loading') {
        ctx.fillStyle = palette.muted
        ctx.font = '12px Inter, system-ui, sans-serif'
        const loadingSpan = track.lastQueryRegion ? formatBases(track.lastQueryRegion.end - track.lastQueryRegion.start) : undefined
        ctx.fillText(`Loading contacts · ${spec.matrixResolution ? formatBases(spec.matrixResolution) : 'automatic resolution'}${loadingSpan ? ` · ${loadingSpan} window` : ''}…`, PLOT_LEFT + 22, top + height / 2)
      }
      this.drawMatrixOutlinesWithoutData(spec, top, bottom, width, palette)
      return 0
    }

    const overlay = this.matrixOverlaySelection(spec, matrix)
    if (matrix.axis2) return this.drawMatrixRectangle(spec, matrix, top, bottom, width, minimum, maximum, scaleLaneWidth, trackBackground, palette, overlay)

    const scale = plotWidth / Math.max(1, this.region.end - this.region.start)
    const direction = spec.matrixDirection === 'down' ? 1 : -1
    const geometry = matrixVerticalGeometry(top, bottom, spec.matrixDirection ?? 'up')
    const baseline = geometry.baseline
    const halfCell = Math.max(0.55, matrix.resolution * scale / 2)
    const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance)
    const depthPixels = Math.min(plotWidth / 2, maximumDistance * scale / 2)
    drawMatrixLegend(ctx, spec, minimum, maximum, top, bottom, scaleLaneWidth, palette)
    ctx.save()
    ctx.beginPath(); ctx.rect(PLOT_LEFT, geometry.clipTop, plotWidth, Math.max(0, geometry.clipBottom - geometry.clipTop)); ctx.clip()
    if (spec.matrixZeroStyle !== 'background' && (!signed || spec.matrixZeroStyle === 'custom')) {
      const zeroStyle = spec.matrixZeroStyle === 'custom'
        ? { color: spec.matrixZeroColor ?? '#d7d9df', alpha: 1 }
        : matrixPaletteStyle(spec, matrixPaletteIntensity(0, spec.matrixPaletteReversed === true))
      ctx.fillStyle = zeroStyle.color
      ctx.globalAlpha = Math.min(1, zeroStyle.alpha * 0.72)
      matrixDomainPath(ctx, PLOT_LEFT, width, baseline, direction, depthPixels)
      ctx.fill()
    }
    const tiled = this.matrixTiles.render({
      trackId: spec.id, source: matrix,
      key: matrixTileCacheKey(spec, matrix, scale, height, minimum, maximum, Math.min(window.devicePixelRatio || 1, 2), document.documentElement.dataset.theme ?? ''),
      target: ctx, plotLeft: PLOT_LEFT, plotWidth, top, height, worldLeft: this.region.start * scale,
      dpr: window.devicePixelRatio || 1,
      box: (cell) => {
        if ((!signed && !(cell.value > 0)) || !Number.isFinite(cell.value)) return undefined
        const first = cell.bin1 + matrix.resolution / 2
        const second = cell.bin2 + matrix.resolution / 2
        const x = (first + second) / 2 * scale
        const y = baseline - top + direction * (second - first) / 2 * scale
        return { left: x - halfCell, right: x + halfCell, top: y - halfCell, bottom: y + halfCell }
      },
      paint: (tile, cell, box) => {
        const scoreIntensity = signed ? (cell.value / maximum + 1) / 2 : matrixValueIntensity(cell.value, minimum, maximum, spec.matrixTransform ?? 'log1p')
        const intensity = matrixPaletteIntensity(scoreIntensity, spec.matrixPaletteReversed === true)
        const style = signed ? { color: matrixSignedColor(scoreIntensity * 2 - 1), alpha: 1 } : matrixPaletteStyle(spec, intensity)
        tile.fillStyle = style.color; tile.globalAlpha = style.alpha
        const x = (box.left + box.right) / 2
        const y = (box.top + box.bottom) / 2
        const half = (box.right - box.left) / 2
        tile.beginPath(); tile.moveTo(x - half, y); tile.lineTo(x, y + half)
        tile.lineTo(x + half, y); tile.lineTo(x, y - half); tile.closePath(); tile.fill()
      },
    })
    this.matrixRendererModes.set(spec.id, tiled ? 'tiled' : 'direct')
    if (!tiled) for (const cell of matrix.cells) {
      if ((!signed && !(cell.value > 0)) || !Number.isFinite(cell.value) || cell.bin2 + matrix.resolution <= this.region.start || cell.bin1 >= this.region.end) continue
      const firstCenter = cell.bin1 + matrix.resolution / 2
      const secondCenter = cell.bin2 + matrix.resolution / 2
      const x = PLOT_LEFT + (((firstCenter + secondCenter) / 2) - this.region.start) * scale
      const y = baseline + direction * ((secondCenter - firstCenter) / 2) * scale
      if (x + halfCell < PLOT_LEFT || x - halfCell > width || y + halfCell < top || y - halfCell > bottom) continue
      const scoreIntensity = signed ? (cell.value / maximum + 1) / 2 : matrixValueIntensity(cell.value, minimum, maximum, spec.matrixTransform ?? 'log1p')
      if (!Number.isFinite(scoreIntensity)) continue
      const intensity = matrixPaletteIntensity(scoreIntensity, spec.matrixPaletteReversed === true)
      const style = signed ? { color: matrixSignedColor(scoreIntensity * 2 - 1), alpha: 1 } : matrixPaletteStyle(spec, intensity)
      ctx.fillStyle = style.color
      ctx.globalAlpha = style.alpha
      ctx.beginPath()
      ctx.moveTo(x - halfCell, y)
      ctx.lineTo(x, y + halfCell)
      ctx.lineTo(x + halfCell, y)
      ctx.lineTo(x, y - halfCell)
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalAlpha = 1
    drawMissingMatrixCells(ctx, matrix.missingCells ?? [], matrix.resolution, this.region, scale, baseline, direction, halfCell, spec.matrixMissingStyle === 'custom' ? spec.matrixMissingColor ?? '#9197a3' : trackBackground)
    drawMaskedMatrixBins(ctx, matrix.maskedBins ?? [], matrix.resolution, this.region, scale, PLOT_LEFT, width, baseline, direction, depthPixels, spec, trackBackground, palette)
    if (overlay) this.drawTriangularMatrixOverlay(overlay, matrix, scale, baseline, direction, halfCell, palette)
    this.drawTriangularMatrixOutlines(spec, scale, baseline, direction, depthPixels, width, palette)
    if (this.matrixHover?.trackId === spec.id) drawMatrixCrosshair(ctx, this.matrixHover, matrix.resolution, PLOT_LEFT, width, geometry.clipTop, geometry.clipBottom, halfCell, direction, palette)
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.axisLine
    ctx.beginPath(); ctx.moveTo(PLOT_LEFT, baseline + 0.5); ctx.lineTo(width, baseline + 0.5); ctx.stroke()
    ctx.restore()
    this.drawMatrixOverlayTruncation(overlay, top + 13, palette)
    ctx.strokeStyle = palette.line
    ctx.beginPath(); ctx.moveTo(0, bottom - 0.5); ctx.lineTo(width, bottom - 0.5); ctx.stroke()
    return matrix.cells.length + (matrix.missingCells?.length ?? 0) + (overlay?.features.length ?? 0)
  }

  private drawMatrixRectangle(spec: TrackSpec, matrix: MatrixFeature, top: number, bottom: number, width: number,
    minimum: number, maximum: number, legendWidth: number, background: string, palette: CanvasPalette, overlay?: MatrixOverlaySelection): number {
    const axis = matrix.axis2!
    const ctx = this.context
    const scaleX = (width - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
    const scaleY = (bottom - top) / Math.max(1, axis.end - axis.start)
    const color = (value: number) => matrixPaletteStyle(spec, matrixPaletteIntensity(matrixValueIntensity(value, minimum, maximum, spec.matrixTransform ?? 'log1p'), spec.matrixPaletteReversed === true))
    ctx.save()
    ctx.beginPath(); ctx.rect(PLOT_LEFT, top, width - PLOT_LEFT, bottom - top); ctx.clip()
    if (spec.matrixZeroStyle !== 'background') {
      ctx.fillStyle = spec.matrixZeroStyle === 'custom' ? spec.matrixZeroColor ?? '#d7d9df' : color(0).color
      ctx.globalAlpha = spec.matrixZeroStyle === 'custom' ? 1 : color(0).alpha * 0.72
      ctx.fillRect(PLOT_LEFT, top, width - PLOT_LEFT, bottom - top)
    }
    const tiled = this.matrixTiles.render({
      trackId: spec.id, source: matrix,
      key: matrixTileCacheKey(spec, matrix, scaleX, bottom - top, minimum, maximum, Math.min(window.devicePixelRatio || 1, 2), document.documentElement.dataset.theme ?? ''),
      target: ctx, plotLeft: PLOT_LEFT, plotWidth: width - PLOT_LEFT, top, height: bottom - top,
      worldLeft: this.region.start * scaleX, dpr: window.devicePixelRatio || 1,
      box: (cell) => cell.value > 0 && Number.isFinite(cell.value) ? {
        left: cell.bin1 * scaleX, right: cell.bin1 * scaleX + Math.max(1, matrix.resolution * scaleX),
        top: (cell.bin2 - axis.start) * scaleY,
        bottom: (cell.bin2 - axis.start) * scaleY + Math.max(1, matrix.resolution * scaleY),
      } : undefined,
      paint: (tile, cell, box) => {
        const style = color(cell.value)
        tile.fillStyle = style.color; tile.globalAlpha = style.alpha
        tile.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top)
      },
    })
    this.matrixRendererModes.set(spec.id, tiled ? 'tiled' : 'direct')
    const draw = (bin1: number, bin2: number, style: { color: string; alpha: number }) => {
      const x = PLOT_LEFT + (bin1 - this.region.start) * scaleX
      const y = top + (bin2 - axis.start) * scaleY
      ctx.fillStyle = style.color; ctx.globalAlpha = style.alpha
      ctx.fillRect(x, y, Math.max(1, matrix.resolution * scaleX), Math.max(1, matrix.resolution * scaleY))
    }
    if (!tiled) for (const cell of matrix.cells) if (cell.bin1 + matrix.resolution > this.region.start && cell.bin1 < this.region.end
      && cell.bin2 + matrix.resolution > axis.start && cell.bin2 < axis.end && cell.value > 0 && Number.isFinite(cell.value)) draw(cell.bin1, cell.bin2, color(cell.value))
    const missing = spec.matrixMissingStyle === 'custom' ? spec.matrixMissingColor ?? '#9197a3' : background
    for (const cell of matrix.missingCells ?? []) draw(cell.bin1, cell.bin2, { color: missing, alpha: 1 })
    const masked = spec.matrixMaskedStyle === 'custom' ? spec.matrixMaskedColor ?? '#9197a3'
      : spec.matrixMaskedStyle === 'background' ? background : palette.muted
    ctx.fillStyle = masked; ctx.globalAlpha = spec.matrixMaskedStyle === 'hatch' ? 0.55 : 1
    for (const bin of matrix.maskedBins ?? []) ctx.fillRect(PLOT_LEFT + (bin - this.region.start) * scaleX, top, Math.max(1, matrix.resolution * scaleX), bottom - top)
    for (const bin of matrix.maskedBins2 ?? []) ctx.fillRect(PLOT_LEFT, top + (bin - axis.start) * scaleY, width - PLOT_LEFT, Math.max(1, matrix.resolution * scaleY))
    if (overlay) this.drawRectangularMatrixOverlay(overlay, matrix, scaleX, scaleY, top, palette)
    this.drawRectangularMatrixOutlines(spec, axis, scaleX, scaleY, top, palette)
    if (this.matrixHover?.trackId === spec.id) {
      ctx.globalAlpha = 1; ctx.strokeStyle = palette.axisLine
      ctx.strokeRect(this.matrixHover.x - matrix.resolution * scaleX / 2, this.matrixHover.y - matrix.resolution * scaleY / 2,
        Math.max(1, matrix.resolution * scaleX), Math.max(1, matrix.resolution * scaleY))
    }
    ctx.restore()
    drawMatrixLegend(ctx, spec, minimum, maximum, top, bottom, legendWidth, palette)
    ctx.fillStyle = palette.ink; ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.fillText(`Y: ${formatLocus(axis)}`, PLOT_LEFT + 6, Math.min(bottom - 5, top + 13))
    this.drawMatrixOverlayTruncation(overlay, Math.min(bottom - 5, top + 27), palette)
    return matrix.cells.length + (matrix.missingCells?.length ?? 0) + (overlay?.features.length ?? 0)
  }

  private matrixOutlinesForTrack(spec: TrackSpec, verticalChr: string, palette: CanvasPalette): Array<Pick<MatrixOutline, 'axis1' | 'axis2' | 'color'>> {
    const outlines: Array<Pick<MatrixOutline, 'axis1' | 'axis2' | 'color'>> = this.document.matrixOutlines
      .filter((outline) => matrixOutlineTargetsTrack(outline, spec.id, this.region.chr, verticalChr))
      .map((outline) => this.matrixOutlineCornerDrag?.id === outline.id
        ? { ...outline, axis1: this.matrixOutlineCornerDrag.axis1, axis2: this.matrixOutlineCornerDrag.axis2 }
        : outline)
    const selection = this.matrixOutlineSelection
    if (selection?.trackId === spec.id) outlines.push({
      axis1: { chr: selection.axis1Chr, start: Math.min(selection.startBin1, selection.currentBin1), end: Math.max(selection.startBin1, selection.currentBin1) + selection.resolution },
      axis2: { chr: selection.axis2Chr, start: Math.min(selection.startBin2, selection.currentBin2), end: Math.max(selection.startBin2, selection.currentBin2) + selection.resolution },
      color: palette.selection,
    })
    return outlines
  }

  private drawTriangularMatrixOutlines(spec: TrackSpec, scale: number, baseline: number, direction: number, depthPixels: number, width: number, palette: CanvasPalette): void {
    const outlines = this.matrixOutlinesForTrack(spec, this.region.chr, palette)
    if (!outlines.length) return
    const ctx = this.context
    const clip = matrixDepthClipBounds(PLOT_LEFT, width, baseline, direction, depthPixels)
    ctx.save()
    ctx.beginPath(); ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top)
    ctx.clip()
    for (const outline of outlines) {
      const points = matrixOutlinePolygon(outline.axis1, outline.axis2, this.region, scale, baseline, direction)
      strokeClosedPolygon(ctx, points, outline.color)
    }
    ctx.restore()
  }

  private drawRectangularMatrixOutlines(spec: TrackSpec, axis: Region, scaleX: number, scaleY: number, top: number, palette: CanvasPalette): void {
    const outlines = this.matrixOutlinesForTrack(spec, axis.chr, palette)
    if (!outlines.length) return
    const ctx = this.context
    for (const outline of outlines) {
      strokeClosedPolygon(ctx, rectangularMatrixOutlinePolygon(outline.axis1, outline.axis2, this.region, axis, scaleX, scaleY, top), outline.color)
    }
  }

  private drawMatrixOutlinesWithoutData(spec: TrackSpec, top: number, bottom: number, width: number, palette: CanvasPalette): void {
    if (spec.matrixSecondaryRegion) {
      const axis = spec.matrixSecondaryRegion
      const scaleX = (width - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
      const scaleY = (bottom - top) / Math.max(1, axis.end - axis.start)
      const ctx = this.context
      ctx.save(); ctx.beginPath(); ctx.rect(PLOT_LEFT, top, width - PLOT_LEFT, bottom - top); ctx.clip()
      this.drawRectangularMatrixOutlines(spec, axis, scaleX, scaleY, top, palette)
      ctx.restore()
      return
    }
    const scale = (width - PLOT_LEFT) / Math.max(1, this.region.end - this.region.start)
    const geometry = matrixVerticalGeometry(top, bottom, spec.matrixDirection ?? 'up')
    const direction = spec.matrixDirection === 'down' ? 1 : -1
    const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance)
    const depthPixels = Math.min((width - PLOT_LEFT) / 2, maximumDistance * scale / 2)
    const ctx = this.context
    ctx.save(); ctx.beginPath(); ctx.rect(PLOT_LEFT, geometry.clipTop, width - PLOT_LEFT, geometry.clipBottom - geometry.clipTop); ctx.clip()
    this.drawTriangularMatrixOutlines(spec, scale, geometry.baseline, direction, depthPixels, width, palette)
    ctx.restore()
  }

  private matrixOverlaySelection(spec: TrackSpec, matrix: MatrixFeature): MatrixOverlaySelection | undefined {
    if (!spec.matrixOverlayInteractionTrackId) return undefined
    const interactionSpec = this.document.tracks.find((track) => track.id === spec.matrixOverlayInteractionTrackId && track.kind === 'interaction')
    const runtime = interactionSpec && this.runtimes.get(signalFeatureKey(interactionSpec.id))
    if (!interactionSpec || !runtime) return undefined
    const sourceFeatures = runtime.features.filter((feature): feature is InteractionFeature => 'featureType' in feature && feature.featureType === 'interaction')
    const filterMode = interactionSpec.interactionFilterMode ?? 'all'
    const geneTargets: InteractionGeneTarget[] = filterMode === 'genes'
      ? (interactionSpec.interactionFilterGenes ?? []).map((name) => ({ name, gene: this.geneSource?.find(name) }))
      : filterMode === 'visible-genes'
        ? (this.geneSource?.featuresFor(this.region) ?? []).map((gene) => ({ name: gene.name, gene }))
        : []
    let filtered = filterMode === 'all' ? sourceFeatures : filterInteractionsForGenes(sourceFeatures, geneTargets)
    filtered = filterInteractionFeatures(filtered, interactionSpec.interactionMinScore, interactionSpec.interactionMaxDistance)
    if (spec.matrixOverlayFocusMode === 'genes') {
      const targets = (spec.matrixOverlayFocusGenes ?? []).map((name) => ({ name, gene: this.geneSource?.find(name) }))
      filtered = filterInteractionsForGenes(filtered, targets)
    } else if (spec.matrixOverlayFocusMode === 'region' && spec.matrixOverlayFocusRegion) {
      filtered = filtered.filter((feature) => interactionTouchesRegion(feature, spec.matrixOverlayFocusRegion!))
    }
    filtered = filtered.filter((feature) => {
      const pair = matrixOverlayAnchorPair(feature, this.region, matrix.axis2)
      if (!pair) return false
      if (matrix.axis2) return true
      const maximumDistance = matrixQueryMaximumDistance(this.region.end - this.region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance)
      return Math.abs(pair.vertical - pair.horizontal) <= maximumDistance
    })
    const limit = Math.min(interactionSpec.interactionMaxFeatures ?? MAX_VISIBLE_INTERACTIONS, spec.matrixOverlayMaxFeatures ?? 250)
    const features = selectInteractionFeatures(filtered, limit)
    const scores = features.map((feature) => feature.score).filter((score): score is number => Number.isFinite(score))
    return {
      interactionSpec,
      features,
      total: filtered.length,
      scoreMin: scores.length ? Math.min(...scores) : 0,
      scoreMax: scores.length ? Math.max(...scores) : 0,
    }
  }

  private drawTriangularMatrixOverlay(overlay: MatrixOverlaySelection, matrix: MatrixFeature, scale: number,
    baseline: number, direction: number, halfCell: number, palette: CanvasPalette): void {
    const ctx = this.context
    for (const feature of overlay.features) {
      const pair = matrixOverlayAnchorPair(feature, this.region)
      if (!pair) continue
      const first = matrixBinCenter(pair.horizontal, matrix.resolution)
      const second = matrixBinCenter(pair.vertical, matrix.resolution)
      const x = PLOT_LEFT + (((first + second) / 2) - this.region.start) * scale
      const y = baseline + direction * ((second - first) / 2) * scale
      const half = Math.max(3, halfCell + 1)
      ctx.beginPath(); ctx.moveTo(x - half, y); ctx.lineTo(x, y + half); ctx.lineTo(x + half, y); ctx.lineTo(x, y - half); ctx.closePath()
      strokeMatrixOverlay(ctx, interactionFeatureColor(feature, overlay.interactionSpec, overlay.scoreMin, overlay.scoreMax), overlay.interactionSpec, palette)
    }
  }

  private drawRectangularMatrixOverlay(overlay: MatrixOverlaySelection, matrix: MatrixFeature, scaleX: number,
    scaleY: number, top: number, palette: CanvasPalette): void {
    const ctx = this.context
    for (const feature of overlay.features) {
      const pair = matrixOverlayAnchorPair(feature, this.region, matrix.axis2)
      if (!pair) continue
      const horizontal = matrixBinCenter(pair.horizontal, matrix.resolution)
      const vertical = matrixBinCenter(pair.vertical, matrix.resolution)
      const cellWidth = Math.max(4, matrix.resolution * scaleX)
      const cellHeight = Math.max(4, matrix.resolution * scaleY)
      const x = PLOT_LEFT + (horizontal - this.region.start) * scaleX - cellWidth / 2
      const y = top + (vertical - matrix.axis2!.start) * scaleY - cellHeight / 2
      ctx.beginPath(); ctx.rect(x, y, cellWidth, cellHeight)
      strokeMatrixOverlay(ctx, interactionFeatureColor(feature, overlay.interactionSpec, overlay.scoreMin, overlay.scoreMax), overlay.interactionSpec, palette)
    }
  }

  private drawMatrixOverlayTruncation(overlay: MatrixOverlaySelection | undefined, y: number, palette: CanvasPalette): void {
    if (!overlay || overlay.features.length >= overlay.total) return
    const ctx = this.context
    ctx.save()
    ctx.globalAlpha = 1
    ctx.fillStyle = palette.muted
    ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.fillText(`BEDPE overlay: ${overlay.features.length.toLocaleString()} of ${overlay.total.toLocaleString()}`, PLOT_LEFT + 6, y)
    ctx.restore()
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
    const sourceAlignments = visible.filter((feature): feature is AlignmentFeature => 'featureType' in feature && feature.featureType === 'alignment')
    const alignments = selectBamAlignments(sourceAlignments, spec.bamMaxReads ?? 10_000, spec.bamSortMode ?? 'start', spec.bamGroupMode ?? 'none', spec.bamGroupTag)
    if (!visible.length) {
      if (track.status === 'loading') {
        ctx.fillStyle = palette.muted
        ctx.font = '12px Inter, system-ui, sans-serif'
        ctx.fillText('Loading alignments…', PLOT_LEFT + 22, top + height / 2)
      }
      return 0
    }
    const viewMode = spec.bamViewMode ?? 'both'
    const coverageHeight = viewMode === 'both' ? Math.min(54, Math.max(28, height * 0.28)) : viewMode === 'coverage' ? height - 8 : 0
    if (coverageHeight > 0 && coverage.length) this.drawBamCoverage(coverage, spec.color, top + 4, coverageHeight, width, palette, spec.bamMinAlleleFrequency ?? 0)
    const readsTop = top + coverageHeight + (coverageHeight ? 7 : 4)
    if (viewMode !== 'coverage' && this.region.end - this.region.start <= BAM_READS_MAX_VISIBLE_SPAN) {
      if (alignments.length) this.drawBamReads(alignments, spec, readsTop, bottom - 3, width, palette)
      else {
        ctx.fillStyle = palette.muted
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.fillText(`Zoom below ${formatBases(BAM_READS_MAX_VISIBLE_SPAN)} to draw individual reads`, PLOT_LEFT + 22, Math.min(bottom - 10, readsTop + 18))
      }
    }
    if (alignments.length < sourceAlignments.length) { ctx.fillStyle = palette.muted; ctx.font = '9px Inter, system-ui, sans-serif'; ctx.fillText(`Showing ${alignments.length.toLocaleString()} of ${sourceAlignments.length.toLocaleString()} reads`, PLOT_LEFT + 8, bottom - 4) }
    return alignments.length + coverage.length
  }

  private drawBamCoverage(features: AlignmentCoverageFeature[], color: string, top: number, height: number, width: number, palette: CanvasPalette, minimumAlleleFrequency: number): void {
    const ctx = this.context
    const scaleX = (width - PLOT_LEFT) / (this.region.end - this.region.start)
    const dividers = this.visibleComparisonDividers()
    const maximum = (selected: readonly AlignmentCoverageFeature[]) => Math.max(1, ...selected.map((feature) => feature.score))
    const overallMax = maximum(features)
    const boundaries = [this.region.start, ...new Set(dividers.map((divider) => divider.position)), this.region.end]
    const sides = !dividers.length
      ? [{ x1: PLOT_LEFT, x2: width, max: overallMax, label: '' }]
      : boundaries.slice(0, -1).map((start, index) => {
          const end = boundaries[index + 1]!
          const label = boundaries.length === 3 ? index === 0 ? 'L ' : 'R ' : `${index + 1} `
          return {
            x1: PLOT_LEFT + (start - this.region.start) * scaleX,
            x2: PLOT_LEFT + (end - this.region.start) * scaleX,
            max: maximum(features.filter((feature) => feature.end > start && feature.start < end)),
            label,
          }
        })
    for (const side of sides) {
      ctx.save()
      ctx.beginPath(); ctx.rect(side.x1, top, Math.max(0, side.x2 - side.x1), height); ctx.clip()
      ctx.fillStyle = color
      ctx.globalAlpha = 0.76
      for (const feature of features) {
        if (feature.score <= 0) continue
        const x1 = Math.max(PLOT_LEFT, PLOT_LEFT + (feature.start - this.region.start) * scaleX)
        const x2 = Math.min(width, PLOT_LEFT + (feature.end - this.region.start) * scaleX)
        const barHeight = (feature.score / side.max) * (height - 11)
        ctx.fillRect(x1, top + height - barHeight, Math.max(1, x2 - x1), barHeight)
        if ((feature.alleleFrequency ?? 0) >= minimumAlleleFrequency && (feature.alleleFrequency ?? 0) > 0) {
          ctx.fillStyle = '#ef8f2f'
          ctx.globalAlpha = 0.88
          ctx.fillRect(x1, top + height - barHeight, Math.max(1, x2 - x1), Math.max(2, barHeight * (feature.alleleFrequency ?? 0)))
          ctx.fillStyle = color
          ctx.globalAlpha = 0.76
        }
      }
      ctx.restore()
      ctx.fillStyle = palette.axisInk
      ctx.globalAlpha = 1
      ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
      if (side.x2 - side.x1 >= 40) ctx.fillText(`${side.label}${formatScore(side.max)}`, side.x1 + 4, top + 9)
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.axisLine
    ctx.beginPath(); ctx.moveTo(PLOT_LEFT, top + height + 0.5); ctx.lineTo(width, top + height + 0.5); ctx.stroke()
  }

  private drawBamReads(features: AlignmentFeature[], spec: TrackSpec, top: number, bottom: number, width: number, palette: CanvasPalette): void {
    const ctx = this.context
    const mode = spec.alignmentDisplayMode ?? 'expanded'
    const rowHeight = mode === 'squished' ? 5 : mode === 'collapsed' ? 8 : 13
    const readHeight = Math.max(3, rowHeight - 3)
    const scale = (width - PLOT_LEFT) / (this.region.end - this.region.start)
    const groups = alignmentRenderGroups(features, spec.bamViewAsPairs === true)
    const laneEnds: number[] = []
    this.bamReadHitboxes = this.bamReadHitboxes.filter((box) => box.trackId !== spec.id)
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
          this.bamReadHitboxes.push({ trackId: spec.id, read, x1, x2, y1: centerY - readHeight / 2 - 2, y2: centerY + readHeight / 2 + 2 })
          drawDirectionalReadBlock(ctx, x1, x2, centerY, readHeight, read.strand)
          if (this.bamHover?.trackId === spec.id && this.bamHover.read === read) {
            ctx.save(); ctx.strokeStyle = palette.ink; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.9
            ctx.strokeRect(x1 - 1, centerY - readHeight / 2 - 1, Math.max(2, x2 - x1 + 2), readHeight + 2); ctx.restore()
          }
        }
        ctx.globalAlpha = 1
        if (spec.bamShowMismatches !== false) for (const difference of read.differences) {
          if (difference.kind === 'substitution' && (difference.quality ?? 0) < (spec.bamMinMismatchBaseq ?? 0)) continue
          if (difference.kind === 'insertion' && spec.bamShowInsertions === false) continue
          if ((difference.kind === 'deletion' || difference.kind === 'skip') && spec.bamShowDeletions === false) continue
          if (difference.kind === 'soft-clip' && spec.bamShowSoftClips === false) continue
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
      const { gene, transcripts, firstSlot } = block
      if (block.labelX !== undefined) {
        const labelY = mode === 'collapsed'
          ? contentTop + 9
          : contentTop + firstSlot * layout.slotHeight + layout.slotHeight - 1
        ctx.fillStyle = palette.ink
        ctx.textAlign = 'center'
        ctx.fillText(gene.name, block.labelX, labelY)
        ctx.textAlign = 'start'
      }

      transcripts.forEach((transcript, transcriptIndex) => {
        const centerY = mode === 'collapsed'
          ? contentTop + 22
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
        if ((spec.geneShowTssIndicators ?? this.showTssIndicators) && mode === 'collapsed' && transcriptIndex === 0 && txX2 - txX1 >= 25) {
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
    const transcriptCount = genes.reduce((sum, gene) => sum + (spec.geneTranscriptMode === 'all' ? gene.transcriptModels.length : (preferredTranscript(gene) ? 1 : 0)), 0)
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
      const visibleCandidates = selectNonOverlappingCollapsedGenes(candidates)
      const placements = placeCollapsedGeneLabels(visibleCandidates.map((candidate) => ({
        preferredX: (candidate.geneX1 + candidate.geneX2) / 2,
        width: candidate.labelWidth,
      })), PLOT_LEFT, width)
      ctx.restore()
      return {
        blocks: visibleCandidates.map((candidate, index) => ({
          gene: candidate.gene,
          transcripts: [candidate.transcript],
          firstSlot: 0,
          geneX1: candidate.geneX1,
          geneX2: candidate.geneX2,
          labelX: placements[index]?.x,
          labelLane: placements[index]?.lane,
        })),
        slotHeight,
        contentHeight: 38,
        transcriptCount,
      }
    }
    if (transcriptCount > 2_000) {
      ctx.restore()
      return { blocks: genes.map((gene) => ({ gene, transcripts: [], firstSlot: 0, geneX1: PLOT_LEFT, geneX2: width })), slotHeight, contentHeight: slotHeight + GENE_CONTENT_PADDING * 2, transcriptCount }
    }
    for (const gene of genes) {
      const preferred = preferredTranscript(gene)
      const transcripts = spec.geneTranscriptMode === 'all' ? gene.transcriptModels : preferred ? [preferred] : []
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
    return track.loadedBasesPerPixel <= requestedBasesPerPixel * 1.25
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
    const overscanFactor = spec?.kind === 'matrix' ? MATRIX_OVERSCAN_FACTOR : spec?.kind === 'alignment' ? 0 : OVERSCAN_FACTOR
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
    track.queryStartedAt = performance.now()
    track.lastQueryRegion = { ...queryRegion }
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
        bamGroupTag: spec.bamGroupMode === 'tag' ? spec.bamGroupTag : undefined,
      } : spec?.kind === 'matrix' ? {
        matrixResolution: spec.matrixResolution,
        matrixNormalization: spec.matrixNormalization,
        matrixValueMode: spec.matrixValueMode,
        matrixComparisonMode: spec.matrixComparisonMode,
        matrixSecondaryRegion: spec.matrixSecondaryRegion,
        matrixPixelHeight: this.trackHeight(spec),
        matrixMaxDistance: spec.matrixSecondaryRegion ? undefined : matrixQueryMaximumDistance(span, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance),
      } : undefined
      const queryPixelWidth = plotWidth * (1 + overscanFactor * 2)
      const features = await source.getFeatures(queryRegion, queryPixelWidth, controller.signal, options)
      if (version !== track.requestVersion) return
      track.lastQueryMs = performance.now() - (track.queryStartedAt ?? performance.now())
      track.queryStartedAt = undefined
      track.features = features
      track.loadedRegion = queryRegion
      track.loadedBasesPerPixel = (queryRegion.end - queryRegion.start) / Math.max(1, queryPixelWidth)
      track.status = 'ready'
    } catch (error) {
      if (version !== track.requestVersion || isAbortError(error)) return
      track.lastQueryMs = performance.now() - (track.queryStartedAt ?? performance.now())
      track.queryStartedAt = undefined
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
    const overlayInteractionIds = new Set(this.document.tracks
      .filter((track) => track.kind === 'matrix' && track.enabled && track.matrixOverlayInteractionTrackId)
      .map((track) => track.matrixOverlayInteractionTrackId!))
    return this.document.tracks.filter((track) => track.kind !== 'genes' && (track.enabled || overlayInteractionIds.has(track.id)))
  }

  private visibleSpecs(pane: 'main' | 'bottom'): TrackSpec[] {
    const representedGroups = new Set<string>()
    return this.document.tracks.filter((track) => {
      if (!track.enabled || track.pane !== pane) return false
      const group = track.displayGroupId ? this.document.groups.find((item) => item.id === track.displayGroupId && item.signalStackMode === 'collapsed') : undefined
      if (!group) return true
      if ((group.signalStackHiddenTrackIds ?? []).includes(track.id)) return false
      if (representedGroups.has(group.id)) return false
      representedGroups.add(group.id)
      return true
    })
  }

  private signalStackForRepresentative(track: TrackSpec): { group: DisplayGroup; members: TrackSpec[] } | undefined {
    const group = track.displayGroupId ? this.document.groups.find((item) => item.id === track.displayGroupId && item.signalStackMode === 'collapsed') : undefined
    if (!group) return undefined
    const members = this.document.tracks.filter((item) => item.displayGroupId === group.id && item.kind === 'signal' && !item.signalStrand)
    return members.length >= 2 ? { group, members } : undefined
  }

  private trackHeight(track: TrackSpec): number {
    const preview = this.resizePreviewPixels.get(track.id)
    if (preview !== undefined) return preview
    if (track.kind !== 'genes' || track.pane !== 'bottom') return trackSpecHeight(track)
    const width = this.bottomCanvas.parentElement?.clientWidth || this.cssWidth(this.bottomCanvas)
    const layoutHeight = this.geneSource ? this.buildGeneLayout(track, width, this.bottomContext).contentHeight : 0
    return Math.max(MIN_BOTTOM_GENE_HEIGHT, Math.ceil(layoutHeight))
  }

  private resizeBoundaryAt(pane: 'main' | 'bottom', pointerY: number): { trackIds: string[]; y: number } | undefined {
    const candidates = bottomTrackResizeBoundaries(this.visibleSpecs(pane).map((track) => ({
      id: track.id,
      height: this.trackHeight(track),
      resizable: !(track.kind === 'genes' && track.pane === 'bottom'),
    })))
    return candidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.y - pointerY) }))
      .filter(({ distance }) => distance <= 5)
      .sort((a, b) => a.distance - b.distance)[0]?.candidate
  }

  private itemAt(_canvas: HTMLCanvasElement, pane: 'main' | 'bottom', x: number, y: number): { kind: 'track' | 'group'; id: string } | undefined {
    let top = 0
    for (const track of this.visibleSpecs(pane)) {
      const bottom = top + this.trackHeight(track)
      const stacked = Boolean(this.signalStackForRepresentative(track))
      if (y >= top && y < bottom) return (stacked || x < GROUP_RAIL_WIDTH) && track.displayGroupId
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
        if (entry.pane !== groupPane) {
          const viewport = entry.canvas.parentElement?.getBoundingClientRect()
          if (!viewport || clientX < viewport.left || clientX > viewport.right || clientY < viewport.top || clientY > viewport.bottom) continue
          const localY = clientY - entry.canvas.getBoundingClientRect().top
          const specs = this.visibleSpecs(entry.pane).filter((track) => !movingIds.has(track.id))
          let y = 0
          let index = 0
          for (const block of trackBlocks(specs)) {
            const height = block.reduce((sum, track) => sum + this.trackHeight(track), 0)
            if (localY < y + height / 2) return { pane: entry.pane, insertionIndex: index }
            y += height
            index += block.length
          }
          return { pane: entry.pane, insertionIndex: specs.length }
        }
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
    return new Set(trackIds)
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

export function filterInteractionFeatures(
  features: readonly InteractionFeature[],
  minimumScore?: number,
  maximumCisDistance?: number,
): InteractionFeature[] {
  return features.filter((feature) => {
    if (minimumScore !== undefined && (feature.score ?? Number.NEGATIVE_INFINITY) < minimumScore) return false
    if (maximumCisDistance === undefined || feature.chrom1 !== feature.chrom2) return true
    return Math.abs(interactionAnchorCenter(feature.start2, feature.end2) - interactionAnchorCenter(feature.start1, feature.end1)) <= maximumCisDistance
  })
}

export function interactionTouchesRegion(feature: InteractionFeature, region: Region): boolean {
  return (feature.chrom1 === region.chr && feature.end1 > region.start && feature.start1 < region.end)
    || (feature.chrom2 === region.chr && feature.end2 > region.start && feature.start2 < region.end)
}

export function matrixOverlayAnchorPair(
  feature: InteractionFeature,
  horizontal: Region,
  vertical?: Region,
): { horizontal: number; vertical: number } | undefined {
  const firstCenter = interactionAnchorCenter(feature.start1, feature.end1)
  const secondCenter = interactionAnchorCenter(feature.start2, feature.end2)
  if (!vertical) {
    if (feature.chrom1 !== horizontal.chr || feature.chrom2 !== horizontal.chr
      || !intervalOverlapsRegion(feature.start1, feature.end1, horizontal)
      || !intervalOverlapsRegion(feature.start2, feature.end2, horizontal)) return undefined
    return firstCenter <= secondCenter
      ? { horizontal: firstCenter, vertical: secondCenter }
      : { horizontal: secondCenter, vertical: firstCenter }
  }
  if (feature.chrom1 === horizontal.chr && feature.chrom2 === vertical.chr
    && intervalOverlapsRegion(feature.start1, feature.end1, horizontal)
    && intervalOverlapsRegion(feature.start2, feature.end2, vertical)) return { horizontal: firstCenter, vertical: secondCenter }
  if (feature.chrom2 === horizontal.chr && feature.chrom1 === vertical.chr
    && intervalOverlapsRegion(feature.start2, feature.end2, horizontal)
    && intervalOverlapsRegion(feature.start1, feature.end1, vertical)) return { horizontal: secondCenter, vertical: firstCenter }
  return undefined
}

function interactionAnchorCenter(start: number, end: number): number {
  return (start + end) / 2
}

function intervalOverlapsRegion(start: number, end: number, region: Region): boolean {
  return end > region.start && start < region.end
}

function matrixBinCenter(coordinate: number, resolution: number): number {
  return Math.floor(coordinate / resolution) * resolution + resolution / 2
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

export function signalChartBounds(top: number, bottom: number, flushBottom = false): { top: number; bottom: number } {
  const inset = Math.min(7, Math.max(2, (bottom - top) * 0.08))
  return { top: top + inset, bottom: flushBottom ? bottom - 0.5 : bottom - inset }
}

export function bottomTrackResizeBoundaries(
  tracks: readonly { id: string; height: number; resizable: boolean }[],
): Array<{ trackIds: string[]; y: number }> {
  let bottom = 0
  return tracks.flatMap((track) => {
    bottom += track.height
    return track.resizable ? [{ trackIds: [track.id], y: bottom }] : []
  })
}

export function selectNonOverlappingCollapsedGenes<T extends { geneX1: number; geneX2: number }>(
  candidates: readonly T[],
  gap = 2,
): T[] {
  const selected: T[] = []
  let occupiedThrough = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    if (candidate.geneX1 <= occupiedThrough + gap) continue
    selected.push(candidate)
    occupiedThrough = candidate.geneX2
  }
  return selected
}

export function placeCollapsedGeneLabels(
  labels: readonly { preferredX: number; width: number }[],
  left: number,
  right: number,
  gap = 6,
): Array<{ x: number; lane: number } | undefined> {
  let laneEnd = left - gap
  return labels.map((label) => {
    const halfWidth = Math.max(0, label.width) / 2
    const minimumCenter = left + halfWidth
    const maximumCenter = right - halfWidth
    if (minimumCenter > maximumCenter) return undefined
    const preferred = Math.max(minimumCenter, Math.min(maximumCenter, label.preferredX))
    const x = Math.max(preferred, laneEnd + gap + halfWidth)
    const shift = Math.abs(x - preferred)
    const maxShift = Math.max(18, label.width * 0.75)
    if (x > maximumCenter || shift > maxShift) return undefined
    laneEnd = x + halfWidth
    return { x, lane: 0 }
  })
}

export const MATRIX_WARM_COLORS = ['#fffdf2', '#fff7bc', '#fdae61', '#d7191c', '#700d1a'] as const
export const MATRIX_BLUE_BLACK_COLORS = ['#daf0ff', '#4d97cf', '#14437a', '#040609'] as const
const MATRIX_SIGNED_COLOR_LOOKUP = Array.from({ length: 257 }, (_, index) => matrixGradientColor(['#2166ac', '#f7f7f7', '#b2182b'], index / 256))
const matrixAutomaticMaximumCache = new WeakMap<MatrixFeature, Map<string, number>>()
const matrixAutomaticMagnitudeCache = new WeakMap<MatrixFeature, Map<string, number>>()
const matrixCellLookupCache = new WeakMap<MatrixFeature, Map<string, number>>()
const matrixMissingLookupCache = new WeakMap<MatrixFeature, Set<string>>()
const matrixMaskedLookupCache = new WeakMap<MatrixFeature, Set<number>>()

function matrixCellKey(bin1: number, bin2: number): string {
  return `${bin1}:${bin2}`
}

function matrixCellLookup(matrix: MatrixFeature): Map<string, number> {
  let lookup = matrixCellLookupCache.get(matrix)
  if (!lookup) {
    lookup = new Map(matrix.cells.map((cell) => [matrixCellKey(cell.bin1, cell.bin2), cell.value]))
    matrixCellLookupCache.set(matrix, lookup)
  }
  return lookup
}

function matrixMissingLookup(matrix: MatrixFeature): Set<string> {
  let lookup = matrixMissingLookupCache.get(matrix)
  if (!lookup) {
    lookup = new Set((matrix.missingCells ?? []).map((cell) => matrixCellKey(cell.bin1, cell.bin2)))
    matrixMissingLookupCache.set(matrix, lookup)
  }
  return lookup
}

function matrixMaskedLookup(matrix: MatrixFeature): Set<number> {
  let lookup = matrixMaskedLookupCache.get(matrix)
  if (!lookup) {
    lookup = new Set(matrix.maskedBins ?? [])
    matrixMaskedLookupCache.set(matrix, lookup)
  }
  return lookup
}

export function inspectMatrixCell(matrix: MatrixFeature, bin1: number, bin2: number): MatrixCellInspection {
  const orderedBin1 = matrix.axis2 ? bin1 : Math.min(bin1, bin2)
  const orderedBin2 = matrix.axis2 ? bin2 : Math.max(bin1, bin2)
  const masked = matrixMaskedLookup(matrix)
  if (masked.has(orderedBin1) || (matrix.axis2 ? (matrix.maskedBins2 ?? []).includes(orderedBin2) : masked.has(orderedBin2))) {
    return { bin1: orderedBin1, bin2: orderedBin2, separation: orderedBin2 - orderedBin1, state: 'masked' }
  }
  const key = matrixCellKey(orderedBin1, orderedBin2)
  if (matrixMissingLookup(matrix).has(key)) {
    return { bin1: orderedBin1, bin2: orderedBin2, separation: orderedBin2 - orderedBin1, state: 'missing' }
  }
  const value = matrixCellLookup(matrix).get(key)
  return value === undefined
    ? { bin1: orderedBin1, bin2: orderedBin2, separation: orderedBin2 - orderedBin1, state: 'zero' }
    : { bin1: orderedBin1, bin2: orderedBin2, separation: orderedBin2 - orderedBin1, state: 'value', value }
}

export function inspectRectangularMatrixPoint(matrix: MatrixFeature, region: Region, x: number, y: number,
  left: number, right: number, top: number, bottom: number): MatrixCellInspection | undefined {
  if (!matrix.axis2 || x < left || x >= right || y < top || y >= bottom) return undefined
  const bin1 = Math.floor((region.start + (x - left) * (region.end - region.start) / (right - left)) / matrix.resolution) * matrix.resolution
  const bin2 = Math.floor((matrix.axis2.start + (y - top) * (matrix.axis2.end - matrix.axis2.start) / (bottom - top)) / matrix.resolution) * matrix.resolution
  return inspectMatrixCell(matrix, bin1, bin2)
}

export function inspectMatrixPoint(
  matrix: MatrixFeature,
  region: Region,
  x: number,
  y: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  direction: 'up' | 'down',
  maximumDistance: number,
): MatrixCellInspection | undefined {
  if (x < left || x > right || y < top || y > bottom) return undefined
  const scale = (right - left) / Math.max(1, region.end - region.start)
  const baseline = matrixVerticalGeometry(top, bottom, direction).baseline
  const directionSign = direction === 'down' ? 1 : -1
  const separation = directionSign * (y - baseline) * 2 / scale
  if (separation < 0 || separation > maximumDistance + matrix.resolution) return undefined
  const center = region.start + (x - left) / scale
  const first = center - separation / 2
  const second = center + separation / 2
  const bin1 = Math.floor(first / matrix.resolution) * matrix.resolution
  const bin2 = Math.floor(second / matrix.resolution) * matrix.resolution
  if (bin1 + matrix.resolution <= matrix.start || bin2 >= matrix.end) return undefined
  return inspectMatrixCell(matrix, bin1, bin2)
}

/** Visible-cell z-max used by automatic matrix scaling. */
export function matrixAutomaticMaximum(matrix: MatrixFeature | undefined, percentile = 0.99, ignoredDiagonals = 3): number {
  if (!matrix?.cells.length) return 1
  const diagonalCount = matrix.axis2 ? 0 : Math.max(0, Math.round(ignoredDiagonals))
  const quantile = Math.max(0.5, Math.min(1, percentile))
  const cacheKey = `${quantile}:${diagonalCount}`
  const cached = matrixAutomaticMaximumCache.get(matrix)?.get(cacheKey)
  if (cached !== undefined) return cached
  const minimumSeparation = diagonalCount * matrix.resolution
  const values = matrix.cells
    .filter((cell) => Math.abs(cell.bin2 - cell.bin1) >= minimumSeparation)
    .map((cell) => cell.value)
    .filter((value) => Number.isFinite(value) && value > 0)
  if (quantile < 1) values.sort((a, b) => a - b)
  const maximum = quantile === 1
    ? values.reduce((largest, value) => Math.max(largest, value), 0) || 1
    : values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))] ?? 1
  const cache = matrixAutomaticMaximumCache.get(matrix) ?? new Map<string, number>()
  cache.set(cacheKey, maximum)
  matrixAutomaticMaximumCache.set(matrix, cache)
  return maximum
}

/** Symmetric magnitude for signed log2 observed/expected values. */
export function matrixAutomaticMagnitude(matrix: MatrixFeature | undefined, percentile = 0.99, ignoredDiagonals = 3): number {
  if (!matrix?.cells.length) return 1
  const quantile = Math.max(0.5, Math.min(1, percentile))
  const diagonalCount = Math.max(0, Math.round(ignoredDiagonals))
  const cacheKey = `${quantile}:${diagonalCount}`
  const cached = matrixAutomaticMagnitudeCache.get(matrix)?.get(cacheKey)
  if (cached !== undefined) return cached
  const separation = diagonalCount * matrix.resolution
  const values = matrix.cells.filter((cell) => cell.bin2 - cell.bin1 >= separation && Number.isFinite(cell.value))
    .map((cell) => Math.abs(cell.value)).sort((a, b) => a - b)
  if (!values.length) return 1
  const maximum = Math.max(1e-9, values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))])
  const cache = matrixAutomaticMagnitudeCache.get(matrix) ?? new Map<string, number>()
  cache.set(cacheKey, maximum)
  matrixAutomaticMagnitudeCache.set(matrix, cache)
  return maximum
}

export function matrixSignedColor(value: number): string {
  return MATRIX_SIGNED_COLOR_LOOKUP[Math.round((Math.max(-1, Math.min(1, value)) + 1) * 128)]
}

/** Query depth is based on the visible genomic span, never on presentation height. */
export function matrixQueryMaximumDistance(visibleSpan: number, mode: 'auto' | 'full' | 'fixed', fixedDistance?: number): number {
  const span = Math.max(1, Math.ceil(visibleSpan))
  if (mode === 'full') return span
  if (mode === 'fixed' && Number.isFinite(fixedDistance) && fixedDistance! > 0) return Math.max(1, Math.round(fixedDistance!))
  return Math.max(1, Math.ceil(span * 0.2))
}

export function matrixVerticalGeometry(top: number, bottom: number, direction: 'up' | 'down'): { baseline: number; clipTop: number; clipBottom: number } {
  return {
    baseline: direction === 'down' ? top + 0.5 : bottom - 0.5,
    clipTop: top + 0.5,
    clipBottom: bottom - 0.5,
  }
}

export function resolveMatrixMaximums(
  specs: readonly TrackSpec[],
  groups: readonly DisplayGroup[],
  individual: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const resolved = new Map(individual)
  for (const group of groups) {
    if (group.scaleBehavior !== 'linked') continue
    for (const mode of ['observed', 'observed-expected', 'log2-observed-expected']) {
      const memberIds = specs.filter((spec) => spec.kind === 'matrix' && !spec.matrixComparisonMode && spec.displayGroupId === group.id && (spec.matrixValueMode ?? 'observed') === mode).map((spec) => spec.id)
      if (memberIds.length < 2) continue
      const shared = Math.max(...memberIds.map((id) => resolved.get(id) ?? 1))
      for (const id of memberIds) resolved.set(id, shared)
    }
  }
  return resolved
}

/** Interpolates evenly spaced low-to-high palette colors. */
export function matrixGradientColor(colors: readonly string[], intensity: number): string {
  const valid = colors.filter((color) => /^#[0-9a-f]{6}$/i.test(color))
  if (!valid.length) return '#000000'
  if (valid.length === 1) return valid[0].toLocaleLowerCase()
  const value = Math.max(0, Math.min(1, intensity))
  const stops = valid.map((color, index) => ({
    at: index / (valid.length - 1),
    color,
  }))
  const upperIndex = Math.max(1, stops.findIndex((stop) => value <= stop.at))
  const lower = stops[upperIndex - 1]
  const upper = stops[upperIndex]
  const mix = (value - lower.at) / Math.max(Number.EPSILON, upper.at - lower.at)
  const lowerChannels = hexChannels(lower.color)
  const upperChannels = hexChannels(upper.color)
  const channels = lowerChannels.map((channel, index) => Math.round(channel + (upperChannels[index] - channel) * mix))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** Low-to-high publication palette adapted from the earlier figure workflow. */
export function matrixWarmPaletteColor(intensity: number): string {
  return matrixGradientColor(MATRIX_WARM_COLORS, intensity)
}

/** Dark-mode contact palette: low scores are light blue and high scores approach black. */
export function matrixBlueBlackPaletteColor(intensity: number): string {
  return matrixGradientColor(MATRIX_BLUE_BLACK_COLORS, intensity)
}

/** Legend values at the high, visual midpoint, and low ends of a matrix scale. */
export function matrixLegendValues(minimum: number, maximum: number, transform: 'linear' | 'log1p'): [number, number, number] {
  const min = Math.max(0, minimum)
  const max = Math.max(min + Math.max(1e-9, Math.abs(min) * 1e-9), maximum)
  const midpoint = transform === 'linear'
    ? min + (max - min) / 2
    : Math.expm1((Math.log1p(min) + Math.log1p(max)) / 2)
  return [max, midpoint, min]
}

export function matrixValueIntensity(value: number, minimum: number, maximum: number, transform: 'linear' | 'log1p'): number {
  if (!Number.isFinite(value)) return Number.NaN
  const min = Math.max(0, minimum)
  const max = Math.max(min + Math.max(1e-9, Math.abs(min) * 1e-9), maximum)
  const transformedMinimum = transform === 'linear' ? min : Math.log1p(min)
  const transformedMaximum = transform === 'linear' ? max : Math.log1p(max)
  const transformedValue = transform === 'linear' ? value : Math.log1p(Math.max(0, value))
  return Math.max(0, Math.min(1, (transformedValue - transformedMinimum) / Math.max(Number.EPSILON, transformedMaximum - transformedMinimum)))
}

export function matrixPaletteIntensity(scoreIntensity: number, reversed: boolean): number {
  const value = Math.max(0, Math.min(1, scoreIntensity))
  return reversed ? 1 - value : value
}

function matrixPaletteStyle(spec: TrackSpec, intensity: number): { color: string; alpha: number } {
  const value = Math.max(0, Math.min(1, intensity))
  if (spec.matrixPalette === 'warm') return { color: matrixWarmPaletteColor(value), alpha: 1 }
  if (spec.matrixPalette === 'blue-black') return { color: matrixBlueBlackPaletteColor(value), alpha: 1 }
  if (spec.matrixPalette === 'custom' && (spec.matrixPaletteColors?.length ?? 0) >= 2) {
    return { color: matrixGradientColor(spec.matrixPaletteColors!, value), alpha: 1 }
  }
  return { color: spec.color, alpha: 0.08 + Math.pow(value, 0.72) * 0.92 }
}

function hexChannels(color: string): [number, number, number] {
  return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)]
}

export function matrixRegionHighlightPolygon(left: number, right: number, baseline: number, direction: number, maximumDepth: number): Array<{ x: number; y: number }> {
  const depth = Math.max(0, Math.min((right - left) / 2, maximumDepth))
  return [
    { x: left, y: baseline },
    { x: right, y: baseline },
    { x: right - depth, y: baseline + direction * depth },
    { x: left + depth, y: baseline + direction * depth },
  ]
}

export function matrixRegionBoundarySegments(left: number, right: number, baseline: number, direction: number, maximumDepth: number): Array<{
  edge: 'start' | 'end'
  start: { x: number; y: number }
  end: { x: number; y: number }
}> {
  const points = matrixRegionHighlightPolygon(left, right, baseline, direction, maximumDepth)
  return [
    { edge: 'start', start: points[0]!, end: points[3]! },
    { edge: 'end', start: points[1]!, end: points[2]! },
  ]
}

export function pointToLineSegmentDistance(point: { x: number; y: number }, start: { x: number; y: number }, end: { x: number; y: number }): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy))
}

export function pointInConvexPolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]): boolean {
  let direction = 0
  for (let index = 0; index < polygon.length; index++) {
    const first = polygon[index]!
    const second = polygon[(index + 1) % polygon.length]!
    const cross = (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x)
    if (Math.abs(cross) < 1e-7) continue
    const nextDirection = Math.sign(cross)
    if (direction && nextDirection !== direction) return false
    direction = nextDirection
  }
  return true
}

export function snapRegionToMatrixBins(region: Region, resolution: number | undefined, chromosomeLength: number): Region {
  let start = region.start
  let end = region.end
  if (resolution && Number.isFinite(resolution) && resolution > 0) {
    start = Math.round(start / resolution) * resolution
    end = Math.round(end / resolution) * resolution
    if (end <= start) end = start + resolution
  }
  const boundedStart = Math.max(0, Math.min(Math.floor(start), chromosomeLength - 1))
  return { chr: region.chr, start: boundedStart, end: Math.max(boundedStart + 1, Math.min(Math.ceil(end), chromosomeLength)) }
}

export function resizeRegionBoundary(region: Region, edge: 'start' | 'end', coordinate: number, resolution: number | undefined, chromosomeLength: number): Region {
  const snapped = resolution && Number.isFinite(resolution) && resolution > 0
    ? Math.round(coordinate / resolution) * resolution
    : Math.round(coordinate)
  if (edge === 'start') return { ...region, start: Math.max(0, Math.min(snapped, region.end - 1)) }
  return { ...region, end: Math.max(region.start + 1, Math.min(snapped, chromosomeLength)) }
}

export function matrixOutlineTargetsTrack(outline: Pick<MatrixOutline, 'visible' | 'targetTrackIds' | 'axis1' | 'axis2'>, trackId: string, horizontalChr: string, verticalChr: string): boolean {
  return outline.visible && outline.targetTrackIds.includes(trackId)
    && outline.axis1.chr === horizontalChr && outline.axis2.chr === verticalChr
}

export function matrixOutlinePolygon(axis1: Region, axis2: Region, viewport: Region, scale: number, baseline: number, direction: number): Array<{ x: number; y: number }> {
  const point = (first: number, second: number) => ({
    x: PLOT_LEFT + (((first + second) / 2) - viewport.start) * scale,
    y: baseline + direction * ((second - first) / 2) * scale,
  })
  return [
    point(axis1.start, axis2.start),
    point(axis1.end, axis2.start),
    point(axis1.end, axis2.end),
    point(axis1.start, axis2.end),
  ]
}

export function matrixDepthClipBounds(left: number, right: number, baseline: number, direction: number, depthPixels: number): {
  left: number; right: number; top: number; bottom: number
} {
  const depthEdge = baseline + direction * Math.max(0, depthPixels)
  return {
    left: Math.min(left, right), right: Math.max(left, right),
    top: Math.min(baseline, depthEdge), bottom: Math.max(baseline, depthEdge),
  }
}

export function rectangularMatrixOutlinePolygon(axis1: Region, axis2: Region, horizontalViewport: Region, verticalViewport: Region,
  scaleX: number, scaleY: number, top: number): Array<{ x: number; y: number }> {
  const left = PLOT_LEFT + (axis1.start - horizontalViewport.start) * scaleX
  const right = PLOT_LEFT + (axis1.end - horizontalViewport.start) * scaleX
  const y1 = top + (axis2.start - verticalViewport.start) * scaleY
  const y2 = top + (axis2.end - verticalViewport.start) * scaleY
  return [{ x: left, y: y1 }, { x: right, y: y1 }, { x: right, y: y2 }, { x: left, y: y2 }]
}

export function resizeMatrixOutlineCorner(axis1: Region, axis2: Region, corner: MatrixOutlineCorner, bin1: number, bin2: number, resolution: number): { axis1: Region; axis2: Region } {
  const size = Math.max(1, Math.round(resolution))
  const nextAxis1 = { ...axis1 }
  const nextAxis2 = { ...axis2 }
  if (corner === 0 || corner === 3) nextAxis1.start = Math.max(0, Math.min(bin1, nextAxis1.end - size))
  else nextAxis1.end = Math.max(nextAxis1.start + size, bin1 + size)
  if (corner === 0 || corner === 1) nextAxis2.start = Math.max(0, Math.min(bin2, nextAxis2.end - size))
  else nextAxis2.end = Math.max(nextAxis2.start + size, bin2 + size)
  return { axis1: nextAxis1, axis2: nextAxis2 }
}

export function verticalRegionBoundaryLines(x1: number, x2: number, ranges: readonly { top: number; bottom: number }[]): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  return ranges.flatMap((range) => range.bottom > range.top ? [
    { x1: x1 + 0.5, y1: range.top, x2: x1 + 0.5, y2: range.bottom },
    { x1: x2 - 0.5, y1: range.top, x2: x2 - 0.5, y2: range.bottom },
  ] : [])
}

function matrixDomainPath(ctx: CanvasRenderingContext2D, left: number, right: number, baseline: number, direction: number, depthPixels: number): void {
  const points = matrixRegionHighlightPolygon(left, right, baseline, direction, depthPixels)
  ctx.beginPath()
  ctx.moveTo(points[0]!.x, points[0]!.y)
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
  ctx.closePath()
}

function strokeClosedPolygon(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[], color: string): void {
  if (!points.length) return
  const path = () => {
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.closePath()
  }
  ctx.globalAlpha = 0.82; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; path(); ctx.stroke()
  ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 2; path(); ctx.stroke()
  ctx.lineWidth = 1
}

function drawMatrixDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, halfCell: number): void {
  ctx.beginPath()
  ctx.moveTo(x - halfCell, y)
  ctx.lineTo(x, y + halfCell)
  ctx.lineTo(x + halfCell, y)
  ctx.lineTo(x, y - halfCell)
  ctx.closePath()
}

function drawMissingMatrixCells(
  ctx: CanvasRenderingContext2D,
  cells: readonly MatrixCellPosition[],
  resolution: number,
  region: Region,
  scale: number,
  baseline: number,
  direction: number,
  halfCell: number,
  color: string,
): void {
  if (!cells.length) return
  ctx.fillStyle = color
  ctx.globalAlpha = 1
  for (const cell of cells) {
    const firstCenter = cell.bin1 + resolution / 2
    const secondCenter = cell.bin2 + resolution / 2
    const x = PLOT_LEFT + (((firstCenter + secondCenter) / 2) - region.start) * scale
    const y = baseline + direction * ((secondCenter - firstCenter) / 2) * scale
    drawMatrixDiamond(ctx, x, y, halfCell)
    ctx.fill()
  }
}

function drawMaskedMatrixBins(
  ctx: CanvasRenderingContext2D,
  bins: readonly number[],
  resolution: number,
  region: Region,
  scale: number,
  left: number,
  right: number,
  baseline: number,
  direction: number,
  depthPixels: number,
  spec: TrackSpec,
  trackBackground: string,
  palette: CanvasPalette,
): void {
  if (!bins.length) return
  ctx.save()
  matrixDomainPath(ctx, left, right, baseline, direction, depthPixels)
  ctx.clip()
  const bandWidth = Math.max(1.25, resolution * scale / Math.SQRT2)
  const drawAllRays = () => {
    ctx.beginPath()
    for (const bin of bins) {
      const x = PLOT_LEFT + (bin + resolution / 2 - region.start) * scale
      if (x + depthPixels < left || x - depthPixels > right) continue
      ctx.moveTo(x, baseline)
      ctx.lineTo(left, baseline + direction * (x - left))
      ctx.moveTo(x, baseline)
      ctx.lineTo(right, baseline + direction * (right - x))
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.lineWidth = bandWidth
  ctx.strokeStyle = spec.matrixMaskedStyle === 'custom' ? spec.matrixMaskedColor ?? '#777d89' : trackBackground
  drawAllRays()
  if (spec.matrixMaskedStyle === 'hatch' || spec.matrixMaskedStyle === undefined) {
    ctx.setLineDash([3, 3])
    ctx.lineWidth = Math.max(1, Math.min(2, bandWidth * 0.24))
    ctx.strokeStyle = palette.muted
    ctx.globalAlpha = 0.8
    drawAllRays()
    ctx.globalAlpha = 1
  }
  ctx.setLineDash([])
  ctx.restore()
}

function drawMatrixCrosshair(
  ctx: CanvasRenderingContext2D,
  hover: MatrixHover,
  resolution: number,
  left: number,
  right: number,
  clipTop: number,
  clipBottom: number,
  halfCell: number,
  direction: number,
  palette: CanvasPalette,
): void {
  const extent = right - left
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, clipTop, extent, Math.max(0, clipBottom - clipTop))
  ctx.clip()
  ctx.strokeStyle = palette.selection
  ctx.globalAlpha = 0.72
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.moveTo(hover.x - extent, hover.y - direction * extent)
  ctx.lineTo(hover.x + extent, hover.y + direction * extent)
  ctx.moveTo(hover.x - extent, hover.y + direction * extent)
  ctx.lineTo(hover.x + extent, hover.y - direction * extent)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  ctx.lineWidth = Math.max(1.5, Math.min(3, resolution > 0 ? halfCell * 0.2 : 1.5))
  drawMatrixDiamond(ctx, hover.x, hover.y, halfCell)
  ctx.stroke()
  ctx.restore()
}

function colorWithAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1]
  if (!hex) return color
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`
}

function drawMatrixLegend(
  ctx: CanvasRenderingContext2D,
  spec: TrackSpec,
  minimum: number,
  maximum: number,
  top: number,
  bottom: number,
  laneWidth: number,
  palette: CanvasPalette,
): void {
  if (!laneWidth || bottom - top < 44) return
  const legendTop = top + 14
  const legendBottom = bottom - 12
  const gradientX = LABEL_WIDTH - 8
  const gradientWidth = 7
  const gradient = ctx.createLinearGradient(0, legendTop, 0, legendBottom)
  for (let step = 20; step >= 0; step -= 1) {
    const scoreIntensity = step / 20
    const intensity = matrixPaletteIntensity(scoreIntensity, spec.matrixPaletteReversed === true)
    const signed = spec.matrixValueMode === 'log2-observed-expected' || spec.matrixComparisonMode === 'difference' || spec.matrixComparisonMode === 'log2-ratio'
    const style = signed
      ? { color: matrixSignedColor(scoreIntensity * 2 - 1), alpha: 1 }
      : matrixPaletteStyle(spec, intensity)
    gradient.addColorStop(1 - scoreIntensity, style.alpha === 1 ? style.color : colorWithAlpha(style.color, style.alpha))
  }
  ctx.strokeStyle = palette.axisLine
  ctx.lineWidth = 1
  ctx.fillStyle = gradient
  ctx.fillRect(gradientX, legendTop, gradientWidth, Math.max(1, legendBottom - legendTop))
  ctx.strokeRect(gradientX + 0.5, legendTop + 0.5, gradientWidth - 1, Math.max(1, legendBottom - legendTop - 1))

  const labels = (spec.matrixValueMode === 'log2-observed-expected' || spec.matrixComparisonMode === 'difference' || spec.matrixComparisonMode === 'log2-ratio' ? [maximum, 0, -maximum] : matrixLegendValues(minimum, maximum, spec.matrixTransform ?? 'log1p')).map(formatScore)
  ctx.fillStyle = palette.axisInk
  ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
  ctx.textAlign = 'right'
  ctx.fillText(labels[0], gradientX - 4, legendTop + 3)
  ctx.fillText(labels[1], gradientX - 4, (legendTop + legendBottom) / 2 + 3)
  ctx.fillText(labels[2], gradientX - 4, legendBottom + 3)
  ctx.textAlign = 'start'
}

function interactionEmphasis(score: number | undefined, minimum: number, maximum: number): number {
  if (!Number.isFinite(score) || maximum <= minimum) return 0.55
  return Math.max(0, Math.min(1, (score! - minimum) / (maximum - minimum)))
}

function scoreColor(score: number, minimum: number, maximum: number): string {
  const fraction = maximum > minimum ? Math.max(0, Math.min(1, (score - minimum) / (maximum - minimum))) : 0.65
  return `hsl(${250 - fraction * 210} 62% 48%)`
}

function interactionFeatureColor(feature: InteractionFeature, spec: TrackSpec, minimum: number, maximum: number): string {
  return spec.interactionColorMode === 'item-rgb' ? feature.itemRgb ?? spec.color
    : spec.interactionColorMode === 'score' && feature.score !== undefined ? scoreColor(feature.score, minimum, maximum)
      : spec.color
}

function strokeMatrixOverlay(ctx: CanvasRenderingContext2D, color: string, spec: TrackSpec, palette: CanvasPalette): void {
  const lineWidth = spec.interactionLineWidth ?? 1
  const alpha = (spec.interactionOpacity ?? 92) / 100
  ctx.globalAlpha = Math.min(1, alpha * 0.9)
  ctx.strokeStyle = palette.background
  ctx.lineWidth = lineWidth + 2
  ctx.stroke()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.lineWidth = 1
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
  style: 'fill' | 'line' | 'bar',
  opacity: number,
  transform: 'linear' | 'log1p' | 'symlog',
): void {
  const height = bottom - top
  ctx.fillStyle = color
  ctx.globalAlpha = opacity
  ctx.save()
  ctx.beginPath(); ctx.rect(left, top, bins.length, height); ctx.clip()
  for (let start = 0; start < bins.length;) {
    while (start < bins.length && !bins[start]) start += 1
    if (start >= bins.length) break
    let end = start
    while (end + 1 < bins.length && bins[end + 1]) end += 1
    const baseline = downward ? top : bottom
    const transformedMaximum = Math.max(1e-9, signalTransform(maximum, transform))
    if (style === 'bar') {
      for (let x = start; x <= end; x += 1) {
        const magnitude = signalTransform(Math.max(Math.abs(bins[x]!.min), Math.abs(bins[x]!.max)), transform)
        const y = downward ? top + (magnitude / transformedMaximum) * height : bottom - (magnitude / transformedMaximum) * height
        ctx.fillRect(left + x, Math.min(baseline, y), 1, Math.max(1, Math.abs(y - baseline)))
      }
      start = end + 1
      continue
    }
    ctx.beginPath()
    ctx.moveTo(left + start, baseline)
    for (let x = start; x <= end; x += 1) {
      const bin = bins[x]!
      const magnitude = signalTransform(Math.max(Math.abs(bin.min), Math.abs(bin.max)), transform)
      const y = downward ? top + (magnitude / transformedMaximum) * height : bottom - (magnitude / transformedMaximum) * height
      ctx.lineTo(left + x, y)
      ctx.lineTo(left + x + 1, y)
    }
    ctx.lineTo(left + end + 1, baseline)
    if (style === 'line') { ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.stroke() } else { ctx.closePath(); ctx.fill() }
    start = end + 1
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

function paintMagnitudeSide(
  ctx: CanvasRenderingContext2D,
  plusBins: readonly ({ min: number; max: number } | undefined)[],
  minusBins: readonly ({ min: number; max: number } | undefined)[],
  spec: TrackSpec,
  chartTop: number,
  zeroY: number,
  chartBottom: number,
  clipStart: number,
  clipEnd: number,
  maximums: { plus: number; minus: number },
  plusTransform: 'linear' | 'log1p' | 'symlog',
  minusTransform: 'linear' | 'log1p' | 'symlog',
): void {
  if (clipEnd <= clipStart) return
  ctx.save()
  ctx.beginPath(); ctx.rect(clipStart, chartTop, clipEnd - clipStart, chartBottom - chartTop); ctx.clip()
  drawMagnitudeBins(ctx, plusBins, PLOT_LEFT, chartTop, zeroY, Math.max(1e-9, maximums.plus), spec.color, false, spec.signalRenderStyle ?? 'fill', (spec.signalOpacity ?? 100) / 100, plusTransform)
  drawMagnitudeBins(ctx, minusBins, PLOT_LEFT, zeroY, chartBottom, Math.max(1e-9, maximums.minus), spec.negativeColor ?? spec.color, true, spec.signalRenderStyle ?? 'fill', (spec.signalOpacity ?? 100) / 100, minusTransform)
  ctx.restore()
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
  style: 'fill' | 'line' | 'bar',
  opacity: number,
  lineDash: readonly number[] = [],
): void {
  ctx.fillStyle = color
  ctx.globalAlpha = opacity
  ctx.save()
  ctx.beginPath(); ctx.rect(left, top, bins.length, bottom - top); ctx.clip()
  for (let start = 0; start < bins.length;) {
    while (start < bins.length && !bins[start]) start += 1
    if (start >= bins.length) break
    let end = start
    while (end + 1 < bins.length && bins[end + 1]) end += 1
    if (style === 'bar') {
      for (let x = start; x <= end; x += 1) {
        const bin = bins[x]!
        const upper = valueToY(Math.max(0, bin.max))
        const lower = valueToY(Math.min(0, bin.min))
        ctx.fillRect(left + x, Math.min(zeroY, upper), 1, Math.max(1, Math.abs(zeroY - upper)))
        if (lower !== zeroY) ctx.fillRect(left + x, Math.min(zeroY, lower), 1, Math.max(1, Math.abs(zeroY - lower)))
      }
      start = end + 1
      continue
    }
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
    if (style === 'line') {
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash([...lineDash])
      ctx.stroke()
      ctx.setLineDash([])
    } else { ctx.closePath(); ctx.fill() }
    start = end + 1
  }
  ctx.restore()
  ctx.globalAlpha = 1
}

export function signalTransform(value: number, transform: 'linear' | 'log1p' | 'symlog'): number {
  if (transform === 'linear') return value
  if (transform === 'log1p') return Math.log1p(Math.max(0, value))
  return Math.sign(value) * Math.log1p(Math.abs(value))
}

interface AlignmentRenderGroup {
  start: number
  end: number
  reads: AlignmentFeature[]
}

export function selectBamAlignments(features: readonly AlignmentFeature[], limit: number, sortMode: 'start' | 'strand' | 'mapq' | 'insert-size', groupMode: 'none' | 'strand' | 'read-group' | 'tag', groupTag?: string): AlignmentFeature[] {
  const compare = (a: AlignmentFeature, b: AlignmentFeature) => {
    const group = groupMode === 'strand' ? a.strand.localeCompare(b.strand) : groupMode === 'read-group' ? (a.readGroup ?? '').localeCompare(b.readGroup ?? '') : groupMode === 'tag' ? (a.tags?.[groupTag ?? ''] ?? '').localeCompare(b.tags?.[groupTag ?? ''] ?? '') : 0
    if (group) return group
    if (sortMode === 'strand') return a.strand.localeCompare(b.strand) || a.start - b.start
    if (sortMode === 'mapq') return b.mapq - a.mapq || a.start - b.start
    if (sortMode === 'insert-size') return Math.abs(b.templateLength) - Math.abs(a.templateLength) || a.start - b.start
    return a.start - b.start
  }
  return [...features].sort(compare).slice(0, limit)
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

export function matrixQueryChanged(previous: TrackSpec, next: TrackSpec): boolean {
  return previous.matrixResolution !== next.matrixResolution
    || previous.matrixNormalization !== next.matrixNormalization
    || previous.matrixValueMode !== next.matrixValueMode
    || previous.matrixComparisonMode !== next.matrixComparisonMode
    || previous.matrixDepthMode !== next.matrixDepthMode
    || previous.matrixMaxDistance !== next.matrixMaxDistance
    || previous.matrixSecondaryRegion?.chr !== next.matrixSecondaryRegion?.chr
    || previous.matrixSecondaryRegion?.start !== next.matrixSecondaryRegion?.start
    || previous.matrixSecondaryRegion?.end !== next.matrixSecondaryRegion?.end
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

function resolvedSignalDomain(bins: readonly (Bin | undefined)[], domain?: ScaleDomain): ScaleDomain {
  if (domain) return domain
  let min = 0
  let max = 0
  for (const bin of bins) {
    if (!bin) continue
    min = Math.min(min, bin.min)
    max = Math.max(max, bin.max)
  }
  if (min === max) max = min + 1
  return { min, max }
}

function signalDomainScaleValue(domain: ScaleDomain): number {
  return domain.max !== 0 ? domain.max : domain.min !== 0 ? Math.abs(domain.min) : 0
}

function paintSignalDomain(
  ctx: CanvasRenderingContext2D,
  bins: readonly (Bin | undefined)[],
  spec: TrackSpec,
  domain: ScaleDomain,
  transform: 'linear' | 'log1p' | 'symlog',
  chartTop: number,
  chartBottom: number,
  clipStart: number,
  clipEnd: number,
  palette: CanvasPalette,
  lineDash: readonly number[] = [],
): void {
  if (clipEnd <= clipStart) return
  const amplitude = Math.max(1e-9, domain.max - domain.min)
  const transformedMin = signalTransform(domain.min, transform)
  const transformedMax = signalTransform(domain.max, transform)
  const transformedAmplitude = Math.max(1e-9, transformedMax - transformedMin)
  const chartHeight = chartBottom - chartTop
  const rawZeroY = chartBottom - ((0 - domain.min) / amplitude) * chartHeight
  const zeroY = spec.signalStrand === 'minus' ? chartTop : Math.max(chartTop, Math.min(chartBottom, rawZeroY))
  ctx.save()
  ctx.beginPath(); ctx.rect(clipStart, chartTop, clipEnd - clipStart, chartHeight); ctx.clip()
  if (domain.min <= 0 && domain.max >= 0) {
    ctx.strokeStyle = palette.zero
    ctx.beginPath(); ctx.moveTo(clipStart, zeroY); ctx.lineTo(clipEnd, zeroY); ctx.stroke()
  }
  drawSignalBins(
    ctx, bins, PLOT_LEFT, chartTop, chartBottom, zeroY,
    (value) => spec.signalStrand === 'minus'
      ? chartTop + (signalTransform(value, transform) / Math.max(1e-9, transformedMax)) * chartHeight
      : chartBottom - ((signalTransform(value, transform) - transformedMin) / transformedAmplitude) * chartHeight,
    spec.color, spec.signalRenderStyle ?? 'fill', (spec.signalOpacity ?? 100) / 100, lineDash,
  )
  ctx.restore()
}

function paintSmoothSignalDomain(
  ctx: CanvasRenderingContext2D,
  bins: readonly (Bin | undefined)[],
  domain: ScaleDomain,
  transform: 'linear' | 'log1p' | 'symlog',
  chartTop: number,
  chartBottom: number,
  clipStart: number,
  clipEnd: number,
  color: string,
  dash: readonly number[],
): void {
  if (clipEnd <= clipStart) return
  const transformedMin = signalTransform(domain.min, transform)
  const transformedMax = signalTransform(domain.max, transform)
  const amplitude = Math.max(1e-9, transformedMax - transformedMin)
  const valueToY = (value: number) => chartBottom - ((signalTransform(value, transform) - transformedMin) / amplitude) * (chartBottom - chartTop)
  ctx.save()
  ctx.beginPath(); ctx.rect(clipStart, chartTop, clipEnd - clipStart, chartBottom - chartTop); ctx.clip()
  ctx.strokeStyle = color
  ctx.globalAlpha = 1
  ctx.lineWidth = 1.75
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([...dash])
  for (let start = 0; start < bins.length;) {
    while (start < bins.length && !bins[start]) start += 1
    if (start >= bins.length) break
    let end = start
    while (end + 1 < bins.length && bins[end + 1]) end += 1
    const points = Array.from({ length: end - start + 1 }, (_, offset) => {
      const bin = bins[start + offset]!
      const value = bin.min >= 0 ? bin.max : bin.max <= 0 ? bin.min : Math.abs(bin.max) >= Math.abs(bin.min) ? bin.max : bin.min
      return { x: PLOT_LEFT + start + offset + 0.5, y: valueToY(value) }
    })
    ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y)
    if (points.length === 2) ctx.lineTo(points[1]!.x, points[1]!.y)
    else for (let index = 1; index < points.length; index += 1) {
      const point = points[index]!
      const next = points[index + 1]
      if (next) ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
      else ctx.lineTo(point.x, point.y)
    }
    ctx.stroke()
    start = end + 1
  }
  ctx.restore()
}

export function signalStackDash(index: number, differentiation: SignalStackDifferentiation): number[] {
  if (differentiation !== 'patterns' && differentiation !== 'shades-patterns') return []
  return [[], [7, 4], [2, 3], [10, 3, 2, 3]][index % 4]!.slice()
}

export function signalStackLegendEntries(
  members: readonly Pick<TrackSpec, 'id' | 'label' | 'color' | 'enabled'>[],
  visibleMembers: readonly Pick<TrackSpec, 'id'>[],
  differentiation: SignalStackDifferentiation,
  hiddenIds: readonly string[],
  styleTrackIds: readonly string[] = members.map((member) => member.id),
): Array<{ id: string; label: string; color: string; dash: number[]; hidden: boolean }> {
  const hiddenIdsSet = new Set(hiddenIds)
  const styleIds = [...new Set([...styleTrackIds, ...members.map((member) => member.id)])]
  return members.map((member) => {
    const visibleIndex = visibleMembers.findIndex((track) => track.id === member.id)
    const hidden = !member.enabled || hiddenIdsSet.has(member.id) || visibleIndex < 0
    const styleIndex = styleIds.indexOf(member.id)
    return {
      id: member.id, label: member.label,
      color: signalStackColor(member.color, styleIndex, styleIds.length, differentiation),
      dash: signalStackDash(styleIndex, differentiation),
      hidden,
    }
  })
}

export function signalStackColor(base: string, index: number, count: number, differentiation: SignalStackDifferentiation): string {
  if (differentiation === 'colors' || differentiation === 'patterns' || count <= 1 || !/^#[0-9a-f]{6}$/i.test(base)) return base
  const number = Number.parseInt(base.slice(1), 16)
  const rgb = [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255]
  const maximum = Math.max(...rgb)
  const minimum = Math.min(...rgb)
  const lightness = (maximum + minimum) / 2
  const delta = maximum - minimum
  const saturation = delta === 0 ? 0.58 : delta / (1 - Math.abs(2 * lightness - 1))
  let hue = delta === 0 ? 252 : maximum === rgb[0] ? 60 * (((rgb[1]! - rgb[2]!) / delta) % 6)
    : maximum === rgb[1] ? 60 * (((rgb[2]! - rgb[0]!) / delta) + 2) : 60 * (((rgb[0]! - rgb[1]!) / delta) + 4)
  if (hue < 0) hue += 360
  const midpoint = (count - 1) / 2
  hue = (hue + (midpoint ? (index - midpoint) / midpoint : 0) * Math.min(64, 24 + count * 8) + 360) % 360
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = hue / 60
  const x = chroma * (1 - Math.abs((section % 2) - 1))
  const [red, green, blue] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0] : section < 3 ? [0, chroma, x]
    : section < 4 ? [0, x, chroma] : section < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const match = lightness - chroma / 2
  return `#${[red, green, blue].map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('')}`
}

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
