import { describe, expect, it } from 'vitest'
import { chevronExonOverlap, formatCoordinate, formatScore, heightScoreForPixels, phasedArrowPositions, trackPixelHeight, verticallyCenteredBaseline } from './browser.ts'

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
