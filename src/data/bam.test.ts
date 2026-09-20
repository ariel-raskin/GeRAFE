import { describe, expect, it } from 'vitest'
import { cigarBlocks, coverageAlleleFrequencies, findBamIndex } from './bam.ts'

describe('BAM companion index detection', () => {
  it('finds both common BAI naming conventions', () => {
    const bam = new File([], 'sample.sorted.bam')
    const appended = new File([], 'sample.sorted.bam.bai')
    const replaced = new File([], 'sample.sorted.bai')
    expect(findBamIndex(bam, [appended])).toBe(appended)
    expect(findBamIndex(bam, [replaced])).toBe(replaced)
  })

  it('does not pair an unrelated index', () => {
    expect(findBamIndex(new File([], 'a.bam'), [new File([], 'b.bam.bai')])).toBeUndefined()
  })

  it('turns matches into blocks and advances across deletions and splice gaps', () => {
    expect(cigarBlocks(100, '5S10M3N5M2D4M1I')).toEqual([
      { start: 100, end: 110 },
      { start: 113, end: 118 },
      { start: 120, end: 124 },
    ])
  })

  it('reports the strongest alternate allele per coverage bin without combining alleles', () => {
    const reads = [{}, {}, {}] as any[]
    const blocks = new Map(reads.map((read) => [read, [{ start: 10, end: 20 }]]))
    const differences = new Map([
      [reads[0], [{ kind: 'substitution', position: 12, length: 1, bases: 'A' }]],
      [reads[1], [{ kind: 'substitution', position: 12, length: 1, bases: 'A' }]],
      [reads[2], [{ kind: 'substitution', position: 13, length: 1, bases: 'C' }]],
    ])
    const frequencies = coverageAlleleFrequencies(reads as any, blocks as any, differences as any, { chr: 'chr1', start: 0, end: 100 }, 10)
    expect(frequencies.byAllele.get('12\u0000A')).toBeCloseTo(2 / 3)
    expect(frequencies.byAllele.get('13\u0000C')).toBeCloseTo(1 / 3)
    expect(frequencies.binMaximums[1]).toBeCloseTo(2 / 3)
  })
})
