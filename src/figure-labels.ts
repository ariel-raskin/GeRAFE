import { signalStackDisplayEntries } from './browser.ts'
import { figureAssignedTrackIds, figureStackGroup, type FigureDocument } from './figure-document.ts'
import { groupFields, rowFields, resolveAppearance } from './figure-appearance.ts'
import type { FigureLayout } from './figure-render.ts'

const n = (value: number) => Math.round(value * 1000) / 1000
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
let measureContext: OffscreenCanvasRenderingContext2D | null | undefined
function textWidth(label: string, font: number, family: string, weight = '400'): number {
  if (measureContext === undefined) measureContext = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
  if (!measureContext) return label.length * font * 0.58
  measureContext.font = `${weight} ${font * 96 / 25.4}px ${family}`
  return measureContext.measureText(label).width * 25.4 / 96
}
const fit = (label: string, width: number, font: number, family: string, weight = '400') => {
  if (textWidth(label, font, family, weight) <= width) return label
  let low = 0, high = label.length
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (textWidth(`${label.slice(0, middle)}…`, font, family, weight) <= width) low = middle; else high = middle - 1 }
  return `${label.slice(0, low)}…`
}

/** Exported labels double as the editor's hit targets; no separate label approximation. */
export function drawFigureLabels(document: FigureDocument, layout: FigureLayout): string {
  const page = document.page, column = document.columns[0], first = layout.columns.get(column.id)!
  const rows = document.rows.filter((row) => row.included)
  const parts: string[] = []
  for (let index = 0; index < rows.length;) {
    const group = document.groups?.find((group) => group.rowIds.includes(rows[index].id))
    if (!group) { index++; continue }
    let end = index + 1
    while (end < rows.length && group.rowIds.includes(rows[end].id)) end++
    const top = layout.rows.get(rows[index].id)!, bottom = layout.rows.get(rows[end - 1].id)!
    const height = bottom.y + bottom.height - top.y
    const a = resolveAppearance(groupFields, group.appearance)
    const x = page.marginMm + a.groupLabelXmm, y = top.y + height / 2 + a.groupLabelYmm
    const requested = (a.groupFontPt || page.fontSizePt * 1.1) * 25.4 / 72
    const font = a.fitLabel ? Math.min(requested, requested * Math.max(0.5, height - a.labelEndPaddingMm * 2) / Math.max(0.001, textWidth(group.label, requested, page.fontFamily, '700'))) : requested
    parts.push(`<g data-fe-group="${esc(group.id)}"><line x1="${n(page.marginMm + a.groupBracketXmm)}" y1="${n(top.y)}" x2="${n(page.marginMm + a.groupBracketXmm)}" y2="${n(bottom.y + bottom.height)}" stroke="${esc(a.groupColor)}" stroke-width="${n(a.groupLinePt * 25.4 / 72)}"/><text data-fe-group-label="${esc(group.id)}" x="${n(x)}" y="${n(y)}" transform="rotate(-90 ${n(x)} ${n(y)})" dominant-baseline="middle" text-anchor="middle" font-size="${n(font)}" font-weight="700" fill="${esc(a.groupColor)}"><title>${esc(group.label)}</title>${esc(group.label)}</text></g>`)
    index = end
  }
  for (const row of rows) {
    const bounds = layout.rows.get(row.id)!, a = resolveAppearance(rowFields, row.appearance)
    const group = document.groups?.find((group) => group.rowIds.includes(row.id))
    const ga = resolveAppearance(groupFields, group?.appearance)
    const left = page.marginMm + (group ? ga.groupBracketXmm + 1.5 : 0)
    const right = first.x - a.labelGapMm + a.labelOffsetXmm
    const width = Math.max(1, right - left)
    const stack = figureStackGroup(document, column, row.id)
    const visibleIds = figureAssignedTrackIds(document, column, row.id)
    const style = column.styles?.[row.id]
    const baseFont = (row.labelFontSizePt ?? page.fontSizePt) * 25.4 / 72
    parts.push(`<g data-fe-row-label="${esc(row.id)}">`)
    if (stack && a.memberLabels) {
      const members = document.sourceDocument.tracks.filter((track) => track.displayGroupId === stack.id)
      const entries = signalStackDisplayEntries(stack, members).filter((entry) => visibleIds.includes(entry.id))
      const header = row.label ? baseFont + 0.5 : 0
      if (row.label) parts.push(`<text x="${n(right)}" y="${n(bounds.y + baseFont)}" text-anchor="end" font-size="${n(baseFont)}" fill="${esc(row.labelColor ?? '#111111')}">${esc(fit(row.label, width, baseFont, page.fontFamily, '600'))}</text>`)
      const line = Math.max(0.6, (bounds.height - header) / Math.max(1, entries.length))
      const font = Math.min(baseFont, Math.max(0.5, (line - a.memberLabelGapMm) * 0.72))
      for (const [index, entry] of entries.entries()) {
        const x = left + a.labelOffsetXmm, y = bounds.y + header + line * (index + 0.5) + a.labelOffsetYmm
        const color = style?.color ?? entry.color
        const marker = a.colorMarkers ? `<rect data-fe-member-marker="${esc(entry.id)}" x="${n(x)}" y="${n(y - line * 0.32)}" width="${n(a.markerWidthMm)}" height="${n(line * 0.64)}" fill="${esc(color)}"/>` : ''
        const labelX = x + (a.colorMarkers ? a.markerWidthMm + 0.8 : 0)
        parts.push(`<g data-fe-track-label="${esc(entry.id)}" data-fe-label-row="${esc(row.id)}"><title>${esc(entry.label)} · ${entry.pattern}</title>${marker}<text x="${n(labelX)}" y="${n(y)}" dominant-baseline="middle" font-size="${n(font)}" fill="${esc(row.labelColor ?? '#111111')}">${esc(fit(entry.label, right - labelX, font, page.fontFamily))}</text></g>`)
      }
    } else {
      const spec = document.sourceDocument.tracks.find((track) => track.id === visibleIds[0])
      const label = row.label || (stack ? stack.label : '')
      const font = baseFont, y = bounds.y + bounds.height / 2 + a.labelOffsetYmm
      const vertical = a.labelOrientation === 'vertical'
      const fitted = vertical ? label : fit(label, width - (a.colorMarkers && spec?.kind === 'signal' ? a.markerWidthMm + 1 : 0), font, page.fontFamily, a.labelWeight)
      const markerX = Math.max(left, right - textWidth(fitted, font, page.fontFamily, a.labelWeight) - a.markerWidthMm - 0.8)
      parts.push(`<g data-fe-track-label="${esc(spec?.id ?? '')}" data-fe-label-row="${esc(row.id)}"><title>${esc(label)}</title>${a.colorMarkers && spec && ['signal', 'stranded'].includes(spec.kind) && !vertical ? `<rect data-fe-member-marker="${esc(spec.id)}" x="${n(markerX)}" y="${n(y - font * 0.5)}" width="${n(a.markerWidthMm)}" height="${n(font)}" fill="${esc(style?.color ?? spec.color)}"/>` : ''}<text x="${n(right)}" y="${n(y)}" dominant-baseline="middle" text-anchor="${vertical ? 'middle' : 'end'}" font-size="${n(font)}" font-weight="${a.labelWeight}" fill="${esc(row.labelColor ?? '#111111')}" ${vertical ? `transform="rotate(-90 ${n(right)} ${n(y)})"` : ''}>${esc(fitted)}</text></g>`)
    }
    parts.push('</g>')
  }
  return parts.join('')
}
