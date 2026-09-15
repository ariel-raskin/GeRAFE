import { describe, expect, it } from 'vitest'
import { cigarBlocks, findBamIndex } from './bam.ts'

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
})
