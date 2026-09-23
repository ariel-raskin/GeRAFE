import { describe, expect, it, vi } from 'vitest'
import { describeNativeFile } from '../native-file.ts'
import type { MatrixFeature, Region } from '../types.ts'
import { NativeMatrixDerivedSource, type NativeMatrixSource } from './matrix.ts'

vi.mock('../native-file.ts', () => ({ describeNativeFile: vi.fn() }))

describe('derived matrix source', () => {
  it('reuses chromosome results and invalidates when the original file changes', async () => {
    const describe = vi.mocked(describeNativeFile)
    describe.mockReset()
    describe.mockResolvedValueOnce({ path: 'matrix.cool', name: 'matrix.cool', size: 500, lastModified: 1, needsHydration: false })
      .mockResolvedValueOnce({ path: 'matrix.cool', name: 'matrix.cool', size: 500, lastModified: 1, needsHydration: false })
      .mockResolvedValueOnce({ path: 'matrix.cool', name: 'matrix.cool', size: 501, lastModified: 2, needsHydration: false })
    const matrix: MatrixFeature = {
      featureType: 'matrix', start: 0, end: 60, resolution: 10, valueMode: 'observed-expected',
      cells: [{ bin1: 0, bin2: 20, value: 4 }, { bin1: 10, bin2: 30, value: 2 }],
      missingCells: [], maskedBins: [],
    }
    const getFeatures = vi.fn(async (_region: Region) => [matrix])
    const native = {
      path: 'matrix.cool', chromosomes: new Map([['chr1', 60]]), getFeatures,
      matrixMetadata: { chromosomes: [{ name: 'chr1', length: 60 }], resolutions: [10], normalizations: ['raw'] },
    } as unknown as NativeMatrixSource
    const derived = new NativeMatrixDerivedSource('Insulation', native, 'insulation', 'raw')
    await derived.getFeatures({ chr: 'chr1', start: 0, end: 40 }, 100)
    await derived.getFeatures({ chr: 'chr1', start: 20, end: 60 }, 100)
    expect(getFeatures).toHaveBeenCalledTimes(1)
    await derived.getFeatures({ chr: 'chr1', start: 0, end: 60 }, 100)
    expect(getFeatures).toHaveBeenCalledTimes(2)
    expect(getFeatures.mock.calls[0][0]).toEqual({ chr: 'chr1', start: 0, end: 60 })
  })
})
