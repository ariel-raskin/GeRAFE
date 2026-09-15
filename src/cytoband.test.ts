import { describe, expect, it } from 'vitest'
import { parseCytobands } from './cytoband.ts'

describe('cytobands', () => {
  it('parses and orders UCSC cytoband rows', () => {
    const bands = parseCytobands('chr1\t20\t30\tp12\tgpos50\nchr1\t0\t20\tp13\tgneg\ninvalid\n')
    expect(bands.get('chr1')).toEqual([
      { chr: 'chr1', start: 0, end: 20, name: 'p13', stain: 'gneg' },
      { chr: 'chr1', start: 20, end: 30, name: 'p12', stain: 'gpos50' },
    ])
  })
})
