import { afterEach, describe, expect, it, vi } from 'vitest'
import { MatrixTileRenderer, MATRIX_TILE_SIZE, matrixTileCacheKey, matrixTileSpan } from './matrix-tiles.ts'
import type { MatrixFeature } from './types.ts'
import type { TrackSpec } from './track-document.ts'

afterEach(() => vi.unstubAllGlobals())

const dense = (count = 30_000): MatrixFeature => ({
  featureType: 'matrix', start: 0, end: 1_000_000, resolution: 10,
  cells: Array.from({ length: count }, () => ({ bin1: 0, bin2: 10, value: 3 })),
  missingCells: [], maskedBins: [],
})

function harness(source = dense(), dpr = 1) {
  const canvases: Array<{ width: number; height: number }> = []
  vi.stubGlobal('document', { createElement: (name: string) => {
    expect(name).toBe('canvas')
    const canvas = { width: 0, height: 0, getContext: () => ({ setTransform() {} }) }
    canvases.push(canvas)
    return canvas
  } })
  const drawn: number[] = []
  const target = { save() {}, restore() {}, drawImage(_canvas: unknown, x: number) { drawn.push(x) }, globalAlpha: 1, imageSmoothingEnabled: true } as unknown as CanvasRenderingContext2D
  const renderer = new MatrixTileRenderer()
  let painted = 0
  const options = {
    trackId: 'matrix', source, key: 'first', target, plotLeft: 176, plotWidth: 500,
    top: 40, height: 200, worldLeft: 0, dpr,
    box: () => ({ left: 254, right: 258, top: 10, bottom: 20 }),
    paint: () => { painted++ },
  }
  return { renderer, options, canvases, drawn, get painted() { return painted } }
}

describe('dense matrix raster tiles', () => {
  it('includes both sides of a tile seam and leaves the sparse fallback untouched', () => {
    expect(MATRIX_TILE_SIZE).toBe(256)
    expect(matrixTileSpan(254, 258)).toEqual([0, 1])
    expect(matrixTileSpan(-1, 1)).toEqual([-1, 0])
    const sparse = harness(dense(29_999))
    expect(sparse.renderer.render(sparse.options)).toBe(false)
    expect(sparse.canvases).toHaveLength(0)
  })

  it('paints cells once at native pixel density and reuses them on pan', () => {
    const view = harness(dense(), 2)
    expect(view.renderer.render(view.options)).toBe(true)
    expect(view.canvases).toHaveLength(2)
    expect(view.canvases.every((canvas) => canvas.width === 512 && canvas.height === 512)).toBe(true)
    expect(view.painted).toBe(60_000)
    expect(view.renderer.memoryBytes).toBe(2 * 512 * 512 * 4)
    const first = [...view.drawn]
    view.drawn.length = 0
    expect(view.renderer.render({ ...view.options, worldLeft: 5 })).toBe(true)
    expect(view.painted).toBe(60_000)
    expect(view.drawn).toEqual(first.map((x) => x - 5))
    expect(view.renderer.render({ ...view.options, key: 'new palette' })).toBe(true)
    expect(view.painted).toBe(120_000)
    expect(view.renderer.render({ ...view.options, source: dense() })).toBe(true)
    expect(view.painted).toBe(180_000)
  })

  it('marks over-budget payloads as direct-only until their source or appearance changes', () => {
    const view = harness()
    const position = { current: 0 }
    const result = view.renderer.render({ ...view.options, dpr: 2,
      box: () => { const x = (position.current++ % 33) * 256; return { left: x, right: x + 1, top: 0, bottom: 1 } },
    })
    expect(result).toBe(false)
    expect(view.canvases).toHaveLength(32)
    expect(view.renderer.memoryBytes).toBe(0)
    expect(view.renderer.render(view.options)).toBe(false)
    expect(view.canvases).toHaveLength(32)
  })

  it('evicts older track tiles above the global memory cap and releases removed tracks', () => {
    const view = harness()
    let position = 0
    for (const trackId of ['one', 'two', 'three']) {
      position = 0
      expect(view.renderer.render({ ...view.options, trackId, dpr: 2,
        box: () => { const x = (position++ % 32) * 256; return { left: x, right: x + 1, top: 0, bottom: 1 } },
      })).toBe(true)
    }
    expect(view.renderer.memoryBytes).toBe(64 * 1024 * 1024)
    view.renderer.retain(new Set(['three']))
    expect(view.renderer.memoryBytes).toBe(32 * 1024 * 1024)
    view.renderer.clear()
    expect(view.renderer.memoryBytes).toBe(0)
  })

  it('invalidates on display, scale, geometry, axis, and theme changes', () => {
    const matrix = dense()
    const spec = { color: '#ffffff', matrixPalette: 'warm', matrixDirection: 'up' } as TrackSpec
    const key = matrixTileCacheKey(spec, matrix, 1, 200, 0, 50, 2, 'light')
    expect(matrixTileCacheKey({ ...spec }, matrix, 1, 200, 0, 50, 2, 'light')).toBe(key)
    expect(matrixTileCacheKey({ ...spec, matrixPalette: 'blue-black' }, matrix, 1, 200, 0, 50, 2, 'light')).not.toBe(key)
    expect(matrixTileCacheKey({ ...spec, matrixDirection: 'down' }, matrix, 1, 200, 0, 50, 2, 'light')).not.toBe(key)
    expect(matrixTileCacheKey(spec, matrix, 2, 200, 0, 50, 2, 'light')).not.toBe(key)
    expect(matrixTileCacheKey(spec, matrix, 1, 300, 0, 50, 2, 'light')).not.toBe(key)
    expect(matrixTileCacheKey(spec, matrix, 1, 200, 0, 25, 2, 'light')).not.toBe(key)
    expect(matrixTileCacheKey(spec, matrix, 1, 200, 0, 50, 2, 'dark')).not.toBe(key)
    expect(matrixTileCacheKey(spec, { ...matrix, axis2: { chr: 'chr2', start: 0, end: 100 } }, 1, 200, 0, 50, 2, 'light')).not.toBe(key)
  })
})
