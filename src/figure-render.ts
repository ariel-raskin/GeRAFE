import { stackAppearance, svgStackPattern } from './signal-stack-style.ts'
import { figureAssignedTrackIds, figureStackGroup } from './figure-document.ts'
import { pageFields, rowFields, cellFields, resolveAppearance, type RowAppearance } from './figure-appearance.ts'
import type { FigureCellStyle, FigureDocument, FigureRow } from './figure-document.ts'
import { signalTransform, signalStackDisplayEntries, filterInteractionFeatures, filterInteractionsForGenes, interactionFeatureColor, interactionTouchesRegion, matrixAutomaticMagnitude, matrixAutomaticMaximum, matrixBlueBlackPaletteColor, matrixGradientColor, matrixOverlayAnchorPair, matrixPaletteIntensity, matrixQueryMaximumDistance, matrixSignedColor, matrixValueIntensity, matrixWarmPaletteColor, selectInteractionFeatures } from './browser.ts'
import { GeneSource } from './reference.ts'
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
  const appearance = resolveAppearance(pageFields, page.appearance)
  const gutters = document.columns.map((column, index) => Math.max(0, ...document.rows.filter((row) => row.included).map((row) => {
    const style = column.styles?.[row.id]
    const cell = resolveAppearance(cellFields, style?.appearance)
    const matrix = (figureAssignedTrackIds(document, column, row.id)).some((id) => document.sourceDocument.tracks.find((track) => track.id === id)?.kind === 'matrix')
    return matrix && style?.showScale !== false && (cell.matrixLegend === 'right' || cell.matrixLegend === 'last-column' && index === document.columns.length - 1) ? cell.legendGapMm + cell.legendWidthMm + 1.5 : 0
  })))
  const available = page.widthMm - page.marginMm * 2 - page.labelWidthMm - page.columnGapMm * (document.columns.length - 1) - gutters.reduce((a, b) => a + b, 0)
  const totalWeight = document.columns.reduce((sum, column) => sum + (column.widthWeight ?? 1), 0)
  const columnWidthMm = available / document.columns.length
  const columns = new Map<string, { x: number; width: number; rulerY: number }>()
  let x = page.marginMm + page.labelWidthMm
  document.columns.forEach((column, index) => {
    const width = available * (column.widthWeight ?? 1) / totalWeight
    if (width < 10) throw new Error('The page is too narrow for its columns, labels, and legends. Increase width or reduce gaps / label area.')
    columns.set(column.id, { x, width, rulerY: page.marginMm + (page.title ? appearance.titleHeightMm : 0) + (document.columns.some((item) => item.title) ? appearance.headingHeightMm : 0) })
    x += width + page.columnGapMm + gutters[index]
  })
  const rulerY = columns.values().next().value?.rulerY ?? page.marginMm
  let y = rulerY + page.rulerHeightMm + appearance.rulerGapMm
  const rows = new Map<string, { y: number; height: number }>()
  for (const row of document.rows) {
    if (!row.included) continue
    rows.set(row.id, { y, height: row.heightMm })
    y += row.heightMm + page.rowGapMm + row.gapAfterMm
  }
  const contentHeight = y + page.marginMm
  if (page.heightMm > 0 && contentHeight > page.heightMm + 0.01) throw new Error(`Tracks need ${n(contentHeight)} mm of page height; increase height, reduce row sizes/gaps, or set height to 0 to fit.`)
  return { widthMm: page.widthMm, heightMm: page.heightMm || contentHeight, columnWidthMm, columns, rows }
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
      for (const trackId of figureAssignedTrackIds(document, column, row.id)) {
        const sourceSpec = document.sourceDocument.tracks.find((track) => track.id === trackId)
        const spec = sourceSpec && figureTrackSpec(sourceSpec, column.styles?.[row.id])
        if (!spec) { issues.push(`${column.title || 'Column'} / ${row.label}: track is missing from the figure project.`); continue }
        if (spec.kind === 'genes') {
          const referenceId = document.sourceDocument.sources.find((source) => source.id === spec.sourceIds[0])?.annotationReferenceId
          if (referenceId && referenceId !== document.referenceId) { issues.push(`${column.title || 'Column'} / ${row.label}: annotation belongs to another reference assembly.`); continue }
          const source = spec.sourceIds[0] ? sources.get(spec.sourceIds[0]) : genes
          if (!(source instanceof GeneSource)) issues.push(`${column.title || 'Column'} / ${row.label}: gene annotation is unavailable.${spec.sourceIds.length ? ' Reopen or relink its source.' : ''}`)
          continue
        }
        for (const [sourceIndex, sourceId] of (spec.kind === 'stranded' ? spec.sourceIds : spec.sourceIds.slice(0, 1)).entries()) {
          const source = sources.get(sourceId)
          if (!source) { issues.push(`${column.title || 'Column'} / ${row.label}: ${spec.label} needs its source file reopened.`); continue }
          const options = queryOptions(spec, row.heightMm, column.region, dpi)
          // Matrix readers have bounded rectangular queries; export resolution must not
          // increase the genomic bin count beyond what the interactive viewer supports.
          const pixelWidth = Math.max(1, Math.min(spec.kind === 'matrix' ? 1_100 : 8_000, Math.ceil(layout.columns.get(column.id)!.width * dpi / 25.4)))
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
        if (spec.kind === 'matrix' && spec.matrixOverlayInteractionTrackId) {
          const overlaySpec = document.sourceDocument.tracks.find((track) => track.id === spec.matrixOverlayInteractionTrackId && track.kind === 'interaction')
          const sourceId = overlaySpec?.sourceIds[0]
          const source = sourceId && sources.get(sourceId)
          if (overlaySpec && !source) issues.push(`${column.title || 'Column'} / ${row.label}: linked BEDPE overlay source needs reopening.`)
          if (overlaySpec && source && sourceId) {
            const pixelWidth = Math.max(1, Math.min(8_000, Math.ceil(layout.columns.get(column.id)!.width * dpi / 25.4)))
            const key = JSON.stringify([sourceId, column.region, pixelWidth, undefined])
            let request = this.cache.get(key)
            if (!request) { request = source.getFeatures(column.region, pixelWidth); this.cache.set(key, request) }
            try { features.set(overlaySpec.id, await request) }
            catch (error) { this.cache.delete(key); issues.push(`${column.title || 'Column'} / ${row.label}: BEDPE overlay: ${error instanceof Error ? error.message : String(error)}`) }
          }
        }
      }
    })))
    return { svg: buildSvg(document, layout, cells, genes, issues, sources), widthMm: layout.widthMm, heightMm: layout.heightMm, issues }
  }
}

function queryOptions(spec: TrackSpec, heightMm: number, region: Region, dpi: number): TrackQueryOptions | undefined {
  if (spec.kind === 'signal' || spec.kind === 'stranded') return { signalResolution: 'full' }
  if (spec.kind === 'alignment') return {
    bamViewMode: spec.bamViewMode, bamViewAsPairs: spec.bamViewAsPairs, bamMinMapq: spec.bamMinMapq,
    bamIncludeDuplicates: spec.bamIncludeDuplicates, bamIncludeSecondary: spec.bamIncludeSecondary,
    bamIncludeSupplementary: spec.bamIncludeSupplementary, bamGroupTag: spec.bamGroupMode === 'tag' ? spec.bamGroupTag : undefined,
  }
  if (spec.kind === 'matrix') return {
    matrixResolution: spec.matrixResolution, matrixNormalization: spec.matrixNormalization, matrixValueMode: spec.matrixValueMode,
    matrixComparisonMode: spec.matrixComparisonMode, matrixSecondaryRegion: spec.matrixSecondaryRegion,
    matrixPixelHeight: Math.max(1, Math.min(1_100, Math.round(heightMm * dpi / 25.4))),
    matrixMaxDistance: spec.matrixSecondaryRegion ? undefined : matrixQueryMaximumDistance(region.end - region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance),
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

function buildSvg(document: FigureDocument, layout: FigureLayout, cells: Map<string, QueryCell>, genes: GeneSource | undefined, issues: string[], sources: ReadonlyMap<string, TrackSource>): string {
  const page = document.page
  const fontMm = page.fontSizePt * 25.4 / 72
  const appearance = resolveAppearance(pageFields, page.appearance)
  const queryCounts = document.columns.flatMap((column) => document.rows.filter((row) => row.included).map((row) => {
    const cell = cells.get(cellKey(column.id, row.id)) ?? new Map<string, TrackFeature[]>()
    return {
      columnId: column.id, rowId: row.id,
      tracks: Object.fromEntries([...cell].map(([id, features]) => [id, features.length])),
      featureTypes: Object.fromEntries([...cell].map(([id, features]) => [id, Object.fromEntries([...new Set(features.map((feature) => 'featureType' in feature ? feature.featureType : 'signal'))].map((type) => [type, features.filter((feature) => ('featureType' in feature ? feature.featureType : 'signal') === type).length]))])),
    }
  }))
  const recipe = structuredClone(document)
  for (const source of recipe.sourceDocument.sources) for (const file of source.files) delete file.path
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${n(layout.widthMm)}mm" height="${n(layout.heightMm)}mm" viewBox="0 0 ${n(layout.widthMm)} ${n(layout.heightMm)}" role="img" aria-label="${escapeXml(document.name)}">`,
    `<metadata>${escapeXml(JSON.stringify({ application: 'GeRAFE', figure: recipe, figureVersion: document.schemaVersion, referenceId: document.referenceId, widthMm: layout.widthMm, heightMm: layout.heightMm, columns: document.columns.map((column) => ({ title: column.title, region: column.region })), sources: document.sourceDocument.sources.map((source) => ({ id: source.id, name: source.name, format: source.format, files: source.files.map((file) => ({ name: file.name, size: file.size })) })), queryCounts }))}</metadata>`,
    rect(0, 0, layout.widthMm, layout.heightMm, page.background),
    `<g font-family="${escapeXml(page.fontFamily)}">`]
  if (page.title) parts.push(text(layout.widthMm / 2, page.marginMm + fontMm * 1.2, page.title, (appearance.titleSizePt || page.fontSizePt * 1.45) * 25.4 / 72, appearance.headingColor, 'text-anchor="middle" font-weight="700"'))
  for (const column of document.columns) {
    const columnLayout = layout.columns.get(column.id)!
    if (column.title) parts.push(text(columnLayout.x + columnLayout.width / 2, columnLayout.rulerY - 2, column.title, (appearance.headingSizePt || page.fontSizePt * 1.25) * 25.4 / 72, appearance.headingColor, `text-anchor="middle" font-weight="${appearance.headingWeight}"`))
    parts.push(drawRuler(column.region, { x: columnLayout.x, y: columnLayout.rulerY, width: columnLayout.width, height: page.rulerHeightMm }, document))
  }
  const visibleRows = document.rows.filter((row) => row.included)
  const sharedMatrixMaxima = new Map<string, number>()
  const sharedMatrixObservedMaxima = new Map<string, number>()
  for (const row of visibleRows) for (const column of document.columns) for (const trackId of figureAssignedTrackIds(document, column, row.id)) {
    const spec = document.sourceDocument.tracks.find((track) => track.id === trackId)
    if (spec?.kind !== 'matrix') continue
    const matrix = (cells.get(cellKey(column.id, row.id))?.get(spec.id) ?? []).find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
    if (!matrix) continue
    const key = `${row.id}\u0000${spec.matrixValueMode}\u0000${spec.matrixComparisonMode}`
    sharedMatrixMaxima.set(key, Math.max(sharedMatrixMaxima.get(key) ?? 0, matrixSourceMaximum(matrix, spec)))
    sharedMatrixObservedMaxima.set(key, Math.max(sharedMatrixObservedMaxima.get(key) ?? 0, matrixSourceMaximum(matrix, spec, false)))
  }
  for (let index = 0; index < visibleRows.length;) {
    const label = visibleRows[index].groupLabel
    if (!label) { index++; continue }
    let end = index + 1
    while (end < visibleRows.length && visibleRows[end].groupLabel === label) end++
    const first = layout.rows.get(visibleRows[index].id)!
    const last = layout.rows.get(visibleRows[end - 1].id)!
    const middle = (first.y + last.y + last.height) / 2
    const group = resolveAppearance(rowFields, visibleRows[index].appearance)
    parts.push(line(page.marginMm + group.groupBracketXmm, first.y, page.marginMm + group.groupBracketXmm, last.y + last.height, group.groupColor, group.groupLinePt * 25.4 / 72))
    parts.push(`<text x="${n(page.marginMm + group.groupLabelXmm)}" y="${n(middle)}" transform="rotate(-90 ${n(page.marginMm + group.groupLabelXmm)} ${n(middle)})" text-anchor="middle" font-size="${n((group.groupFontPt || page.fontSizePt * 1.15) * 25.4 / 72)}" font-weight="700" fill="${group.groupColor}">${escapeXml(label)}</text>`)
    index = end
  }
  for (const row of document.rows) {
    const rowLayout = layout.rows.get(row.id)
    if (!rowLayout) continue
    const firstColumn = layout.columns.get(document.columns[0].id)!
    const rowAppearance = resolveAppearance(rowFields, row.appearance)
    const labelX = firstColumn.x - rowAppearance.labelGapMm + rowAppearance.labelOffsetXmm
    const labelY = rowLayout.y + rowLayout.height / 2 + rowAppearance.labelOffsetYmm
    const vertical = rowAppearance.labelOrientation === 'vertical'
    parts.push(text(labelX, labelY, row.label, (row.labelFontSizePt ?? page.fontSizePt) * 25.4 / 72, row.labelColor ?? '#111111', `text-anchor="${vertical ? 'middle' : 'end'}" dominant-baseline="middle" font-weight="${rowAppearance.labelWeight}" ${vertical ? `transform="rotate(-90 ${n(labelX)} ${n(labelY)})"` : ''}`))
    for (const column of document.columns) {
      const frame = figureCellBounds(layout, row.id, column.id)!
      const padding = Math.min(rowAppearance.paddingMm, (frame.height - 0.5) / 2)
      const bounds = { ...frame, y: frame.y + padding, height: frame.height - padding * 2 }
      const clipId = `clip-${safeId(column.id)}-${safeId(row.id)}`
      parts.push(`<defs><clipPath id="${clipId}">${rect(bounds.x, bounds.y, bounds.width, bounds.height, '#ffffff')}</clipPath></defs>`)
      parts.push(`<g data-fe-row="${escapeXml(row.id)}" data-fe-column="${escapeXml(column.id)}">`)
      parts.push(rect(frame.x, frame.y, frame.width, frame.height, rowAppearance.background))
      parts.push(`<g clip-path="url(#${clipId})">`)
      const trackIds = figureAssignedTrackIds(document, column, row.id)
      const cell: QueryCell = cells.get(cellKey(column.id, row.id)) ?? new Map()
      const specs = trackIds.map((id) => document.sourceDocument.tracks.find((track) => track.id === id)).filter((item): item is TrackSpec => Boolean(item))
      const style = column.styles?.[row.id]
      if (!specs.length) parts.push(text(bounds.x + 2, bounds.y + bounds.height / 2, 'No track assigned', fontMm * 0.8, '#888888'))
      else if (specs.length > 1 && specs.every((spec) => spec.kind === 'signal') || figureStackGroup(document, column, row.id)) parts.push(drawSignalStack(specs, cell, column.region, bounds, document, cells, row, column.id, style))
      else for (const spec of specs) {
        const renderSpec = figureTrackSpec(spec, style)
        const features = cell.get(spec.id) ?? []
        if (spec.kind === 'signal') parts.push(drawSignal(features as SignalFeature[], renderSpec, column.region, bounds, document, cells, row, style, cell))
        else if (spec.kind === 'stranded') parts.push(drawStranded(renderSpec, features as SignalFeature[], cell, column.region, bounds, style, document, row, cells))
        else if (spec.kind === 'interval') parts.push(drawIntervals(features as IntervalFeature[], renderSpec, column.region, bounds, fontMm))
        else if (spec.kind === 'interaction') parts.push(drawInteractions(features as InteractionFeature[], renderSpec, column.region, bounds, genes, style))
        else if (spec.kind === 'matrix') {
          parts.push(`<g opacity="${n((style?.opacity ?? 100) / 100)}">`)
          parts.push(drawMatrix(features as MatrixFeature[], renderSpec, column.region, bounds, document.page.background, style,
            (style?.scaleMode === 'shared' ? sharedMatrixObservedMaxima : sharedMatrixMaxima).get(`${row.id}\u0000${spec.matrixValueMode}\u0000${spec.matrixComparisonMode}`), issues, `${column.title || 'Column'} / ${row.label}`))
          parts.push(drawMatrixBedpeOverlay(document, renderSpec, cell, column.region, bounds, genes))
          if (rowAppearance.showAnnotations && rowAppearance.showOutlines) parts.push(drawMatrixOutlines(document, spec.id, renderSpec, column.region, bounds))
          parts.push('</g>')
        }
        else if (spec.kind === 'alignment') parts.push(drawAlignments(features, renderSpec, column.region, bounds))
        else if (spec.kind === 'genes') {
          const referenceId = document.sourceDocument.sources.find((source) => source.id === spec.sourceIds[0])?.annotationReferenceId
          if (referenceId && referenceId !== document.referenceId) continue
          const source = spec.sourceIds[0] ? sources.get(spec.sourceIds[0]) : genes
          if (source instanceof GeneSource) parts.push(`<g opacity="${n((style?.opacity ?? 100) / 100)}">${drawGenes(source, renderSpec, column.region, bounds, fontMm, style)}</g>`)
        }
      }
      if (rowAppearance.showAnnotations) parts.push(drawAnnotations(document, column.region, bounds, specs.find((spec) => spec.kind === 'matrix') ? figureTrackSpec(specs.find((spec) => spec.kind === 'matrix')!, style) : undefined, rowAppearance))
      parts.push('</g>')
      for (const spec of specs.filter((item) => item.kind === 'matrix')) {
        const matrix = (cell.get(spec.id) ?? []).find((item): item is MatrixFeature => 'featureType' in item && item.featureType === 'matrix')
        if (matrix) parts.push(drawMatrixLegend(matrix, figureTrackSpec(spec, style), bounds, style, (style?.scaleMode === 'shared' ? sharedMatrixObservedMaxima : sharedMatrixMaxima).get(`${row.id}\u0000${spec.matrixValueMode}\u0000${spec.matrixComparisonMode}`), column.id === document.columns.at(-1)!.id))
      }
      parts.push(`<rect x="${n(frame.x)}" y="${n(frame.y)}" width="${n(frame.width)}" height="${n(frame.height)}" fill="none" stroke="${escapeXml(row.frameColor ?? '#444444')}" stroke-width="${n((row.frameWidthPt ?? 0.5) * 25.4 / 72)}"/>`)
      parts.push('</g>')
    }
  }
  if (issues.length) parts.push(text(page.marginMm, layout.heightMm - page.marginMm / 2, `${issues.length} source issue${issues.length === 1 ? '' : 's'} — export requires review`, fontMm * 0.75, '#b42318'))
  parts.push('</g></svg>')
  return parts.join('')
}

function safeId(value: string): string { return value.replace(/[^a-z0-9_-]/gi, '_') }

function drawRuler(region: Region, bounds: FigureCellBounds, document: FigureDocument): string {
  const a = resolveAppearance(pageFields, document.page.appearance)
  if (bounds.height <= 0 || a.rulerStyle === 'none') return ''
  const font = (a.rulerFontPt || document.page.fontSizePt * 0.7) * 25.4 / 72
  const chromosomeFont = (a.chromosomeFontPt || document.page.fontSizePt * 0.8) * 25.4 / 72
  const span = region.end - region.start
  const nice = (value: number) => {
    const power = Math.pow(10, Math.floor(Math.log10(value)))
    return [1, 2, 5, 10].map((multiple) => multiple * power).find((step) => step >= value) ?? power * 10
  }
  const units = a.rulerUnits === 'Mb' ? 1e6 : a.rulerUnits === 'kb' ? 1e3 : 1
  const coordinate = (value: number) => `${(value / units).toFixed(a.rulerDecimals)} ${a.rulerUnits}`
  const y = bounds.y + bounds.height - 0.5
  const stroke = a.rulerLinePt * 25.4 / 72
  const parts = [a.shadeRuler ? rect(bounds.x, bounds.y, bounds.width, bounds.height, a.rulerBackground) : '']
  if (a.showChromosome) parts.push(text(bounds.x + 0.4, bounds.y + chromosomeFont, region.chr, chromosomeFont, a.rulerColor, 'font-weight="700"'))
  if (a.rulerStyle === 'endpoints') {
    parts.push(text(bounds.x + 0.4, y, coordinate(region.start), font, a.rulerColor), text(bounds.x + bounds.width - 0.4, y, coordinate(region.end), font, a.rulerColor, 'text-anchor="end"'))
    const length = Math.min(span, a.scaleBarBp || nice(span / 5))
    const width = length / span * bounds.width
    const x = bounds.x + (bounds.width - width) / 2
    const barY = bounds.y + bounds.height * 0.38
    const barFont = (a.scaleBarFontPt || document.page.fontSizePt * 0.65) * 25.4 / 72
    parts.push(line(x, barY, x + width, barY, a.rulerColor, stroke), line(x, barY - 0.5, x, barY + 0.5, a.rulerColor, stroke), line(x + width, barY - 0.5, x + width, barY + 0.5, a.rulerColor, stroke), text(x + width / 2, barY + barFont + 0.5, length >= 1e6 ? `${length / 1e6} Mb` : length >= 1e3 ? `${length / 1e3} kb` : `${length} bp`, barFont, a.rulerColor, 'text-anchor="middle"'))
  } else {
    const step = nice(span / 4)
    parts.push(line(bounds.x, y, bounds.x + bounds.width, y, a.rulerColor, stroke))
    for (let pos = Math.ceil(region.start / step) * step; pos < region.end; pos += step) {
      const x = px(region, bounds, pos)
      parts.push(line(x, y - 0.7, x, y + 0.5, a.rulerColor, stroke), text(x, y - 1.2, coordinate(pos), font, a.rulerColor, 'text-anchor="middle"'))
    }
  }
  return parts.join('')
}

function signalDomain(features: readonly SignalFeature[], spec: TrackSpec, document: FigureDocument, respectSource = true): { min: number; max: number } {
  const binding = document.sourceDocument.scales.find((item) => item.id === spec.scaleBindingId)
  if (respectSource && binding?.mode === 'fixed' && binding.limits) return binding.limits
  let min = 0; let max = 0
  for (const feature of features) { if (Number.isFinite(feature.score)) { min = Math.min(min, feature.score); max = Math.max(max, feature.score) } }
  if (spec.allowNegativeValues === false) min = 0
  return { min, max }
}

/** Sections are genomic intervals, never numbered display labels. */
export function figureScaleSections(document: FigureDocument, row: FigureRow, region: Region): Region[] {
  const cuts = resolveAppearance(rowFields, row.appearance).segmentedScales
    ? document.sourceDocument.comparisonDividers.filter((divider) => divider.chr === region.chr && divider.position > region.start && divider.position < region.end).map((divider) => divider.position) : []
  const positions = [...new Set([region.start, ...cuts, region.end])].sort((a, b) => a - b)
  return positions.slice(0, -1).map((start, index) => ({ chr: region.chr, start, end: positions[index + 1] }))
}

function sectionDomain(document: FigureDocument, row: FigureRow, allCells: Map<string, QueryCell>, cell: QueryCell, region: Region, spec: TrackSpec, style?: FigureCellStyle, stranded = false, viewport = region): { min: number; max: number } {
  if (style?.scaleMode === 'fixed') return style.segmentLimits?.[String(region.start)] ?? { min: style.scaleMin ?? 0, max: style.scaleMax ?? 1 }
  const sectionIndex = figureScaleSections(document, row, viewport).findIndex((section) => section.start === region.start)
  const values: SignalFeature[] = []
  const negatives: SignalFeature[] = []
  for (const column of document.columns) {
    const candidate = allCells.get(cellKey(column.id, row.id))
    if (!candidate || style?.scaleMode === 'independent' && candidate !== cell) continue
    for (const id of figureAssignedTrackIds(document, column, row.id)) {
      const assigned = document.sourceDocument.tracks.find((track) => track.id === id)
      if (!assigned || (stranded ? assigned.kind !== 'stranded' : assigned.kind !== 'signal')) continue
      const pooledSection = figureScaleSections(document, row, column.region)[sectionIndex] ?? column.region
      const overlap = (feature: SignalFeature) => Number.isFinite(feature.score) && feature.start < pooledSection.end && feature.end > pooledSection.start
      values.push(...((candidate.get(id) ?? []) as SignalFeature[]).filter(overlap).map((feature) => !stranded && assigned.allowNegativeValues === false ? { ...feature, score: Math.max(0, feature.score) } : feature))
      if (stranded) negatives.push(...((candidate.get(assigned.sourceIds[1]) ?? []) as SignalFeature[]).filter(overlap))
    }
  }
  if (stranded) {
    let max = values.reduce((limit, feature) => Math.max(limit, Math.abs(feature.score)), 0)
    let min = negatives.reduce((limit, feature) => Math.max(limit, Math.abs(feature.score)), 0)
    if (!style?.scaleMode || style.scaleMode === 'source') {
      const positive = document.sourceDocument.scales.find((binding) => binding.id === spec.scaleBindingId)
      const negative = document.sourceDocument.scales.find((binding) => binding.id === spec.negativeScaleBindingId)
      if (positive?.mode === 'fixed' && positive.limits) max = Math.max(Math.abs(positive.limits.min), Math.abs(positive.limits.max))
      if (negative?.mode === 'fixed' && negative.limits) min = Math.max(Math.abs(negative.limits.min), Math.abs(negative.limits.max))
    }
    return { min: -min, max }
  }
  return signalDomain(values, spec, document, !style?.scaleMode || style.scaleMode === 'source')
}

function scaleLabel(value: number, appearance: RowAppearance): string { return Number(value.toPrecision(appearance.scalePrecision)).toString() }
function drawScaleLabels(bounds: FigureCellBounds, domain: { min: number; max: number }, appearance = resolveAppearance(rowFields), showZeroMinimum = false): string {
  const font = appearance.scaleFontPt * 25.4 / 72
  const label = (value: number, y: number) => {
    const formatted = scaleLabel(value, appearance)
    const x = bounds.x + appearance.scaleInsetMm
    return (appearance.scaleLabelBackground ? rect(x - 0.2, y - font * 0.85, formatted.length * font * 0.58 + 0.4, font * 1.05, appearance.scaleBackgroundColor) : '') + text(x, y, formatted, font, appearance.scaleColor)
  }
  return label(domain.max, bounds.y + font + 0.3) + ((domain.min !== 0 || showZeroMinimum) ? label(domain.min, bounds.y + bounds.height - 0.3) : '')
}

function drawSignal(features: SignalFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds, document: FigureDocument, allCells: Map<string, QueryCell>, row: FigureRow, style?: FigureCellStyle, queryCell?: QueryCell): string {
  const a = resolveAppearance(rowFields, row.appearance)
  const cell = queryCell ?? new Map()
  const c = resolveAppearance(cellFields, style?.appearance)
  return figureScaleSections(document, row, region).map((section) => {
    const left = px(region, bounds, section.start), right = px(region, bounds, section.end)
    const b = { ...bounds, x: left, width: right - left }
    const domain = sectionDomain(document, row, allCells, cell, section, spec, style, false, region)
    const inset = Math.min(0.8, bounds.height * 0.1)
    const y = (score: number) => bounds.y + inset + (bounds.height - inset * 2) * (1 - (Math.max(domain.min, Math.min(domain.max, score)) - domain.min) / Math.max(1e-12, domain.max - domain.min))
    const zero = y(0)
    const values = features.filter((feature) => feature.end > section.start && feature.start < section.end && Number.isFinite(feature.score))
    const color = style?.color ?? spec.color
    const lineStyle = (style?.renderStyle === 'source' || !style?.renderStyle ? spec.signalRenderStyle : style.renderStyle) === 'line'
    const marks = lineStyle ? `<path d="${values.map((feature, index) => `${index ? 'L' : 'M'}${n(px(region, bounds, (Math.max(section.start, feature.start) + Math.min(section.end, feature.end)) / 2))} ${n(y(feature.score))}`).join(' ')}" fill="none" stroke="${escapeXml(color)}" stroke-width="${n(c.lineWidthPt * 25.4 / 72)}"/>`
      : values.map((feature) => { const x1 = Math.max(left, px(region, bounds, feature.start)), x2 = Math.min(right, px(region, bounds, feature.end)), point = y(feature.score); return rect(x1, Math.min(zero, point), x2 - x1, Math.abs(zero - point), color) }).join('')
    return `<g data-scale-start="${section.start}" data-scale-min="${n(domain.min)}" data-scale-max="${n(domain.max)}"><g opacity="${n((style?.opacity ?? spec.signalOpacity ?? 100) / 100)}">${marks}</g>${line(left, zero, right, zero, a.baselineColor, a.baselineWidthPt * 25.4 / 72)}${style?.showScale === false ? '' : drawScaleLabels(b, domain, a)}</g>`
  }).join('')
}

function drawSignalStack(specs: TrackSpec[], cell: QueryCell, region: Region, bounds: FigureCellBounds, document: FigureDocument, allCells: Map<string, QueryCell>, row: FigureRow, columnId: string, style?: FigureCellStyle): string {
  const column = document.columns.find((column) => column.id === columnId)!
  const group = figureStackGroup(document, column, row.id) ?? { id: '', label: '', signalStackRenderStyle: 'line' as const, signalStackDifferentiation: 'colors' as const }
  const members = document.sourceDocument.tracks.filter((track) => track.displayGroupId === group.id)
  const a = stackAppearance(group, members.length ? members : specs)
  const entries = signalStackDisplayEntries(group, members.length ? members : specs, specs)
  const presentation = resolveAppearance(rowFields, row.appearance)
  const renderStyle = !style?.renderStyle || style.renderStyle === 'source' ? a.renderStyle : style.renderStyle === 'line' ? 'line' : 'fill'
  const fills: string[] = [], outlines: string[] = [], labels: string[] = []
  for (const section of figureScaleSections(document, row, region)) {
    const domain = sectionDomain(document, row, allCells, cell, section, { ...specs[0], allowNegativeValues: true }, style, false, region)
    const left = px(region, bounds, section.start), right = px(region, bounds, section.end)
    const inset = Math.min(0.8, bounds.height * 0.1)
    const transform = document.sourceDocument.scales.find((binding) => binding.id === specs[0].scaleBindingId)?.transform ?? 'linear'
    const transformedMin = signalTransform(domain.min, transform), transformedMax = signalTransform(domain.max, transform)
    const y = (value: number) => bounds.y + inset + (bounds.height - inset * 2) * (1 - (signalTransform(Math.max(domain.min, Math.min(domain.max, value)), transform) - transformedMin) / Math.max(1e-12, transformedMax - transformedMin))
    const zero = y(0)
    for (const spec of specs) {
      const entry = entries.find((entry) => entry.id === spec.id)!
      const values = ((cell.get(spec.id) ?? []) as SignalFeature[]).map((feature) => spec.allowNegativeValues === false ? { ...feature, score: Math.max(0, feature.score) } : feature).filter((feature) => Number.isFinite(feature.score) && feature.start < section.end && feature.end > section.start).sort((a, b) => a.start - b.start)
      const runs: SignalFeature[][] = []
      for (const value of values) {
        const run = runs.at(-1)
        if (!run || value.start > run.at(-1)!.end) runs.push([value]); else run.push(value)
      }
      const color = style?.color ?? entry.color
      const id = `stack-${safeId(columnId)}-${safeId(row.id)}-${safeId(spec.id)}-${section.start}`
      if (renderStyle !== 'line' && entry.pattern !== 'none') fills.push(`<defs>${svgStackPattern(id, entry.pattern, color, a.patternSpacing * 25.4 / 96, 25.4 / 96)}</defs>`)
      for (const run of runs) {
        const x1 = Math.max(left, px(region, bounds, run[0].start)), x2 = Math.min(right, px(region, bounds, run.at(-1)!.end))
        const steps = run.map((feature, index) => `${index ? `L${n(Math.max(left, px(region, bounds, feature.start)))} ${n(y(feature.score))}` : ''} L${n(Math.min(right, px(region, bounds, feature.end)))} ${n(y(feature.score))}`).join(' ')
        const curve = `M${n(x1)} ${n(y(run[0].score))}${steps}`
        const area = `${curve} L${n(x2)} ${n(zero)} L${n(x1)} ${n(zero)} Z`
        if (renderStyle !== 'line') {
          fills.push(`<path data-stack-fill="${escapeXml(spec.id)}" d="${area}" fill="${escapeXml(color)}" opacity="${n((style?.opacity ?? a.opacity) / 100)}"/>`)
          if (entry.pattern !== 'none') fills.push(`<path data-stack-pattern="${entry.pattern}" d="${area}" fill="url(#${id})" opacity="${n(a.patternOpacity / 100)}"/>`)
        }
        if (renderStyle !== 'fill') outlines.push(`<path data-stack-outline="${escapeXml(spec.id)}" d="${curve}" fill="none" stroke="${escapeXml(color)}" stroke-width="${n(style?.appearance?.lineWidthPt ? style.appearance.lineWidthPt * 25.4 / 72 : a.lineWidth * 25.4 / 96)}" stroke-dasharray="${entry.dash.map((value) => n(value * 25.4 / 96)).join(' ')}"/>`)
      }
    }
    labels.push(line(left, zero, right, zero, presentation.baselineColor, presentation.baselineWidthPt * 25.4 / 72))
    if (style?.showScale !== false) labels.push(drawScaleLabels({ ...bounds, x: left, width: right - left }, domain, presentation))
  }
  return fills.join('') + outlines.join('') + labels.join('')
}

function drawStranded(spec: TrackSpec, plus: SignalFeature[], cell: QueryCell, region: Region, bounds: FigureCellBounds, style: FigureCellStyle | undefined, document: FigureDocument, row: FigureRow, allCells: Map<string, QueryCell>): string {
  const minus = (cell.get(spec.sourceIds[1]) ?? []) as SignalFeature[]
  const a = resolveAppearance(rowFields, row.appearance), c = resolveAppearance(cellFields, style?.appearance)
  const fraction = c.positiveFraction / 100
  const midpoint = bounds.y + bounds.height * fraction
  return figureScaleSections(document, row, region).map((section) => {
    const domain = sectionDomain(document, row, allCells, cell, section, spec, style, true, region)
    const left = px(region, bounds, section.start), right = px(region, bounds, section.end)
    const render = (features: SignalFeature[], color: string, positive: boolean) => {
      const maximum = Math.max(1e-12, positive ? domain.max : -domain.min)
      const available = Math.max(0.1, bounds.height * (positive ? fraction : 1 - fraction) - 0.3)
      const values = features.filter((feature) => feature.end > section.start && feature.start < section.end && Number.isFinite(feature.score))
      const point = (score: number) => midpoint + (positive ? -1 : 1) * Math.min(1, Math.abs(score) / maximum) * available
      if (style?.renderStyle === 'line') return `<path d="${values.map((feature, index) => `${index ? 'L' : 'M'}${n(px(region, bounds, (Math.max(section.start, feature.start) + Math.min(section.end, feature.end)) / 2))} ${n(point(feature.score))}`).join(' ')}" fill="none" stroke="${escapeXml(color)}" stroke-width="${n(c.lineWidthPt * 25.4 / 72)}"/>`
      return values.map((feature) => { const x1 = Math.max(left, px(region, bounds, feature.start)), x2 = Math.min(right, px(region, bounds, feature.end)), y = point(feature.score); return rect(x1, Math.min(midpoint, y), x2 - x1, Math.abs(midpoint - y), color) }).join('')
    }
    return `<g data-scale-start="${section.start}" data-scale-min="${n(domain.min)}" data-scale-max="${n(domain.max)}"><g opacity="${n((style?.opacity ?? 100) / 100)}">${render(plus, style?.color ?? spec.color, true)}${render(minus, style?.negativeColor ?? spec.negativeColor ?? '#2878d4', false)}</g>${line(left, midpoint, right, midpoint, a.baselineColor, a.baselineWidthPt * 25.4 / 72)}${style?.showScale === false ? '' : drawScaleLabels({ ...bounds, x: left, width: right - left }, domain, a, true)}</g>`
  }).join('')
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

function figureTrackSpec(spec: TrackSpec, style?: FigureCellStyle): TrackSpec {
  const a = resolveAppearance(cellFields, style?.appearance)
  const colors = a.matrixColors.split(',').map((color) => color.trim()).filter((color) => /^#[0-9a-f]{6}$/i.test(color))
  const focus = a.arcGenes.split(',').map((name) => name.trim()).filter(Boolean)
  return { ...spec, color: style?.color ?? spec.color,
    geneDisplayMode: a.geneMode === 'source' ? spec.geneDisplayMode : a.geneMode as TrackSpec['geneDisplayMode'],
    geneTranscriptMode: a.geneTranscripts === 'source' ? spec.geneTranscriptMode : a.geneTranscripts as TrackSpec['geneTranscriptMode'],
    matrixResolution: a.matrixResolutionBp || spec.matrixResolution,
    matrixNormalization: a.matrixNormalization.trim() || spec.matrixNormalization,
    matrixDirection: a.matrixDirection === 'source' ? spec.matrixDirection : a.matrixDirection as TrackSpec['matrixDirection'],
    matrixDepthMode: a.matrixMaxDistanceBp ? 'fixed' : spec.matrixDepthMode,
    matrixMaxDistance: a.matrixMaxDistanceBp || spec.matrixMaxDistance,
    interactionMaxDistance: a.arcMaxDistanceBp || spec.interactionMaxDistance,
    interactionMaxFeatures: a.arcMaxFeatures || spec.interactionMaxFeatures,
    matrixTransform: a.matrixTransform === 'source' ? spec.matrixTransform : a.matrixTransform as TrackSpec['matrixTransform'],
    matrixPalette: colors.length >= 2 ? 'custom' : spec.matrixPalette,
    matrixPaletteColors: colors.length >= 2 ? colors : spec.matrixPaletteColors,
    matrixPaletteReversed: a.matrixReverse === 'source' ? spec.matrixPaletteReversed : a.matrixReverse === 'reverse',
    interactionFilterMode: focus.length ? 'genes' : spec.interactionFilterMode,
    interactionFilterGenes: focus.length ? focus : spec.interactionFilterGenes,
    interactionDirection: a.arcDirection === 'source' ? spec.interactionDirection : a.arcDirection as TrackSpec['interactionDirection'],
  }
}

function drawInteractions(features: InteractionFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds, genes?: GeneSource, style?: FigureCellStyle): string {
  const appearance = resolveAppearance(cellFields, style?.appearance)
  const direction = spec.interactionDirection === 'down' ? 1 : -1
  const baseline = direction < 0 ? bounds.y + bounds.height - 0.8 : bounds.y + 0.8
  const span = region.end - region.start
  const filterMode = spec.interactionFilterMode ?? 'all'
  const targets = filterMode === 'genes' ? (spec.interactionFilterGenes ?? []).map((name) => ({ name, gene: genes?.find(name) }))
    : filterMode === 'visible-genes' ? (genes?.featuresFor(region) ?? []).map((gene) => ({ name: gene.name, gene })) : []
  const filtered = filterInteractionFeatures(filterMode === 'all' ? features : filterInteractionsForGenes(features, targets), spec.interactionMinScore, spec.interactionMaxDistance)
  const selected = selectInteractionFeatures(filtered.filter((feature) => feature.end > region.start && feature.start < region.end), spec.interactionMaxFeatures ?? 2_000)
  const scores = selected.map((feature) => feature.score).filter((score): score is number => Number.isFinite(score))
  const minimum = scores.length ? Math.min(...scores) : 0
  const maximum = scores.length ? Math.max(...scores) : 0
  return selected.map((feature) => {
    if (feature.chrom1 !== region.chr || feature.chrom2 !== region.chr) return ''
    const x1 = px(region, bounds, Math.max(region.start, Math.min(region.end, (feature.start1 + feature.end1) / 2)))
    const x2 = px(region, bounds, Math.max(region.start, Math.min(region.end, (feature.start2 + feature.end2) / 2)))
    if (Math.abs(x2 - x1) > (spec.interactionMaxDistance ?? Infinity) / span * bounds.width) return ''
    const height = Math.min(bounds.height - 1.5, spec.interactionArcHeightMode === 'fixed' ? bounds.height * 0.65 : Math.sqrt(Math.abs(x2 - x1) / bounds.width) * bounds.height)
    const cy = baseline + direction * Math.min(bounds.height - 0.8, height * appearance.arcHeight) * 1.25
    const color = interactionFeatureColor(feature, spec, minimum, maximum)
    const opacity = (style?.opacity ?? spec.interactionOpacity ?? 92) / 100
    if (appearance.arcGeometry === 'ribbon') {
      const anchor = (coordinate: number) => px(region, bounds, Math.max(region.start, Math.min(region.end, coordinate)))
      const a = anchor(feature.start1), b = anchor(feature.end1), c = anchor(feature.start2), d = anchor(feature.end2)
      return `<path d="M ${n(a)} ${n(baseline)} C ${n(a)} ${n(cy)} ${n(d)} ${n(cy)} ${n(d)} ${n(baseline)} L ${n(c)} ${n(baseline)} C ${n(c)} ${n(cy)} ${n(b)} ${n(cy)} ${n(b)} ${n(baseline)} Z" fill="${escapeXml(color)}" opacity="${n(opacity)}"/>`
    }
    return `<path d="M ${n(x1)} ${n(baseline)} C ${n(x1)} ${n(cy)} ${n(x2)} ${n(cy)} ${n(x2)} ${n(baseline)}" fill="none" stroke="${escapeXml(interactionFeatureColor(feature, spec, minimum, maximum))}" stroke-width="${n(appearance.arcWidthPt ? appearance.arcWidthPt * 25.4 / 72 : (spec.interactionLineWidth ?? 1) * 0.2)}" opacity="${n(opacity)}"/>`
  }).join('')
}

function matrixSourceMaximum(matrix: MatrixFeature, spec: TrackSpec, respectSource = true): number {
  if (respectSource && spec.matrixScaleMode === 'fixed' && spec.matrixScaleMax !== undefined) return spec.matrixScaleMax
  const percentile = spec.matrixScaleMode === 'maximum' ? 1 : spec.matrixScalePercentile ?? 0.99
  const signed = spec.matrixValueMode === 'log2-observed-expected' || spec.matrixComparisonMode === 'difference' || spec.matrixComparisonMode === 'log2-ratio'
  return signed ? matrixAutomaticMagnitude(matrix, percentile, spec.matrixIgnoreDiagonals ?? 3) : matrixAutomaticMaximum(matrix, percentile, spec.matrixIgnoreDiagonals ?? 3)
}

function matrixDomain(matrix: MatrixFeature, spec: TrackSpec, style?: FigureCellStyle, sharedMaximum?: number) {
  const signed = spec.matrixValueMode === 'log2-observed-expected' || spec.matrixComparisonMode === 'difference' || spec.matrixComparisonMode === 'log2-ratio'
  const minimum = signed ? 0 : Math.max(0, style?.scaleMode === 'fixed' ? style.scaleMin ?? 0 : spec.matrixScaleMin ?? 0)
  const maximum = Math.max(minimum + 1e-9, style?.scaleMode === 'fixed' && style.scaleMax !== undefined ? style.scaleMax
    : style?.scaleMode === 'independent' ? matrixSourceMaximum(matrix, spec, false) : sharedMaximum ?? matrixSourceMaximum(matrix, spec))
  return { signed, minimum, maximum }
}

function matrixFill(value: number, minimum: number, maximum: number, signed: boolean, spec: TrackSpec, style?: FigureCellStyle): { color: string; alpha: number } {
  if (signed) return { color: matrixSignedColor(value / maximum), alpha: 1 }
  const intensity = matrixPaletteIntensity(matrixValueIntensity(value, minimum, maximum, spec.matrixTransform ?? 'log1p'), spec.matrixPaletteReversed === true)
  const palette = resolveAppearance(cellFields, style?.appearance).matrixColors.trim() ? 'custom' : style?.matrixPalette && style.matrixPalette !== 'source' ? style.matrixPalette : spec.matrixPalette
  if (palette === 'warm') return { color: matrixWarmPaletteColor(intensity), alpha: 1 }
  if (palette === 'blue-black') return { color: matrixBlueBlackPaletteColor(intensity), alpha: 1 }
  if (palette === 'custom' && (spec.matrixPaletteColors?.length ?? 0) >= 2) return { color: matrixGradientColor(spec.matrixPaletteColors!, intensity), alpha: 1 }
  return { color: spec.color, alpha: 0.08 + Math.pow(intensity, 0.72) * 0.92 }
}

function drawMatrixLegend(matrix: MatrixFeature, spec: TrackSpec, bounds: FigureCellBounds, style: FigureCellStyle | undefined, sharedMaximum: number | undefined, lastColumn: boolean): string {
  const a = resolveAppearance(cellFields, style?.appearance)
  if (style?.showScale === false || a.matrixLegend !== 'right' && !(a.matrixLegend === 'last-column' && lastColumn)) return ''
  const { signed, minimum, maximum } = matrixDomain(matrix, spec, style, sharedMaximum)
  const x = bounds.x + bounds.width + a.legendGapMm
  const height = Math.max(1, bounds.height - 3), y = bounds.y + 1.5
  const min = signed ? -maximum : minimum
  const strips = Array.from({ length: 96 }, (_, index) => {
    const value = maximum - index / 95 * (maximum - min)
    const fill = matrixFill(value, minimum, maximum, signed, spec, style)
    return rect(x, y + index / 96 * height, a.legendWidthMm, height / 96 + 0.01, fill.color, `opacity="${n(fill.alpha)}"`)
  }).join('')
  const font = a.legendFontPt * 25.4 / 72
  return `<g data-fe-legend="matrix">${strips}${text(x + a.legendWidthMm / 2, y - 0.5, Number(maximum.toPrecision(3)).toString(), font, '#222222', 'text-anchor="middle"')}${text(x + a.legendWidthMm / 2, y + height + font, Number(min.toPrecision(3)).toString(), font, '#222222', 'text-anchor="middle"')}</g>`
}

function drawMatrix(features: MatrixFeature[], spec: TrackSpec, region: Region, bounds: FigureCellBounds, pageBackground: string, cellStyle: FigureCellStyle | undefined, sharedMaximum: number | undefined, issues: string[], label: string): string {
  const matrix = features.find((feature) => feature.featureType === 'matrix')
  if (!matrix) return ''
  if (matrix.cells.length > 80_000) {
    issues.push(`${label}: ${matrix.cells.length.toLocaleString()} matrix cells exceed the 80,000-cell SVG safety limit; choose a coarser resolution or narrower region.`)
    return ''
  }
  const { signed, minimum, maximum } = matrixDomain(matrix, spec, cellStyle, sharedMaximum)
  const style = (value: number) => matrixFill(value, minimum, maximum, signed, spec, cellStyle)
  const legend = cellStyle?.showScale === false || resolveAppearance(cellFields, cellStyle?.appearance).matrixLegend !== 'inline' ? '' : rect(bounds.x + 0.7, bounds.y + 0.7, 1.4, 1.4, style(maximum).color)
    + text(bounds.x + 2.6, bounds.y + 2.1, signed ? `±${Number(maximum.toPrecision(3))}` : `${Number(minimum.toPrecision(3))}–${Number(maximum.toPrecision(3))}`, resolveAppearance(cellFields, cellStyle?.appearance).legendFontPt * 25.4 / 72, '#222222')
  const resolution = matrix.resolution
  if (matrix.axis2) {
    const axis = matrix.axis2
    const background = spec.matrixZeroStyle === 'background' ? '' : rect(bounds.x, bounds.y, bounds.width, bounds.height, spec.matrixZeroStyle === 'custom' ? spec.matrixZeroColor ?? '#d7d9df' : style(0).color)
    const contacts = matrix.cells.filter((cell) => signed ? Number.isFinite(cell.value) : cell.value > 0 && Number.isFinite(cell.value)).map((cell) => {
      const x1 = px(region, bounds, cell.bin1)
      const x2 = px(region, bounds, cell.bin1 + resolution)
      const y1 = bounds.y + (cell.bin2 - axis.start) / (axis.end - axis.start) * bounds.height
      const y2 = bounds.y + (cell.bin2 + resolution - axis.start) / (axis.end - axis.start) * bounds.height
      const fill = style(cell.value)
      return rect(x1, y1, x2 - x1, y2 - y1, fill.color, `opacity="${n(fill.alpha)}"`)
    }).join('')
    const missing = (matrix.missingCells ?? []).map((cell) => rect(px(region, bounds, cell.bin1), bounds.y + (cell.bin2 - axis.start) / (axis.end - axis.start) * bounds.height,
      resolution / (region.end - region.start) * bounds.width, resolution / (axis.end - axis.start) * bounds.height,
      spec.matrixMissingStyle === 'custom' ? spec.matrixMissingColor ?? '#9197a3' : pageBackground)).join('')
    const maskColor = spec.matrixMaskedStyle === 'custom' ? spec.matrixMaskedColor ?? '#9197a3' : spec.matrixMaskedStyle === 'background' ? pageBackground : '#9197a3'
    const maskOpacity = spec.matrixMaskedStyle === 'hatch' ? 0.55 : 1
    const maskX = (matrix.maskedBins ?? []).map((bin) => rect(px(region, bounds, bin), bounds.y,
      resolution / (region.end - region.start) * bounds.width, bounds.height, maskColor, `opacity="${n(maskOpacity)}"`)).join('')
    const maskY = (matrix.maskedBins2 ?? []).map((bin) => rect(bounds.x, bounds.y + (bin - axis.start) / (axis.end - axis.start) * bounds.height,
      bounds.width, resolution / (axis.end - axis.start) * bounds.height, maskColor, `opacity="${n(maskOpacity)}"`)).join('')
    return background + contacts + missing + maskX + maskY + legend
  }
  const direction = spec.matrixDirection === 'down' ? 1 : -1
  const baseline = direction < 0 ? bounds.y + bounds.height : bounds.y
  const binWidth = resolution / (region.end - region.start) * bounds.width
  const depth = Math.min(bounds.height, bounds.width / 2, matrixQueryMaximumDistance(region.end - region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance) / (region.end - region.start) * bounds.width / 2)
  const background = spec.matrixZeroStyle === 'background' || signed && spec.matrixZeroStyle !== 'custom' ? ''
    : `<polygon points="${n(bounds.x)},${n(baseline)} ${n(bounds.x + bounds.width)},${n(baseline)} ${n(bounds.x + bounds.width - depth)},${n(baseline + direction * depth)} ${n(bounds.x + depth)},${n(baseline + direction * depth)}" fill="${escapeXml(spec.matrixZeroStyle === 'custom' ? spec.matrixZeroColor ?? '#d7d9df' : style(0).color)}"/>`
  const contact = (bin1: number, bin2: number, fill: string, alpha: number): string => {
    const x = px(region, bounds, (bin1 + bin2 + resolution) / 2)
    const distance = Math.abs(bin2 - bin1) / (region.end - region.start) * bounds.width
    const y = baseline + direction * distance / 2
    if (y < bounds.y - binWidth || y > bounds.y + bounds.height + binWidth) return ''
    return `<path d="M ${n(x)} ${n(y - binWidth / 2)} L ${n(x + binWidth / 2)} ${n(y)} L ${n(x)} ${n(y + binWidth / 2)} L ${n(x - binWidth / 2)} ${n(y)} Z" fill="${escapeXml(fill)}" opacity="${n(alpha)}"/>`
  }
  const contacts = matrix.cells.filter((cell) => signed ? Number.isFinite(cell.value) : cell.value > 0 && Number.isFinite(cell.value)).map((cell) => {
    const fill = style(cell.value)
    return contact(cell.bin1, cell.bin2, fill.color, fill.alpha)
  }).join('')
  const missing = (matrix.missingCells ?? []).map((cell) => contact(cell.bin1, cell.bin2, spec.matrixMissingStyle === 'custom' ? spec.matrixMissingColor ?? '#9197a3' : pageBackground, 1)).join('')
  const maskColor = spec.matrixMaskedStyle === 'custom' ? spec.matrixMaskedColor ?? '#9197a3' : spec.matrixMaskedStyle === 'background' ? pageBackground : '#9197a3'
  const maskOpacity = spec.matrixMaskedStyle === 'hatch' ? 0.55 : 1
  const masked = (matrix.maskedBins ?? []).map((bin) => {
    const baseX = px(region, bounds, bin + resolution / 2)
    const maxDepth = Math.min(depth, bounds.height)
    const width = Math.max(0.25, binWidth / 2)
    const extra = `opacity="${n(maskOpacity)}" ${spec.matrixMaskedStyle === 'hatch' ? 'stroke-dasharray="0.8 0.5"' : ''}`
    return line(baseX, baseline, baseX - maxDepth, baseline + direction * maxDepth, maskColor, width, extra)
      + line(baseX, baseline, baseX + maxDepth, baseline + direction * maxDepth, maskColor, width, extra)
  }).join('')
  return background + contacts + missing + masked + legend
}

function drawMatrixOutlines(document: FigureDocument, trackId: string, spec: TrackSpec, region: Region, bounds: FigureCellBounds): string {
  const parts: string[] = []
  for (const outline of document.sourceDocument.matrixOutlines) {
    if (!outline.visible || (outline.sourceTrackId !== trackId && !outline.targetTrackIds.includes(trackId))) continue
    const outlineWidth = document.annotationStyles?.[`outline:${outline.id}`]?.lineWidthMm ?? 0.35
    if (outline.axis1.chr !== region.chr || outline.axis1.end <= region.start || outline.axis1.start >= region.end) continue
    if (spec.matrixSecondaryRegion) {
      const axis = spec.matrixSecondaryRegion
      if (outline.axis2.chr !== axis.chr || outline.axis2.end <= axis.start || outline.axis2.start >= axis.end) continue
      const x1 = px(region, bounds, outline.axis1.start)
      const x2 = px(region, bounds, outline.axis1.end)
      const y1 = bounds.y + (outline.axis2.start - axis.start) / (axis.end - axis.start) * bounds.height
      const y2 = bounds.y + (outline.axis2.end - axis.start) / (axis.end - axis.start) * bounds.height
      parts.push(`<rect x="${n(x1)}" y="${n(y1)}" width="${n(x2 - x1)}" height="${n(y2 - y1)}" fill="none" stroke="${escapeXml(outline.color)}" stroke-width="${n(outlineWidth)}"/>`)
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
    parts.push(`<polygon points="${points}" fill="none" stroke="${escapeXml(outline.color)}" stroke-width="${n(outlineWidth)}"/>`)
  }
  return parts.join('')
}

function drawMatrixBedpeOverlay(document: FigureDocument, spec: TrackSpec, cell: QueryCell, region: Region, bounds: FigureCellBounds, genes?: GeneSource): string {
  const overlayId = spec.matrixOverlayInteractionTrackId
  if (!overlayId) return ''
  const interactionSpec = document.sourceDocument.tracks.find((track) => track.id === overlayId && track.kind === 'interaction')
  const matrix = (cell.get(spec.id) ?? []).find((feature): feature is MatrixFeature => 'featureType' in feature && feature.featureType === 'matrix')
  if (!interactionSpec || !matrix) return ''
  const source = (cell.get(overlayId) ?? []).filter((feature): feature is InteractionFeature => 'featureType' in feature && feature.featureType === 'interaction')
  const filterMode = interactionSpec.interactionFilterMode ?? 'all'
  const targets = filterMode === 'genes' ? (interactionSpec.interactionFilterGenes ?? []).map((name) => ({ name, gene: genes?.find(name) }))
    : filterMode === 'visible-genes' ? (genes?.featuresFor(region) ?? []).map((gene) => ({ name: gene.name, gene })) : []
  let selected = filterMode === 'all' ? source : filterInteractionsForGenes(source, targets)
  selected = filterInteractionFeatures(selected, interactionSpec.interactionMinScore, interactionSpec.interactionMaxDistance)
  if (spec.matrixOverlayFocusMode === 'genes') selected = filterInteractionsForGenes(selected, (spec.matrixOverlayFocusGenes ?? []).map((name) => ({ name, gene: genes?.find(name) })))
  else if (spec.matrixOverlayFocusMode === 'region' && spec.matrixOverlayFocusRegion) selected = selected.filter((feature) => interactionTouchesRegion(feature, spec.matrixOverlayFocusRegion!))
  const depth = matrixQueryMaximumDistance(region.end - region.start, spec.matrixDepthMode ?? 'full', spec.matrixMaxDistance)
  selected = selected.filter((feature) => {
    const pair = matrixOverlayAnchorPair(feature, region, matrix.axis2)
    return pair && (matrix.axis2 || Math.abs(pair.vertical - pair.horizontal) <= depth)
  })
  const limit = Math.min(interactionSpec.interactionMaxFeatures ?? 2_000, spec.matrixOverlayMaxFeatures ?? 250)
  const outlined = selectInteractionFeatures(selected, limit)
  const scores = outlined.map((feature) => feature.score).filter((score): score is number => Number.isFinite(score))
  const scoreMin = scores.length ? Math.min(...scores) : 0
  const scoreMax = scores.length ? Math.max(...scores) : 0
  const width = Math.max(0.2, (interactionSpec.interactionLineWidth ?? 1) * 0.22)
  const opacity = (interactionSpec.interactionOpacity ?? 92) / 100
  return outlined.map((feature) => {
    const pair = matrixOverlayAnchorPair(feature, region, matrix.axis2)!
    const color = interactionFeatureColor(feature, interactionSpec, scoreMin, scoreMax)
    const horizontal = Math.floor(pair.horizontal / matrix.resolution) * matrix.resolution + matrix.resolution / 2
    const vertical = Math.floor(pair.vertical / matrix.resolution) * matrix.resolution + matrix.resolution / 2
    if (matrix.axis2) {
      const cellWidth = Math.max(0.7, matrix.resolution / (region.end - region.start) * bounds.width)
      const cellHeight = Math.max(0.7, matrix.resolution / (matrix.axis2.end - matrix.axis2.start) * bounds.height)
      const x = px(region, bounds, horizontal) - cellWidth / 2
      const y = bounds.y + (vertical - matrix.axis2.start) / (matrix.axis2.end - matrix.axis2.start) * bounds.height - cellHeight / 2
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(cellWidth)}" height="${n(cellHeight)}" fill="none" stroke="#ffffff" stroke-width="${n(width + 0.35)}"/><rect x="${n(x)}" y="${n(y)}" width="${n(cellWidth)}" height="${n(cellHeight)}" fill="none" stroke="${escapeXml(color)}" stroke-width="${n(width)}" opacity="${n(opacity)}"/>`
    }
    const direction = spec.matrixDirection === 'down' ? 1 : -1
    const baseline = direction < 0 ? bounds.y + bounds.height : bounds.y
    const x = px(region, bounds, (horizontal + vertical) / 2)
    const y = baseline + direction * (vertical - horizontal) / (region.end - region.start) * bounds.width / 2
    const half = Math.max(0.7, matrix.resolution / (region.end - region.start) * bounds.width / 2)
    const points = `${n(x - half)},${n(y)} ${n(x)},${n(y + half)} ${n(x + half)},${n(y)} ${n(x)},${n(y - half)}`
    return `<polygon points="${points}" fill="none" stroke="#ffffff" stroke-width="${n(width + 0.35)}"/><polygon points="${points}" fill="none" stroke="${escapeXml(color)}" stroke-width="${n(width)}" opacity="${n(opacity)}"/>`
  }).join('')
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
    const alt = (feature.alleleFrequency ?? 0) >= (spec.bamMinAlleleFrequency ?? 0) && (feature.alleleFrequency ?? 0) > 0
    return rect(x1, bounds.y + coverageHeight - height, Math.max(0, x2 - x1), height, spec.color)
      + (alt ? rect(x1, bounds.y + coverageHeight - height, Math.max(0, x2 - x1), Math.max(0.2, height * (feature.alleleFrequency ?? 0)), '#ef8f2f') : '')
  }).join('') + text(bounds.x + 0.7, bounds.y + 2.5, Number(maximum.toPrecision(3)).toString(), 1.9)
  if (mode === 'coverage') return bars
  const readsTop = bounds.y + coverageHeight + (coverageHeight ? 0.7 : 0.5)
  const laneHeight = spec.alignmentDisplayMode === 'squished' ? 0.9 : spec.alignmentDisplayMode === 'collapsed' ? 1.4 : 2.1
  const laneEnds: number[] = []
  const selectedReads = reads.slice(0, spec.bamMaxReads ?? 10_000)
  const groups: AlignmentFeature[][] = []
  if (spec.bamViewAsPairs) {
    const byName = new Map<string, AlignmentFeature[]>()
    for (const read of selectedReads) {
      const group = byName.get(read.name) ?? []
      group.push(read)
      byName.set(read.name, group)
    }
    groups.push(...byName.values())
  } else groups.push(...selectedReads.map((read) => [read]))
  const readMarks = groups.map((group) => {
    const groupStart = Math.min(...group.map((read) => read.start))
    const groupEnd = Math.max(...group.map((read) => read.end))
    const x1 = px(region, bounds, groupStart); const x2 = px(region, bounds, groupEnd)
    let lane = 0
    while ((laneEnds[lane] ?? -Infinity) > x1) lane++
    laneEnds[lane] = x2 + 0.3
    const centerY = readsTop + lane * laneHeight + laneHeight / 2
    const readHeight = Math.max(0.45, laneHeight - 0.5)
    if (centerY + readHeight / 2 > bounds.y + bounds.height) return ''
    const connector = group.length > 1 ? line(Math.max(bounds.x, x1), centerY, Math.min(bounds.x + bounds.width, x2), centerY, bamFigureReadColor(group[0], spec), 0.14, 'opacity="0.65"') : ''
    const marks = group.map((read) => {
      const color = bamFigureReadColor(read, spec)
      const opacity = Math.max(0.28, Math.min(1, 0.32 + read.mapq / 70))
      const blocks = read.blocks.map((block) => {
        const left = Math.max(bounds.x, px(region, bounds, block.start))
        const right = Math.min(bounds.x + bounds.width, px(region, bounds, block.end))
        if (right <= left) return ''
        const tip = Math.min((right - left) / 2, readHeight * 0.45)
        const top = centerY - readHeight / 2; const bottom = centerY + readHeight / 2
        const points = read.strand === '+' && right - left >= readHeight ? [[left, top], [right - tip, top], [right, centerY], [right - tip, bottom], [left, bottom]]
          : read.strand === '-' && right - left >= readHeight ? [[right, top], [left + tip, top], [left, centerY], [left + tip, bottom], [right, bottom]]
            : [[left, top], [right, top], [right, bottom], [left, bottom]]
        return `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${escapeXml(color)}" opacity="${n(opacity)}"/>`
      }).join('')
      const differences = spec.bamShowMismatches === false ? '' : read.differences.map((difference) => {
        if (difference.kind === 'substitution' && (difference.quality ?? 0) < (spec.bamMinMismatchBaseq ?? 0)) return ''
        if (difference.kind === 'insertion' && spec.bamShowInsertions === false) return ''
        if ((difference.kind === 'deletion' || difference.kind === 'skip') && spec.bamShowDeletions === false) return ''
        if (difference.kind === 'soft-clip' && spec.bamShowSoftClips === false) return ''
        const x = px(region, bounds, difference.position)
        if (x < bounds.x || x > bounds.x + bounds.width) return ''
        if (difference.kind === 'substitution') {
          const base = difference.bases?.[0]?.toUpperCase() ?? 'N'
          const baseColor = ({ A: '#39a85a', C: '#3e83d1', G: '#d89625', T: '#d55362' } as Record<string, string>)[base] ?? '#858b92'
          return rect(x, centerY - readHeight / 2, Math.max(0.25, bounds.width / (region.end - region.start)), readHeight, baseColor)
        }
        if (difference.kind === 'insertion') return line(x, centerY - readHeight / 2 - 0.2, x, centerY + readHeight / 2 + 0.2, '#9b59e6', 0.35)
        if (difference.kind === 'deletion' || difference.kind === 'skip') return line(x, centerY, px(region, bounds, difference.position + difference.length), centerY, difference.kind === 'deletion' ? '#1f2937' : '#858b92', 0.2)
        if (difference.kind === 'soft-clip') return line(x, centerY - readHeight / 2, x, centerY + readHeight / 2, '#858b92', 0.2, 'stroke-dasharray="0.4 0.3"')
        return ''
      }).join('')
      return blocks + differences
    }).join('')
    return connector + marks
  }).join('')
  return bars + readMarks
}

function bamFigureReadColor(read: AlignmentFeature, spec: TrackSpec): string {
  const mode = spec.bamColorMode ?? 'track'
  if (mode === 'strand') return read.strand === '+' ? '#477ed1' : '#d65b70'
  if (mode === 'pair-orientation') {
    if (!read.paired || !read.mateOnSameChromosome) return '#858b92'
    const orientation = read.pairOrientation?.toUpperCase() ?? ''
    return ({ FR: '#477ed1', RF: '#159c8d', FF: '#d88928', RR: '#c052a8' } as Record<string, string>)[orientation] ?? (read.properPair ? '#477ed1' : '#d65b70')
  }
  if (mode === 'mapping-quality') return `hsl(252 58% ${n(76 - Math.max(0, Math.min(60, read.mapq)) / 60 * 38)}%)`
  return spec.color
}

function drawGenes(genes: GeneSource, spec: TrackSpec, region: Region, bounds: FigureCellBounds, fontMm: number, style?: FigureCellStyle): string {
  const a = resolveAppearance(cellFields, style?.appearance)
  const names = a.geneNames.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  const visible = genes.featuresFor(region).filter((gene) => !names.length || names.includes(gene.name.toLowerCase()) || names.includes(gene.id.toLowerCase())).slice(0, 100)
  const laneEnds: number[] = []
  const mode = spec.geneDisplayMode ?? 'collapsed'
  const laneHeight = a.geneLaneMm || (mode === 'squished' ? 1.5 : mode === 'expanded' ? 3.1 : 3.5)
  const color = spec.color || '#164a91'
  const labelFont = a.geneFontPt ? a.geneFontPt * 25.4 / 72 : fontMm * 0.7
  return visible.map((gene) => {
    const x1 = Math.max(bounds.x, px(region, bounds, gene.start)), x2 = Math.min(bounds.x + bounds.width, px(region, bounds, gene.end))
    const models = mode === 'expanded' && spec.geneTranscriptMode === 'all' ? gene.transcriptModels : gene.transcriptModels.slice(0, 1)
    const showLabel = a.geneLabels && mode !== 'squished'
    const occupied = models.length + (showLabel ? Math.ceil((labelFont + a.geneLabelGapMm) / laneHeight) : 0)
    const labelHalfWidth = gene.name.length * labelFont * 0.3
    const labelX = Math.max(bounds.x + labelHalfWidth, Math.min(bounds.x + bounds.width - labelHalfWidth, (x1 + x2) / 2))
    const occupiedStart = showLabel ? Math.min(x1, labelX - labelHalfWidth) : x1
    const occupiedEnd = showLabel ? Math.max(x2, labelX + labelHalfWidth) : x2
    let lane = 0
    while (Array.from({ length: occupied }, (_, index) => laneEnds[lane + index] ?? -Infinity).some((end) => end > occupiedStart)) lane++
    for (let index = 0; index < occupied; index++) laneEnds[lane + index] = occupiedEnd + 0.5
    const top = bounds.y + a.geneTopMm + lane * laneHeight
    const marks = models.map((model, index) => {
      const y = top + index * laneHeight
      if (y > bounds.y + bounds.height - 0.3) return ''
      const start = Math.max(bounds.x, px(region, bounds, model.start)), end = Math.min(bounds.x + bounds.width, px(region, bounds, model.end))
      const blocks = (features: { start: number; end: number }[], height: number) => features.map((block) => {
        const left = Math.max(bounds.x, px(region, bounds, block.start)), right = Math.min(bounds.x + bounds.width, px(region, bounds, block.end))
        return rect(left, y - height / 2, right - left, height, color)
      }).join('')
      const exonHeight = mode === 'squished' ? a.exonHeightMm * 0.6 : a.exonHeightMm
      const arrowX = gene.strand === '+' ? Math.min(end - 0.3, bounds.x + bounds.width - 0.5) : Math.max(start + 0.3, bounds.x + 0.5)
      const arrowSize = a.arrowSizeMm, direction = gene.strand === '+' ? -1 : 1
      const arrow = arrowSize ? `<path d="M ${n(arrowX + direction * arrowSize)} ${n(y - arrowSize * 0.7)} L ${n(arrowX)} ${n(y)} L ${n(arrowX + direction * arrowSize)} ${n(y + arrowSize * 0.7)}" fill="none" stroke="${escapeXml(color)}" stroke-width="${n(a.intronWidthPt * 25.4 / 72)}"/>` : ''
      return line(start, y, end, y, color, a.intronWidthPt * 25.4 / 72) + blocks(model.exons, exonHeight) + (mode === 'squished' ? '' : blocks(model.cds, a.cdsHeightMm)) + arrow
    }).join('')
    const labelY = a.geneLabelPosition === 'above' ? top - Math.max(a.exonHeightMm, a.cdsHeightMm) / 2 - a.geneLabelGapMm : top + (models.length - 1) * laneHeight + Math.max(a.exonHeightMm, a.cdsHeightMm) / 2 + a.geneLabelGapMm + labelFont
    return marks + (showLabel && labelY >= bounds.y + labelFont && labelY <= bounds.y + bounds.height ? text(labelX, labelY, gene.name, labelFont, a.geneLabelColor, `text-anchor="middle" ${a.geneItalic ? 'font-style="italic"' : ''}`) : '')
  }).join('')
}

function drawAnnotations(document: FigureDocument, region: Region, bounds: FigureCellBounds, matrixSpec?: TrackSpec, appearance = resolveAppearance(rowFields)): string {
  const parts: string[] = []
  for (const saved of appearance.showRegions ? document.sourceDocument.savedRegions : []) {
    if (saved.region.chr !== region.chr || saved.region.end <= region.start || saved.region.start >= region.end || !saved.highlighted) continue
    const x1 = px(region, bounds, saved.region.start)
    const x2 = px(region, bounds, saved.region.end)
    const dash = saved.boundaryStyle === 'dashed' ? 'stroke-dasharray="1 0.6"' : ''
    const boundaryWidth = document.annotationStyles?.[`region:${saved.id}`]?.lineWidthMm ?? 0.16
    if (matrixSpec && !matrixSpec.matrixSecondaryRegion) {
      const direction = matrixSpec.matrixDirection === 'down' ? 1 : -1
      const baseline = direction < 0 ? bounds.y + bounds.height : bounds.y
      const maxDepth = matrixQueryMaximumDistance(region.end - region.start, matrixSpec.matrixDepthMode ?? 'full', matrixSpec.matrixMaxDistance) / (region.end - region.start) * bounds.width / 2
      const depth = Math.max(0, Math.min((x2 - x1) / 2, bounds.height, maxDepth))
      const points = `${n(x1)},${n(baseline)} ${n(x2)},${n(baseline)} ${n(x2 - depth)},${n(baseline + direction * depth)} ${n(x1 + depth)},${n(baseline + direction * depth)}`
      if (saved.fill) parts.push(`<polygon points="${points}" fill="${escapeXml(saved.color)}" opacity="${n(saved.shadeOpacity)}"/>`)
      if (saved.boundaryStyle !== 'none') {
        parts.push(line(x1, baseline, x1 + depth, baseline + direction * depth, saved.color, boundaryWidth, dash))
        parts.push(line(x2, baseline, x2 - depth, baseline + direction * depth, saved.color, boundaryWidth, dash))
      }
    } else {
      if (saved.fill) parts.push(rect(Math.max(bounds.x, x1), bounds.y, Math.min(bounds.x + bounds.width, x2) - Math.max(bounds.x, x1), bounds.height, saved.color, `opacity="${n(saved.shadeOpacity)}"`))
      if (saved.boundaryStyle !== 'none') {
        parts.push(line(x1, bounds.y, x1, bounds.y + bounds.height, saved.color, boundaryWidth, dash))
        parts.push(line(x2, bounds.y, x2, bounds.y + bounds.height, saved.color, boundaryWidth, dash))
      }
    }
  }
  for (const divider of appearance.showDividers ? document.sourceDocument.comparisonDividers : []) {
    if (divider.chr !== region.chr || divider.position < region.start || divider.position > region.end) continue
    const x = px(region, bounds, divider.position)
    parts.push(line(x, bounds.y, x, bounds.y + bounds.height, divider.color, document.annotationStyles?.[`divider:${divider.id}`]?.lineWidthMm ?? 0.2, divider.lineStyle === 'dashed' ? 'stroke-dasharray="1 0.6"' : ''))
  }
  return parts.join('')
}

export async function figureSvgToPng(svg: string, widthMm: number, heightMm: number, dpi: number): Promise<Blob> {
  const width = Math.max(1, Math.round(widthMm * dpi / 25.4))
  const height = Math.max(1, Math.round(heightMm * dpi / 25.4))
  if (width > 16_384 || height > 16_384 || width * height > 100_000_000) throw new Error(`PNG export would be ${width} × ${height} pixels. Reduce page size or choose 300 DPI.`)
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
