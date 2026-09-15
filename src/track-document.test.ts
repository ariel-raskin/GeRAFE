import { describe, expect, it } from 'vitest'
import {
  addSignalTrack,
  addAlignmentTrack,
  addIntervalTrack,
  assignDisplayGroup,
  computeScaleDomains,
  createTrackDocument,
  linkScales,
  normalizeTrackDocument,
  removeTrack,
  reorderTracks,
  TrackDocumentStore,
  unlinkScales,
} from './track-document.ts'

function documentWithTwoTracks() {
  const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
  addSignalTrack(document, { id: 's1', name: 'plus', format: 'bigwig', files: [] }, { id: 't1' })
  addSignalTrack(document, { id: 's2', name: 'minus', format: 'bigwig', files: [] }, { id: 't2' })
  return document
}

describe('track document', () => {
  it('keeps visual grouping and scale linkage independent', () => {
    const document = documentWithTwoTracks()
    assignDisplayGroup(document, ['t1', 't2'], 'Condition A')
    expect(document.tracks.find((track) => track.id === 't1')?.displayGroupId)
      .toBe(document.tracks.find((track) => track.id === 't2')?.displayGroupId)
    expect(document.tracks.find((track) => track.id === 't1')?.scaleBindingId)
      .not.toBe(document.tracks.find((track) => track.id === 't2')?.scaleBindingId)

    linkScales(document, ['t1', 't2'])
    expect(document.tracks.find((track) => track.id === 't1')?.scaleBindingId)
      .toBe(document.tracks.find((track) => track.id === 't2')?.scaleBindingId)
    unlinkScales(document, ['t1', 't2'])
    expect(document.tracks.find((track) => track.id === 't1')?.scaleBindingId)
      .not.toBe(document.tracks.find((track) => track.id === 't2')?.scaleBindingId)
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
    expect(restored.tracks.map((track) => track.label)).toEqual(['plus', 'minus', 'RefSeq genes'])
    const store = new TrackDocumentStore(restored)
    store.edit((draft) => { draft.tracks[0].label = 'renamed' })
    expect(store.current.tracks[0].label).toBe('renamed')
    store.undo()
    expect(store.current.tracks[0].label).toBe('plus')
    store.redo()
    expect(store.current.tracks[0].label).toBe('renamed')
  })

  it('preserves native paths and BED interval display settings', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 100 })
    addIntervalTrack(document, {
      id: 'bed-source',
      name: 'peaks.bed',
      format: 'bed',
      files: [{ name: 'peaks.bed', size: 42, lastModified: 123, role: 'signal', path: 'C:\\data\\peaks.bed' }],
    }, { id: 'bed-track' })
    document.tracks.find((track) => track.id === 'bed-track')!.intervalDisplayMode = 'expanded'
    const restored = normalizeTrackDocument(JSON.parse(JSON.stringify(document)))
    expect(restored.sources[0].files[0].path).toBe('C:\\data\\peaks.bed')
    expect(restored.tracks.find((track) => track.id === 'bed-track')).toMatchObject({ kind: 'interval', intervalDisplayMode: 'expanded' })
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
    expect(restored.schemaVersion).toBe(4)
    expect(restored.tracks.every((track) => track.height >= 30 && track.height <= 33)).toBe(true)
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

  it('moves a selected group as one unit between panes', () => {
    const document = documentWithTwoTracks()
    assignDisplayGroup(document, ['t1', 't2'], 'Pair')
    reorderTracks(document, ['t1'], 'bottom', 0)
    const members = document.tracks.filter((track) => track.displayGroupId === document.groups.find((group) => group.label === 'Pair')?.id)
    expect(members.map((track) => track.id)).toEqual(['t1', 't2'])
    expect(members.every((track) => track.pane === 'bottom')).toBe(true)
    expect(document.tracks.filter((track) => track.pane === 'bottom').map((track) => track.id)).toEqual(['t1', 't2', 'reference-genes'])
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
})
