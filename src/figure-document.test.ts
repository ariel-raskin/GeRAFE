import { describe, expect, it } from 'vitest'
import { addFigureColumn, applyManuscriptPreset, createFigureDocument, figureRequiredSourceIds, FigureDocumentStore, normalizeFigureDocument, setFigureColumnRegion } from './figure-document.ts'
import { addInteractionTrack, addMatrixTrack, addSignalTrack, createTrackDocument } from './track-document.ts'

function browserDocument() {
  const document = createTrackDocument('hg38', { chr: 'chr1', start: 100, end: 200 })
  addSignalTrack(document, { id: 'signal-a', name: 'untreated.bw', format: 'bigwig', files: [] }, { id: 'track-a', autoPair: false })
  addSignalTrack(document, { id: 'signal-b', name: 'treated.bw', format: 'bigwig', files: [] }, { id: 'track-b', autoPair: false })
  return document
}

describe('figure document', () => {
  it('migrates version 1 projects and round-trips manuscript settings through undo and JSON', () => {
    const source = browserDocument()
    const old = { ...createFigureDocument(source), schemaVersion: 1 }
    const store = new FigureDocumentStore(normalizeFigureDocument(old))
    expect(store.current.schemaVersion).toBe(2)
    const normalizedSource = structuredClone(store.current.sourceDocument)
    store.edit((draft) => { addFigureColumn(draft); addFigureColumn(draft); applyManuscriptPreset(draft); draft.columns[1].widthWeight = 2 })
    const reopened = normalizeFigureDocument(JSON.parse(JSON.stringify(store.current)))
    expect(reopened.columns).toHaveLength(3)
    expect(reopened.columns[1].widthWeight).toBe(2)
    expect(reopened.page.appearance?.rulerStyle).toBe('endpoints')
    expect(reopened.rows[0].appearance?.segmentedScales).toBe(true)
    expect(reopened.sourceDocument).toEqual(normalizedSource)
    store.undo()
    expect(store.current.columns).toHaveLength(1)
    store.redo()
    expect(store.current).toEqual(reopened)
  })

  it('validates column identity, limits the column count, and rejects malformed palettes and section limits', () => {
    const figure = createFigureDocument(browserDocument())
    addFigureColumn(figure)
    const duplicate = structuredClone(figure)
    duplicate.columns[1].id = duplicate.columns[0].id
    expect(() => normalizeFigureDocument(duplicate)).toThrow(/column/)
    while (figure.columns.length < 8) addFigureColumn(figure)
    expect(() => addFigureColumn(figure)).toThrow(/eight/)
    const row = figure.rows[0]
    figure.columns[0].styles = { [row.id]: { appearance: { matrixColors: '#ff0000,broken' } } }
    expect(() => normalizeFigureDocument(figure)).toThrow(/palette/)
    figure.columns[0].styles![row.id] = { segmentLimits: { '100': { min: 5, max: 2 } } }
    expect(() => normalizeFigureDocument(figure)).toThrow(/section scale/)
  })
  it('hands off fractional browser viewports as complete bases without changing GeR', () => {
    const source = browserDocument()
    source.region = { chr: 'chr1', start: 100.25, end: 200.75 }
    const figure = createFigureDocument(source)
    const store = new FigureDocumentStore(figure)
    expect(store.current.columns[0].region).toEqual({ chr: 'chr1', start: 100, end: 201 })
    expect(store.current.sourceDocument.region).toEqual(store.current.columns[0].region)
    expect(source.region).toEqual({ chr: 'chr1', start: 100.25, end: 200.75 })
  })

  it('hands off every loaded track without mutating GeR', () => {
    const source = browserDocument()
    const figure = createFigureDocument(source)
    expect(figure.rows.map((row) => row.trackIds)).toEqual([['track-a'], ['track-b'], ['reference-genes']])
    expect(figure.columns[0].region).toEqual(source.region)
    figure.rows[0].label = 'Edited in FE'
    figure.sourceDocument.tracks[0].color = '#abcdef'
    expect(source.tracks[0].label).toBe('untreated.bw')
    expect(source.tracks[0].color).not.toBe('#abcdef')
  })

  it('duplicates row assignments, allows two independent regions, and supports undo', () => {
    const store = new FigureDocumentStore(createFigureDocument(browserDocument()))
    store.edit((draft) => addFigureColumn(draft, 'Second region'))
    const [first, second] = store.current.columns
    expect(second.assignments).toEqual(first.assignments)
    store.edit((draft) => {
      setFigureColumnRegion(draft, second.id, { chr: 'chr1', start: 300, end: 500 })
      draft.columns[1].assignments[draft.rows[0].id] = ['track-b']
    })
    expect(store.current.columns[0].region).toEqual({ chr: 'chr1', start: 100, end: 200 })
    expect(store.current.columns[1].assignments[store.current.rows[0].id]).toEqual(['track-b'])
    store.undo()
    expect(store.current.columns[1].region).toEqual({ chr: 'chr1', start: 100, end: 200 })
    store.redo()
    expect(store.current.columns[1].region.start).toBe(300)
  })

  it('rejects invalid saved assignments and regions', () => {
    const figure = createFigureDocument(browserDocument())
    expect(() => normalizeFigureDocument({ ...figure, columns: [{ ...figure.columns[0], region: { chr: 'chr1', start: 5, end: 4 } }] })).toThrow()
    expect(() => normalizeFigureDocument({ ...figure, columns: [{ ...figure.columns[0], assignments: { [figure.rows[0].id]: ['missing-track'] } }] })).toThrow()
  })

  it('persists independent figure cell styles and validates fixed scales', () => {
    const figure = createFigureDocument(browserDocument())
    const rowId = figure.rows[0].id
    const first = figure.columns[0]
    first.styles = { [rowId]: { color: '#123456', scaleMode: 'fixed', scaleMin: -2, scaleMax: 8, showScale: true } }
    addFigureColumn(figure)
    figure.columns[1].styles![rowId].color = '#abcdef'
    expect(first.styles[rowId].color).toBe('#123456')
    const reopened = normalizeFigureDocument(JSON.parse(JSON.stringify(figure)))
    expect(reopened.columns[1].styles?.[rowId]).toMatchObject({ color: '#abcdef', scaleMin: -2, scaleMax: 8 })
    reopened.columns[1].styles![rowId].scaleMax = -3
    expect(() => normalizeFigureDocument(reopened)).toThrow(/fixed figure scale/i)
  })

  it('requires a linked BEDPE source even when its own figure row is removed', () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addInteractionTrack(document, { id: 'arcs', name: 'arcs.bedpe', format: 'bedpe', files: [] }, { id: 'arc-track' })
    addMatrixTrack(document, { id: 'contacts', name: 'contacts.cool', format: 'cool', files: [] }, { id: 'matrix-track' })
    document.tracks.find((track) => track.id === 'matrix-track')!.matrixOverlayInteractionTrackId = 'arc-track'
    const figure = createFigureDocument(document)
    figure.rows.find((row) => row.trackIds.includes('arc-track'))!.included = false
    expect([...figureRequiredSourceIds(figure)].sort()).toEqual(['arcs', 'contacts'])
  })

  it('keeps figure-only annotation line widths through project normalization', () => {
    const document = browserDocument()
    document.savedRegions.push({ id: 'focus', label: 'Focus', region: { chr: 'chr1', start: 110, end: 140 }, color: '#ff0000', highlighted: true, boundaryStyle: 'solid', fill: true, shadeOpacity: 0.2 })
    const figure = createFigureDocument(document)
    figure.annotationStyles = { 'region:focus': { lineWidthMm: 0.65 } }
    const restored = normalizeFigureDocument(JSON.parse(JSON.stringify(figure)))
    expect(restored.annotationStyles?.['region:focus'].lineWidthMm).toBe(0.65)
    restored.annotationStyles!['region:focus'].lineWidthMm = 10
    expect(normalizeFigureDocument(restored).annotationStyles?.['region:focus'].lineWidthMm).toBe(3)
  })
})
