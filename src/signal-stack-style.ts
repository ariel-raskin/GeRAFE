import type { DisplayGroup, TrackSpec } from './track-document.ts'

export const STACK_PATTERNS = ['none', 'diagonal', 'reverse', 'crosshatch', 'dots', 'horizontal', 'vertical'] as const
export type StackPattern = typeof STACK_PATTERNS[number]
export interface SignalStackAppearance {
  colorMode: 'same' | 'distinct' | 'original'
  color?: string
  fillPatterns: 'none' | 'hatches' | 'mixed'
  memberPatterns: Record<string, StackPattern>
  outlinePatterns: boolean
  patternOpacity: number
  patternSpacing: number
  lineWidth: number
}

export function normalizeStackAppearance(value: unknown): Partial<SignalStackAppearance> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<SignalStackAppearance>
  const bounded = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
  return {
    colorMode: ['same', 'distinct', 'original'].includes(input.colorMode ?? '') ? input.colorMode : undefined,
    color: typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : undefined,
    fillPatterns: ['none', 'hatches', 'mixed'].includes(input.fillPatterns ?? '') ? input.fillPatterns : undefined,
    memberPatterns: Object.fromEntries(Object.entries(input.memberPatterns ?? {}).filter(([, pattern]) => STACK_PATTERNS.includes(pattern)).slice(0, 500)),
    outlinePatterns: typeof input.outlinePatterns === 'boolean' ? input.outlinePatterns : undefined,
    patternOpacity: bounded(input.patternOpacity, 0, 100, 65),
    patternSpacing: bounded(input.patternSpacing, 4, 24, 8),
    lineWidth: bounded(input.lineWidth, 0.5, 4, 1.75),
  }
}

export function stackAppearance(group: DisplayGroup, members: readonly Pick<TrackSpec, 'id' | 'color'>[]): SignalStackAppearance & { color: string; renderStyle: 'line' | 'fill' | 'fill-line'; opacity: number } {
  const saved = group.signalStackAppearance ?? {}
  const differentiation = group.signalStackDifferentiation ?? 'patterns'
  const first = members.find((member) => member.id === group.signalStackStyleTrackIds?.[0]) ?? members[0]
  return {
    colorMode: saved.colorMode ?? (differentiation === 'shades' || differentiation === 'shades-patterns' ? 'distinct' : 'original'),
    color: saved.color ?? group.color ?? first?.color ?? '#6d55e0',
    fillPatterns: saved.fillPatterns ?? 'none', memberPatterns: saved.memberPatterns ?? {},
    outlinePatterns: saved.outlinePatterns ?? (differentiation === 'patterns' || differentiation === 'shades-patterns'),
    patternOpacity: saved.patternOpacity ?? 65, patternSpacing: saved.patternSpacing ?? 8, lineWidth: saved.lineWidth ?? 1.75,
    renderStyle: group.signalStackRenderStyle ?? 'line', opacity: group.signalStackOpacity ?? 30,
  }
}

export function stackMemberPattern(index: number, scheme: SignalStackAppearance['fillPatterns']): StackPattern {
  const patterns: StackPattern[] = scheme === 'mixed' ? ['diagonal', 'dots', 'reverse', 'horizontal', 'crosshatch', 'vertical'] : scheme === 'hatches' ? ['diagonal', 'reverse', 'horizontal', 'vertical', 'crosshatch'] : ['none']
  return patterns[index % patterns.length]
}

/** One tile definition serves canvas rendering, menu swatches and SVG export. */
export function stackPatternGeometry(pattern: StackPattern, size: number) {
  const lines: number[][] = []
  if (pattern === 'diagonal' || pattern === 'crosshatch') lines.push([0, size, size, 0], [-size / 2, size / 2, size / 2, -size / 2], [size / 2, size * 1.5, size * 1.5, size / 2])
  if (pattern === 'reverse' || pattern === 'crosshatch') lines.push([0, 0, size, size], [-size / 2, size / 2, size / 2, size * 1.5], [size / 2, -size / 2, size * 1.5, size / 2])
  if (pattern === 'horizontal') lines.push([0, size / 2, size, size / 2])
  if (pattern === 'vertical') lines.push([size / 2, 0, size / 2, size])
  return { lines, dots: pattern === 'dots' ? [[size / 2, size / 2, size * 0.12]] : [] }
}

const patternCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>()
export function canvasStackPattern(ctx: CanvasRenderingContext2D, pattern: StackPattern, color: string, spacing: number): CanvasPattern | undefined {
  if (pattern === 'none') return undefined
  const dpr = globalThis.devicePixelRatio || 1
  const key = `${pattern}:${color}:${spacing}:${dpr}`
  const cache = patternCache.get(ctx) ?? new Map<string, CanvasPattern>()
  patternCache.set(ctx, cache)
  if (cache.has(key)) return cache.get(key)
  const tile = document.createElement('canvas')
  tile.width = tile.height = Math.ceil(spacing * dpr)
  const paint = tile.getContext('2d')!
  const pixelsPerUnit = tile.width / spacing
  paint.scale(pixelsPerUnit, pixelsPerUnit); paint.strokeStyle = color; paint.fillStyle = color; paint.lineWidth = 1
  const geometry = stackPatternGeometry(pattern, spacing)
  for (const [x1, y1, x2, y2] of geometry.lines) { paint.beginPath(); paint.moveTo(x1, y1); paint.lineTo(x2, y2); paint.stroke() }
  for (const [x, y, radius] of geometry.dots) { paint.beginPath(); paint.arc(x, y, radius, 0, Math.PI * 2); paint.fill() }
  const result = ctx.createPattern(tile, 'repeat')
  if (!result) return undefined
  result.setTransform(new DOMMatrix().scale(1 / pixelsPerUnit))
  if (cache.size >= 100) cache.clear()
  cache.set(key, result)
  return result
}

export function svgStackPattern(id: string, pattern: StackPattern, color: string, spacing: number, lineWidth: number): string {
  const { lines, dots } = stackPatternGeometry(pattern, spacing)
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
  color = escape(color); id = escape(id)
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${spacing}" height="${spacing}">${lines.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${lineWidth}"/>`).join('')}${dots.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`).join('')}</pattern>`
}
