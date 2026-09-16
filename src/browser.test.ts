import { describe, expect, it } from 'vitest'
import { chevronExonOverlap, formatCoordinate, formatScore, heightScoreForPixels, interactionArcHeight, phasedArrowPositions, selectInteractionFeatures, trackPixelHeight, verticallyCenteredBaseline } from './browser.ts'
import type { InteractionFeature } from './types.ts'

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
})
