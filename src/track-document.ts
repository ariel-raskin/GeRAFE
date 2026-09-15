import type { Region, SignalFeature } from './types.ts'

export const TRACK_DOCUMENT_VERSION = 4 as const
export const TRACK_COLORS = ['#6d55e0', '#d95d74', '#169b8f', '#d88928', '#3478c9'] as const

export type SourceFormat = 'bigwig' | 'bedgraph' | 'tdf' | 'bam' | 'bed'
export type ScaleMode = 'auto-visible' | 'fixed'

export interface SourceFileSpec {
  name: string
  size: number
  lastModified: number
  role: 'signal' | 'index'
  /** Native desktop path. Browser-only files omit this and need relinking after restart. */
  path?: string
}

export interface TrackSourceSpec {
  id: string
  name: string
  format: SourceFormat
  files: SourceFileSpec[]
}

export interface DisplayGroup {
  id: string
  label: string
  color?: string
  scaleBehavior?: 'linked' | 'independent'
}

export interface ScaleBinding {
  id: string
  label: string
  mode: ScaleMode
  includeZero: boolean
  limits?: { min: number; max: number }
}

export interface TrackSpec {
  id: string
  kind: 'signal' | 'interval' | 'alignment' | 'genes'
  sourceIds: string[]
  label: string
  color: string
  enabled: boolean
  height: number
  pane: 'main' | 'bottom'
  geneDisplayMode?: 'collapsed' | 'expanded' | 'squished'
  intervalDisplayMode?: 'collapsed' | 'expanded' | 'squished'
  alignmentDisplayMode?: 'collapsed' | 'expanded' | 'squished'
  bamViewMode?: 'coverage' | 'alignments' | 'both'
  bamColorMode?: 'track' | 'strand' | 'pair-orientation' | 'mapping-quality'
  bamViewAsPairs?: boolean
  bamShowMismatches?: boolean
  bamMinMapq?: number
  bamIncludeDuplicates?: boolean
  bamIncludeSecondary?: boolean
  bamIncludeSupplementary?: boolean
  displayGroupId?: string
  scaleBindingId?: string
}

export interface TrackDocument {
  schemaVersion: typeof TRACK_DOCUMENT_VERSION
  referenceId: string
  region: Region
  sources: TrackSourceSpec[]
  tracks: TrackSpec[]
  groups: DisplayGroup[]
  scales: ScaleBinding[]
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

export function createTrackDocument(referenceId: string, region: Region): TrackDocument {
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
    }],
    groups: [],
    scales: [],
  }
}

export function addSignalTrack(
  draft: TrackDocument,
  source: TrackSourceSpec,
  options: { id?: string; label?: string; color?: string } = {},
): TrackSpec {
  const id = options.id ?? crypto.randomUUID()
  const scaleBindingId = crypto.randomUUID()
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
  }
  draft.sources.push(source)
  draft.scales.push({ id: scaleBindingId, label: track.label, mode: 'auto-visible', includeZero: true })
  const bottomIndex = draft.tracks.findIndex((item) => item.pane === 'bottom')
  draft.tracks.splice(bottomIndex < 0 ? draft.tracks.length : bottomIndex, 0, track)
  return track
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
    height: 32,
    pane: 'main',
    intervalDisplayMode: 'collapsed',
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
  const scaleBindingId = original.kind === 'signal' ? crypto.randomUUID() : undefined
  const copy: TrackSpec = {
    ...original,
    id: crypto.randomUUID(),
    sourceIds: [...original.sourceIds],
    label: `${original.label} copy`,
    scaleBindingId,
  }
  draft.tracks.splice(index + 1, 0, copy)
  if (scaleBindingId) draft.scales.push({ id: scaleBindingId, label: copy.label, mode: 'auto-visible', includeZero: true })
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
    pane = groupMembers[0].pane
  } else {
    for (const track of draft.tracks) {
      if (!movingIds.has(track.id) || !track.displayGroupId) continue
      for (const member of draft.tracks) if (member.displayGroupId === track.displayGroupId) movingIds.add(member.id)
    }
  }
  const moving = draft.tracks.filter((track) => movingIds.has(track.id))
  if (!moving.length) return
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
}

export function assignDisplayGroup(draft: TrackDocument, trackIds: readonly string[], label: string): void {
  const cleanLabel = label.trim()
  if (!cleanLabel) {
    for (const track of draft.tracks) if (trackIds.includes(track.id)) track.displayGroupId = undefined
    pruneDocument(draft)
    return
  }
  let group = draft.groups.find((item) => item.label.toLocaleLowerCase() === cleanLabel.toLocaleLowerCase())
  if (!group) {
    group = { id: crypto.randomUUID(), label: cleanLabel }
    draft.groups.push(group)
  }
  const existingMember = draft.tracks.find((track) => track.displayGroupId === group.id)
  const firstTarget = draft.tracks.find((track) => trackIds.includes(track.id))
  const pane = existingMember?.pane ?? firstTarget?.pane
  for (const track of draft.tracks) if (trackIds.includes(track.id)) {
    track.displayGroupId = group.id
    if (pane) track.pane = pane
  }
  if (group.color) for (const track of draft.tracks) if (track.displayGroupId === group.id) track.color = group.color
  makeGroupContiguous(draft, group.id)
  const members = draft.tracks.filter((track) => track.kind === 'signal' && track.displayGroupId === group.id).map((track) => track.id)
  if (group.scaleBehavior === 'linked') linkScales(draft, members)
  if (group.scaleBehavior === 'independent') unlinkScales(draft, trackIds)
  pruneDocument(draft)
}

export function linkScales(draft: TrackDocument, trackIds: readonly string[]): void {
  const targets = draft.tracks.filter((track) => track.kind === 'signal' && trackIds.includes(track.id))
  if (targets.length < 2) return
  const previous = targets.map((track) => draft.scales.find((scale) => scale.id === track.scaleBindingId)).find(Boolean)
  const binding: ScaleBinding = {
    id: crypto.randomUUID(),
    label: `Linked scale (${targets.length})`,
    mode: previous?.mode ?? 'auto-visible',
    includeZero: previous?.includeZero ?? true,
    limits: previous?.limits ? { ...previous.limits } : undefined,
  }
  draft.scales.push(binding)
  for (const track of targets) track.scaleBindingId = binding.id
  pruneDocument(draft)
}

export function unlinkScales(draft: TrackDocument, trackIds: readonly string[]): void {
  for (const track of draft.tracks) {
    if (track.kind !== 'signal' || !trackIds.includes(track.id)) continue
    const existing = draft.scales.find((scale) => scale.id === track.scaleBindingId)
    const binding: ScaleBinding = {
      id: crypto.randomUUID(),
      label: track.label,
      mode: existing?.mode ?? 'auto-visible',
      includeZero: existing?.includeZero ?? true,
      limits: existing?.limits ? { ...existing.limits } : undefined,
    }
    draft.scales.push(binding)
    track.scaleBindingId = binding.id
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
      result.set(binding.id, safeDomain(binding.limits.min, binding.limits.max, binding.includeZero))
      continue
    }
    let min = binding.includeZero ? 0 : Number.POSITIVE_INFINITY
    let max = binding.includeZero ? 0 : Number.NEGATIVE_INFINITY
    for (const track of document.tracks) {
      if (!track.enabled || track.scaleBindingId !== binding.id) continue
      for (const feature of featuresByTrack.get(track.id) ?? []) {
        min = Math.min(min, feature.score)
        max = Math.max(max, feature.score)
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1 }
    result.set(binding.id, safeDomain(min, max, binding.includeZero))
  }
  return result
}

export function normalizeTrackDocument(value: unknown): TrackDocument {
  if (!isRecord(value) || ![1, 2, 3, TRACK_DOCUMENT_VERSION].includes(value.schemaVersion)) throw new Error('This is not a supported Locus Glide workspace file.')
  if (typeof value.referenceId !== 'string' || !isRegion(value.region)) throw new Error('The workspace is missing a valid reference or region.')
  const sources = Array.isArray(value.sources) ? value.sources.filter(isSourceSpec).map(cloneSource) : []
  const groups = Array.isArray(value.groups) ? value.groups.filter(isGroup).map((group) => ({ ...group })) : []
  const scales = Array.isArray(value.scales) ? value.scales.filter(isScale).map(cloneScale) : []
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
    pane: track.pane === 'main' || track.pane === 'bottom' ? track.pane : track.kind === 'genes' ? 'bottom' : 'main',
    sourceIds: track.sourceIds.filter((id) => sourceIds.has(id)),
    displayGroupId: track.displayGroupId && groupIds.has(track.displayGroupId) ? track.displayGroupId : undefined,
    scaleBindingId: track.scaleBindingId && scaleIds.has(track.scaleBindingId) ? track.scaleBindingId : undefined,
    geneDisplayMode: track.kind === 'genes' && (track.geneDisplayMode === 'collapsed' || track.geneDisplayMode === 'expanded' || track.geneDisplayMode === 'squished')
      ? track.geneDisplayMode
      : track.kind === 'genes' ? 'collapsed' : undefined,
    intervalDisplayMode: track.kind === 'interval' && (track.intervalDisplayMode === 'collapsed' || track.intervalDisplayMode === 'expanded' || track.intervalDisplayMode === 'squished')
      ? track.intervalDisplayMode
      : track.kind === 'interval' ? 'collapsed' : undefined,
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
  })) : []
  const document: TrackDocument = {
    schemaVersion: TRACK_DOCUMENT_VERSION,
    referenceId: value.referenceId,
    region: { ...value.region },
    sources,
    tracks,
    groups,
    scales,
  }
  for (const track of document.tracks) {
    const sourceFormat = document.sources.find((source) => track.sourceIds.includes(source.id))?.format
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
    if (track.kind === 'signal' && !track.scaleBindingId) {
      const binding = { id: crypto.randomUUID(), label: track.label, mode: 'auto-visible' as const, includeZero: true }
      document.scales.push(binding)
      track.scaleBindingId = binding.id
    }
  }
  pruneDocument(document)
  return document
}

export function cloneDocument(document: TrackDocument): TrackDocument {
  return structuredClone(document)
}

function pruneDocument(document: TrackDocument): void {
  const usedSources = new Set(document.tracks.flatMap((track) => track.sourceIds))
  const usedGroups = new Set(document.tracks.map((track) => track.displayGroupId).filter(Boolean))
  const usedScales = new Set(document.tracks.map((track) => track.scaleBindingId).filter(Boolean))
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
    && ['bigwig', 'bedgraph', 'tdf', 'bam', 'bed'].includes(value.format) && Array.isArray(value.files) && value.files.every(isSourceFileSpec)
}

function isSourceFileSpec(value: unknown): value is SourceFileSpec {
  return isRecord(value) && typeof value.name === 'string' && Number.isFinite(value.size)
    && Number.isFinite(value.lastModified) && ['signal', 'index'].includes(value.role)
    && (value.path === undefined || typeof value.path === 'string')
}

function isGroup(value: unknown): value is DisplayGroup {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string'
    && (value.color === undefined || typeof value.color === 'string')
    && (value.scaleBehavior === undefined || ['linked', 'independent'].includes(value.scaleBehavior))
}

function isScale(value: unknown): value is ScaleBinding {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string'
    && ['auto-visible', 'fixed'].includes(value.mode) && typeof value.includeZero === 'boolean'
}

function isTrack(value: unknown, legacyHeight = false): value is TrackSpec {
  return isRecord(value) && typeof value.id === 'string' && ['signal', 'interval', 'alignment', 'genes'].includes(value.kind)
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

function cloneScale(scale: ScaleBinding): ScaleBinding {
  const limits = scale.limits && Number.isFinite(scale.limits.min) && Number.isFinite(scale.limits.max)
    ? { ...scale.limits }
    : undefined
  return { ...scale, limits }
}
