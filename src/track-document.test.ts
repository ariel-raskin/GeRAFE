import { describe, expect, it } from 'vitest'
import {
  addSignalTrack,
  addAlignmentTrack,
  addInteractionTrack,
  addIntervalTrack,
  addMatrixTrack,
  applyAutomaticStrandedColors,
  assignDisplayGroup,
  computeScaleDomains,
  createTrackDocument,
  inferSignalStrand,
  intervalLabelHeightScore,
  linkScales,
  normalizeTrackDocument,
  removeTrack,
  reorderTracks,
  signalFeatureKey,
  TRACK_DOCUMENT_VERSION,
  TrackDocumentStore,
  unlinkScales,
  unlinkStrandedTrack,
} from './track-document.ts'

function documentWithTwoTracks() {
  const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
  addSignalTrack(document, { id: 's1', name: 'first.bw', format: 'bigwig', files: [] }, { id: 't1' })
  addSignalTrack(document, { id: 's2', name: 'second.bw', format: 'bigwig', files: [] }, { id: 't2' })
  return document
}

describe('track document', () => {
  it('links scales automatically for a new visual group and can opt out', () => {
    const document = documentWithTwoTracks()
    assignDisplayGroup(document, ['t1', 't2'], 'Condition A')
    expect(document.tracks.find((track) => track.id === 't1')?.displayGroupId)
      .toBe(document.tracks.find((track) => track.id === 't2')?.displayGroupId)
    expect(document.tracks.find((track) => track.id === 't1')?.scaleBindingId)
      .toBe(document.tracks.find((track) => track.id === 't2')?.scaleBindingId)

    unlinkScales(document, ['t1', 't2'])
    expect(document.tracks.find((track) => track.id === 't1')?.scaleBindingId)
      .not.toBe(document.tracks.find((track) => track.id === 't2')?.scaleBindingId)

    const independent = documentWithTwoTracks()
    assignDisplayGroup(independent, ['t1', 't2'], 'Independent', { autoScale: false })
    expect(independent.tracks.find((track) => track.id === 't1')?.scaleBindingId)
      .not.toBe(independent.tracks.find((track) => track.id === 't2')?.scaleBindingId)
  })

  it('uses one scale domain for linked tracks', () => {
    const document = documentWithTwoTracks()
    linkScales(document, ['t1', 't2'])
    const scaleId = document.tracks.find((track) => track.id === 't1')!.scaleBindingId!
    const domains = computeScaleDomains(document, new Map([
      ['t1', [{ start: 0, end: 10, score: 3 }]],
      ['t2', [{ start: 0, end: 10, score: -8 }]],
    ]))
    expect(domains.get(scaleId)).toEqual({ min: -8, max: 3 })
  })

  it('normalizes reversed fixed limits', () => {
    const document = documentWithTwoTracks()
    const scaleId = document.tracks.find((track) => track.id === 't1')!.scaleBindingId!
    const scale = document.scales.find((item) => item.id === scaleId)!
    scale.mode = 'fixed'
    scale.includeZero = false
    scale.limits = { min: 9, max: -2 }
    expect(computeScaleDomains(document, new Map()).get(scaleId)).toEqual({ min: -2, max: 9 })
  })

  it('round-trips JSON and supports undo/redo', () => {
    const initial = documentWithTwoTracks()
    const restored = normalizeTrackDocument(JSON.parse(JSON.stringify(initial)))
    expect(restored.tracks.map((track) => track.label)).toEqual(['first.bw', 'second.bw', 'RefSeq genes'])
    const store = new TrackDocumentStore(restored)
    store.edit((draft) => { draft.tracks[0].label = 'renamed' })
    expect(store.current.tracks[0].label).toBe('renamed')
    store.undo()
    expect(store.current.tracks[0].label).toBe('first.bw')
    store.redo()
    expect(store.current.tracks[0].label).toBe('renamed')
  })

  it('persists exact fitted and manually resized pixel heights and upgrades version 8 workspaces', () => {
    const document = documentWithTwoTracks()
    document.tracks[0].fittedHeight = 317
    document.tracks[0].heightLocked = true
    document.tracks[1].manualPixelHeight = 143
    const legacy = JSON.parse(JSON.stringify(document))
    legacy.schemaVersion = 8
    const restored = normalizeTrackDocument(legacy)
    expect(restored.schemaVersion).toBe(TRACK_DOCUMENT_VERSION)
    expect(restored.tracks[0].fittedHeight).toBe(317)
    expect(restored.tracks[0].heightLocked).toBe(true)
    expect(restored.tracks[1].manualPixelHeight).toBe(143)
  })

  it('preserves native paths and BED interval display settings', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    addIntervalTrack(document, {
      id: 'bed-source',
      name: 'peaks.bed',
      format: 'bed',
      files: [{ name: 'peaks.bed', size: 42, lastModified: 123, role: 'signal', path: 'C:\\data\\peaks.bed' }],
    }, { id: 'bed-track' })
    Object.assign(document.tracks.find((track) => track.id === 'bed-track')!, {
      intervalDisplayMode: 'expanded', intervalShowLabels: false, intervalColorMode: 'score', intervalMinScore: 120, intervalMaxRows: 4,
    })
    const restored = normalizeTrackDocument(JSON.parse(JSON.stringify(document)))
    expect(restored.sources[0].files[0].path).toBe('C:\\data\\peaks.bed')
    expect(restored.tracks.find((track) => track.id === 'bed-track')).toMatchObject({
      kind: 'interval', intervalDisplayMode: 'expanded', intervalShowLabels: false, intervalColorMode: 'score', intervalMinScore: 120, intervalMaxRows: 4,
    })
  })

  it('starts interval tracks at a compact label-fitting height', () => {
    expect(intervalLabelHeightScore('peaks.bed')).toBe(5)
    expect(intervalLabelHeightScore('a very long interval-track label that wraps')).toBeGreaterThan(5)
  })

  it('persists per-track gene transcript and TSS choices', () => {
    const document = documentWithTwoTracks()
    const genes = document.tracks.find((track) => track.kind === 'genes')!
    genes.geneTranscriptMode = 'all'
    genes.geneShowTssIndicators = false
    const restored = normalizeTrackDocument(JSON.parse(JSON.stringify(document)))
    expect(restored.tracks.find((track) => track.kind === 'genes')).toMatchObject({
      geneTranscriptMode: 'all', geneShowTssIndicators: false,
    })
  })

  it('initializes a new gene track with the supplied global TSS preference', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 }, { geneShowTssIndicators: false })
    expect(document.tracks.find((track) => track.kind === 'genes')).toMatchObject({ geneShowTssIndicators: false })
  })

  it('creates alignment tracks with independent BAM display and filtering options', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    const track = addAlignmentTrack(document, { id: 'bam-source', name: 'reads.bam', format: 'bam', files: [] }, { id: 'bam-track' })
    expect(track).toMatchObject({
      kind: 'alignment', alignmentDisplayMode: 'expanded', bamViewMode: 'both', bamColorMode: 'track',
      bamViewAsPairs: false, bamShowMismatches: true, bamMinMapq: 0,
    })
    expect(track.scaleBindingId).toBeUndefined()
  })

  it('migrates earlier BAM signal tracks into alignment tracks', () => {
    const legacy = documentWithTwoTracks() as any
    legacy.schemaVersion = 3
    legacy.sources[0].format = 'bam'
    const oldScaleId = legacy.tracks[0].scaleBindingId
    const restored = normalizeTrackDocument(legacy)
    const track = restored.tracks.find((item) => item.id === 't1')!
    expect(track).toMatchObject({ kind: 'alignment', bamViewMode: 'both', alignmentDisplayMode: 'expanded' })
    expect(track.scaleBindingId).toBeUndefined()
    expect(restored.scales.some((scale) => scale.id === oldScaleId)).toBe(false)
  })

  it('migrates multiplier heights from version 1 to the 1–100 height scale', () => {
    const legacy = documentWithTwoTracks() as any
    legacy.schemaVersion = 1
    for (const track of legacy.tracks) track.height = 1
    const restored = normalizeTrackDocument(legacy)
    expect(restored.schemaVersion).toBe(TRACK_DOCUMENT_VERSION)
    expect(restored.tracks.every((track) => track.height >= 30 && track.height <= 33)).toBe(true)
  })

  it('persists BEDPE interaction tracks across workspace normalization', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    addInteractionTrack(document, {
      id: 'bedpe-source', name: 'loops.bedpe', format: 'bedpe',
      files: [{ name: 'loops.bedpe', size: 42, lastModified: 123, role: 'signal', path: 'C:\\data\\loops.bedpe' }],
    }, { id: 'interaction-track' })
    Object.assign(document.tracks.find((track) => track.id === 'interaction-track')!, {
      interactionDirection: 'down', interactionFilterMode: 'genes', interactionFilterGenes: ['RUNX1', 'MYC'],
      interactionMinScore: 12, interactionMaxDistance: 50_000, interactionMaxFeatures: 300, interactionLineWidth: 2,
      interactionOpacity: 70, interactionArcHeightMode: 'fixed', interactionShowAnchors: false, interactionShowNames: true, interactionColorMode: 'score',
    })
    const restored = normalizeTrackDocument(JSON.parse(JSON.stringify(document)))
    expect(restored.schemaVersion).toBe(TRACK_DOCUMENT_VERSION)
    expect(restored.sources[0]).toMatchObject({ format: 'bedpe', name: 'loops.bedpe' })
    expect(restored.tracks.find((track) => track.id === 'interaction-track')).toMatchObject({
      kind: 'interaction', height: 32, interactionDirection: 'down', interactionFilterMode: 'genes', interactionFilterGenes: ['RUNX1', 'MYC'],
      interactionMinScore: 12, interactionMaxDistance: 50_000, interactionMaxFeatures: 300, interactionLineWidth: 2,
      interactionOpacity: 70, interactionArcHeightMode: 'fixed', interactionShowAnchors: false, interactionShowNames: true, interactionColorMode: 'score',
    })
  })

  it('persists contact-matrix display and query settings', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 })
    const track = addMatrixTrack(document, {
      id: 'matrix-source', name: 'contacts.mcool', format: 'mcool',
      files: [{ name: 'contacts.mcool', size: 84, lastModified: 123, role: 'signal', path: 'C:\\data\\contacts.mcool' }],
    }, { id: 'matrix-track', defaultNormalization: 'weight' })
    Object.assign(track, {
      matrixDirection: 'down', matrixResolution: 10_000, matrixNormalization: 'raw', matrixTransform: 'linear', matrixScaleMax: 42,
      matrixScaleMode: 'fixed', matrixScaleMin: 2, matrixScalePercentile: 0.98, matrixIgnoreDiagonals: 4,
      matrixDepthMode: 'fixed', matrixMaxDistance: 250_000,
      matrixPalette: 'custom', matrixPaletteColors: ['#ffffff', '#ff0000', '#111111'], matrixPaletteReversed: true,
      matrixZeroStyle: 'custom', matrixZeroColor: '#eeeeee', matrixMissingStyle: 'custom', matrixMissingColor: '#999999',
      matrixMaskedStyle: 'custom', matrixMaskedColor: '#777777',
    })
    const restored = normalizeTrackDocument(JSON.parse(JSON.stringify(document)))
    expect(restored.schemaVersion).toBe(TRACK_DOCUMENT_VERSION)
    expect(restored.sources[0]).toMatchObject({ format: 'mcool', name: 'contacts.mcool' })
    expect(restored.tracks.find((item) => item.id === 'matrix-track')).toMatchObject({
      kind: 'matrix', matrixDirection: 'down', matrixResolution: 10_000,
      matrixNormalization: 'raw', matrixTransform: 'linear', matrixScaleMode: 'fixed', matrixScaleMin: 2, matrixScaleMax: 42,
      matrixScalePercentile: 0.98, matrixIgnoreDiagonals: 4, matrixDepthMode: 'fixed', matrixMaxDistance: 250_000, matrixPalette: 'custom',
      matrixPaletteColors: ['#ffffff', '#ff0000', '#111111'], matrixPaletteReversed: true,
      matrixZeroStyle: 'custom', matrixZeroColor: '#eeeeee', matrixMissingStyle: 'custom', matrixMissingColor: '#999999',
      matrixMaskedStyle: 'custom', matrixMaskedColor: '#777777',
    })
  })

  it('migrates the version 13 dark-warm palette to blue-black', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 }) as any
    const track = addMatrixTrack(legacy, { id: 'matrix-source', name: 'contacts.cool', format: 'cool', files: [] })
    legacy.schemaVersion = 13
    ;(track as any).matrixPalette = 'warm-dark'
    expect(normalizeTrackDocument(legacy).tracks[0]).toMatchObject({ matrixPalette: 'blue-black' })
  })

  it('drops the retired high-color threshold from older matrix workspaces', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 }) as any
    const track = addMatrixTrack(legacy, { id: 'matrix-source', name: 'contacts.cool', format: 'cool', files: [] })
    legacy.schemaVersion = 14
    ;(track as any).matrixHighColorStart = 0.94
    expect((normalizeTrackDocument(legacy).tracks[0] as any).matrixHighColorStart).toBeUndefined()
  })

  it('migrates version 15 matrices to robust scaling and height-independent automatic depth', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 }) as any
    const track = addMatrixTrack(legacy, { id: 'matrix-source', name: 'contacts.cool', format: 'cool', files: [] })
    legacy.schemaVersion = 15
    delete track.matrixScaleMode
    delete track.matrixScaleMin
    delete track.matrixScalePercentile
    delete track.matrixIgnoreDiagonals
    delete track.matrixDepthMode
    expect(normalizeTrackDocument(legacy).tracks[0]).toMatchObject({
      matrixScaleMode: 'percentile', matrixScaleMin: 0, matrixScalePercentile: 0.99,
      matrixIgnoreDiagonals: 3, matrixDepthMode: 'full',
    })
  })

  it('migrates version 16 matrices to explicit cell-state defaults', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 }) as any
    const track = addMatrixTrack(legacy, { id: 'matrix-source', name: 'contacts.cool', format: 'cool', files: [] })
    legacy.schemaVersion = 16
    delete track.matrixZeroStyle
    delete track.matrixMissingStyle
    delete track.matrixMaskedStyle
    expect(normalizeTrackDocument(legacy).tracks[0]).toMatchObject({
      matrixZeroStyle: 'background', matrixMissingStyle: 'background', matrixMaskedStyle: 'hatch',
    })
  })

  it('starts contact matrices with raw values and the warm publication palette', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 })
    const cooler = addMatrixTrack(document, { id: 'cool', name: 'contacts.cool', format: 'cool', files: [] })
    const hic = addMatrixTrack(document, { id: 'hic', name: 'contacts.hic', format: 'hic', files: [] }, { defaultNormalization: 'NONE' })
    expect(cooler).toMatchObject({ matrixNormalization: 'raw', matrixPalette: 'warm', matrixDepthMode: 'full', matrixZeroStyle: 'background', matrixMaskedStyle: 'hatch' })
    expect(hic).toMatchObject({ matrixNormalization: 'NONE', matrixPalette: 'warm', matrixDepthMode: 'full', matrixZeroStyle: 'background', matrixMaskedStyle: 'hatch' })
  })

  it('migrates version 10 matrix tracks to the monochrome palette', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1_000_000 }) as any
    legacy.schemaVersion = 10
    legacy.tracks.push({
      id: 'matrix-track', kind: 'matrix', sourceIds: [], label: 'contacts', color: '#6d55e0',
      enabled: true, height: 80, pane: 'main', matrixDirection: 'up', matrixTransform: 'log1p',
    })
    expect(normalizeTrackDocument(legacy).tracks.find((item) => item.id === 'matrix-track')?.matrixPalette).toBe('monochrome')
  })

  it('migrates version 6 workspaces to the interaction-aware schema', () => {
    const legacy = documentWithTwoTracks() as any
    legacy.schemaVersion = 6
    expect(normalizeTrackDocument(legacy).schemaVersion).toBe(TRACK_DOCUMENT_VERSION)
  })

  it('migrates version 7 BEDPE tracks to default arc options', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 }) as any
    addInteractionTrack(legacy, { id: 'bedpe-source', name: 'loops.bedpe', format: 'bedpe', files: [] }, { id: 'interaction-track' })
    legacy.schemaVersion = 7
    delete legacy.tracks[0].interactionDirection
    delete legacy.tracks[0].interactionFilterMode
    const restored = normalizeTrackDocument(legacy)
    expect(restored.tracks[0]).toMatchObject({ interactionDirection: 'up', interactionFilterMode: 'all' })
  })

  it('migrates recognizable version 4 strand files into a persisted pair', () => {
    const legacy = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 }) as any
    addSignalTrack(legacy, { id: 'legacy-plus-source', name: 'treated.plus.tdf', format: 'tdf', files: [] }, { id: 'legacy-plus', autoPair: false })
    addSignalTrack(legacy, { id: 'legacy-minus-source', name: 'treated.minus.tdf', format: 'tdf', files: [] }, { id: 'legacy-minus', autoPair: false })
    legacy.schemaVersion = 4
    for (const track of legacy.tracks) {
      delete track.signalStrand
      delete track.strandBaseLabel
    }
    const restored = normalizeTrackDocument(legacy)
    expect(restored.tracks.find((track) => track.kind === 'stranded')).toMatchObject({ label: 'treated', sourceIds: ['legacy-plus-source', 'legacy-minus-source'] })
  })

  it('keeps group members contiguous and applies stored group defaults to additions', () => {
    const document = documentWithTwoTracks()
    addSignalTrack(document, { id: 's3', name: 'third', format: 'bigwig', files: [] }, { id: 't3' })
    assignDisplayGroup(document, ['t1', 't3'], 'Treatment')
    expect(document.tracks.slice(0, 2).map((track) => track.id)).toEqual(['t1', 't3'])
    const group = document.groups.find((item) => item.label === 'Treatment')!
    group.color = '#123456'
    group.scaleBehavior = 'linked'
    assignDisplayGroup(document, ['t2'], 'Treatment')
    const members = document.tracks.filter((track) => track.displayGroupId === group.id)
    expect(members.map((track) => track.color)).toEqual(['#123456', '#123456', '#123456'])
    expect(new Set(members.map((track) => track.scaleBindingId)).size).toBe(1)
  })

  it('detaches a single group member when it moves to another pane', () => {
    const document = documentWithTwoTracks()
    assignDisplayGroup(document, ['t1', 't2'], 'Pair')
    reorderTracks(document, ['t1'], 'bottom', 0)
    expect(document.tracks.find((track) => track.id === 't1')).toMatchObject({ pane: 'bottom', displayGroupId: undefined })
    expect(document.tracks.find((track) => track.id === 't2')).toMatchObject({ pane: 'main' })
  })

  it('preserves a complete group when all its tracks move between panes', () => {
    const document = documentWithTwoTracks()
    assignDisplayGroup(document, ['t1', 't2'], 'Pair')
    const groupId = document.tracks.find((track) => track.id === 't1')!.displayGroupId!
    reorderTracks(document, ['t1', 't2'], 'bottom', 0)
    const members = document.tracks.filter((track) => track.displayGroupId === groupId)
    expect(members.map((track) => track.id)).toEqual(['t1', 't2'])
    expect(members.every((track) => track.pane === 'bottom')).toBe(true)
  })

  it('reorders members within a group without removing them from it', () => {
    const document = documentWithTwoTracks()
    addSignalTrack(document, { id: 's3', name: 'third', format: 'bigwig', files: [] }, { id: 't3' })
    assignDisplayGroup(document, ['t1', 't2', 't3'], 'Trio')
    const groupId = document.tracks.find((track) => track.id === 't1')!.displayGroupId!
    reorderTracks(document, ['t1'], 'main', 2, groupId)
    expect(document.tracks.filter((track) => track.displayGroupId === groupId).map((track) => track.id)).toEqual(['t2', 't3', 't1'])
  })

  it('removes every track in a group and prunes its document records', () => {
    const document = documentWithTwoTracks()
    assignDisplayGroup(document, ['t1', 't2', 'reference-genes'], 'Disposable group')
    const groupId = document.tracks.find((track) => track.id === 't1')!.displayGroupId!
    const memberIds = document.tracks.filter((track) => track.displayGroupId === groupId).map((track) => track.id)
    for (const id of memberIds) removeTrack(document, id)

    expect(document.tracks).toHaveLength(0)
    expect(document.groups.some((group) => group.id === groupId)).toBe(false)
    expect(document.sources).toHaveLength(0)
    expect(document.scales).toHaveLength(0)
  })

  it('recognizes common strand tokens while preserving a shared base label', () => {
    expect(inferSignalStrand('dTAG_2hr.plus.avg.tdf')).toEqual({ strand: 'plus', baseLabel: 'dTAG 2hr avg' })
    expect(inferSignalStrand('dTAG_2hr.negative.avg.bigWig')).toEqual({ strand: 'minus', baseLabel: 'dTAG 2hr avg' })
    expect(inferSignalStrand('sample+')).toEqual({ strand: 'plus', baseLabel: 'sample' })
    expect(inferSignalStrand('ordinary-signal.bw')).toBeUndefined()
  })

  it('automatically combines complementary sources into one stranded track and can unlink them', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    addSignalTrack(document, { id: 'plus-source', name: 'PRO.plus.tdf', format: 'tdf', files: [] }, { id: 'plus-track', color: '#112233' })
    const paired = addSignalTrack(document, { id: 'minus-source', name: 'PRO.minus.tdf', format: 'tdf', files: [] }, { id: 'minus-track', color: '#445566' })

    expect(paired).toMatchObject({ kind: 'stranded', label: 'PRO', sourceIds: ['plus-source', 'minus-source'], color: '#112233', negativeColor: '#445566' })
    expect(document.tracks.filter((track) => track.kind !== 'genes')).toHaveLength(1)
    expect(paired.scaleBindingId).not.toBe(paired.negativeScaleBindingId)

    const unlinked = unlinkStrandedTrack(document, paired.id)
    expect(unlinked.map((track) => track.signalStrand)).toEqual(['plus', 'minus'])
    expect(unlinked.every((track) => track.strandAutoLinkDisabled)).toBe(true)
    expect(document.sources.map((source) => source.id)).toEqual(['plus-source', 'minus-source'])
  })

  it('uses red and blue for automatically colored stranded pairs without changing manual colors otherwise', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    addSignalTrack(document, { id: 'plus-source', name: 'PRO.plus.tdf', format: 'tdf', files: [] }, { id: 'plus-track', color: '#112233' })
    const paired = addSignalTrack(document, { id: 'minus-source', name: 'PRO.minus.tdf', format: 'tdf', files: [] }, { id: 'minus-track', color: '#445566', autoStrandColors: true })
    expect(paired).toMatchObject({ color: '#e3342f', negativeColor: '#2878d4' })
    paired.color = '#ffffff'
    applyAutomaticStrandedColors(document)
    expect(paired).toMatchObject({ color: '#e3342f', negativeColor: '#2878d4' })
  })

  it('links positive and negative group scales independently and normalizes magnitudes', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    const pairA = addSignalTrack(document, { id: 'a-plus-source', name: 'A.plus.bw', format: 'bigwig', files: [] }, { id: 'a-plus' })
    const pairedA = addSignalTrack(document, { id: 'a-minus-source', name: 'A.minus.bw', format: 'bigwig', files: [] }, { id: 'a-minus' })
    expect(pairA.kind).toBe('signal')
    addSignalTrack(document, { id: 'b-plus-source', name: 'B.pos.bedgraph', format: 'bedgraph', files: [] }, { id: 'b-plus' })
    const pairedB = addSignalTrack(document, { id: 'b-minus-source', name: 'B.neg.bedgraph', format: 'bedgraph', files: [] }, { id: 'b-minus' })
    assignDisplayGroup(document, [pairedA.id, pairedB.id], 'PRO-seq')
    linkScales(document, [pairedA.id, pairedB.id])

    expect(pairedA.scaleBindingId).toBe(pairedB.scaleBindingId)
    expect(pairedA.negativeScaleBindingId).toBe(pairedB.negativeScaleBindingId)
    expect(pairedA.scaleBindingId).not.toBe(pairedA.negativeScaleBindingId)
    const domains = computeScaleDomains(document, new Map([
      [signalFeatureKey(pairedA.id, 'plus'), [{ start: 0, end: 10, score: 4 }]],
      [signalFeatureKey(pairedA.id, 'minus'), [{ start: 0, end: 10, score: -17 }]],
      [signalFeatureKey(pairedB.id, 'plus'), [{ start: 0, end: 10, score: 9 }]],
      [signalFeatureKey(pairedB.id, 'minus'), [{ start: 0, end: 10, score: 6 }]],
    ]))
    expect(domains.get(pairedA.scaleBindingId!)).toEqual({ min: 0, max: 9 })
    expect(domains.get(pairedA.negativeScaleBindingId!)).toEqual({ min: 0, max: 17 })
  })

  it('keeps ordinary, positive, and negative group color defaults separate', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    addSignalTrack(document, { id: 'plus-source', name: 'condition.plus.bw', format: 'bigwig', files: [] }, { id: 'plus-track' })
    const paired = addSignalTrack(document, { id: 'minus-source', name: 'condition.minus.bw', format: 'bigwig', files: [] }, { id: 'minus-track' })
    const ordinary = addSignalTrack(document, { id: 'ordinary-source', name: 'input.bw', format: 'bigwig', files: [] }, { id: 'ordinary-track' })
    assignDisplayGroup(document, [paired.id, ordinary.id], 'Mixed')
    const group = document.groups.find((item) => item.label === 'Mixed')!
    Object.assign(group, { color: '#111111', positiveColor: '#222222', negativeColor: '#333333' })
    assignDisplayGroup(document, [paired.id, ordinary.id], 'Mixed')
    expect(ordinary.color).toBe('#111111')
    expect(paired.color).toBe('#222222')
    expect(paired.negativeColor).toBe('#333333')
  })

  it('uses an absolute magnitude domain for an unpaired negative-strand track', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    const track = addSignalTrack(document, { id: 'minus-source', name: 'orphan.minus.tdf', format: 'tdf', files: [] }, { id: 'minus-track', autoPair: false })
    const domains = computeScaleDomains(document, new Map([[signalFeatureKey(track.id, 'minus'), [{ start: 0, end: 10, score: -12 }]]]))
    expect(domains.get(track.scaleBindingId!)).toEqual({ min: 0, max: 12 })
    const scale = document.scales.find((binding) => binding.id === track.scaleBindingId)!
    scale.mode = 'fixed'
    scale.limits = { min: -20, max: 0 }
    expect(computeScaleDomains(document, new Map()).get(track.scaleBindingId!)).toEqual({ min: 0, max: 20 })
  })

  it('can clamp an ordinary signal track to zero for display-scale calculations', () => {
    const document = documentWithTwoTracks()
    const track = document.tracks.find((item) => item.id === 't1')!
    track.allowNegativeValues = false
    const domain = computeScaleDomains(document, new Map([[track.id, [{ start: 0, end: 10, score: -7 }, { start: 10, end: 20, score: 3 }]]]))
    expect(domain.get(track.scaleBindingId!)).toEqual({ min: 0, max: 3 })
  })
})
