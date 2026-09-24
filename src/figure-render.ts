import type { FigureCellStyle, FigureDocument, FigureRow } from './figure-document.ts'
import type { GeneSource } from './reference.ts'
import type { TrackSpec } from './track-document.ts'
import type { AlignmentCoverageFeature, AlignmentFeature, InteractionFeature, IntervalFeature, MatrixFeature, Region, SignalFeature, TrackFeature, TrackQueryOptions, TrackSource } from './types.ts'

export interface FigureRenderResult { svg: string; widthMm: number; heightMm: number; issues: string[] }
export interface FigureCellBounds { x: number; y: number; width: number; height: number }
export interface FigureLayout {
  widthMm: number
  heightMm: number
  columnWidthMm: number
  columns: Map<string, { x: number; width: number; rulerY: number }>
  rows: Map<string, { y: number; height: number }>
}

export function layoutFigure(document: FigureDocument): FigureLayout {
  const page = document.page
  const columnWidthMm = (page.widthMm - page.marginMm * 2 - page.labelWidthMm - page.columnGapMm * (document.columns.length - 1)) / document.columns.length
  if (columnWidthMm < 15) throw new Error('The page is too narrow for its columns, labels, and margins.')
  const columns = new Map<string, { x: number; width: number; rulerY: number }>()
  document.columns.forEach((column, index) => columns.set(column.id, {
    x: page.marginMm + page.labelWidthMm + index * (columnWidthMm + page.columnGapMm),
    width: columnWidthMm,
    rulerY: page.marginMm + (page.title ? 12 : 0) + (document.columns.some((item) => item.title) ? 8 : 0),
  }))
  const rulerY = columns.values().next().value?.rulerY ?? page.marginMm
  let y = rulerY + page.rulerHeightMm + 2
  const rows = new Map<string, { y: number; height: number }>()
  for (const row of document.rows) {
    if (!row.included) continue
    rows.set(row.id, { y, height: row.heightMm })
    y += row.heightMm + page.rowGapMm + row.gapAfterMm
  }
  const contentHeight = y + page.marginMm
  return { widthMm: page.widthMm, heightMm: Math.max(contentHeight, page.heightMm || 0), columnWidthMm, columns, rows }
}

export function figureCellBounds(layout: FigureLayout, rowId: string, columnId: string): FigureCellBounds | undefined {
  const row = layout.rows.get(rowId)
  const column = layout.columns.get(columnId)
  return row && column ? { x: column.x, y: row.y, width: column.width, height: row.height } : undefined
}

type QueryCell = Map<string, TrackFeature[]>

/** Owns figure-specific query resolution and caches completed source reads across style edits. */
export class FigureRenderSession {
  private cache = new Map<string, Promise<TrackFeature[]>>()

  clear(): void { this.cache.clear() }

  async render(document: FigureDocument, sources: ReadonlyMap<string, TrackSource>, genes?: GeneSource, dpi = 96): Promise<FigureRenderResult> {
    const layout = layoutFigure(document)
    const issues: string[] = []
    const cells = new Map<string, QueryCell>()
    await Promise.all(document.columns.flatMap((column) => document.rows.filter((row) => row.included).map(async (row) => {
      const features = new Map<string, TrackFeature[]>()
      cells.set(cellKey(column.id, row.id), features)
      for (const trackId of column.assignments[row.id] ?? []) {
        const spec = document.sourceDocument.tracks.find((track) => track.id === trackId)
        if (!spec) { issues.push(`${column.title || 'Column'} / ${row.label}: track is missing from the figure project.`); continue }
        if (spec.kind === 'genes') {
          if (!genes) issues.push(`${column.title || 'Column'} / ${row.label}: gene annotation is unavailable.`)
          continue
        }
        for (const [sourceIndex, sourceId] of (spec.kind === 'stranded' ? spec.sourceIds : spec.sourceIds.slice(0, 1)).entries()) {
          const source = sources.get(sourceId)
          if (!source) { issues.push(`${column.title || 'Column'} / ${row.label}: ${spec.label} needs its source file reopened.`); continue }
          const options = queryOptions(spec, row.heightMm, column.region)
          // Matrix readers have bounded rectangular queries; export resolution must not
          // increase the genomic bin count beyond what the interactive viewer supports.
          const pixelWidth = Math.max(1, Math.min(spec.kind === 'matrix' ? 1_100 : 8_000, Math.ceil(layout.columnWidthMm * dpi / 25.4)))
          const key = JSON.stringify([sourceId, column.region, pixelWidth, options])
          let request = this.cache.get(key)
          if (!request) {
            request = source.getFeatures(column.region, pixelWidth, undefined, options)
            this.cache.set(key, request)
          }
          try {
            const result = await request
            if (sourceIndex === 0) features.set(trackId, result)
            else features.set(sourceId, result)
          } catch (error) {
            this.cache.delete(key)
            issues.push(`${column.title || 'Column'} / ${row.label}: ${spec.label}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    })))
    return { svg: buildSvg(document, layout, cells, genes, issues), widthMm: layout.widthMm, heightMm: layout.heightMm, issues }
  }
}

function queryOptions(spec: TrackSpec, heightMm: number, region: Region): TrackQueryOptions | undefined {
  if (spec.kind === 'alignment') return {
    bamViewMode: spec.bamViewMode, bamViewAsPairs: spec.bamViewAsPairs, bamMinMapq: spec.bamMinMapq,
    bamIncludeDuplicates: spec.bamIncludeDuplicates, bamIncludeSecondary: spec.bamIncludeSecondary,
    bamIncludeSupplementary: spec.bamIncludeSupplementary, bamGroupTag: spec.bamGroupMode === 'tag' ? spec.bamGroupTag : undefined,
  }
  if (spec.kind === 'matrix') return {
    matrixResolution: spec.matrixResolution, matrixNormalization: spec.matrixNormalization, matrixValueMode: spec.matrixValueMode,
    matrixComparisonMode: spec.matrixComparisonMode, matrixSecondaryRegion: spec.matrixSecondaryRegion,
    matrixPixelHeight: Math.max(1, Math.round(heightMm * 96 / 25.4)),
    matrixMaxDistance: spec.matrixSecondaryRegion ? undefined : spec.matrixDepthMode === 'fixed' ? spec.matrixMaxDistance : spec.matrixDepthMode === 'full' ? region.end - region.start : region.end - region.start,
  }
  return undefined
}

function cellKey(columnId: string, rowId: string): string { return `${columnId}\u0000${rowId}` }
function n(value: number): string { return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0' }
function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!) }
function rect(x: number, y: number, width: number, height: number, fill: string, extra = ''): string {
  if (width <= 0 || height <= 0) return ''
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="${escapeXml(fill)}" ${extra}/>`
}
function line(x1: number, y1: number, x2: number, y2: number, color: string, width = 0.18, extra = ''): string {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${escapeXml(color)}" stroke-width="${n(width)}" ${extra}/>`
}
function text(x: number, y: number, label: string, sizeMm: number, color = '#161616', extra = ''): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(sizeMm)}" fill="${escapeXml(color)}" ${extra}>${escapeXml(label)}</text>`
}
function px(region: Region, bounds: FigureCellBounds, coordinate: number): number {
  return bounds.x + ((coordinate - region.start) / (region.end - region.start)) * bounds.width
}

function buildSvg(document: FigureDocument, layout: FigureLayout, cells: Map<string, QueryCell>, genes: GeneSource | undefined, issues: string[]): string {
  const page = document.page
  const fontMm = page.fontSizePt * 25.4 / 72
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${n(layout.widthMm)}mm" height="${n(layout.heightMm)}mm" viewBox="0 0 ${n(layout.widthMm)} ${n(layout.heightMm)}" role="img" aria-label="${escapeXml(document.name)}">`,
    `<metadata>${escapeXml(JSON.stringify({ application: 'GeRAFE', figureVersion: document.schemaVersion, referenceId: document.referenceId, widthMm: layout.widthMm, heightMm: layout.heightMm, columns: document.columns.map((column) => ({ title: column.title, region: column.region })), sources: document.sourceDocument.sources.map((source) => ({ id: source.id, name: source.name, format: source.format, files: source.files.map((file) => ({ name: file.name, size: file.size })) })) }))}</metadata>`,
    rect(0, 0, layout.widthMm, layout.heightMm, page.background),
    `<g font-family="${escapeXml(page.fontFamily)}">`]
  if (page.title) parts.push(text(layout.widthMm / 2, page.marginMm + fontMm * 1.2, page.title, fontMm * 1.45, '#111111', 'text-anchor="middle" font-weight="700"'))
  for (const column of document.columns) {
    const columnLayout = layout.columns.get(column.id)!
    if (column.title) parts.push(text(columnLayout.x + columnLayout.width / 2, columnLayout.rulerY - 2, column.title, fontMm * 1.25, '#111111', 'text-anchor="middle" font-weight="700"'))
    parts.push(drawRuler(column.region, { x: columnLayout.x, y: columnLayout.rulerY, width: columnLayout.width, height: page.rulerHeightMm }, fontMm))
  }
  const visibleRows = document.rows.filter((row) => row.included)
  for (let index = 0; index < visibleRows.length;) {
    const label = visibleRows[index].groupLabel
    if (!label) { index++; continue }
    let end = index + 1
    while (end < visibleRows.length && visibleRows[end].groupLabel === label) end++
    const first = layout.rows.get(visibleRows[index].id)!
    const last = layout.rows.get(visibleRows[end - 1].id)!
    const middle = (first.y + last.y + last.height) / 2
    parts.push(line(page.marginMm + 7, first.y, page.marginMm + 7, last.y + last.height, '#6b7280', 0.2))
    parts.push(`<text x="${n(page.marginMm + 5)}" y="${n(middle)}" transform="rotate(-90 ${n(page.marginMm + 5)} ${n(middle)})" text-anchor="middle" font-size="${n(fontMm * 1.15)}" font-weight="700" fill="#111111">${escapeXml(label)}</text>`)
    index = end
  }
  for (const row of document.rows) {
    const rowLayout = layout.rows.get(row.id)
    if (!rowLayout) continue
    const firstColumn = layout.columns.get(document.columns[0].id)!
    parts.push(text(firstColumn.x - 2, rowLayout.y + rowLayout.height / 2 + fontMm * 0.3, row.label, (row.labelFontSizePt ?? page.fontSizePt) * 25.4 / 72, row.labelColor ?? '#111111', 'text-anchor="end" font-weight="600"'))
    for (const column of document.columns) {
      const bounds = figureCellBounds(layout, row.id, column.id)!
      const clipId = `clip-${safeId(column.id)}-${safeId(row.id)}`
      parts.push(`<defs><clipPath id="${clipId}">${rect(bounds.x, bounds.y, bounds.width, bounds.height, '#ffffff')}</clipPath></defs>`)
      parts.push(`<g data-fe-row="${escapeXml(row.id)}" data-fe-column="${escapeXml(column.id)}">`)
      parts.push(`<g clip-path="url(#${clipId})">`)
      const trackIds = column.assignments[row.id] ?? []
      const cell = cells.get(cellKey(column.id, row.id)) ?? new Map()
      const specs = trackIds.map((id) => document.sourceDocument.tracks.find((track) => track.id === id)).filter((item): item is TrackSpec => Boolean(item))
      const style = column.styles?.[row.id]
      if (!specs.length) parts.push(text(bounds.x + 2, bounds.y + bounds.height / 2, 'No track assigned', fontMm * 0.8, '#888888'))
      else if (specs.length > 1 && specs.every((spec) => spec.kind === 'signal')) parts.push(drawSignalStack(specs, cell, column.region, bounds, document, style))
      else for (const spec of specs) {
        const features = cell.get(spec.id) ?? []
        if (spec.kind === 'signal') parts.push(drawSignal(features as SignalFeature[], spec, column.region, bounds, document, cells, row, style))
        else if (spec.kind === 'stranded') parts.push(drawStranded(spec, features as SignalFeature[], cell, column.region, bounds, style, document, row, cells))
        else if (spec.kind === 'interval') parts.push(drawIntervals(features as IntervalFeature[], spec, column.region, bounds, fontMm))
        else if (spec.kind === 'interaction') parts.push(drawInteractions(features as InteractionFeature[], spec, column.region, bounds))
        else if (spec.kind === 'matrix') {
          parts.push(drawMatrix(features as MatrixFeature[], spec, column.region, bounds, issues, `${column.title || 'Column'} / ${row.label}`))
          parts.push(drawMatrixOutlines(document, spec.id, spec, column.region, bounds))
        }
        else if (spec.kind === 'alignment') parts.push(drawAlignments(features, spec, column.region, bounds))
        else if (spec.kind === 'genes' && genes) parts.push(drawGenes(genes, column.region, bounds, fontMm))
      }
      parts.push(drawAnnotations(document, column.region, bounds))
      parts.push('</g>')
      parts.push(`<rect x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.width)}" height="${n(bounds.height)}" fill="none" stroke="${escapeXml(row.frameColor ?? '#444444')}" stroke-width="${n((row.frameWidthPt ?? 0.5) * 25.4 / 72)}"/>`)
      parts.push('</g>')
    }
  }
  if (issues.length) parts.push(text(page.marginMm, layout.heightMm - page.marginMm / 2, `${issues.length} source issue${issues.length === 1 ? '' : 's'} — export requires review`, fontMm * 0.75, '#b42318'))
  parts.push('</g></svg>')
  return parts.join('')
}

function safeId(value: string): string { return value.replace(/[^a-z0-9_-]/gi, '_') }

function drawRuler(region: Region, bounds: FigureCellBounds, fontMm: number): string {
  const y = bounds.y + bounds.height - 1
  const span = region.end - region.start
  const roughStep = span / 4
  const power = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const step = [1, 2, 5, 10].map((value) => value * power).find((value) => value >= roughStep) ?? power * 10
  const ticks: string[] = [line(bounds.x, y, bounds.x + bounds.width, y, '#667085', 0.2), text(bounds.x, bounds.y + fontMm, region.chr, fontMm * 0.8, '#475467', 'font-weight="700"')]
  for (let pos = Math.ceil(region.start / step) * step; pos < region.end; pos += step) {
    const x = px(region, bounds, pos)
    ticks.push(line(x, y - 1, x, y + 1, '#667085', 0.2))
    ticks.push(text(x, y - 1.8, `${(pos / 1_000_000).toFixed(3)} Mb`, fontMm * 0.7, '#475467', 'text-anchor="middle"'))
  }
  return ticks.join('')
}

function signalDomain(features: readonly SignalFeature[], spec: TrackSpec, document: FigureDocument): { min: number; max: number } {
  const binding = document.sourceDocument.scales.find((item) => item.id === spec.scaleBindingId)
  if (binding?.mode === 'fixed' && binding.limits) return binding.limits
  let min = 0; let max = 0
  for (const feature of features) { if (Number.isFinite(feature.score)) { min = Math.min(min, feature.score); max = Math.max(max, feature.score) } }
  if (spec.allowNegativeValues === false) min = 0
  return { min, max: max > min ? max : min + 1 }
}

function drawSignal(features: SignalFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds, document: FigureDocument, allCells: Map<string, QueryCell>, row: FigureRow, style?: FigureCellStyle): string {
  const values = features.filter((feature) => feature.end > region.start && feature.start < region.end && Number.isFinite(feature.score))
  if (!values.length) return ''
  const shared = document.columns.flatMap((column) => (column.assignments[row.id] ?? []).flatMap((trackId) => allCells.get(cellKey(column.id, row.id))?.get(trackId) ?? []).filter((feature): feature is SignalFeature => 'score' in feature && !('featureType' in feature)))
  const domain = style?.scaleMode === 'fixed' && style.scaleMin !== undefined && style.scaleMax !== undefined
    ? { min: style.scaleMin, max: style.scaleMax }
    : signalDomain(style?.scaleMode === 'independent' ? values : shared.length ? shared : values, spec, document)
  const innerTop = bounds.y + 0.8; const innerHeight = bounds.height - 1.6
  const y = (score: number) => innerTop + innerHeight * (1 - (Math.max(domain.min, Math.min(domain.max, score)) - domain.min) / (domain.max - domain.min))
  const zero = y(0)
  const color = style?.color ?? spec.color
  const opacity = (style?.opacity ?? spec.signalOpacity ?? 100) / 100
  const scale = style?.showScale === false ? '' : drawScaleLabels(bounds, domain)
  if ((style?.renderStyle === 'source' || !style?.renderStyle ? spec.signalRenderStyle : style.renderStyle) === 'line') {
    const path = values.map((feature, index) => `${index ? 'L' : 'M'}${n(px(region, bounds, (feature.start + feature.end) / 2))} ${n(y(feature.score))}`).join(' ')
    return `<path d="${path}" fill="none" stroke="${escapeXml(color)}" stroke-width="0.28" opacity="${n(opacity)}"/>${line(bounds.x, zero, bounds.x + bounds.width, zero, '#666666', 0.12)}${scale}`
  }
  const bars = values.map((feature) => {
    const left = Math.max(bounds.x, px(region, bounds, feature.start))
    const right = Math.min(bounds.x + bounds.width, px(region, bounds, feature.end))
    const pointY = y(spec.allowNegativeValues === false ? Math.max(0, feature.score) : feature.score)
    return rect(left, Math.min(zero, pointY), Math.max(0.05, right - left), Math.max(0.03, Math.abs(zero - pointY)), color)
  }).join('')
  return `<g opacity="${n(opacity)}">${bars}</g>${line(bounds.x, zero, bounds.x + bounds.width, zero, '#666666', 0.12)}${scale}`
}

function drawScaleLabels(bounds: FigureCellBounds, domain: { min: number; max: number }): string {
  const label = (value: number) => Number(value.toPrecision(3)).toString()
  return text(bounds.x + 0.8, bounds.y + 2.5, label(domain.max), 1.9, '#222222')
    + (domain.min < 0 ? text(bounds.x + 0.8, bounds.y + bounds.height - 0.8, label(domain.min), 1.9, '#222222') : '')
}

function drawSignalStack(specs: TrackSpec[], cell: QueryCell, region: Region, bounds: FigureCellBounds, document: FigureDocument, style?: FigureCellStyle): string {
  const all = specs.flatMap((spec) => cell.get(spec.id) ?? []).filter((feature): feature is SignalFeature => 'score' in feature && !('featureType' in feature))
  const domain = style?.scaleMode === 'fixed' && style.scaleMin !== undefined && style.scaleMax !== undefined
    ? { min: style.scaleMin, max: style.scaleMax } : signalDomain(all, specs[0], document)
  return specs.map((spec, index) => {
    const features = (cell.get(spec.id) ?? []) as SignalFeature[]
    const y = (score: number) => bounds.y + bounds.height - 1 - (score - domain.min) / (domain.max - domain.min) * (bounds.height - 2)
    const path = features.filter((feature) => feature.end > region.start && feature.start < region.end).map((feature, offset) => `${offset ? 'L' : 'M'}${n(px(region, bounds, (feature.start + feature.end) / 2))} ${n(y(feature.score))}`).join(' ')
    return path ? `<path d="${path}" fill="none" stroke="${escapeXml(spec.color)}" stroke-width="0.3" opacity="${n((style?.opacity ?? 100) / 100)}" ${index % 2 ? 'stroke-dasharray="1.2 0.55"' : ''}/>` : ''
  }).join('') + (style?.showScale === false ? '' : drawScaleLabels(bounds, domain))
}

function drawStranded(spec: TrackSpec, plus: SignalFeature[], cell: QueryCell, region: Region, bounds: FigureCellBounds, style: FigureCellStyle | undefined, document: FigureDocument, row: FigureRow, allCells: Map<string, QueryCell>): string {
  const minus = (cell.get(spec.sourceIds[1]) ?? []) as SignalFeature[]
  const midpoint = bounds.y + bounds.height / 2
  let positiveMaximum = 1
  let negativeMaximum = 1
  const sourceCells = style?.scaleMode === 'independent' ? [cell] : document.columns.map((column) => allCells.get(cellKey(column.id, row.id)) ?? new Map())
  for (const sourceCell of sourceCells) for (const trackId of document.columns.flatMap((column) => column.assignments[row.id] ?? [])) {
    const assigned = document.sourceDocument.tracks.find((track) => track.id === trackId)
    if (assigned?.kind !== 'stranded') continue
    for (const feature of (sourceCell.get(assigned.id) ?? []) as SignalFeature[]) positiveMaximum = Math.max(positiveMaximum, Math.abs(feature.score))
    for (const feature of (sourceCell.get(assigned.sourceIds[1]) ?? []) as SignalFeature[]) negativeMaximum = Math.max(negativeMaximum, Math.abs(feature.score))
  }
  if (style?.scaleMode === 'fixed') {
    if (style.scaleMax !== undefined) positiveMaximum = Math.max(1, style.scaleMax)
    if (style.scaleMin !== undefined) negativeMaximum = Math.max(1, -style.scaleMin)
  }
  const render = (features: SignalFeature[], color: string, direction: -1 | 1, maximum: number) => features.map((feature) => {
    const x1 = Math.max(bounds.x, px(region, bounds, feature.start))
    const x2 = Math.min(bounds.x + bounds.width, px(region, bounds, feature.end))
    const height = Math.min(bounds.height / 2 - 0.7, Math.abs(feature.score) / maximum * (bounds.height / 2 - 0.7))
    return rect(x1, direction < 0 ? midpoint - height : midpoint, Math.max(0.04, x2 - x1), height, color)
  }).join('')
  return `<g opacity="${n((style?.opacity ?? 100) / 100)}">${render(plus, style?.color ?? spec.color, -1, positiveMaximum)}${render(minus, style?.negativeColor ?? spec.negativeColor ?? '#2878d4', 1, negativeMaximum)}</g>` + line(bounds.x, midpoint, bounds.x + bounds.width, midpoint, '#555555', 0.14)
    + (style?.showScale === false ? '' : text(bounds.x + 0.8, bounds.y + 2.5, Number(positiveMaximum.toPrecision(3)).toString(), 1.9) + text(bounds.x + 0.8, bounds.y + bounds.height - 0.8, `-${Number(negativeMaximum.toPrecision(3))}`, 1.9))
}

function drawIntervals(features: IntervalFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds, fontMm: number): string {
  const visible = features.filter((feature) => feature.end > region.start && feature.start < region.end && (spec.intervalMinScore === undefined || (feature.score ?? -Infinity) >= spec.intervalMinScore))
  const laneEnds: number[] = []
  const parts: string[] = []
  for (const feature of visible) {
    const x1 = Math.max(bounds.x, px(region, bounds, feature.start))
    const x2 = Math.min(bounds.x + bounds.width, px(region, bounds, feature.end))
    let lane = 0
    if (spec.intervalDisplayMode !== 'collapsed') {
      while ((laneEnds[lane] ?? -Infinity) > x1) lane++
      laneEnds[lane] = x2 + 1
    }
    if (spec.intervalMaxRows && lane >= spec.intervalMaxRows) continue
    const center = bounds.y + 2 + lane * 3.2 + Math.min(2, bounds.height / 3)
    if (center > bounds.y + bounds.height - 1) continue
    const color = spec.intervalColorMode === 'item-rgb' && feature.itemRgb ? feature.itemRgb : spec.color
    parts.push(line(x1, center, x2, center, color, 0.22))
    for (const block of feature.blocks?.length ? feature.blocks : [{ start: feature.start, end: feature.end }]) {
      const bx1 = Math.max(bounds.x, px(region, bounds, block.start))
      const bx2 = Math.min(bounds.x + bounds.width, px(region, bounds, block.end))
      parts.push(rect(bx1, center - 0.65, Math.max(0, bx2 - bx1), 1.3, color))
    }
    if (feature.name && spec.intervalShowLabels !== false && spec.intervalDisplayMode !== 'squished') parts.push(text(Math.min(bounds.x + bounds.width - 1, x1 + 0.5), Math.max(bounds.y + fontMm * 0.75, center - 1), feature.name, fontMm * 0.65, color))
  }
  return parts.join('')
}

function drawInteractions(features: InteractionFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds): string {
  const direction = spec.interactionDirection === 'down' ? 1 : -1
  const baseline = direction < 0 ? bounds.y + bounds.height - 0.8 : bounds.y + 0.8
  const span = region.end - region.start
  return features.filter((feature) => feature.end > region.start && feature.start < region.end && (spec.interactionMinScore === undefined || (feature.score ?? -Infinity) >= spec.interactionMinScore)).slice(0, spec.interactionMaxFeatures ?? 2_000).map((feature) => {
    if (feature.chrom1 !== region.chr || feature.chrom2 !== region.chr) return ''
    const x1 = px(region, bounds, (feature.start1 + feature.end1) / 2)
    const x2 = px(region, bounds, (feature.start2 + feature.end2) / 2)
    if (Math.abs(x2 - x1) > (spec.interactionMaxDistance ?? Infinity) / span * bounds.width) return ''
    const height = Math.min(bounds.height - 1.5, spec.interactionArcHeightMode === 'fixed' ? bounds.height * 0.65 : Math.sqrt(Math.abs(x2 - x1) / bounds.width) * bounds.height)
    const cy = baseline + direction * height * 1.35
    return `<path d="M ${n(x1)} ${n(baseline)} C ${n(x1)} ${n(cy)} ${n(x2)} ${n(cy)} ${n(x2)} ${n(baseline)}" fill="none" stroke="${escapeXml(spec.interactionColorMode === 'item-rgb' && feature.itemRgb ? feature.itemRgb : spec.color)}" stroke-width="${n((spec.interactionLineWidth ?? 1) * 0.2)}" opacity="${n((spec.interactionOpacity ?? 92) / 100)}"/>`
  }).join('')
}

function drawMatrix(features: MatrixFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds, issues: string[], label: string): string {
  const matrix = features.find((feature) => feature.featureType === 'matrix')
  if (!matrix) return ''
  if (matrix.cells.length > 80_000) {
    issues.push(`${label}: ${matrix.cells.length.toLocaleString()} matrix cells exceed the 80,000-cell SVG safety limit; choose a coarser resolution or narrower region.`)
    return ''
  }
  let maximum = spec.matrixScaleMode === 'fixed' && spec.matrixScaleMax ? spec.matrixScaleMax : 1
  if (spec.matrixScaleMode !== 'fixed') for (const cell of matrix.cells) maximum = Math.max(maximum, Math.abs(cell.value))
  const colors = spec.matrixPalette === 'warm' ? ['#fff7bc', '#fdae61', '#d7191c', '#700d1a'] : spec.matrixPalette === 'blue-black' ? ['#daf0ff', '#4d97cf', '#14437a', '#040609'] : spec.matrixPaletteColors?.length ? spec.matrixPaletteColors : ['#f7f7f7', spec.color]
  const palette = spec.matrixPaletteReversed ? [...colors].reverse() : colors
  const color = (value: number) => matrix.valueMode === 'log2-observed-expected' || spec.matrixComparisonMode ? value < 0 ? '#3675b5' : '#c73b3b' : palette[Math.min(palette.length - 1, Math.floor(Math.abs(value) / maximum * (palette.length - 1)))]
  const resolution = matrix.resolution
  if (matrix.axis2) {
    const axis = matrix.axis2
    return matrix.cells.map((cell) => {
      const x1 = px(region, bounds, cell.bin1)
      const x2 = px(region, bounds, cell.bin1 + resolution)
      const y1 = bounds.y + (cell.bin2 - axis.start) / (axis.end - axis.start) * bounds.height
      const y2 = bounds.y + (cell.bin2 + resolution - axis.start) / (axis.end - axis.start) * bounds.height
      return rect(x1, y1, x2 - x1, y2 - y1, color(cell.value))
    }).join('')
  }
  const direction = spec.matrixDirection === 'down' ? 1 : -1
  const baseline = direction < 0 ? bounds.y + bounds.height : bounds.y
  const binWidth = resolution / (region.end - region.start) * bounds.width
  return matrix.cells.map((cell) => {
    const x = px(region, bounds, (cell.bin1 + cell.bin2 + resolution) / 2)
    const distance = Math.abs(cell.bin2 - cell.bin1) / (region.end - region.start) * bounds.width
    const y = baseline + direction * distance / 2
    if (y < bounds.y - binWidth || y > bounds.y + bounds.height + binWidth) return ''
    return `<path d="M ${n(x)} ${n(y - binWidth / 2)} L ${n(x + binWidth / 2)} ${n(y)} L ${n(x)} ${n(y + binWidth / 2)} L ${n(x - binWidth / 2)} ${n(y)} Z" fill="${escapeXml(color(cell.value))}"/>`
  }).join('')
}

function drawMatrixOutlines(document: FigureDocument, trackId: string, spec: TrackSpec, region: Region, bounds: FigureCellBounds): string {
  const parts: string[] = []
  for (const outline of document.sourceDocument.matrixOutlines) {
    if (!outline.visible || (outline.sourceTrackId !== trackId && !outline.targetTrackIds.includes(trackId))) continue
    if (outline.axis1.chr !== region.chr || outline.axis1.end <= region.start || outline.axis1.start >= region.end) continue
    if (spec.matrixSecondaryRegion) {
      const axis = spec.matrixSecondaryRegion
      if (outline.axis2.chr !== axis.chr || outline.axis2.end <= axis.start || outline.axis2.start >= axis.end) continue
      const x1 = px(region, bounds, outline.axis1.start)
      const x2 = px(region, bounds, outline.axis1.end)
      const y1 = bounds.y + (outline.axis2.start - axis.start) / (axis.end - axis.start) * bounds.height
      const y2 = bounds.y + (outline.axis2.end - axis.start) / (axis.end - axis.start) * bounds.height
      parts.push(`<rect x="${n(x1)}" y="${n(y1)}" width="${n(x2 - x1)}" height="${n(y2 - y1)}" fill="none" stroke="${escapeXml(outline.color)}" stroke-width="0.35"/>`)
      continue
    }
    if (outline.axis2.chr !== region.chr) continue
    const direction = spec.matrixDirection === 'down' ? 1 : -1
    const baseline = direction < 0 ? bounds.y + bounds.height : bounds.y
    const point = (axis1: number, axis2: number) => {
      const x = px(region, bounds, (axis1 + axis2) / 2)
      const y = baseline + direction * (axis2 - axis1) / (region.end - region.start) * bounds.width / 2
      return `${n(x)},${n(y)}`
    }
    const points = [point(outline.axis1.start, outline.axis2.start), point(outline.axis1.end, outline.axis2.start), point(outline.axis1.end, outline.axis2.end), point(outline.axis1.start, outline.axis2.end)].join(' ')
    parts.push(`<polygon points="${points}" fill="none" stroke="${escapeXml(outline.color)}" stroke-width="0.35"/>`)
  }
  return parts.join('')
}

function drawAlignments(features: TrackFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds): string {
  const coverage = features.filter((feature): feature is AlignmentCoverageFeature => 'featureType' in feature && feature.featureType === 'coverage')
  const reads = features.filter((feature): feature is AlignmentFeature => 'featureType' in feature && feature.featureType === 'alignment')
  const mode = spec.bamViewMode ?? 'both'
  const coverageHeight = mode === 'both' ? bounds.height * 0.4 : mode === 'coverage' ? bounds.height - 1 : 0
  let maximum = 1
  for (const feature of coverage) maximum = Math.max(maximum, feature.score)
  const bars = mode === 'alignments' ? '' : coverage.map((feature) => {
    const x1 = Math.max(bounds.x, px(region, bounds, feature.start)); const x2 = Math.min(bounds.x + bounds.width, px(region, bounds, feature.end))
    const height = Math.max(0, feature.score / maximum * coverageHeight)
    return rect(x1, bounds.y + coverageHeight - height, Math.max(0, x2 - x1), height, spec.color)
  }).join('')
  if (mode === 'coverage') return bars
  const readsTop = bounds.y + coverageHeight + (coverageHeight ? 0.7 : 0.5)
  const laneHeight = 1.5
  const laneEnds: number[] = []
  const readMarks = reads.slice(0, spec.bamMaxReads ?? 10_000).map((read) => {
    const x1 = px(region, bounds, read.start); const x2 = px(region, bounds, read.end)
    let lane = 0
    while ((laneEnds[lane] ?? -Infinity) > x1) lane++
    laneEnds[lane] = x2 + 0.3
    const y = readsTop + lane * laneHeight
    if (y + laneHeight > bounds.y + bounds.height) return ''
    return read.blocks.map((block) => rect(Math.max(bounds.x, px(region, bounds, block.start)), y, Math.max(0, Math.min(bounds.x + bounds.width, px(region, bounds, block.end)) - Math.max(bounds.x, px(region, bounds, block.start))), 0.7, spec.color)).join('')
  }).join('')
  return bars + readMarks
}

function drawGenes(genes: GeneSource, region: Region, bounds: FigureCellBounds, fontMm: number): string {
  const visible = genes.featuresFor(region).slice(0, 100)
  const laneEnds: number[] = []
  return visible.map((gene) => {
    const x1 = px(region, bounds, gene.start); const x2 = px(region, bounds, gene.end)
    let lane = 0
    while ((laneEnds[lane] ?? -Infinity) > x1) lane++
    laneEnds[lane] = x2 + 1
    const y = bounds.y + 2 + lane * 3.2
    if (y > bounds.y + bounds.height - 1) return ''
    const model = gene.transcriptModels[0]
    const color = '#164a91'
    return line(x1, y, x2, y, color, 0.18) + (model?.exons ?? []).map((exon) => rect(Math.max(bounds.x, px(region, bounds, exon.start)), y - 0.5, Math.max(0, Math.min(bounds.x + bounds.width, px(region, bounds, exon.end)) - Math.max(bounds.x, px(region, bounds, exon.start))), 1, color)).join('') + text(Math.max(bounds.x + 0.3, Math.min(bounds.x + bounds.width - 1, (x1 + x2) / 2)), y + 2.3, gene.name, fontMm * 0.7, '#1f2937', 'text-anchor="middle"')
  }).join('')
}

function drawAnnotations(document: FigureDocument, region: Region, bounds: FigureCellBounds): string {
  const parts: string[] = []
  for (const saved of document.sourceDocument.savedRegions) {
    if (saved.region.chr !== region.chr || saved.region.end <= region.start || saved.region.start >= region.end || !saved.highlighted) continue
    const x1 = Math.max(bounds.x, px(region, bounds, saved.region.start))
    const x2 = Math.min(bounds.x + bounds.width, px(region, bounds, saved.region.end))
    if (saved.fill) parts.push(rect(x1, bounds.y, x2 - x1, bounds.height, saved.color, `opacity="${n(saved.shadeOpacity)}"`))
    if (saved.boundaryStyle !== 'none') {
      const dash = saved.boundaryStyle === 'dashed' ? 'stroke-dasharray="1 0.6"' : ''
      parts.push(line(x1, bounds.y, x1, bounds.y + bounds.height, saved.color, 0.16, dash))
      parts.push(line(x2, bounds.y, x2, bounds.y + bounds.height, saved.color, 0.16, dash))
    }
  }
  for (const divider of document.sourceDocument.comparisonDividers) {
    if (divider.chr !== region.chr || divider.position < region.start || divider.position > region.end) continue
    const x = px(region, bounds, divider.position)
    parts.push(line(x, bounds.y, x, bounds.y + bounds.height, divider.color, 0.2, divider.lineStyle === 'dashed' ? 'stroke-dasharray="1 0.6"' : ''))
  }
  return parts.join('')
}

export async function figureSvgToPng(svg: string, widthMm: number, heightMm: number, dpi: number): Promise<Blob> {
  const width = Math.max(1, Math.round(widthMm * dpi / 25.4))
  const height = Math.max(1, Math.round(heightMm * dpi / 25.4))
  const image = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not render SVG for PNG export.')); image.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas export is unavailable.')
    context.drawImage(image, 0, 0, width, height)
    const encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode PNG export.')), 'image/png'))
    return new Blob([embedPngDpi(new Uint8Array(await encoded.arrayBuffer()), dpi) as BlobPart], { type: 'image/png' })
  } finally { URL.revokeObjectURL(url) }
}

/** Store physical output resolution in PNG pHYs, not just in its pixel dimensions. */
export function embedPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) throw new Error('PNG export is invalid.')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (view.getUint32(8) !== 13 || String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR') throw new Error('PNG export has no header.')
  const meters = Math.round(dpi / 0.0254)
  const physical = new Uint8Array(21)
  const p = new DataView(physical.buffer)
  p.setUint32(0, 9)
  physical.set([112, 72, 89, 115], 4) // pHYs
  p.setUint32(8, meters)
  p.setUint32(12, meters)
  physical[16] = 1
  let crc = 0xffffffff
  for (let index = 4; index < 17; index++) {
    crc ^= physical[index]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  p.setUint32(17, (crc ^ 0xffffffff) >>> 0)
  let existingStart = -1; let existingEnd = -1
  for (let offset = 33; offset + 12 <= png.length;) {
    const size = view.getUint32(offset)
    const end = offset + size + 12
    if (end > png.length) break
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'pHYs') { existingStart = offset; existingEnd = end; break }
    if (type === 'IDAT') break
    offset = end
  }
  const result = new Uint8Array(png.length + physical.length - (existingStart < 0 ? 0 : existingEnd - existingStart))
  result.set(png.subarray(0, 33))
  result.set(physical, 33)
  if (existingStart < 0) result.set(png.subarray(33), 54)
  else { result.set(png.subarray(33, existingStart), 54); result.set(png.subarray(existingEnd), 54 + existingStart - 33) }
  return result
}
