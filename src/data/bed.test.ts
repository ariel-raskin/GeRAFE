import { describe, expect, it } from 'vitest'
import { BedSource } from './bed.ts'

describe('BED source', () => {
  it('parses simple intervals and BED12 structure', async () => {
    const text = [
      'chr1\t100\t180\tpeak-a',
      'chr1\t200\t320\tmodel-b\t500\t-\t220\t300\t12,34,56\t2\t30,40,\t0,80,',
      'chr2\t10\t20',
    ].join('\n')
    const source = await BedSource.fromFile({ name: 'example.bed', size: text.length, async text() { return text } })
    const features = await source.getFeatures({ chr: 'chr1', start: 150, end: 330 }, 500)
    expect(features).toHaveLength(2)
    expect(features[1]).toMatchObject({
      name: 'model-b',
      strand: '-',
      thickStart: 220,
      thickEnd: 300,
      itemRgb: 'rgb(12,34,56)',
      blocks: [{ start: 200, end: 230 }, { start: 280, end: 320 }],
    })
  })

  it('returns every long interval overlapping a window, not only the nearest start', async () => {
    const text = 'chr1\t0\t1000\tlong-a\nchr1\t10\t900\tlong-b\nchr1\t500\t510\tnearby'
    const source = await BedSource.fromFile({ name: 'overlap.bed', size: text.length, async text() { return text } })
    const features = await source.getFeatures({ chr: 'chr1', start: 700, end: 800 }, 500)
    expect(features.map((feature) => feature.name)).toEqual(['long-a', 'long-b'])
  })

  it('preserves spaces inside tab-delimited BED names', async () => {
    const text = 'chr1\t100\t220\tCpG: 361\t3468\t361\t2761\t20.8\t79.6\t0.73'
    const source = await BedSource.fromFile({ name: 'cpg-islands.bed', size: text.length, async text() { return text } })
    const [feature] = await source.getFeatures({ chr: 'chr1', start: 0, end: 500 }, 500)
    expect(feature).toMatchObject({ name: 'CpG: 361', score: 3468 })
  })
})
