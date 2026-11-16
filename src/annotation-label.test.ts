import { describe, expect, it } from 'vitest'
import { annotationTrackLabel } from './annotation-label.ts'
import { addGeneTrack, createTrackDocument, normalizeTrackDocument } from './track-document.ts'
import { createFigureDocument, normalizeFigureDocument } from './figure-document.ts'

const damaged = 'NCBI RefSeq \u00c2\u00b7 hg38'
const corrected = 'NCBI RefSeq \u00b7 hg38'
function fixture() {
  const doc = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
  const source = { id: 'online', name: damaged, format: 'genepred' as const, files: [], annotationUrl: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/ncbiRefSeq.txt.gz' }
  addGeneTrack(doc, source, { id: 'online-track' })
  return doc
}

describe('downloaded annotation names', () => {
  it('uses plain punctuation in new generated names', () => {
    expect(annotationTrackLabel('NCBI RefSeq', 'hg38')).toBe('NCBI RefSeq (hg38)')
    expect(annotationTrackLabel('GENCODE v49 \u00b7 Basic', 'hg38')).toBe('GENCODE v49 - Basic (hg38)')
  })

  it('repairs persisted source/default track names without changing custom or local names', () => {
    const doc = fixture()
    addGeneTrack(doc, { ...doc.sources[0], id: 'custom-source' }, { id: 'custom', label: 'My \u00c2\u00b7 annotation' })
    addGeneTrack(doc, { id: 'local-source', name: 'local-\u00c2\u00b7.gtf', format: 'gtf', files: [] }, { id: 'local' })
    const restored = normalizeTrackDocument(doc)
    expect(restored.sources.find((source) => source.id === 'online')?.name).toBe(corrected)
    expect(restored.tracks.find((track) => track.id === 'online-track')?.label).toBe(corrected)
    expect(restored.tracks.find((track) => track.id === 'custom')?.label).toBe('My \u00c2\u00b7 annotation')
    expect(restored.tracks.find((track) => track.id === 'local')?.label).toBe('local-\u00c2\u00b7.gtf')
    expect(normalizeTrackDocument(restored)).toEqual(restored)
    expect(doc.sources[0].name).toBe(damaged)
  })

  it('repairs inherited FE labels when reopening a project and retains figure-only renames', () => {
    const figure = createFigureDocument(fixture())
    const row = figure.rows.find((row) => row.trackIds.includes('online-track'))!
    const restored = normalizeFigureDocument(figure)
    expect(restored.rows.find((candidate) => candidate.id === row.id)?.label).toBe(corrected)
    row.label = 'My custom label'
    expect(normalizeFigureDocument(figure).rows.find((candidate) => candidate.id === row.id)?.label).toBe('My custom label')
  })
})
