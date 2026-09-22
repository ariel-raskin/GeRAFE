import type { Region, SignalFeature } from './types.ts'

export const TRACK_DOCUMENT_VERSION = 26 as const
export const TRACK_COLORS = ['#6d55e0', '#d95d74', '#169b8f', '#d88928', '#3478c9'] as const
export const STRANDED_POSITIVE_COLOR = '#e3342f'
export const STRANDED_NEGATIVE_COLOR = '#2878d4'

export type SourceFormat = 'bigwig' | 'bedgraph' | 'tdf' | 'bam' | 'bed' | 'bedpe' | 'hic' | 'cool' | 'mcool' | 'matrix-comparison' | 'matrix-derived'
export type ScaleMode = 'auto-visible' | 'auto-percentile' | 'fixed'
export type SignalTransform = 'linear' | 'log1p' | 'symlog'
export type SignalRenderStyle = 'fill' | 'line' | 'bar'
export type SignalStrand = 'plus' | 'minus'
export type SignalScaleChannel = 'ordinary' | SignalStrand
export type InteractionDirection = 'up' | 'down'
export type InteractionFilterMode = 'all' | 'genes' | 'visible-genes'
export type IntervalColorMode = 'track' | 'item-rgb' | 'strand' | 'score'
export type InteractionColorMode = 'track' | 'item-rgb' | 'score'
export type InteractionArcHeightMode = 'distance' | 'fixed'
export type MatrixPalette = 'monochrome' | 'warm' | 'blue-black' | 'custom'
export type MatrixScaleMode = 'maximum' | 'percentile' | 'fixed'
export type MatrixDepthMode = 'auto' | 'full' | 'fixed'
export type MatrixZeroStyle = 'background' | 'low-color' | 'custom'
export type MatrixMissingStyle = 'background' | 'custom'
export type MatrixMaskedStyle = 'background' | 'hatch' | 'custom'
export type MatrixOverlayFocusMode = 'all' | 'genes' | 'region'

export interface SourceFileSpec {
  name: string
  size: number
  lastModified: number
  role: 'signal' | 'index' | 'comparison'
  /** Native desktop path. Browser-only files omit this and need relinking after restart. */
  path?: string
}

export interface TrackSourceSpec {
  id: string
  name: string
  format: SourceFormat
  files: SourceFileSpec[]
  /** Derived signal computed from a native matrix; no data pixels are stored in the workspace. */
  matrixDerivedMode?: 'insulation' | 'compartment'
  matrixDerivedNormalization?: string
  matrixDerivedResolution?: number
  strand?: SignalStrand
  strandBaseLabel?: string
}

export interface DisplayGroup {
  id: string
  label: string
  color?: string
  positiveColor?: string
  negativeColor?: string
  scaleBehavior?: 'linked' | 'independent'
}

export interface SavedRegion {
  id: string
  label: string
  region: Region
  color: string
  highlighted: boolean
}

export interface ComparisonDivider {
  chr: string
  position: number
}

export interface ScaleBinding {
  id: string
  label: string
  mode: ScaleMode
  includeZero: boolean
  limits?: { min: number; max: number }
  /** Upper/lower quantiles used by robust visible-window scaling. */
  percentile?: number
  /** Use equal positive and negative magnitude around zero. */
  symmetric?: boolean
  transform?: SignalTransform
}

export interface TrackSpec {
  id: string
  kind: 'signal' | 'stranded' | 'interval' | 'interaction' | 'matrix' | 'alignment' | 'genes'
  sourceIds: string[]
  label: string
  color: string
  enabled: boolean
  height: number
  /** Exact pixel height assigned by Fit tracks; manual height changes clear it. */
  fittedHeight?: number
  /** Exact pixel height assigned by direct boundary dragging. */
  manualPixelHeight?: number
  /** Excludes this track from Fit tracks while retaining manual resizing. */
  heightLocked?: boolean
  pane: 'main' | 'bottom'
  geneDisplayMode?: 'collapsed' | 'expanded' | 'squished'
  /** In expanded views, show the representative transcript or every available isoform. */
  geneTranscriptMode?: 'canonical' | 'all'
  /** Undefined follows the browser-wide TSS preference. */
  geneShowTssIndicators?: boolean
  intervalDisplayMode?: 'collapsed' | 'expanded' | 'squished'
  intervalShowLabels?: boolean
  intervalColorMode?: IntervalColorMode
  intervalMinScore?: number
  intervalMaxRows?: number
  interactionDirection?: InteractionDirection
  interactionFilterMode?: InteractionFilterMode
  interactionFilterGenes?: string[]
  interactionMinScore?: number
  /** Maximum cis-anchor separation in bases; trans interactions remain visible. */
  interactionMaxDistance?: number
  interactionMaxFeatures?: number
  interactionLineWidth?: number
  interactionOpacity?: number
  interactionArcHeightMode?: InteractionArcHeightMode
  interactionShowAnchors?: boolean
  interactionShowNames?: boolean
  interactionColorMode?: InteractionColorMode
  matrixDirection?: InteractionDirection
  matrixResolution?: number
  matrixNormalization?: string
  matrixValueMode?: 'observed' | 'observed-expected' | 'log2-observed-expected'
  /** The source contains two matrix files, in numerator/minuend then denominator/subtrahend order. */
  matrixComparisonMode?: 'difference' | 'ratio' | 'log2-ratio'
  /** A second, independently navigated genomic axis enables the rectangular view. */
  matrixSecondaryRegion?: Region
  /** BEDPE interaction track outlined over this matrix without changing contact colors. */
  matrixOverlayInteractionTrackId?: string
  matrixOverlayFocusMode?: MatrixOverlayFocusMode
  matrixOverlayFocusGenes?: string[]
  matrixOverlayFocusRegion?: Region
  /** Independent safety cap; the linked BEDPE display limit can lower it further. */
  matrixOverlayMaxFeatures?: number
  matrixTransform?: 'linear' | 'log1p'
  matrixScaleMode?: MatrixScaleMode
  matrixScaleMin?: number
  matrixScaleMax?: number
  matrixScalePercentile?: number
  /** Number of diagonals, including the main diagonal, excluded from automatic scaling. */
  matrixIgnoreDiagonals?: number
  matrixDepthMode?: MatrixDepthMode
  /** Maximum genomic separation in bases when matrixDepthMode is fixed. */
  matrixMaxDistance?: number
  matrixPalette?: MatrixPalette
  /** Reverses which end of the selected palette represents the highest score. */
  matrixPaletteReversed?: boolean
  /** Ordered low-to-high colors for the custom matrix palette. */
  matrixPaletteColors?: string[]
  matrixZeroStyle?: MatrixZeroStyle
  matrixZeroColor?: string
  matrixMissingStyle?: MatrixMissingStyle
  matrixMissingColor?: string
  matrixMaskedStyle?: MatrixMaskedStyle
  matrixMaskedColor?: string
  alignmentDisplayMode?: 'collapsed' | 'expanded' | 'squished'
  bamViewMode?: 'coverage' | 'alignments' | 'both'
  bamColorMode?: 'track' | 'strand' | 'pair-orientation' | 'mapping-quality'
  bamViewAsPairs?: boolean
  bamShowMismatches?: boolean
  bamMinMapq?: number
  bamIncludeDuplicates?: boolean
  bamIncludeSecondary?: boolean
  bamIncludeSupplementary?: boolean
  bamSortMode?: 'start' | 'strand' | 'mapq' | 'insert-size'
  bamGroupMode?: 'none' | 'strand' | 'read-group' | 'tag'
  bamGroupTag?: string
  bamMaxReads?: number
  bamShowInsertions?: boolean
  bamShowDeletions?: boolean
  bamShowSoftClips?: boolean
  bamMinMismatchBaseq?: number
  /** Minimum alternate-base frequency (0–1) for BAM coverage highlighting. */
  bamMinAlleleFrequency?: number
  displayGroupId?: string
  scaleBindingId?: string
  signalStrand?: SignalStrand
  strandBaseLabel?: string
  negativeColor?: string
  negativeScaleBindingId?: string
  strandAutoLinkDisabled?: boolean
  /** False clamps ordinary signal values to the zero baseline for display and autoscaling. */
  allowNegativeValues?: boolean
  signalRenderStyle?: SignalRenderStyle
  /** Opacity percentage from 10 through 100. */
  signalOpacity?: number
}

export interface TrackDocument {
  schemaVersion: typeof TRACK_DOCUMENT_VERSION
  referenceId: string
  region: Region
  sources: TrackSourceSpec[]
  tracks: TrackSpec[]
  groups: DisplayGroup[]
  scales: ScaleBinding[]
  savedRegions: SavedRegion[]
  comparisonDivider?: ComparisonDivider
}

export type DocumentChangeReason = 'edit' | 'undo' | 'redo' | 'replace' | 'viewport'
export type DocumentListener = (document: TrackDocument, reason: DocumentChangeReason) => void

export class TrackDocumentStore {
  private document: TrackDocument
  private past: TrackDocument[] = []
  private future: TrackDocument[] = []
  private listeners = new Set<DocumentListener>()

  constructor(initial: TrackDocument) {
    this.document = normalizeTrackDocument(initial)
  }

  get current(): TrackDocument { return this.document }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  subscribe(listener: DocumentListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  edit(update: (draft: TrackDocument) => void): void {
    const next = cloneDocument(this.document)
    update(next)
    const normalized = normalizeTrackDocument(next)
    if (JSON.stringify(normalized) === JSON.stringify(this.document)) return
    this.past.push(cloneDocument(this.document))
    if (this.past.length > 100) this.past.shift()
    this.future = []
    this.document = normalized
    this.emit('edit')
  }

  setViewport(referenceId: string, region: Region): void {
    if (this.document.referenceId === referenceId && sameRegion(this.document.region, region)) return
    this.document = { ...this.document, referenceId, region: { ...region } }
    this.emit('viewport')
  }

  replace(document: TrackDocument): void {
    this.past.push(cloneDocument(this.document))
    this.future = []
    this.document = normalizeTrackDocument(document)
    this.emit('replace')
  }

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(cloneDocument(this.document))
    this.document = previous
    this.emit('undo')
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(cloneDocument(this.document))
    this.document = next
    this.emit('redo')
  }

  private emit(reason: DocumentChangeReason): void {
    for (const listener of this.listeners) listener(this.document, reason)
  }
}

export function createTrackDocument(referenceId: string, region: Region, options: { geneShowTssIndicators?: boolean } = {}): TrackDocument {
  return {
    schemaVersion: TRACK_DOCUMENT_VERSION,
    referenceId,
    region: { ...region },
    sources: [],
    tracks: [{
      id: 'reference-genes',
      kind: 'genes',
      sourceIds: [],
      label: 'RefSeq genes',
      color: '#6652c9',
      enabled: true,
      height: 32,
      pane: 'bottom',
      geneDisplayMode: 'collapsed',
      geneShowTssIndicators: options.geneShowTssIndicators,
    }],
    groups: [],
    scales: [],
    savedRegions: [],
  }
}

export function addSignalTrack(
  draft: TrackDocument,
  source: TrackSourceSpec,
  options: { id?: string; label?: string; color?: string; displayGroupId?: string; autoPair?: boolean; autoStrandColors?: boolean } = {},
): TrackSpec {
  const id = options.id ?? crypto.randomUUID()
  const scaleBindingId = crypto.randomUUID()
  const inferred = inferSignalStrand(source.name)
  source.strand = inferred?.strand
  source.strandBaseLabel = inferred?.baseLabel
  const track: TrackSpec = {
    id,
    kind: 'signal',
    sourceIds: [source.id],
    label: options.label ?? source.name,
    color: options.color ?? TRACK_COLORS[draft.tracks.filter((item) => item.kind === 'signal').length % TRACK_COLORS.length],
    enabled: true,
    height: 32,
    pane: 'main',
    scaleBindingId,
    displayGroupId: options.displayGroupId,
    signalStrand: inferred?.strand,
    strandBaseLabel: inferred?.baseLabel,
  }
  draft.sources.push(source)
  draft.scales.push({ id: scaleBindingId, label: track.label, mode: 'auto-visible', includeZero: true })
  const bottomIndex = draft.tracks.findIndex((item) => item.pane === 'bottom')
  draft.tracks.splice(bottomIndex < 0 ? draft.tracks.length : bottomIndex, 0, track)
  if (options.autoPair !== false && inferred) {
    const complement = draft.tracks.find((candidate) => candidate.id !== track.id && candidate.kind === 'signal'
      && !candidate.strandAutoLinkDisabled && candidate.signalStrand !== inferred.strand
      && strandBaseKey(candidate.strandBaseLabel ?? candidate.label) === strandBaseKey(inferred.baseLabel))
    if (complement) return pairStrandedTracks(draft, track.id, complement.id, { autoColors: options.autoStrandColors }) ?? track
  }
  return track
}

export function inferSignalStrand(name: string): { strand: SignalStrand; baseLabel: string } | undefined {
  const extensionless = name.replace(/\.(?:bigwig|bw|bedgraph|tdf)$/i, '')
  const words = extensionless.split(/([\s._()\[\]-]+)/)
  const plus = /^(?:positive|pos|plus|forward|fwd|sense)$/i
  const minus = /^(?:negative|neg|minus|reverse|rev|antisense)$/i
  let strand: SignalStrand | undefined
  const kept = words.filter((word) => {
    const clean = word.trim()
    if (!clean) return true
    if (plus.test(clean)) { strand = 'plus'; return false }
    if (minus.test(clean)) { strand = 'minus'; return false }
    return true
  })
  if (!strand) {
    const signMatch = extensionless.match(/^(.*?)(?:[\s._-]*)([+-])$/)
    if (!signMatch) return undefined
    strand = signMatch[2] === '+' ? 'plus' : 'minus'
    kept.splice(0, kept.length, signMatch[1])
  }
  const baseLabel = kept.join('').replace(/(?:[\s._-]*strand)?[\s._-]*$/i, '').replace(/^[\s._-]+|[\s._-]+$/g, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return baseLabel ? { strand, baseLabel } : undefined
}

export function pairStrandedTracks(draft: TrackDocument, firstId: string, secondId: string, options: { autoColors?: boolean } = {}): TrackSpec | undefined {
  const firstIndex = draft.tracks.findIndex((track) => track.id === firstId)
  const secondIndex = draft.tracks.findIndex((track) => track.id === secondId)
  const first = draft.tracks[firstIndex]
  const second = draft.tracks[secondIndex]
  if (!first || !second || first.kind !== 'signal' || second.kind !== 'signal'
    || !first.signalStrand || !second.signalStrand || first.signalStrand === second.signalStrand) return undefined
  const firstBase = strandBaseKey(first.strandBaseLabel ?? first.label)
  const secondBase = strandBaseKey(second.strandBaseLabel ?? second.label)
  if (!firstBase || firstBase !== secondBase) return undefined
  const plus = first.signalStrand === 'plus' ? first : second
  const minus = first.signalStrand === 'minus' ? first : second
  const insertionIndex = Math.min(firstIndex, secondIndex)
  const groupId = plus.displayGroupId === minus.displayGroupId ? plus.displayGroupId : plus.displayGroupId ?? minus.displayGroupId
  const paired: TrackSpec = {
    id: firstIndex <= secondIndex ? first.id : second.id,
    kind: 'stranded',
    sourceIds: [plus.sourceIds[0], minus.sourceIds[0]],
    label: plus.strandBaseLabel ?? minus.strandBaseLabel ?? plus.label,
    color: options.autoColors ? STRANDED_POSITIVE_COLOR : plus.color,
    negativeColor: options.autoColors ? STRANDED_NEGATIVE_COLOR : minus.color,
    enabled: plus.enabled || minus.enabled,
    height: Math.max(plus.height, minus.height),
    pane: firstIndex <= secondIndex ? first.pane : second.pane,
    displayGroupId: groupId,
    scaleBindingId: plus.scaleBindingId,
    negativeScaleBindingId: minus.scaleBindingId,
  }
  draft.tracks = draft.tracks.filter((track) => track.id !== first.id && track.id !== second.id)
  draft.tracks.splice(insertionIndex, 0, paired)
  if (groupId) makeGroupContiguous(draft, groupId)
  pruneDocument(draft)
  return paired
}

export function autoPairStrandedTracks(draft: TrackDocument, options: { autoColors?: boolean } = {}): TrackSpec[] {
  const paired: TrackSpec[] = []
  for (const track of [...draft.tracks]) {
    if (track.kind !== 'signal' || !track.signalStrand || track.strandAutoLinkDisabled || !draft.tracks.includes(track)) continue
    const complement = draft.tracks.find((candidate) => candidate.id !== track.id && candidate.kind === 'signal'
      && !candidate.strandAutoLinkDisabled && candidate.signalStrand && candidate.signalStrand !== track.signalStrand
      && strandBaseKey(candidate.strandBaseLabel ?? candidate.label) === strandBaseKey(track.strandBaseLabel ?? track.label))
    const result = complement ? pairStrandedTracks(draft, track.id, complement.id, options) : undefined
    if (result) paired.push(result)
  }
  return paired
}

export function applyAutomaticStrandedColors(draft: TrackDocument): void {
  for (const track of draft.tracks) {
    if (track.kind !== 'stranded') continue
    track.color = STRANDED_POSITIVE_COLOR
    track.negativeColor = STRANDED_NEGATIVE_COLOR
  }
}

export function unlinkStrandedTrack(draft: TrackDocument, trackId: string): TrackSpec[] {
  const index = draft.tracks.findIndex((track) => track.id === trackId)
  const paired = draft.tracks[index]
  if (!paired || paired.kind !== 'stranded') return []
  const plusSource = draft.sources.find((source) => source.id === paired.sourceIds[0])
  const minusSource = draft.sources.find((source) => source.id === paired.sourceIds[1])
  const common = { enabled: paired.enabled, height: paired.height, pane: paired.pane, displayGroupId: paired.displayGroupId, strandAutoLinkDisabled: true }
  const plus: TrackSpec = {
    ...common, id: paired.id, kind: 'signal', sourceIds: [paired.sourceIds[0]], label: plusSource?.name ?? `${paired.label} plus`,
    color: paired.color, scaleBindingId: paired.scaleBindingId, signalStrand: 'plus', strandBaseLabel: paired.label,
  }
  const minus: TrackSpec = {
    ...common, id: crypto.randomUUID(), kind: 'signal', sourceIds: [paired.sourceIds[1]], label: minusSource?.name ?? `${paired.label} minus`,
    color: paired.negativeColor ?? paired.color, scaleBindingId: paired.negativeScaleBindingId, signalStrand: 'minus', strandBaseLabel: paired.label,
  }
  draft.tracks.splice(index, 1, plus, minus)
  pruneDocument(draft)
  return [plus, minus]
}

export function signalFeatureKey(trackId: string, strand?: SignalStrand): string {
  return strand ? `${trackId}:${strand}` : trackId
}

/** Compact BED tracks start just tall enough for their wrapped left-card label. */
export function intervalLabelHeightScore(label: string): number {
  const estimatedLines = Math.max(1, Math.ceil(label.length / 20))
  return Math.max(5, Math.min(20, Math.ceil(estimatedLines * 15 / 3.6)))
}

export function addIntervalTrack(
  draft: TrackDocument,
  source: TrackSourceSpec,
  options: { id?: string; label?: string; color?: string } = {},
): TrackSpec {
  const track: TrackSpec = {
    id: options.id ?? crypto.randomUUID(),
    kind: 'interval',
    sourceIds: [source.id],
    label: options.label ?? source.name,
    color: options.color ?? TRACK_COLORS[draft.tracks.filter((item) => item.kind !== 'genes').length % TRACK_COLORS.length],
    enabled: true,
    height: intervalLabelHeightScore(options.label ?? source.name),
    pane: 'main',
    intervalDisplayMode: 'collapsed',
  }
  draft.sources.push(source)
  const bottomIndex = draft.tracks.findIndex((item) => item.pane === 'bottom')
  draft.tracks.splice(bottomIndex < 0 ? draft.tracks.length : bottomIndex, 0, track)
  return track
}

export function addInteractionTrack(
  draft: TrackDocument,
  source: TrackSourceSpec,
  options: { id?: string; label?: string; color?: string } = {},
): TrackSpec {
  const track: TrackSpec = {
    id: options.id ?? crypto.randomUUID(),
    kind: 'interaction',
    sourceIds: [source.id],
    label: options.label ?? source.name,
    color: options.color ?? TRACK_COLORS[draft.tracks.filter((item) => item.kind !== 'genes').length % TRACK_COLORS.length],
    enabled: true,
    height: 32,
    pane: 'main',
    interactionDirection: 'up',
    interactionFilterMode: 'all',
  }
  draft.sources.push(source)
  const bottomIndex = draft.tracks.findIndex((item) => item.pane === 'bottom')
  draft.tracks.splice(bottomIndex < 0 ? draft.tracks.length : bottomIndex, 0, track)
  return track
}

export function addMatrixTrack(
  draft: TrackDocument,
  source: TrackSourceSpec,
  options: { id?: string; label?: string; color?: string; defaultNormalization?: string } = {},
): TrackSpec {
  const track: TrackSpec = {
    id: options.id ?? crypto.randomUUID(),
    kind: 'matrix',
    sourceIds: [source.id],
    label: options.label ?? source.name,
    color: options.color ?? '#d94b5f',
    enabled: true,
    height: 50,
    pane: 'main',
    matrixDirection: 'up',
    matrixNormalization: options.defaultNormalization ?? 'raw',
    matrixValueMode: 'observed',
    matrixTransform: 'log1p',
    matrixScaleMode: 'percentile',
    matrixScaleMin: 0,
    matrixScalePercentile: 0.99,
    matrixIgnoreDiagonals: 3,
    matrixDepthMode: 'full',
    matrixPalette: 'warm',
    matrixZeroStyle: 'background',
    matrixMissingStyle: 'background',
    matrixMaskedStyle: 'hatch',
  }
  draft.sources.push(source)
  const bottomIndex = draft.tracks.findIndex((item) => item.pane === 'bottom')
  draft.tracks.splice(bottomIndex < 0 ? draft.tracks.length : bottomIndex, 0, track)
  return track
}

export function addAlignmentTrack(
  draft: TrackDocument,
  source: TrackSourceSpec,
  options: { id?: string; label?: string; color?: string } = {},
): TrackSpec {
  const track: TrackSpec = {
    id: options.id ?? crypto.randomUUID(),
    kind: 'alignment',
    sourceIds: [source.id],
    label: options.label ?? source.name,
    color: options.color ?? TRACK_COLORS[draft.tracks.filter((item) => item.kind !== 'genes').length % TRACK_COLORS.length],
    enabled: true,
    height: 58,
    pane: 'main',
    alignmentDisplayMode: 'expanded',
    bamViewMode: 'both',
    bamColorMode: 'track',
    bamViewAsPairs: false,
    bamShowMismatches: true,
    bamMinMapq: 0,
    bamMinAlleleFrequency: 0,
  }
  draft.sources.push(source)
  const bottomIndex = draft.tracks.findIndex((item) => item.pane === 'bottom')
  draft.tracks.splice(bottomIndex < 0 ? draft.tracks.length : bottomIndex, 0, track)
  return track
}

export function duplicateTrack(draft: TrackDocument, trackId: string): TrackSpec | undefined {
  const index = draft.tracks.findIndex((track) => track.id === trackId)
  const original = draft.tracks[index]
  if (!original || original.kind === 'genes') return undefined
  const scaleBindingId = original.kind === 'signal' || original.kind === 'stranded' ? crypto.randomUUID() : undefined
  const negativeScaleBindingId = original.kind === 'stranded' ? crypto.randomUUID() : undefined
  const copy: TrackSpec = {
    ...original,
    id: crypto.randomUUID(),
    sourceIds: [...original.sourceIds],
    label: `${original.label} copy`,
    scaleBindingId,
    negativeScaleBindingId,
  }
  draft.tracks.splice(index + 1, 0, copy)
  if (scaleBindingId) draft.scales.push({ id: scaleBindingId, label: copy.label, mode: 'auto-visible', includeZero: true })
  if (negativeScaleBindingId) draft.scales.push({ id: negativeScaleBindingId, label: `${copy.label} minus`, mode: 'auto-visible', includeZero: true })
  return copy
}

export function removeTrack(draft: TrackDocument, trackId: string): void {
  const removed = draft.tracks.find((track) => track.id === trackId)
  if (!removed) return
  draft.tracks = draft.tracks.filter((track) => track.id !== trackId)
  pruneDocument(draft)
}

export function moveTrack(draft: TrackDocument, trackId: string, direction: -1 | 1): void {
  const movable = draft.tracks.filter((track) => track.kind !== 'genes')
  const position = movable.findIndex((track) => track.id === trackId)
  const neighbor = movable[position + direction]
  if (position < 0 || !neighbor) return
  const index = draft.tracks.findIndex((track) => track.id === trackId)
  const neighborIndex = draft.tracks.findIndex((track) => track.id === neighbor.id)
  ;[draft.tracks[index], draft.tracks[neighborIndex]] = [draft.tracks[neighborIndex], draft.tracks[index]]
}

export function reorderTracks(
  draft: TrackDocument,
  requestedTrackIds: readonly string[],
  pane: 'main' | 'bottom',
  insertionIndex: number,
  withinGroupId?: string,
): void {
  const movingIds = new Set(requestedTrackIds)
  if (withinGroupId) {
    const groupMembers = draft.tracks.filter((track) => track.displayGroupId === withinGroupId)
    if (!groupMembers.length || [...movingIds].some((id) => !groupMembers.some((track) => track.id === id))) return
    if (pane !== groupMembers[0].pane) withinGroupId = undefined
  }
  const moving = draft.tracks.filter((track) => movingIds.has(track.id))
  if (!moving.length) return
  // Visual groups stay contiguous and cannot span panes. Moving a partial
  // group outside its own within-group reorder detaches that subset; moving
  // every member preserves the group.
  const partiallyMovedGroupIds = new Set(moving
    .map((track) => track.displayGroupId)
    .filter((id): id is string => Boolean(id))
    .filter((id) => {
      const members = draft.tracks.filter((track) => track.displayGroupId === id)
      return members.some((track) => !movingIds.has(track.id))
        && (!withinGroupId || members.some((track) => movingIds.has(track.id) && track.pane !== pane))
    }))
  for (const track of moving) if (track.displayGroupId && partiallyMovedGroupIds.has(track.displayGroupId)) track.displayGroupId = undefined
  for (const track of moving) track.pane = pane
  const remaining = draft.tracks.filter((track) => !movingIds.has(track.id))
  const target = remaining.filter((track) => track.pane === pane)
  let safeIndex = Math.max(0, Math.min(insertionIndex, target.length))
  if (withinGroupId) {
    const positions = target.map((track, index) => track.displayGroupId === withinGroupId ? index : -1).filter((index) => index >= 0)
    if (!positions.length) return
    safeIndex = Math.max(Math.min(...positions), Math.min(safeIndex, Math.max(...positions) + 1))
  }
  target.splice(safeIndex, 0, ...moving)
  const otherPane: 'main' | 'bottom' = pane === 'main' ? 'bottom' : 'main'
  const other = remaining.filter((track) => track.pane === otherPane)
  draft.tracks = pane === 'main' ? [...target, ...other] : [...other, ...target]
  pruneDocument(draft)
}

export function assignDisplayGroup(draft: TrackDocument, trackIds: readonly string[], label: string, options: { autoScale?: boolean } = {}): void {
  const cleanLabel = label.trim()
  if (!cleanLabel) {
    for (const track of draft.tracks) if (trackIds.includes(track.id)) track.displayGroupId = undefined
    pruneDocument(draft)
    return
  }
  let group = draft.groups.find((item) => item.label.toLocaleLowerCase() === cleanLabel.toLocaleLowerCase())
  if (!group) {
    group = { id: crypto.randomUUID(), label: cleanLabel, scaleBehavior: options.autoScale === false ? 'independent' : 'linked' }
    draft.groups.push(group)
  } else if (group.scaleBehavior === undefined && options.autoScale !== false) {
    // Workspaces created before group autoscaling did not persist a behavior.
    // Adopt the current preference the next time that group is edited.
    group.scaleBehavior = 'linked'
  }
  const existingMember = draft.tracks.find((track) => track.displayGroupId === group.id)
  const firstTarget = draft.tracks.find((track) => trackIds.includes(track.id))
  const pane = existingMember?.pane ?? firstTarget?.pane
  for (const track of draft.tracks) if (trackIds.includes(track.id)) {
    track.displayGroupId = group.id
    if (pane) track.pane = pane
  }
  for (const track of draft.tracks) if (track.displayGroupId === group.id) {
    const channel = track.kind === 'stranded' ? 'plus' : track.kind === 'signal' ? track.signalStrand ?? 'ordinary' : 'ordinary'
    if (channel === 'ordinary' && group.color) track.color = group.color
    if (channel === 'plus' && group.positiveColor) track.color = group.positiveColor
    if (track.kind === 'stranded' && group.negativeColor) track.negativeColor = group.negativeColor
    if (channel === 'minus' && group.negativeColor) track.color = group.negativeColor
  }
  makeGroupContiguous(draft, group.id)
  const members = draft.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && track.displayGroupId === group.id).map((track) => track.id)
  if (group.scaleBehavior === 'linked') linkScales(draft, members)
  if (group.scaleBehavior === 'independent') unlinkScales(draft, trackIds)
  pruneDocument(draft)
}

export function linkScales(draft: TrackDocument, trackIds: readonly string[]): void {
  const targets = draft.tracks.filter((track) => (track.kind === 'signal' || track.kind === 'stranded') && trackIds.includes(track.id))
  for (const channel of ['ordinary', 'plus', 'minus'] as const) {
    const refs = targets.flatMap((track) => scaleChannelRefs(track).filter((ref) => ref.channel === channel))
    if (refs.length < 2) continue
    const previous = refs.map((ref) => draft.scales.find((scale) => scale.id === ref.scaleBindingId)).find(Boolean)
    const binding: ScaleBinding = {
      id: crypto.randomUUID(),
      label: `Linked ${channel === 'ordinary' ? '' : `${channel} `}scale (${refs.length})`.replace('  ', ' '),
      mode: previous?.mode ?? 'auto-visible',
      includeZero: previous?.includeZero ?? true,
      limits: previous?.limits ? { ...previous.limits } : undefined,
      percentile: previous?.percentile,
      symmetric: previous?.symmetric,
      transform: previous?.transform,
    }
    draft.scales.push(binding)
    for (const ref of refs) setScaleChannelBinding(ref.track, channel, binding.id)
  }
  pruneDocument(draft)
}

export function unlinkScales(draft: TrackDocument, trackIds: readonly string[]): void {
  for (const track of draft.tracks) {
    if ((track.kind !== 'signal' && track.kind !== 'stranded') || !trackIds.includes(track.id)) continue
    for (const ref of scaleChannelRefs(track)) {
      const existing = draft.scales.find((scale) => scale.id === ref.scaleBindingId)
      const binding: ScaleBinding = {
        id: crypto.randomUUID(),
        label: `${track.label}${ref.channel === 'ordinary' ? '' : ` ${ref.channel}`}`,
        mode: existing?.mode ?? 'auto-visible',
        includeZero: existing?.includeZero ?? true,
        limits: existing?.limits ? { ...existing.limits } : undefined,
        percentile: existing?.percentile,
        symmetric: existing?.symmetric,
        transform: existing?.transform,
      }
      draft.scales.push(binding)
      setScaleChannelBinding(track, ref.channel, binding.id)
    }
  }
  pruneDocument(draft)
}

export function computeScaleDomains(
  document: TrackDocument,
  featuresByTrack: ReadonlyMap<string, readonly SignalFeature[]>,
): ReadonlyMap<string, { min: number; max: number }> {
  const result = new Map<string, { min: number; max: number }>()
  for (const binding of document.scales) {
    if (binding.mode === 'fixed' && binding.limits) {
      const magnitudeChannel = document.tracks.some((track) => scaleChannelRefs(track).some((ref) => ref.scaleBindingId === binding.id && ref.channel !== 'ordinary'))
      result.set(binding.id, magnitudeChannel
        ? safeDomain(0, Math.max(Math.abs(binding.limits.min), Math.abs(binding.limits.max)), true)
        : safeDomain(binding.limits.min, binding.limits.max, binding.includeZero))
      continue
    }
    const values: number[] = []
    let min = binding.includeZero ? 0 : Number.POSITIVE_INFINITY
    let max = binding.includeZero ? 0 : Number.NEGATIVE_INFINITY
    for (const track of document.tracks) {
      if (!track.enabled) continue
      for (const ref of scaleChannelRefs(track)) {
        if (ref.scaleBindingId !== binding.id) continue
        for (const feature of featuresByTrack.get(signalFeatureKey(track.id, ref.channel === 'ordinary' ? undefined : ref.channel)) ?? []) {
          const score = ref.channel === 'ordinary'
            ? (track.allowNegativeValues === false ? Math.max(0, feature.score) : feature.score)
            : Math.abs(feature.score)
          values.push(score)
          min = Math.min(min, score)
          max = Math.max(max, score)
        }
      }
    }
    if (binding.mode === 'auto-percentile' && values.length) {
      const sorted = values.sort((a, b) => a - b)
      const percentile = Math.max(0.5, Math.min(1, binding.percentile ?? 0.99))
      const high = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))]!
      const low = sorted[Math.max(0, Math.ceil((sorted.length - 1) * (1 - percentile)))]!
      min = binding.includeZero ? Math.min(0, low) : low
      max = binding.includeZero ? Math.max(0, high) : high
    }
    if (binding.symmetric) {
      const magnitude = Math.max(Math.abs(min), Math.abs(max), 1e-9)
      min = -magnitude
      max = magnitude
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1 }
    result.set(binding.id, safeDomain(min, max, binding.includeZero))
  }
  return result
}

export function computeSplitScaleDomains(
  document: TrackDocument,
  featuresByTrack: ReadonlyMap<string, readonly SignalFeature[]>,
  divider: number,
): { left: ReadonlyMap<string, { min: number; max: number }>; right: ReadonlyMap<string, { min: number; max: number }> } {
  const left = new Map<string, readonly SignalFeature[]>()
  const right = new Map<string, readonly SignalFeature[]>()
  for (const [trackId, features] of featuresByTrack) {
    left.set(trackId, features.filter((feature) => feature.start < divider))
    right.set(trackId, features.filter((feature) => feature.end > divider))
  }
  return { left: computeScaleDomains(document, left), right: computeScaleDomains(document, right) }
}

export function normalizeTrackDocument(value: unknown): TrackDocument {
  if (!isRecord(value) || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, TRACK_DOCUMENT_VERSION].includes(value.schemaVersion)) throw new Error('This is not a supported GeRAFE workspace file.')
  if (typeof value.referenceId !== 'string' || !isRegion(value.region)) throw new Error('The workspace is missing a valid reference or region.')
  const sources = Array.isArray(value.sources) ? value.sources.filter(isSourceSpec).map(cloneSource) : []
  const groups = Array.isArray(value.groups) ? value.groups.filter(isGroup).map((group) => ({ ...group })) : []
  const scales = Array.isArray(value.scales) ? value.scales.filter(isScale).map(cloneScale) : []
  const savedRegionIds = new Set<string>()
  const savedRegions: SavedRegion[] = Array.isArray(value.savedRegions) ? value.savedRegions.flatMap((saved): SavedRegion[] => {
    if (!isRecord(saved) || typeof saved.id !== 'string' || !saved.id.trim() || savedRegionIds.has(saved.id)
      || typeof saved.label !== 'string' || !saved.label.trim() || !isRegion(saved.region) || saved.region.start < 0) return []
    savedRegionIds.add(saved.id)
    return [{
      id: saved.id,
      label: saved.label.trim().slice(0, 120),
      region: { ...saved.region },
      color: typeof saved.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color.toLowerCase() : '#6d55e0',
      highlighted: saved.highlighted !== false,
    }]
  }).slice(0, 500) : []
  const comparisonDivider = isRecord(value.comparisonDivider) && typeof value.comparisonDivider.chr === 'string'
    && value.comparisonDivider.chr.trim() && typeof value.comparisonDivider.position === 'number'
    && Number.isFinite(value.comparisonDivider.position) && value.comparisonDivider.position >= 0
    ? { chr: value.comparisonDivider.chr, position: Math.round(value.comparisonDivider.position) }
    : undefined
  const sourceIds = new Set(sources.map((source) => source.id))
  const groupIds = new Set(groups.map((group) => group.id))
  const scaleIds = new Set(scales.map((scale) => scale.id))
  const legacyHeights = value.schemaVersion === 1
  const tracks = Array.isArray(value.tracks) ? value.tracks.filter((track) => isTrack(track, legacyHeights)).map((track) => ({
    id: track.id,
    kind: track.kind,
    label: track.label,
    color: track.color,
    enabled: track.enabled,
    height: legacyHeights ? legacyHeightScore(track.kind, track.height) : Math.round(track.height),
    fittedHeight: typeof track.fittedHeight === 'number' && Number.isFinite(track.fittedHeight)
      ? Math.max(20, Math.min(4_000, Math.round(track.fittedHeight)))
      : undefined,
    manualPixelHeight: typeof track.manualPixelHeight === 'number' && Number.isFinite(track.manualPixelHeight)
      ? Math.max(20, Math.min(4_000, Math.round(track.manualPixelHeight)))
      : undefined,
    heightLocked: track.heightLocked === true ? true : undefined,
    pane: track.pane === 'main' || track.pane === 'bottom' ? track.pane : track.kind === 'genes' ? 'bottom' : 'main',
    sourceIds: track.sourceIds.filter((id) => sourceIds.has(id)),
    displayGroupId: track.displayGroupId && groupIds.has(track.displayGroupId) ? track.displayGroupId : undefined,
    scaleBindingId: track.scaleBindingId && scaleIds.has(track.scaleBindingId) ? track.scaleBindingId : undefined,
    signalStrand: track.kind === 'signal' && (track.signalStrand === 'plus' || track.signalStrand === 'minus') ? track.signalStrand : undefined,
    strandBaseLabel: track.kind === 'signal' && typeof track.strandBaseLabel === 'string' ? track.strandBaseLabel : undefined,
    negativeColor: track.kind === 'stranded' && typeof track.negativeColor === 'string' ? track.negativeColor : undefined,
    negativeScaleBindingId: track.kind === 'stranded' && track.negativeScaleBindingId && scaleIds.has(track.negativeScaleBindingId) ? track.negativeScaleBindingId : undefined,
    strandAutoLinkDisabled: track.kind === 'signal' && track.strandAutoLinkDisabled === true ? true : undefined,
    allowNegativeValues: track.kind === 'signal' ? track.allowNegativeValues !== false : undefined,
    signalRenderStyle: (track.kind === 'signal' || track.kind === 'stranded') && (track.signalRenderStyle === 'line' || track.signalRenderStyle === 'bar') ? track.signalRenderStyle as SignalRenderStyle : (track.kind === 'signal' || track.kind === 'stranded') ? 'fill' as SignalRenderStyle : undefined,
    signalOpacity: (track.kind === 'signal' || track.kind === 'stranded') && typeof track.signalOpacity === 'number' && Number.isFinite(track.signalOpacity)
      ? Math.max(10, Math.min(100, Math.round(track.signalOpacity))) : (track.kind === 'signal' || track.kind === 'stranded') ? 100 : undefined,
    geneDisplayMode: track.kind === 'genes' && (track.geneDisplayMode === 'collapsed' || track.geneDisplayMode === 'expanded' || track.geneDisplayMode === 'squished')
      ? track.geneDisplayMode
      : track.kind === 'genes' ? 'collapsed' : undefined,
    geneTranscriptMode: track.kind === 'genes' && track.geneTranscriptMode === 'all' ? 'all' as const : track.kind === 'genes' ? 'canonical' as const : undefined,
    geneShowTssIndicators: track.kind === 'genes' && typeof track.geneShowTssIndicators === 'boolean' ? track.geneShowTssIndicators : undefined,
    intervalDisplayMode: track.kind === 'interval' && (track.intervalDisplayMode === 'collapsed' || track.intervalDisplayMode === 'expanded' || track.intervalDisplayMode === 'squished')
      ? track.intervalDisplayMode
      : track.kind === 'interval' ? 'collapsed' : undefined,
    intervalShowLabels: track.kind === 'interval' ? track.intervalShowLabels !== false : undefined,
    intervalColorMode: track.kind === 'interval' && ['item-rgb', 'strand', 'score'].includes(track.intervalColorMode as string) ? track.intervalColorMode as IntervalColorMode : track.kind === 'interval' ? 'track' as IntervalColorMode : undefined,
    intervalMinScore: track.kind === 'interval' && typeof track.intervalMinScore === 'number' && Number.isFinite(track.intervalMinScore) ? track.intervalMinScore : undefined,
    intervalMaxRows: track.kind === 'interval' && typeof track.intervalMaxRows === 'number' && Number.isFinite(track.intervalMaxRows) ? Math.max(1, Math.min(100, Math.round(track.intervalMaxRows))) : undefined,
    interactionDirection: track.kind === 'interaction' && (track.interactionDirection === 'up' || track.interactionDirection === 'down')
      ? track.interactionDirection
      : track.kind === 'interaction' ? 'up' : undefined,
    interactionFilterMode: track.kind === 'interaction' && (track.interactionFilterMode === 'genes' || track.interactionFilterMode === 'visible-genes')
      ? track.interactionFilterMode
      : track.kind === 'interaction' ? ('all' as InteractionFilterMode) : undefined,
    interactionFilterGenes: track.kind === 'interaction' && Array.isArray(track.interactionFilterGenes)
      ? [...new Set(track.interactionFilterGenes.filter((gene: unknown): gene is string => typeof gene === 'string').map((gene: string) => gene.trim()).filter(Boolean))].slice(0, 100)
      : undefined,
    interactionMinScore: track.kind === 'interaction' && typeof track.interactionMinScore === 'number' && Number.isFinite(track.interactionMinScore) ? track.interactionMinScore : undefined,
    interactionMaxDistance: track.kind === 'interaction' && typeof track.interactionMaxDistance === 'number' && Number.isFinite(track.interactionMaxDistance) && track.interactionMaxDistance > 0 ? Math.round(track.interactionMaxDistance) : undefined,
    interactionMaxFeatures: track.kind === 'interaction' && typeof track.interactionMaxFeatures === 'number' && Number.isFinite(track.interactionMaxFeatures) ? Math.max(1, Math.min(10_000, Math.round(track.interactionMaxFeatures))) : track.kind === 'interaction' ? 2_000 : undefined,
    interactionLineWidth: track.kind === 'interaction' && typeof track.interactionLineWidth === 'number' && Number.isFinite(track.interactionLineWidth) ? Math.max(0.25, Math.min(10, track.interactionLineWidth)) : track.kind === 'interaction' ? 1 : undefined,
    interactionOpacity: track.kind === 'interaction' && typeof track.interactionOpacity === 'number' && Number.isFinite(track.interactionOpacity) ? Math.max(10, Math.min(100, Math.round(track.interactionOpacity))) : track.kind === 'interaction' ? 92 : undefined,
    interactionArcHeightMode: track.kind === 'interaction' && track.interactionArcHeightMode === 'fixed' ? 'fixed' as const : track.kind === 'interaction' ? 'distance' as const : undefined,
    interactionShowAnchors: track.kind === 'interaction' ? track.interactionShowAnchors !== false : undefined,
    interactionShowNames: track.kind === 'interaction' ? track.interactionShowNames === true : undefined,
    interactionColorMode: track.kind === 'interaction' && (track.interactionColorMode === 'item-rgb' || track.interactionColorMode === 'score') ? track.interactionColorMode as InteractionColorMode : track.kind === 'interaction' ? 'track' as InteractionColorMode : undefined,
    matrixDirection: track.kind === 'matrix' && (track.matrixDirection === 'up' || track.matrixDirection === 'down')
      ? track.matrixDirection
      : track.kind === 'matrix' ? 'up' : undefined,
    matrixResolution: track.kind === 'matrix' && typeof track.matrixResolution === 'number' && Number.isSafeInteger(track.matrixResolution) && track.matrixResolution > 0
      ? track.matrixResolution
      : undefined,
    matrixNormalization: track.kind === 'matrix' && typeof track.matrixNormalization === 'string' && track.matrixNormalization.trim()
      ? track.matrixNormalization.trim()
      : track.kind === 'matrix' ? 'raw' : undefined,
    matrixValueMode: track.kind === 'matrix' && !track.matrixSecondaryRegion && (track.matrixValueMode === 'observed-expected' || track.matrixValueMode === 'log2-observed-expected') ? track.matrixValueMode as 'observed-expected' | 'log2-observed-expected' : track.kind === 'matrix' ? 'observed' as const : undefined,
    matrixComparisonMode: track.kind === 'matrix' && ['difference', 'ratio', 'log2-ratio'].includes(track.matrixComparisonMode as string) ? track.matrixComparisonMode as 'difference' | 'ratio' | 'log2-ratio' : undefined,
    matrixSecondaryRegion: track.kind === 'matrix' && sources.some((source) => source.id === track.sourceIds[0] && ['hic', 'cool', 'mcool'].includes(source.format))
      && isRegion(track.matrixSecondaryRegion) && track.matrixSecondaryRegion.start >= 0
      ? { ...track.matrixSecondaryRegion } : undefined,
    matrixOverlayInteractionTrackId: track.kind === 'matrix' && typeof track.matrixOverlayInteractionTrackId === 'string'
      ? track.matrixOverlayInteractionTrackId : undefined,
    matrixOverlayFocusMode: track.kind === 'matrix' && (track.matrixOverlayFocusMode === 'genes' || track.matrixOverlayFocusMode === 'region')
      ? track.matrixOverlayFocusMode : track.kind === 'matrix' ? 'all' as const : undefined,
    matrixOverlayFocusGenes: track.kind === 'matrix' && Array.isArray(track.matrixOverlayFocusGenes)
      ? [...new Set(track.matrixOverlayFocusGenes.filter((gene: unknown): gene is string => typeof gene === 'string').map((gene: string) => gene.trim().toLocaleUpperCase()).filter(Boolean))].slice(0, 100)
      : undefined,
    matrixOverlayFocusRegion: track.kind === 'matrix' && isRegion(track.matrixOverlayFocusRegion) && track.matrixOverlayFocusRegion.start >= 0
      ? { ...track.matrixOverlayFocusRegion } : undefined,
    matrixOverlayMaxFeatures: track.kind === 'matrix' && typeof track.matrixOverlayMaxFeatures === 'number' && Number.isFinite(track.matrixOverlayMaxFeatures)
      ? Math.max(1, Math.min(2_000, Math.round(track.matrixOverlayMaxFeatures))) : track.kind === 'matrix' ? 250 : undefined,
    matrixTransform: track.kind === 'matrix' && track.matrixTransform === 'linear' ? 'linear' as const : track.kind === 'matrix' ? 'log1p' as const : undefined,
    matrixScaleMode: track.kind === 'matrix' && (track.matrixScaleMode === 'maximum' || track.matrixScaleMode === 'percentile' || track.matrixScaleMode === 'fixed')
      ? track.matrixScaleMode
      : track.kind === 'matrix' ? (track.matrixScaleMax === undefined ? 'percentile' as const : 'fixed' as const) : undefined,
    matrixScaleMin: track.kind === 'matrix' && typeof track.matrixScaleMin === 'number' && Number.isFinite(track.matrixScaleMin) && track.matrixScaleMin >= 0
      ? track.matrixScaleMin
      : track.kind === 'matrix' ? 0 : undefined,
    matrixScaleMax: track.kind === 'matrix' && typeof track.matrixScaleMax === 'number' && Number.isFinite(track.matrixScaleMax) && track.matrixScaleMax > 0
      ? track.matrixScaleMax
      : undefined,
    matrixScalePercentile: track.kind === 'matrix' && typeof track.matrixScalePercentile === 'number' && Number.isFinite(track.matrixScalePercentile)
      ? Math.max(0.5, Math.min(1, track.matrixScalePercentile))
      : track.kind === 'matrix' ? 0.99 : undefined,
    matrixIgnoreDiagonals: track.kind === 'matrix' && typeof track.matrixIgnoreDiagonals === 'number' && Number.isFinite(track.matrixIgnoreDiagonals)
      ? Math.max(0, Math.min(100, Math.round(track.matrixIgnoreDiagonals)))
      : track.kind === 'matrix' ? 3 : undefined,
    matrixDepthMode: track.kind === 'matrix' && (track.matrixDepthMode === 'auto' || track.matrixDepthMode === 'full' || track.matrixDepthMode === 'fixed')
      ? track.matrixDepthMode
      : track.kind === 'matrix' ? 'full' as const : undefined,
    matrixMaxDistance: track.kind === 'matrix' && typeof track.matrixMaxDistance === 'number' && Number.isSafeInteger(track.matrixMaxDistance) && track.matrixMaxDistance > 0
      ? track.matrixMaxDistance
      : undefined,
    matrixPalette: track.kind === 'matrix' && (track.matrixPalette === 'warm' || track.matrixPalette === 'blue-black' || track.matrixPalette === 'custom' || (track.matrixPalette as string) === 'warm-dark')
      ? (track.matrixPalette as string) === 'warm-dark' ? 'blue-black' : track.matrixPalette
      : track.kind === 'matrix' ? 'monochrome' as const : undefined,
    matrixPaletteReversed: track.kind === 'matrix' && track.matrixPaletteReversed === true ? true : undefined,
    matrixPaletteColors: track.kind === 'matrix' && Array.isArray(track.matrixPaletteColors)
      ? track.matrixPaletteColors.filter((color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 8)
      : undefined,
    matrixZeroStyle: track.kind === 'matrix' && (track.matrixZeroStyle === 'low-color' || track.matrixZeroStyle === 'custom')
      ? track.matrixZeroStyle
      : track.kind === 'matrix' ? 'background' as const : undefined,
    matrixZeroColor: track.kind === 'matrix' && typeof track.matrixZeroColor === 'string' && /^#[0-9a-f]{6}$/i.test(track.matrixZeroColor)
      ? track.matrixZeroColor
      : undefined,
    matrixMissingStyle: track.kind === 'matrix' && track.matrixMissingStyle === 'custom'
      ? 'custom' as const
      : track.kind === 'matrix' ? 'background' as const : undefined,
    matrixMissingColor: track.kind === 'matrix' && typeof track.matrixMissingColor === 'string' && /^#[0-9a-f]{6}$/i.test(track.matrixMissingColor)
      ? track.matrixMissingColor
      : undefined,
    matrixMaskedStyle: track.kind === 'matrix' && (track.matrixMaskedStyle === 'background' || track.matrixMaskedStyle === 'custom')
      ? track.matrixMaskedStyle
      : track.kind === 'matrix' ? 'hatch' as const : undefined,
    matrixMaskedColor: track.kind === 'matrix' && typeof track.matrixMaskedColor === 'string' && /^#[0-9a-f]{6}$/i.test(track.matrixMaskedColor)
      ? track.matrixMaskedColor
      : undefined,
    alignmentDisplayMode: track.kind === 'alignment' && (track.alignmentDisplayMode === 'collapsed' || track.alignmentDisplayMode === 'expanded' || track.alignmentDisplayMode === 'squished')
      ? track.alignmentDisplayMode
      : track.kind === 'alignment' ? 'expanded' : undefined,
    bamViewMode: track.kind === 'alignment' && (track.bamViewMode === 'coverage' || track.bamViewMode === 'alignments' || track.bamViewMode === 'both') ? track.bamViewMode : track.kind === 'alignment' ? 'both' : undefined,
    bamColorMode: track.kind === 'alignment' && (track.bamColorMode === 'track' || track.bamColorMode === 'strand' || track.bamColorMode === 'pair-orientation' || track.bamColorMode === 'mapping-quality') ? track.bamColorMode : track.kind === 'alignment' ? 'track' : undefined,
    bamViewAsPairs: track.kind === 'alignment' ? track.bamViewAsPairs === true : undefined,
    bamShowMismatches: track.kind === 'alignment' ? track.bamShowMismatches !== false : undefined,
    bamMinMapq: track.kind === 'alignment' && typeof track.bamMinMapq === 'number' && Number.isFinite(track.bamMinMapq) ? Math.max(0, Math.min(255, Math.round(track.bamMinMapq))) : track.kind === 'alignment' ? 0 : undefined,
    bamIncludeDuplicates: track.kind === 'alignment' ? track.bamIncludeDuplicates === true : undefined,
    bamIncludeSecondary: track.kind === 'alignment' ? track.bamIncludeSecondary === true : undefined,
    bamIncludeSupplementary: track.kind === 'alignment' ? track.bamIncludeSupplementary === true : undefined,
    bamSortMode: track.kind === 'alignment' && ['strand', 'mapq', 'insert-size'].includes(track.bamSortMode as string) ? track.bamSortMode as 'strand' | 'mapq' | 'insert-size' : track.kind === 'alignment' ? 'start' as const : undefined,
    bamGroupMode: track.kind === 'alignment' && (track.bamGroupMode === 'strand' || track.bamGroupMode === 'read-group' || track.bamGroupMode === 'tag') ? track.bamGroupMode : track.kind === 'alignment' ? 'none' as const : undefined,
    bamGroupTag: track.kind === 'alignment' && typeof track.bamGroupTag === 'string' && /^[A-Za-z][A-Za-z0-9]$/.test(track.bamGroupTag) ? track.bamGroupTag : undefined,
    bamMaxReads: track.kind === 'alignment' && typeof track.bamMaxReads === 'number' && Number.isFinite(track.bamMaxReads) ? Math.max(100, Math.min(100_000, Math.round(track.bamMaxReads))) : track.kind === 'alignment' ? 10_000 : undefined,
    bamShowInsertions: track.kind === 'alignment' ? track.bamShowInsertions !== false : undefined,
    bamShowDeletions: track.kind === 'alignment' ? track.bamShowDeletions !== false : undefined,
    bamShowSoftClips: track.kind === 'alignment' ? track.bamShowSoftClips !== false : undefined,
    bamMinMismatchBaseq: track.kind === 'alignment' && typeof track.bamMinMismatchBaseq === 'number' && Number.isFinite(track.bamMinMismatchBaseq) ? Math.max(0, Math.min(93, Math.round(track.bamMinMismatchBaseq))) : track.kind === 'alignment' ? 0 : undefined,
    bamMinAlleleFrequency: track.kind === 'alignment' && typeof track.bamMinAlleleFrequency === 'number' && Number.isFinite(track.bamMinAlleleFrequency) ? Math.max(0, Math.min(1, track.bamMinAlleleFrequency)) : track.kind === 'alignment' ? 0 : undefined,
  })) : []
  const document: TrackDocument = {
    schemaVersion: TRACK_DOCUMENT_VERSION,
    referenceId: value.referenceId,
    region: { ...value.region },
    sources,
    tracks,
    groups,
    scales,
    savedRegions,
    comparisonDivider,
  }
  for (const track of document.tracks) {
    const sourceFormat = document.sources.find((source) => track.sourceIds.includes(source.id))?.format
    const source = document.sources.find((candidate) => candidate.id === track.sourceIds[0])
    if (track.kind === 'interaction' && track.interactionFilterMode === 'genes' && !track.interactionFilterGenes?.length) {
      track.interactionFilterMode = 'all'
    }
    if (track.kind === 'signal' && !track.signalStrand && source) {
      const inferred = inferSignalStrand(source.name)
      if (inferred) {
        track.signalStrand = inferred.strand
        track.strandBaseLabel = inferred.baseLabel
        source.strand = inferred.strand
        source.strandBaseLabel = inferred.baseLabel
      }
    }
    if (track.kind === 'signal' && sourceFormat === 'bam') {
      track.kind = 'alignment'
      track.scaleBindingId = undefined
      track.alignmentDisplayMode = 'expanded'
      track.bamViewMode = 'both'
      track.bamColorMode = 'track'
      track.bamViewAsPairs = false
      track.bamShowMismatches = true
      track.bamMinMapq = 0
    }
    if (track.kind === 'genes' && track.displayGroupId === 'reference-annotation') track.displayGroupId = undefined
    if ((track.kind === 'signal' || track.kind === 'stranded') && !track.scaleBindingId) {
      const binding = { id: crypto.randomUUID(), label: track.label, mode: 'auto-visible' as const, includeZero: true }
      document.scales.push(binding)
      track.scaleBindingId = binding.id
    }
    if (track.kind === 'stranded' && !track.negativeScaleBindingId) {
      const binding = { id: crypto.randomUUID(), label: `${track.label} minus`, mode: 'auto-visible' as const, includeZero: true }
      document.scales.push(binding)
      track.negativeScaleBindingId = binding.id
    }
  }
  if (value.schemaVersion < TRACK_DOCUMENT_VERSION) autoPairStrandedTracks(document)
  pruneDocument(document)
  return document
}

export function cloneDocument(document: TrackDocument): TrackDocument {
  return structuredClone(document)
}

function pruneDocument(document: TrackDocument): void {
  const interactionTrackIds = new Set(document.tracks.filter((track) => track.kind === 'interaction').map((track) => track.id))
  for (const track of document.tracks) {
    if (track.kind !== 'matrix') continue
    if (!track.matrixOverlayInteractionTrackId || !interactionTrackIds.has(track.matrixOverlayInteractionTrackId)) {
      delete track.matrixOverlayInteractionTrackId
      delete track.matrixOverlayFocusMode
      delete track.matrixOverlayFocusGenes
      delete track.matrixOverlayFocusRegion
      delete track.matrixOverlayMaxFeatures
      continue
    }
    if (track.matrixOverlayFocusMode === 'genes' && !track.matrixOverlayFocusGenes?.length) track.matrixOverlayFocusMode = 'all'
    if (track.matrixOverlayFocusMode === 'region' && !track.matrixOverlayFocusRegion) track.matrixOverlayFocusMode = 'all'
    if (track.matrixOverlayFocusMode !== 'genes') delete track.matrixOverlayFocusGenes
    if (track.matrixOverlayFocusMode !== 'region') delete track.matrixOverlayFocusRegion
  }
  const usedSources = new Set(document.tracks.flatMap((track) => track.sourceIds))
  const usedGroups = new Set(document.tracks.map((track) => track.displayGroupId).filter(Boolean))
  const usedScales = new Set(document.tracks.flatMap((track) => [track.scaleBindingId, track.negativeScaleBindingId]).filter(Boolean))
  document.sources = document.sources.filter((source) => usedSources.has(source.id))
  document.groups = document.groups.filter((group) => usedGroups.has(group.id))
  document.scales = document.scales.filter((scale) => usedScales.has(scale.id))
}

function makeGroupContiguous(document: TrackDocument, groupId: string): void {
  const memberIndexes = document.tracks.map((track, index) => track.displayGroupId === groupId ? index : -1).filter((index) => index >= 0)
  if (memberIndexes.length < 2) return
  const insertionIndex = Math.min(...memberIndexes)
  const members = document.tracks.filter((track) => track.displayGroupId === groupId)
  const others = document.tracks.filter((track) => track.displayGroupId !== groupId)
  const beforeCount = document.tracks.slice(0, insertionIndex).filter((track) => track.displayGroupId !== groupId).length
  others.splice(beforeCount, 0, ...members)
  document.tracks = others
}

function safeDomain(min: number, max: number, includeZero: boolean): { min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (min > max) [min, max] = [max, min]
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max) }
  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.05)
    min -= padding
    max += padding
  }
  return { min, max }
}

function sameRegion(a: Region, b: Region): boolean {
  return a.chr === b.chr && a.start === b.start && a.end === b.end
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function isRegion(value: unknown): value is Region {
  return isRecord(value) && typeof value.chr === 'string' && Number.isFinite(value.start) && Number.isFinite(value.end) && value.end > value.start
}

function isSourceSpec(value: unknown): value is TrackSourceSpec {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && ['bigwig', 'bedgraph', 'tdf', 'bam', 'bed', 'bedpe', 'hic', 'cool', 'mcool', 'matrix-comparison', 'matrix-derived'].includes(value.format) && Array.isArray(value.files) && value.files.every(isSourceFileSpec)
    && (value.format !== 'matrix-comparison' || (value.files.length === 2 && value.files[0].role === 'signal' && value.files[1].role === 'comparison'))
    && (value.format !== 'matrix-derived' || (value.files.length === 1 && value.files[0].role === 'signal'
      && ['insulation', 'compartment'].includes(value.matrixDerivedMode) && typeof value.matrixDerivedNormalization === 'string'
      && (value.matrixDerivedResolution === undefined || (Number.isSafeInteger(value.matrixDerivedResolution) && value.matrixDerivedResolution > 0))))
    && (value.strand === undefined || value.strand === 'plus' || value.strand === 'minus')
    && (value.strandBaseLabel === undefined || typeof value.strandBaseLabel === 'string')
}

function isSourceFileSpec(value: unknown): value is SourceFileSpec {
  return isRecord(value) && typeof value.name === 'string' && Number.isFinite(value.size)
    && Number.isFinite(value.lastModified) && ['signal', 'index', 'comparison'].includes(value.role)
    && (value.path === undefined || typeof value.path === 'string')
}

function isGroup(value: unknown): value is DisplayGroup {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string'
    && (value.color === undefined || typeof value.color === 'string')
    && (value.positiveColor === undefined || typeof value.positiveColor === 'string')
    && (value.negativeColor === undefined || typeof value.negativeColor === 'string')
    && (value.scaleBehavior === undefined || ['linked', 'independent'].includes(value.scaleBehavior))
}

function isScale(value: unknown): value is ScaleBinding {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string'
    && ['auto-visible', 'auto-percentile', 'fixed'].includes(value.mode) && typeof value.includeZero === 'boolean'
}

function isTrack(value: unknown, legacyHeight = false): value is TrackSpec {
  return isRecord(value) && typeof value.id === 'string' && ['signal', 'stranded', 'interval', 'interaction', 'matrix', 'alignment', 'genes'].includes(value.kind)
    && Array.isArray(value.sourceIds) && value.sourceIds.every((id: unknown) => typeof id === 'string')
    && typeof value.label === 'string' && typeof value.color === 'string' && typeof value.enabled === 'boolean'
    && Number.isFinite(value.height) && value.height >= (legacyHeight ? 0.5 : 1) && value.height <= (legacyHeight ? 3 : 100)
    && (value.pane === undefined || value.pane === 'main' || value.pane === 'bottom')
}

function legacyHeightScore(kind: TrackSpec['kind'], multiplier: number): number {
  const pixels = (kind === 'genes' ? 118 : 132) * multiplier
  const score = kind === 'genes' ? (pixels - 16) / 3.2 : (pixels - 16) / 3.6
  return Math.max(1, Math.min(100, Math.round(score)))
}

function cloneSource(source: TrackSourceSpec): TrackSourceSpec {
  return { ...source, files: source.files.map((file) => ({ ...file })) }
}

function strandBaseKey(label: string): string {
  return label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')
}

function scaleChannelRefs(track: TrackSpec): Array<{ track: TrackSpec; channel: SignalScaleChannel; scaleBindingId?: string }> {
  if (track.kind === 'stranded') return [
    { track, channel: 'plus', scaleBindingId: track.scaleBindingId },
    { track, channel: 'minus', scaleBindingId: track.negativeScaleBindingId },
  ]
  if (track.kind === 'signal') return [{ track, channel: track.signalStrand ?? 'ordinary', scaleBindingId: track.scaleBindingId }]
  return []
}

function setScaleChannelBinding(track: TrackSpec, channel: SignalScaleChannel, scaleBindingId: string): void {
  if (channel === 'minus' && track.kind === 'stranded') track.negativeScaleBindingId = scaleBindingId
  else track.scaleBindingId = scaleBindingId
}

function cloneScale(scale: ScaleBinding): ScaleBinding {
  const limits = scale.limits && Number.isFinite(scale.limits.min) && Number.isFinite(scale.limits.max)
    ? { ...scale.limits }
    : undefined
  return {
    ...scale,
    limits,
    percentile: typeof scale.percentile === 'number' && Number.isFinite(scale.percentile) ? Math.max(0.5, Math.min(1, scale.percentile)) : undefined,
    symmetric: scale.symmetric === true ? true : undefined,
    transform: scale.transform === 'log1p' || scale.transform === 'symlog' ? scale.transform : undefined,
  }
}
