import { describe, expect, it } from 'vitest'
import { BedPeSource } from './bedpe.ts'

function input(text: string, name = 'loops.bedpe') {
  return { name, size: text.length, async text() { return text } }
}

describe('BEDPE source', () => {
  it('parses BEDPE6 through BEDPE10+ fields and optional colors', async () => {
    const source = await BedPeSource.fromFile(input([
      '#chrom1\tstart1\tend1\tchrom2\tstart2\tend2\tname\tscore\tstrand1\tstrand2\tcolor',
      'chr1\t100\t120\tchr1\t300\t330\tloop-a\t5.32\t+\t-\t255,150,150',
      'chr2\t10\t20\tchr3\t40\t50',
    ].join('\n')))
    const [loop] = await source.getFeatures({ chr: 'chr1', start: 0, end: 500 }, 800)
    expect(loop).toMatchObject({
      featureType: 'interaction', chrom1: 'chr1', start1: 100, end1: 120,
      chrom2: 'chr1', start2: 300, end2: 330, name: 'loop-a', score: 5.32,
      strand1: '+', strand2: '-', itemRgb: 'rgb(255,150,150)', start: 100, end: 330,
    })
  })

  it('uses named columns in nonstandard BEDPE-derived tables', async () => {
    const source = await BedPeSource.fromFile(input([
      'chrom1\tstart1\tend1\tchrom2\tstart2\tend2\tn_supporting_rows\tsource_samples\tmax_score',
      'chr1\t100\t110\tchr1\t200\t210\t3\tA,B\t11.99',
    ].join('\n')))
    const [loop] = await source.getFeatures({ chr: 'chr1', start: 100, end: 120 }, 300)
    expect(loop.score).toBe(11.99)
    expect(loop.name).toBeUndefined()
  })

  it('indexes interchromosomal contacts at both anchors', async () => {
    const source = await BedPeSource.fromFile(input('chr1\t100\t120\tchr2\t500\t530\ttrans'))
    const [onFirst] = await source.getFeatures({ chr: 'chr1', start: 90, end: 130 }, 300)
    const [onSecond] = await source.getFeatures({ chr: 'chr2', start: 490, end: 540 }, 300)
    expect(onFirst).toMatchObject({ name: 'trans', start: 100, end: 120 })
    expect(onSecond).toMatchObject({ name: 'trans', start: 500, end: 530 })
  })

  it('returns an interaction whose same-chromosome span crosses the window', async () => {
    const source = await BedPeSource.fromFile(input('chr1\t0\t10\tchr1\t990\t1000\twide'))
    const features = await source.getFeatures({ chr: 'chr1', start: 450, end: 550 }, 300)
    expect(features.map((feature) => feature.name)).toEqual(['wide'])
  })
})
