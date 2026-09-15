import { describe, expect, it } from 'vitest'
import { BedGraphSource } from './bedgraph.ts'

describe('BedGraphSource', () => {
  it('parses, sorts, and slices a local signal file', async () => {
    const file = new File([
      'track type=bedGraph\nchr1\t20\t30\t2\nchr1\t0\t10\t1\nchr2\t4\t8\t9\n',
    ], 'small.bedGraph')
    const source = await BedGraphSource.fromFile(file)
    expect([...source.chromosomes]).toEqual([['chr1', 30], ['chr2', 8]])
    await expect(source.getFeatures({ chr: 'chr1', start: 5, end: 25 }, 100)).resolves.toEqual([
      { start: 0, end: 10, score: 1 },
      { start: 20, end: 30, score: 2 },
    ])
  })

  it('rejects files with no data rows', async () => {
    await expect(BedGraphSource.fromFile(new File(['# only a comment'], 'empty.bedGraph'))).rejects.toThrow('No valid bedGraph rows')
  })
})
