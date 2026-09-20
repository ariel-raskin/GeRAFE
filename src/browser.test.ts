import { describe, expect, it } from 'vitest'
import { bottomTrackResizeBoundaries, chevronExonOverlap, distributeFittedPixels, filterInteractionsForGenes, formatCoordinate, formatScore, heightScoreForPixels, inspectMatrixCell, inspectMatrixPoint, interactionArcHeight, matrixAutomaticMagnitude, matrixAutomaticMaximum, matrixBlueBlackPaletteColor, matrixGradientColor, matrixInspectionHeading, matrixLegendValues, matrixPaletteIntensity, matrixQueryChanged, matrixQueryMaximumDistance, matrixSignedColor, matrixValueIntensity, matrixVerticalGeometry, matrixWarmPaletteColor, phasedArrowPositions, placeCollapsedGeneLabels, resizedTrackPixels, resolveMatrixMaximums, selectBamAlignments, selectInteractionFeatures, selectNonOverlappingCollapsedGenes, signalChartBounds, signalTransform, trackPixelHeight, verticallyCenteredBaseline } from './browser.ts'
import type { AlignmentFeature, InteractionFeature, MatrixFeature } from './types.ts'
import type { GeneFeature } from './reference.ts'
import type { TrackSpec } from './track-document.ts'

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

  it('shows matrix values without a redundant label', () => {
    expect(matrixInspectionHeading({ bin1: 10, bin2: 20, separation: 10, state: 'value', value: 7.5 })).toBe('7.5')
    expect(matrixInspectionHeading({ bin1: 10, bin2: 20, separation: 10, state: 'zero' })).toBe('Zero contact')
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

  it('keeps collapsed gene labels in one bounded lane', () => {
    const placements = placeCollapsedGeneLabels([
      { preferredX: 10, width: 30 }, { preferredX: 12, width: 30 }, { preferredX: 14, width: 30 }, { preferredX: 50, width: 120 },
    ], 0, 100)
    expect(placements.slice(0, 3)).toEqual([{ x: 15, lane: 0 }, undefined, undefined])
    expect(placements[3]).toBeUndefined()
  })

  it('uses one collapsed gene structure for each overlapping pixel interval', () => {
    const genes = [
      { name: 'first', geneX1: 10, geneX2: 40 },
      { name: 'overlapping', geneX1: 35, geneX2: 55 },
      { name: 'separate', geneX1: 60, geneX2: 80 },
    ]
    expect(selectNonOverlappingCollapsedGenes(genes).map((gene) => gene.name)).toEqual(['first', 'separate'])
  })

  it('uses most of the signal height with a small symmetric inset', () => {
    expect(signalChartBounds(100, 220)).toEqual({ top: 107, bottom: 213 })
    expect(signalChartBounds(0, 20)).toEqual({ top: 2, bottom: 18 })
    expect(signalChartBounds(100, 220, true)).toEqual({ top: 107, bottom: 219.5 })
  })

  it('assigns each resize line only to the track directly above it', () => {
    expect(bottomTrackResizeBoundaries([
      { id: 'first', height: 80, resizable: true },
      { id: 'second', height: 60, resizable: true },
      { id: 'genes', height: 44, resizable: false },
    ])).toEqual([{ trackIds: ['first'], y: 80 }, { trackIds: ['second'], y: 140 }])
  })
})

describe('BAM read ordering and grouping', () => {
  it('groups by selected tags before applying a stable requested sort', () => {
    const reads = [
      { featureType: 'alignment', name: 'late-b', start: 30, end: 40, mapq: 10, strand: '+', flags: 0, cigar: '10M', blocks: [], differences: [], paired: false, properPair: false, mateOnSameChromosome: false, templateLength: 100, tags: { CB: 'B' } },
      { featureType: 'alignment', name: 'early-a', start: 20, end: 30, mapq: 60, strand: '-', flags: 0, cigar: '10M', blocks: [], differences: [], paired: false, properPair: false, mateOnSameChromosome: false, templateLength: 50, tags: { CB: 'A' } },
      { featureType: 'alignment', name: 'late-a', start: 10, end: 20, mapq: 20, strand: '+', flags: 0, cigar: '10M', blocks: [], differences: [], paired: false, properPair: false, mateOnSameChromosome: false, templateLength: 25, tags: { CB: 'A' } },
    ] satisfies AlignmentFeature[]
    expect(selectBamAlignments(reads, 10, 'mapq', 'tag', 'CB').map((read) => read.name)).toEqual(['early-a', 'late-a', 'late-b'])
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
  it('reloads matrix data for depth changes but not presentation height changes', () => {
    const original: TrackSpec = { id: 'matrix', kind: 'matrix', sourceIds: [], label: 'Matrix', color: '#000000', enabled: true, height: 40, manualPixelHeight: 160, pane: 'main' }
    expect(matrixQueryChanged(original, { ...original, manualPixelHeight: 240 })).toBe(false)
    expect(matrixQueryChanged(original, { ...original, matrixDepthMode: 'fixed', matrixMaxDistance: 250_000 })).toBe(true)
    expect(matrixQueryChanged(original, { ...original })).toBe(false)
    expect(matrixQueryChanged(original, { ...original, matrixValueMode: 'observed-expected' })).toBe(true)
  })

  it('uses explicit viewport-based matrix depths rather than track height', () => {
    expect(matrixQueryMaximumDistance(1_000_000, 'auto')).toBe(200_000)
    expect(matrixQueryMaximumDistance(1_000_000, 'full')).toBe(1_000_000)
    expect(matrixQueryMaximumDistance(1_000_000, 'fixed', 75_000)).toBe(75_000)
  })

  it('supports maximum and robust-percentile autoscaling after diagonal exclusion', () => {
    const matrix = {
      featureType: 'matrix', start: 0, end: 100, resolution: 10,
      cells: [
        { bin1: 0, bin2: 0, value: 1_000 },
        { bin1: 0, bin2: 10, value: 500 },
        { bin1: 0, bin2: 20, value: 100 },
        { bin1: 0, bin2: 30, value: 1 },
        { bin1: 0, bin2: 40, value: 2 },
        { bin1: 0, bin2: 50, value: 100 },
      ],
      missingCells: [],
      maskedBins: [],
    } satisfies MatrixFeature
    expect(matrixAutomaticMaximum(matrix, 1, 0)).toBe(1_000)
    expect(matrixAutomaticMaximum(matrix, 0.5, 3)).toBe(2)
  })

  it('scales signed log2 ratios symmetrically and preserves neutral cells', () => {
    const matrix: MatrixFeature = {
      featureType: 'matrix', start: 0, end: 100, resolution: 10,
      cells: [{ bin1: 0, bin2: 10, value: -2 }, { bin1: 0, bin2: 20, value: 0 }, { bin1: 0, bin2: 30, value: 1 }],
      missingCells: [], maskedBins: [], valueMode: 'log2-observed-expected',
    }
    expect(matrixAutomaticMagnitude(matrix, 1, 0)).toBe(2)
    expect(inspectMatrixCell(matrix, 0, 20)).toMatchObject({ state: 'value', value: 0 })
    expect(matrixSignedColor(-1)).toBe('#2166ac')
    expect(matrixSignedColor(0)).toBe('#f7f7f7')
    expect(matrixSignedColor(1)).toBe('#b2182b')
  })

  it('maps low contacts through yellow and red to a deep-red maximum', () => {
    expect(matrixWarmPaletteColor(0)).toBe('#fffdf2')
    expect(matrixWarmPaletteColor(0.75)).toBe('#d7191c')
    expect(matrixWarmPaletteColor(1)).toBe('#700d1a')
  })

  it('uses a light-blue to black palette for dark-mode matrices', () => {
    expect(matrixBlueBlackPaletteColor(0)).toBe('#daf0ff')
    expect(matrixBlueBlackPaletteColor(2 / 3)).toBe('#14437a')
    expect(matrixBlueBlackPaletteColor(1)).toBe('#040609')
  })

  it('labels linear and log matrix gradients at their visual midpoint', () => {
    expect(matrixLegendValues(0, 100, 'linear')).toEqual([100, 50, 0])
    expect(matrixLegendValues(0, 99, 'log1p')[1]).toBeCloseTo(9)
    expect(matrixLegendValues(20, 100, 'linear')).toEqual([100, 60, 20])
    expect(matrixValueIntensity(60, 20, 100, 'linear')).toBe(0.5)
  })

  it('can reverse which palette end represents high scores', () => {
    expect(matrixPaletteIntensity(0.2, false)).toBe(0.2)
    expect(matrixPaletteIntensity(0.2, true)).toBe(0.8)
    expect(matrixPaletteIntensity(1, true)).toBe(0)
  })

  it('interpolates custom palette colors at even score intervals', () => {
    const colors = ['#fff7bc', '#d7191c', '#111111']
    expect(matrixGradientColor(colors, 0.5)).toBe('#d7191c')
    expect(matrixGradientColor(colors, 0.75)).not.toBe('#111111')
    expect(matrixGradientColor(colors, 1)).toBe('#111111')
  })

  it('shares the largest matrix z-max only when a group is linked', () => {
    const tracks = [
      { id: 'a', kind: 'matrix', displayGroupId: 'g' },
      { id: 'b', kind: 'matrix', displayGroupId: 'g' },
    ] as any
    expect([...resolveMatrixMaximums(tracks, [{ id: 'g', label: 'Matrices', scaleBehavior: 'linked' }], new Map([['a', 8], ['b', 21]])).values()]).toEqual([21, 21])
    expect([...resolveMatrixMaximums(tracks, [{ id: 'g', label: 'Matrices', scaleBehavior: 'independent' }], new Map([['a', 8], ['b', 21]])).values()]).toEqual([8, 21])
    expect([...resolveMatrixMaximums([{ ...tracks[0], matrixValueMode: 'observed' }, { ...tracks[1], matrixValueMode: 'log2-observed-expected' }], [{ id: 'g', label: 'Matrices', scaleBehavior: 'linked' }], new Map([['a', 8], ['b', 21]])).values()]).toEqual([8, 21])
  })

  it('keeps an upward matrix baseline and clip inside its bottom track boundary', () => {
    expect(matrixVerticalGeometry(100, 220, 'up')).toEqual({ baseline: 219.5, clipTop: 100.5, clipBottom: 219.5 })
    expect(matrixVerticalGeometry(100, 220, 'down').baseline).toBe(100.5)
  })

  it('distinguishes values, sparse zeros, explicit missing pixels, and masked bins', () => {
    const matrix: MatrixFeature = {
      featureType: 'matrix', start: 0, end: 100, resolution: 10,
      cells: [{ bin1: 10, bin2: 30, value: 7.5 }],
      missingCells: [{ bin1: 20, bin2: 40 }],
      maskedBins: [50],
    }
    expect(inspectMatrixCell(matrix, 10, 30)).toMatchObject({ state: 'value', value: 7.5, separation: 20 })
    expect(inspectMatrixCell(matrix, 0, 10)).toMatchObject({ state: 'zero', separation: 10 })
    expect(inspectMatrixCell(matrix, 20, 40)).toMatchObject({ state: 'missing', separation: 20 })
    expect(inspectMatrixCell(matrix, 30, 50)).toMatchObject({ state: 'masked', separation: 20 })
  })

  it('maps upward and downward matrix pixels to stable genomic bins', () => {
    const matrix: MatrixFeature = {
      featureType: 'matrix', start: 0, end: 100, resolution: 10,
      cells: [{ bin1: 10, bin2: 30, value: 7.5 }], missingCells: [], maskedBins: [],
    }
    expect(inspectMatrixPoint(matrix, { chr: 'chr1', start: 0, end: 100 }, 25, 49.5, 0, 100, 0, 60, 'up', 100)).toMatchObject({ bin1: 10, bin2: 30, value: 7.5 })
    expect(inspectMatrixPoint(matrix, { chr: 'chr1', start: 0, end: 100 }, 25, 10.5, 0, 100, 0, 60, 'down', 100)).toMatchObject({ bin1: 10, bin2: 30, value: 7.5 })
    expect(inspectMatrixPoint(matrix, { chr: 'chr1', start: 0, end: 100 }, 25, 39.5, 0, 100, 0, 60, 'up', 10)).toBeUndefined()
  })

  it('transforms signal values for linear, log, and signed-log scales', () => {
    expect(signalTransform(12, 'linear')).toBe(12)
    expect(signalTransform(99, 'log1p')).toBeCloseTo(Math.log(100))
    expect(signalTransform(-99, 'log1p')).toBe(0)
    expect(signalTransform(-99, 'symlog')).toBeCloseTo(-Math.log(100))
  })

})
