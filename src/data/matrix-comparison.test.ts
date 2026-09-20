import { describe, expect, it } from 'vitest'
import type { MatrixFeature } from '../types.ts'
import { compareMatrixFeatures } from './matrix-comparison.ts'
import { MatrixComparisonSource, type NativeMatrixSource } from './matrix.ts'

const first: MatrixFeature = { featureType: 'matrix', start: 0, end: 30, resolution: 10, valueMode: 'observed', cells: [
  { bin1: 0, bin2: 0, value: 8 }, { bin1: 0, bin2: 10, value: 2 }, { bin1: 0, bin2: 20, value: 1 },
], missingCells: [], maskedBins: [] }
const second: MatrixFeature = { ...first, cells: [
  { bin1: 0, bin2: 0, value: 4 }, { bin1: 10, bin2: 20, value: 5 },
], missingCells: [], maskedBins: [] }

describe('matrix comparisons', () => {
  it('aligns sparse pixels and retains negative differences', () => {
    expect(compareMatrixFeatures(first, second, 'difference').cells).toEqual([
      { bin1: 0, bin2: 0, value: 4 }, { bin1: 0, bin2: 10, value: 2 },
      { bin1: 0, bin2: 20, value: 1 }, { bin1: 10, bin2: 20, value: -5 },
    ])
  })
  it('treats zero denominators as missing and propagates source masks', () => {
    const compared = compareMatrixFeatures({ ...first, maskedBins: [20] }, second, 'ratio')
    expect(compared.cells).toEqual([{ bin1: 0, bin2: 0, value: 2 }])
    expect(compared.missingCells).toEqual([{ bin1: 0, bin2: 10 }])
    expect(compared.maskedBins).toEqual([20])
  })
  it('preserves explicit missing pixels from either matrix', () => {
    const compared = compareMatrixFeatures(first, { ...second, missingCells: [{ bin1: 0, bin2: 10 }] }, 'difference')
    expect(compared.cells.some((cell) => cell.bin1 === 0 && cell.bin2 === 10)).toBe(false)
    expect(compared.missingCells).toContainEqual({ bin1: 0, bin2: 10 })
  })
  it('maps log2 ratios to signed values and excludes zero from the logarithm', () => {
    const compared = compareMatrixFeatures(first, second, 'log2-ratio')
    expect(compared.cells).toEqual([{ bin1: 0, bin2: 0, value: 1 }])
    expect(compared.missingCells).toEqual([
      { bin1: 0, bin2: 10 }, { bin1: 0, bin2: 20 }, { bin1: 10, bin2: 20 },
    ])
  })
  it('refuses mismatched bins', () => {
    expect(() => compareMatrixFeatures(first, { ...second, resolution: 20 }, 'difference')).toThrow(/matching resolutions/)
  })
  it('rejects a pair without shared resolutions', () => {
    const mock = (resolutions: number[]): NativeMatrixSource => ({
      format: 'cool', chromosomes: new Map([['chr1', 100]]),
      matrixMetadata: { format: 'cool', chromosomes: [{ name: 'chr1', length: 100 }], resolutions,
        normalizations: ['raw'], defaultNormalization: 'raw' },
    }) as unknown as NativeMatrixSource
    expect(() => new MatrixComparisonSource('A / B', mock([10]), mock([20]))).toThrow(/shared resolution/)
  })
  it('selects a shared resolution and maps raw to NONE for .hic', async () => {
    const calls: Array<{ format: string; resolution?: number; normalization?: string }> = []
    const mock = (format: 'hic' | 'cool', resolutions: number[]): NativeMatrixSource => ({
      format, chromosomes: new Map([['chr1', 1_000_000]]),
      matrixMetadata: { format, chromosomes: [{ name: 'chr1', length: 1_000_000 }], resolutions,
        normalizations: format === 'hic' ? ['NONE', 'KR'] : ['raw', 'weight'], defaultNormalization: format === 'hic' ? 'NONE' : 'raw' },
      getFeatures: async (_region: unknown, _width: unknown, _signal: unknown, options: { matrixResolution?: number; matrixNormalization?: string }) => {
        calls.push({ format, resolution: options.matrixResolution, normalization: options.matrixNormalization })
        return [{ ...first, resolution: options.matrixResolution! }]
      },
    }) as unknown as NativeMatrixSource
    const comparison = new MatrixComparisonSource('first / second', mock('hic', [10, 20]), mock('cool', [20, 40]))
    const [result] = await comparison.getFeatures({ chr: 'chr1', start: 0, end: 1000 }, 100, undefined, { matrixComparisonMode: 'ratio' })
    expect(calls).toEqual([
      { format: 'hic', resolution: 20, normalization: 'NONE' },
      { format: 'cool', resolution: 20, normalization: 'raw' },
    ])
    expect(result.resolution).toBe(20)
    expect(comparison.matrixMetadata.resolutions).toEqual([20])
    await expect(comparison.getFeatures({ chr: 'chr1', start: 0, end: 1000 }, 100, undefined, { matrixResolution: 10 }))
      .rejects.toThrow(/not shared/)
  })
})
