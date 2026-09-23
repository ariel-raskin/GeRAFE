import { describe, expect, it } from 'vitest'
import { clampRegion, formatBases, formatLocus, formatZoomPercentage, hg38, parseLocus, resolveChromosome } from './genome.ts'

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

  it('accepts pasted whitespace-delimited coordinates and case variants', () => {
    const expected = { chr: 'chr1', start: 109_681_276, end: 110_058_784 }
    for (const input of [
      'chr1 109681277 110058784',
      ' CHR1   109,681,277     110,058,784 ',
      '1\t109681277\t110058784',
      'chr1: 109,681,277 - 110,058,784',
      'chr1 109681277–110058784',
      'chr1:109681277..110058784',
      'chr1 109681277 to 110058784',
    ]) expect(parseLocus(input, hg38)).toEqual(expected)
  })

  it('retains chromosome-only and single-position searches', () => {
    expect(parseLocus('CHR1', hg38)).toEqual({ chr: 'chr1', start: 0, end: hg38.get('chr1') })
    expect(parseLocus('chr1 100', hg38)).toEqual(parseLocus('chr1:100', hg38))
  })

  it('rejects inverted or malformed loci', () => {
    expect(parseLocus('chr1:200-100', hg38)).toBeUndefined()
    expect(parseLocus('made-up:1-10', hg38)).toBeUndefined()
    for (const input of ['chr1 200 100', 'chr1 0 100', 'chr1 100 200 300', 'chr1:100-', 'chr1:100:200', 'RUNX1 100 200']) {
      expect(parseLocus(input, hg38)).toBeUndefined()
    }
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

describe('zoom labels', () => {
  it('formats chromosome-relative zoom compactly', () => {
    expect(formatZoomPercentage(100)).toBe('100%')
    expect(formatZoomPercentage(170_000)).toBe('170k%')
    expect(formatZoomPercentage(1_250_000)).toBe('1.25m%')
  })
})
