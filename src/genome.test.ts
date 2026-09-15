import { describe, expect, it } from 'vitest'
import { clampRegion, formatBases, formatLocus, hg38, parseLocus, resolveChromosome } from './genome.ts'

describe('genomic coordinates', () => {
  it('parses display coordinates into zero-based half-open coordinates', () => {
    expect(parseLocus('chr8:127,700,001-127,900,000', hg38)).toEqual({
      chr: 'chr8', start: 127_700_000, end: 127_900_000,
    })
  })

  it('accepts chromosome aliases and commas', () => {
    expect(parseLocus('8:1,001-2,000', hg38)).toEqual({ chr: 'chr8', start: 1000, end: 2000 })
    expect(resolveChromosome('X', hg38)).toBe('chrX')
  })

  it('rejects inverted or malformed loci', () => {
    expect(parseLocus('chr1:200-100', hg38)).toBeUndefined()
    expect(parseLocus('made-up:1-10', hg38)).toBeUndefined()
  })

  it('keeps a panned region within chromosome boundaries', () => {
    expect(clampRegion({ chr: 'chr1', start: -100, end: 900 }, 10_000)).toEqual({ chr: 'chr1', start: 0, end: 1000 })
    expect(clampRegion({ chr: 'chr1', start: 9500, end: 10_500 }, 10_000)).toEqual({ chr: 'chr1', start: 9000, end: 10_000 })
  })

  it('formats loci and spans for the interface', () => {
    expect(formatLocus({ chr: 'chr2', start: 999, end: 2000 })).toBe('chr2:1,000-2,000')
    expect(formatBases(1_250_000)).toBe('1.25 Mb')
  })
})
