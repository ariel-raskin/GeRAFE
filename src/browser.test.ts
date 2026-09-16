import { describe, expect, it } from 'vitest'
import { chevronExonOverlap, distributeFittedPixels, filterInteractionsForGenes, formatCoordinate, formatScore, heightScoreForPixels, interactionArcHeight, matrixWarmPaletteColor, phasedArrowPositions, resizedTrackPixels, selectInteractionFeatures, trackPixelHeight, verticallyCenteredBaseline } from './browser.ts'
import type { InteractionFeature } from './types.ts'
import type { GeneFeature } from './reference.ts'

describe('gene direction arrow geometry', () => {
  it('keeps arrow phase attached to the transcript while panning', () => {
    const before = phasedArrowPositions(170, 176, 400, 36, 14)
    const afterFivePixelPan = phasedArrowPositions(165, 176, 400, 36, 14)
    expect(afterFivePixelPan.slice(0, before.length)).toEqual(before.map((position) => position - 5))
  })

  it('allows chevrons outside exons but avoids partial exon overlap', () => {
    expect(chevronExonOverlap(112, [{ start: 100, end: 120 }], 3)).toBe('inside')
    expect(chevronExonOverlap(121, [{ start: 100, end: 120 }], 3)).toBe('partial')
    expect(chevronExonOverlap(50, [{ start: 100, end: 104 }], 3)).toBe('outside')
  })
})

describe('track layout and ruler formatting', () => {
  it('gives each stranded channel the same height as a regular signal track', () => {
    const regular = trackPixelHeight('signal', 32)
    expect(trackPixelHeight('stranded', 32)).toBe(regular * 2)
    expect(heightScoreForPixels('stranded', regular * 2)).toBe(32)
  })

  it('uses enough coordinate precision to distinguish nearby megabase ticks', () => {
    expect(formatCoordinate(109_800_000, 20_000, 109_950_000)).toBe('109.80m')
    expect(formatCoordinate(109_820_000, 20_000, 109_950_000)).toBe('109.82m')
    expect(formatCoordinate(820_000, 20_000, 900_000)).toBe('820k')
  })

  it('keeps large scale labels readable without exponential notation', () => {
    expect(formatScore(1_600)).toBe('1600')
    expect(formatScore(-12_345)).toBe('-12345')
  })

  it('centers text line blocks around a track midpoint', () => {
    expect(verticallyCenteredBaseline(0, 100, 1, 15)).toBe(54)
    expect(verticallyCenteredBaseline(0, 100, 2, 15)).toBe(46.5)
  })

  it('distributes every fit pixel while honoring label-height minimums', () => {
    expect(distributeFittedPixels([50, 20, 100], [1, 1, 2], 403)).toEqual([108, 78, 217])
    expect(distributeFittedPixels([50, 50], [1, 1], 80)).toEqual([50, 50])
  })

  it('applies one clamped pixel delta to every selected track', () => {
    const initial = new Map([['a', 100], ['b', 70]])
    const minimums = new Map([['a', 40], ['b', 50]])
    expect([...resizedTrackPixels(initial, minimums, 18)]).toEqual([['a', 118], ['b', 88]])
    expect([...resizedTrackPixels(initial, minimums, -80)]).toEqual([['a', 80], ['b', 50]])
  })
})

describe('interaction rendering helpers', () => {
  it('bounds arc height while retaining span emphasis', () => {
    expect(interactionArcHeight(4, 100)).toBeCloseTo(8.4)
    expect(interactionArcHeight(100, 100)).toBeGreaterThan(8)
    expect(interactionArcHeight(100_000, 100)).toBe(86)
  })

  it('deterministically retains the strongest interactions in a dense window', () => {
    const interactions = [1, 9, 4].map((score, index) => ({
      featureType: 'interaction', start: index, end: index + 1,
      chrom1: 'chr1', start1: index, end1: index + 1,
      chrom2: 'chr1', start2: index + 10, end2: index + 11, score,
    } satisfies InteractionFeature))
    expect(selectInteractionFeatures(interactions, 2).map((feature) => feature.score)).toEqual([9, 4])
  })

  it('filters either anchor by annotated gene overlap', () => {
    const interactions = [
      { featureType: 'interaction', start: 100, end: 520, chrom1: 'chr1', start1: 100, end1: 120, chrom2: 'chr1', start2: 500, end2: 520, name: 'first' },
      { featureType: 'interaction', start: 700, end: 920, chrom1: 'chr1', start1: 700, end1: 720, chrom2: 'chr1', start2: 900, end2: 920, name: 'second' },
    ] satisfies InteractionFeature[]
    const gene = { chr: 'chr1', start: 495, end: 540, name: 'GENE1', id: 'GENE1', strand: '+', transcripts: 1, transcriptModels: [] } satisfies GeneFeature
    expect(filterInteractionsForGenes(interactions, [{ name: gene.name, gene }]).map((feature) => feature.name)).toEqual(['first'])
  })

  it('falls back to exact gene tokens in BEDPE names', () => {
    const interactions = [
      { featureType: 'interaction', start: 0, end: 20, chrom1: 'chr1', start1: 0, end1: 10, chrom2: 'chr1', start2: 10, end2: 20, name: 'RUNX1(chr21)_to_MYC(chr8)' },
      { featureType: 'interaction', start: 20, end: 40, chrom1: 'chr1', start1: 20, end1: 30, chrom2: 'chr1', start2: 30, end2: 40, name: 'RUNX1T1_to_MYC' },
    ] satisfies InteractionFeature[]
    expect(filterInteractionsForGenes(interactions, [{ name: 'RUNX1' }]).map((feature) => feature.name)).toEqual(['RUNX1(chr21)_to_MYC(chr8)'])
  })
})

describe('contact-matrix rendering helpers', () => {
  it('maps low contacts through yellow and red to a black maximum', () => {
    expect(matrixWarmPaletteColor(0)).toBe('#fff7bc')
    expect(matrixWarmPaletteColor(0.82)).toBe('#d7191c')
    expect(matrixWarmPaletteColor(1)).toBe('#111111')
  })
})
