import { cloneDocument, normalizeTrackDocument, type TrackDocument, type TrackSpec } from './track-document.ts'
import type { Region } from './types.ts'

export const FIGURE_DOCUMENT_VERSION = 1 as const

export interface FigurePage {
  widthMm: number
  /** Zero fits the page to its contents. */
  heightMm: number
  marginMm: number
  labelWidthMm: number
  columnGapMm: number
  rowGapMm: number
  rulerHeightMm: number
  title: string
  fontFamily: string
  fontSizePt: number
  background: string
}

export interface FigureRow {
  id: string
  label: string
  groupLabel?: string
  trackIds: string[]
  heightMm: number
  gapAfterMm: number
  labelFontSizePt?: number
  labelColor?: string
  frameColor?: string
  frameWidthPt?: number
  included: boolean
}

export interface FigureColumn {
  id: string
  title: string
  region: Region
  /** A row may contain several source tracks when it represents a collapsed signal stack. */
  assignments: Record<string, string[]>
  /** Figure-only presentation overrides, keyed by row. */
  styles?: Record<string, FigureCellStyle>
}

export interface FigureCellStyle {
  color?: string
  negativeColor?: string
  opacity?: number
  renderStyle?: 'source' | 'fill' | 'line'
  scaleMode?: 'shared' | 'independent' | 'fixed'
  scaleMin?: number
  scaleMax?: number
  showScale?: boolean
}

export interface FigureDocument {
  schemaVersion: typeof FIGURE_DOCUMENT_VERSION
  id: string
  name: string
  referenceId: string
  sourceDocument: TrackDocument
  page: FigurePage
  rows: FigureRow[]
  columns: FigureColumn[]
  linkedRegions: boolean
}

export function createFigureDocument(source: TrackDocument): FigureDocument {
  const snapshot = cloneDocument(source)
  const rows: FigureRow[] = []
  const representedStacks = new Set<string>()
  for (const track of snapshot.tracks) {
    const group = track.displayGroupId ? snapshot.groups.find((candidate) => candidate.id === track.displayGroupId && candidate.signalStackMode === 'collapsed') : undefined
    if (group) {
      if (representedStacks.has(group.id)) continue
      representedStacks.add(group.id)
      const members = snapshot.tracks.filter((candidate) => candidate.displayGroupId === group.id)
      if (!members.length) continue
      rows.push(makeRow(track, members.map((member) => member.id), group.label))
    } else rows.push(makeRow(track, [track.id], track.label, track.displayGroupId ? snapshot.groups.find((candidate) => candidate.id === track.displayGroupId)?.label : undefined))
  }
  return {
    schemaVersion: FIGURE_DOCUMENT_VERSION,
    id: crypto.randomUUID(),
    name: 'Untitled figure',
    referenceId: snapshot.referenceId,
    sourceDocument: snapshot,
    page: {
      widthMm: 180, heightMm: 0, marginMm: 7, labelWidthMm: 30, columnGapMm: 8,
      rowGapMm: 1.5, rulerHeightMm: 9, title: '', fontFamily: 'Arial, sans-serif',
      fontSizePt: 9, background: '#ffffff',
    },
    rows,
    columns: [{ id: crypto.randomUUID(), title: '', region: { ...snapshot.region }, assignments: Object.fromEntries(rows.map((row) => [row.id, [...row.trackIds]])), styles: {} }],
    linkedRegions: false,
  }
}

function makeRow(track: TrackSpec, trackIds: string[], label = track.label, groupLabel?: string): FigureRow {
  return {
    id: crypto.randomUUID(), label, groupLabel, trackIds, included: true,
    heightMm: track.kind === 'matrix' ? 22 : track.kind === 'genes' ? 9 : 13,
    gapAfterMm: 0,
  }
}

export function cloneFigureDocument(document: FigureDocument): FigureDocument {
  return structuredClone(document)
}

export function normalizeFigureDocument(value: unknown): FigureDocument {
  if (!value || typeof value !== 'object') throw new Error('This is not a GeRAFE figure project.')
  const input = value as Partial<FigureDocument>
  if (input.schemaVersion !== FIGURE_DOCUMENT_VERSION) throw new Error(`Unsupported figure project version: ${String(input.schemaVersion)}.`)
  const sourceDocument = normalizeTrackDocument(input.sourceDocument)
  if (input.referenceId !== sourceDocument.referenceId || !Array.isArray(input.rows) || !Array.isArray(input.columns) || !input.page) throw new Error('The figure project is incomplete or inconsistent.')
  if (input.columns.length < 1 || input.columns.length > 2) throw new Error('A figure must have one or two columns.')
  const trackIds = new Set(sourceDocument.tracks.map((track) => track.id))
  const rowIds = new Set<string>()
  const rows = input.rows.map((row) => {
    if (!row || typeof row.id !== 'string' || rowIds.has(row.id) || !Array.isArray(row.trackIds) || row.trackIds.some((id) => !trackIds.has(id))) throw new Error('A figure row refers to an unavailable track.')
    rowIds.add(row.id)
    return {
      id: row.id, label: String(row.label ?? ''), groupLabel: row.groupLabel === undefined ? undefined : String(row.groupLabel), trackIds: [...row.trackIds], included: row.included !== false,
      heightMm: boundedNumber(row.heightMm, 2, 100, 13), gapAfterMm: boundedNumber(row.gapAfterMm, 0, 100, 0),
      labelFontSizePt: row.labelFontSizePt === undefined ? undefined : boundedNumber(row.labelFontSizePt, 4, 40, 9),
      labelColor: colorOrUndefined(row.labelColor), frameColor: colorOrUndefined(row.frameColor),
      frameWidthPt: row.frameWidthPt === undefined ? undefined : boundedNumber(row.frameWidthPt, 0, 8, 0.5),
    }
  })
  const columns = input.columns.map((column) => {
    if (!column || typeof column.id !== 'string' || !validRegion(column.region)) throw new Error('A figure column has an invalid genomic region.')
    const assignments: Record<string, string[]> = {}
    for (const row of rows) {
      const assigned = column.assignments?.[row.id] ?? row.trackIds
      if (!Array.isArray(assigned) || assigned.some((id) => !trackIds.has(id))) throw new Error('A figure column refers to an unavailable track.')
      assignments[row.id] = [...assigned]
    }
    const styles: Record<string, FigureCellStyle> = {}
    for (const [rowId, style] of Object.entries(column.styles ?? {})) {
      if (!rowIds.has(rowId) || !style || typeof style !== 'object') continue
      styles[rowId] = {
        color: colorOrUndefined(style.color), negativeColor: colorOrUndefined(style.negativeColor),
        opacity: style.opacity === undefined ? undefined : boundedNumber(style.opacity, 0, 100, 100),
        renderStyle: ['source', 'fill', 'line'].includes(style.renderStyle ?? '') ? style.renderStyle : undefined,
        scaleMode: ['shared', 'independent', 'fixed'].includes(style.scaleMode ?? '') ? style.scaleMode : undefined,
        scaleMin: typeof style.scaleMin === 'number' && Number.isFinite(style.scaleMin) ? style.scaleMin : undefined,
        scaleMax: typeof style.scaleMax === 'number' && Number.isFinite(style.scaleMax) ? style.scaleMax : undefined,
        showScale: style.showScale === undefined ? undefined : style.showScale === true,
      }
      if (styles[rowId].scaleMode === 'fixed' && (!(Number.isFinite(styles[rowId].scaleMin)) || !(Number.isFinite(styles[rowId].scaleMax)) || styles[rowId].scaleMax! <= styles[rowId].scaleMin!)) throw new Error('A fixed figure scale needs a minimum below its maximum.')
    }
    return { id: column.id, title: String(column.title ?? ''), region: { ...column.region }, assignments, styles }
  })
  const page = input.page
  return {
    schemaVersion: FIGURE_DOCUMENT_VERSION, id: String(input.id ?? crypto.randomUUID()), name: String(input.name ?? 'Untitled figure'),
    referenceId: sourceDocument.referenceId, sourceDocument, rows, columns, linkedRegions: input.linkedRegions === true,
    page: {
      widthMm: boundedNumber(page.widthMm, 50, 600, 180), heightMm: page.heightMm === 0 ? 0 : boundedNumber(page.heightMm, 50, 600, 0), marginMm: boundedNumber(page.marginMm, 0, 100, 7),
      labelWidthMm: boundedNumber(page.labelWidthMm, 0, 120, 30), columnGapMm: boundedNumber(page.columnGapMm, 0, 100, 8),
      rowGapMm: boundedNumber(page.rowGapMm, 0, 50, 1.5), rulerHeightMm: boundedNumber(page.rulerHeightMm, 0, 50, 9),
      title: String(page.title ?? ''), fontFamily: String(page.fontFamily ?? 'Arial, sans-serif'),
      fontSizePt: boundedNumber(page.fontSizePt, 4, 40, 9), background: colorOrUndefined(page.background) ?? '#ffffff',
    },
  }
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function colorOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}

function validRegion(value: unknown): value is Region {
  if (!value || typeof value !== 'object') return false
  const region = value as Region
  return typeof region.chr === 'string' && region.chr.length > 0 && Number.isSafeInteger(region.start) && Number.isSafeInteger(region.end) && region.start >= 0 && region.end > region.start
}

export class FigureDocumentStore {
  private currentDocument: FigureDocument
  private past: FigureDocument[] = []
  private future: FigureDocument[] = []

  constructor(document: FigureDocument) { this.currentDocument = normalizeFigureDocument(document) }
  get current(): FigureDocument { return this.currentDocument }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  edit(change: (draft: FigureDocument) => void): void {
    const next = cloneFigureDocument(this.currentDocument)
    change(next)
    const normalized = normalizeFigureDocument(next)
    if (JSON.stringify(normalized) === JSON.stringify(this.currentDocument)) return
    this.past.push(this.currentDocument)
    if (this.past.length > 100) this.past.shift()
    this.future = []
    this.currentDocument = normalized
  }

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(this.currentDocument)
    this.currentDocument = previous
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(this.currentDocument)
    this.currentDocument = next
  }
}

export function addFigureColumn(draft: FigureDocument, title = ''): void {
  if (draft.columns.length >= 2) throw new Error('The first Figure Editor supports up to two aligned columns.')
  const first = draft.columns[0]
  draft.columns.push({ id: crypto.randomUUID(), title, region: { ...first.region }, assignments: structuredClone(first.assignments), styles: structuredClone(first.styles ?? {}) })
}

export function setFigureColumnRegion(draft: FigureDocument, columnId: string, region: Region): void {
  if (!validRegion(region)) throw new Error('Enter a valid genomic region.')
  const column = draft.columns.find((candidate) => candidate.id === columnId)
  if (!column) return
  const before = column.region
  column.region = { ...region }
  if (draft.linkedRegions) for (const other of draft.columns) if (other.id !== columnId) {
    if (before.chr === region.chr && other.region.chr === before.chr) {
      const startDelta = region.start - before.start
      const endDelta = region.end - before.end
      other.region = { chr: other.region.chr, start: Math.max(0, other.region.start + startDelta), end: Math.max(1, other.region.end + endDelta) }
    } else other.region = { ...region }
  }
}
