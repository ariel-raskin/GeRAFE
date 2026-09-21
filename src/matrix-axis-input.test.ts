import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hg38 } from './genome.ts'
import { resolveMatrixAxisInput } from './matrix-axis-input.ts'
import { GeneSource } from './reference.ts'

const chromosomes = new Map([['chr8', hg38.get('chr8')!], ['chr21', hg38.get('chr21')!]])
const options = { chromosomes, resolutions: [1_000, 5_000, 10_000] }

describe('vertical matrix locus input', () => {
  it('opens a bounded central chromosome window instead of querying the whole chromosome', () => {
    const result = resolveMatrixAxisInput('chr8', options)
    expect(result).toMatchObject({ kind: 'chromosome' })
    if (!('region' in result)) return
    expect(result.region.chr).toBe('chr8')
    expect(result.region.end - result.region.start).toBe(2_000_000)
    expect((result.region.start + result.region.end) / 2).toBeCloseTo(chromosomes.get('chr8')! / 2)
    expect(Math.ceil(result.region.end / 10_000) - Math.floor(result.region.start / 10_000)).toBeLessThanOrEqual(1_200)
  })

  it('shrinks a chromosome preview for a fine fixed resolution', () => {
    const result = resolveMatrixAxisInput('8', { ...options, selectedResolution: 1_000 })
    expect(result).toMatchObject({ kind: 'chromosome' })
    if (!('region' in result)) return
    expect(result.region.end - result.region.start).toBe(1_198_000)
    expect(Math.ceil(result.region.end / 1_000) - Math.floor(result.region.start / 1_000)).toBeLessThanOrEqual(1_200)
  })

  it('centers a case-insensitive gene lookup on the matrix chromosome name', () => {
    const result = resolveMatrixAxisInput('myc', {
      ...options,
      findGene: (name) => name.toUpperCase() === 'MYC'
        ? { name: 'MYC', chr: '8', start: 127_735_000, end: 127_743_000 }
        : undefined,
    })
    expect(result).toMatchObject({ kind: 'gene', label: 'MYC' })
    if (!('region' in result)) return
    expect(result.region.chr).toBe('chr8')
    expect(result.region.end - result.region.start).toBe(500_000)
    expect(result.region.start).toBeLessThan(127_735_000)
    expect(result.region.end).toBeGreaterThan(127_743_000)
  })

  it('resolves MYC from the bundled hg38 RefSeq index', () => {
    const genes = GeneSource.fromTsv(readFileSync(new URL('../static/reference/hg38-refseq-genes.tsv', import.meta.url), 'utf8'))
    const result = resolveMatrixAxisInput('myc', { ...options, findGene: (name) => genes.find(name) })
    expect(result).toMatchObject({ kind: 'gene', label: 'MYC' })
    if (!('region' in result)) return
    const myc = genes.find('MYC')!
    expect(result.region.chr).toBe('chr8')
    expect(result.region.start).toBeLessThanOrEqual(myc.start)
    expect(result.region.end).toBeGreaterThanOrEqual(myc.end)
  })

  it('keeps a valid explicit trans interval intact', () => {
    expect(resolveMatrixAxisInput('chr8:50,000,001-52,000,000', options)).toEqual({
      kind: 'interval', region: { chr: 'chr8', start: 50_000_000, end: 52_000_000 },
    })
  })

  it('explains an interval that exceeds the Cooler bin limit at a selected resolution', () => {
    const result = resolveMatrixAxisInput('chr8:50,000,001-52,000,000', { ...options, selectedResolution: 1_000 })
    expect(result).toHaveProperty('error')
    if ('error' in result) expect(result.error).toMatch(/2,000 bins.*1,200.*coarser/)
  })

  it('does not impose the Cooler bin limit on .hic windows', () => {
    expect(resolveMatrixAxisInput('chr8:50,000,001-52,000,000', {
      ...options, selectedResolution: 1_000, enforceBinLimit: false,
    })).toMatchObject({ kind: 'interval' })
  })

  it('rejects out-of-range coordinates rather than silently clamping them', () => {
    const result = resolveMatrixAxisInput('chr8:145,138,630-145,138,999', options)
    expect(result).toHaveProperty('error')
    if ('error' in result) expect(result.error).toMatch(/beyond the end/)
  })

  it('explains when a gene index is unavailable or the gene is absent from the matrix', () => {
    expect(resolveMatrixAxisInput('MYC', options)).toHaveProperty('error', expect.stringMatching(/hg38 gene index/))
    expect(resolveMatrixAxisInput('RUNX1', {
      ...options,
      findGene: () => ({ name: 'RUNX1', chr: 'chr1', start: 1_000_000, end: 1_001_000 }),
    })).toHaveProperty('error', expect.stringMatching(/not present in this matrix/))
  })
})
