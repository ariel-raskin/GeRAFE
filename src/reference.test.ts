import { describe, expect, it } from 'vitest'
import { GeneSource, parseChromosomeIndex, restoreReference, serializeReference } from './reference.ts'

describe('reference genomes', () => {
  it('reads FAI and two-column chromosome-size files', () => {
    expect([...parseChromosomeIndex('chr1\t248956422\t6\t50\t51\nchrX 156040895')]).toEqual([
      ['chr1', 248956422], ['chrX', 156040895],
    ])
  })

  it('persists custom reference metadata without retaining a file handle', () => {
    const original = { id: 'custom-test', name: 'test', chromosomes: new Map([['contig1', 1200]]) }
    expect(restoreReference(serializeReference(original))?.chromosomes.get('contig1')).toBe(1200)
  })

  it('loads, queries, and searches a compact gene index case-insensitively', () => {
    const genes = GeneSource.fromTsv('chr21\t36160097\t37376965\t-\tRUNX1\tRUNX1\t12\n')
    expect(genes.find('runx1')?.chr).toBe('chr21')
    expect(genes.featuresFor({ chr: 'chr21', start: 36_000_000, end: 36_300_000 })).toHaveLength(1)
    expect(genes.featuresFor({ chr: 'chr1', start: 0, end: 100 })).toHaveLength(0)
  })

  it('retains transcript exon and coding structure', () => {
    const genes = GeneSource.fromTsv('chr1\t100\t300\t+\tTEST1\tG1\tNM_1\t100-150,200-300\t120-150,200-260\n')
    const gene = genes.find('test1')!
    expect(gene.transcripts).toBe(1)
    expect(gene.transcriptModels[0].exons).toEqual([{ start: 100, end: 150 }, { start: 200, end: 300 }])
    expect(gene.transcriptModels[0].cds).toEqual([{ start: 120, end: 150 }, { start: 200, end: 260 }])
  })
})
