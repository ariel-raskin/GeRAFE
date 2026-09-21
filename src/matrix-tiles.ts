import type { TrackSpec } from './track-document.ts'
import type { MatrixCell, MatrixFeature } from './types.ts'

export const MATRIX_TILE_SIZE = 256
export const MATRIX_TILE_THRESHOLD = 30_000
const MAX_TRACK_TILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_TILE_BYTES = 64 * 1024 * 1024

export interface MatrixTileBox { left: number; top: number; right: number; bottom: number }

interface TileEntry {
  source: MatrixFeature
  key: string
  tiles: Map<string, HTMLCanvasElement> | undefined
  bytes: number
}

/** Presentation-only fingerprint: a new source object or any pixel-affecting setting invalidates tiles. */
export function matrixTileCacheKey(spec: TrackSpec, matrix: MatrixFeature, scale: number, height: number,
  minimum: number, maximum: number, dpr: number, theme: string): string {
  return JSON.stringify([scale.toPrecision(12), height, minimum, maximum, dpr, theme, matrix.resolution,
    matrix.axis2?.chr, matrix.axis2?.start, matrix.axis2?.end, spec.color, spec.matrixPalette,
    spec.matrixPaletteColors, spec.matrixPaletteReversed, spec.matrixTransform, spec.matrixDirection,
    spec.matrixValueMode, spec.matrixComparisonMode, spec.matrixZeroStyle, spec.matrixMissingStyle,
    spec.matrixMaskedStyle])
}

/** Inclusive tile indices, including a neighboring tile for a cell straddling a seam. */
export function matrixTileSpan(start: number, end: number): [number, number] {
  return [Math.floor(start / MATRIX_TILE_SIZE), Math.floor(end / MATRIX_TILE_SIZE)]
}

/** Bounded, full-device-resolution cell tiles; zero/missing/masks/labels remain live overlays. */
export class MatrixTileRenderer {
  private readonly entries = new Map<string, TileEntry>()

  get memoryBytes(): number { return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) }

  clear(): void { this.entries.clear() }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id)
  }

  render(options: {
    trackId: string
    source: MatrixFeature
    key: string
    target: CanvasRenderingContext2D
    plotLeft: number
    plotWidth: number
    top: number
    height: number
    worldLeft: number
    dpr: number
    box(cell: MatrixCell): MatrixTileBox | undefined
    paint(context: CanvasRenderingContext2D, cell: MatrixCell, box: MatrixTileBox): void
  }): boolean {
    const { trackId, source, key, target, plotLeft, plotWidth, top, height, worldLeft, box, paint } = options
    if (source.cells.length < MATRIX_TILE_THRESHOLD || !Number.isFinite(worldLeft) || plotWidth <= 0 || height <= 0) {
      this.entries.delete(trackId)
      return false
    }
    const dpr = Math.max(0.5, Math.min(2, options.dpr))
    let entry = this.entries.get(trackId)
    if (entry?.source !== source || entry.key !== key) {
      this.entries.delete(trackId)
      const tilePixels = Math.round(MATRIX_TILE_SIZE * dpr)
      const bytesPerTile = tilePixels * tilePixels * 4
      const maxTiles = Math.floor(MAX_TRACK_TILE_BYTES / bytesPerTile)
      const tiles = new Map<string, HTMLCanvasElement>()
      const contexts = new Map<string, CanvasRenderingContext2D>()
      let failed = false
      for (const cell of source.cells) {
        const bounds = box(cell)
        if (!bounds || bounds.bottom < 0 || bounds.top >= height || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) continue
        const [firstX, lastX] = matrixTileSpan(bounds.left, bounds.right)
        const [firstY, lastY] = matrixTileSpan(bounds.top, bounds.bottom)
        for (let tileY = Math.max(0, firstY); tileY <= Math.min(lastY, Math.ceil(height / MATRIX_TILE_SIZE) - 1); tileY++) {
          for (let tileX = firstX; tileX <= lastX; tileX++) {
            const id = `${tileX}:${tileY}`
            let context = contexts.get(id)
            if (!context) {
              if (tiles.size >= maxTiles) { failed = true; break }
              const tile = document.createElement('canvas')
              tile.width = tilePixels
              tile.height = tilePixels
              context = tile.getContext('2d') ?? undefined
              if (!context) { failed = true; break }
              context.setTransform(dpr, 0, 0, dpr, 0, 0)
              contexts.set(id, context)
              tiles.set(id, tile)
            }
            paint(context, cell, {
              left: bounds.left - tileX * MATRIX_TILE_SIZE,
              right: bounds.right - tileX * MATRIX_TILE_SIZE,
              top: bounds.top - tileY * MATRIX_TILE_SIZE,
              bottom: bounds.bottom - tileY * MATRIX_TILE_SIZE,
            })
          }
          if (failed) break
        }
        if (failed) break
      }
      entry = { source, key, tiles: failed ? undefined : tiles, bytes: failed ? 0 : tiles.size * bytesPerTile }
      this.entries.set(trackId, entry)
      if (!failed) this.evictToBudget(trackId)
    } else {
      // Map insertion order is the eviction order, not the track's vertical order.
      this.entries.delete(trackId)
      this.entries.set(trackId, entry)
    }
    if (!entry.tiles) return false
    const [firstX, lastX] = matrixTileSpan(worldLeft, worldLeft + plotWidth)
    target.save()
    target.globalAlpha = 1
    target.imageSmoothingEnabled = false
    for (const [id, tile] of entry.tiles) {
      const [tileX, tileY] = id.split(':').map(Number)
      if (tileX < firstX || tileX > lastX) continue
      target.drawImage(tile, plotLeft + tileX * MATRIX_TILE_SIZE - worldLeft, top + tileY * MATRIX_TILE_SIZE,
        MATRIX_TILE_SIZE, MATRIX_TILE_SIZE)
    }
    target.restore()
    return true
  }

  private evictToBudget(current: string): void {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [id, entry] of this.entries) {
      if (bytes <= MAX_TOTAL_TILE_BYTES) break
      if (id === current) continue
      this.entries.delete(id)
      bytes -= entry.bytes
    }
  }
}
