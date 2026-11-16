import { describe, expect, it } from 'vitest'
import { createFigureDocument, FigureDocumentStore, figureAssignedTrackIds, moveFigureGroup, normalizeFigureDocument, removeFigureGroup, renameFigureGroup, setFigureRowGroup } from './figure-document.ts'
import { addSignalTrack, assignDisplayGroup, collapseSignalStack, createTrackDocument } from './track-document.ts'
import { FigureRenderSession, matrixLegendLayout } from './figure-render.ts'
import type { TrackSource } from './types.ts'

function fixture() {
  const source = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
  for (const [id, color] of [['a', '#ff0000'], ['b', '#0000ff'], ['c', '#00aa00']]) addSignalTrack(source, { id, name: id, format: 'bedgraph', files: [] }, { id, color, autoPair: false })
  assignDisplayGroup(source, ['a', 'b'], 'Replicates'); collapseSignalStack(source, source.groups[0].id)
  return { source, figure: createFigureDocument(source) }
}

describe('figure label groups and legends', () => {
  it('preserves vertical stack groups and per-member markers/names rather than a single horizontal group name', async () => {
    const { source, figure } = fixture()
    const row = figure.rows.find((row) => row.trackIds.includes('a'))!
    expect(row.label).toBe('')
    expect(figure.groups?.[0]).toMatchObject({ id: source.groups[0].id, label: 'Replicates', rowIds: [row.id] })
    figure.rows.forEach((candidate) => { candidate.included = candidate.id === row.id })
    const reader: TrackSource = { name: 'signal', chromosomes: new Map(), async getFeatures() { return [{ start: 0, end: 1000, score: 4 }] } }
    const rendered = await new FigureRenderSession().render(figure, new Map([['a', reader], ['b', reader]]))
    expect(rendered.issues).toEqual([])
    expect(rendered.svg).toContain(`data-fe-group-label="${source.groups[0].id}"`)
    expect(rendered.svg).toContain('data-fe-track-label="a"')
    expect(rendered.svg).toContain('data-fe-member-marker="b"')
    expect(rendered.svg).toContain('fill="#ff0000"')
    expect(rendered.svg).toContain('fill="#0000ff"')
  })

  it('migrates old collapsed labels and keeps explicit figure groups reversible without editing GeR', () => {
    const { source, figure } = fixture()
    const row = figure.rows.find((row) => row.trackIds.includes('a'))!
    row.label = 'Replicates'; row.groupLabel = undefined
    const { groups: _groups, ...old } = figure
    const store = new FigureDocumentStore(normalizeFigureDocument({ ...old, schemaVersion: 2 }))
    expect(store.current.rows.find((item) => item.id === row.id)?.label).toBe('')
    const id = store.current.groups![0].id
    store.edit((draft) => { renameFigureGroup(draft, id, 'Figure group'); draft.groups![0].appearance = { groupLabelXmm: 9, groupLabelYmm: 3 } })
    expect(store.current.sourceDocument.groups[0].label).toBe('Figure group')
    expect(source.groups[0].label).toBe('Replicates')
    store.edit((draft) => removeFigureGroup(draft, id))
    expect(store.current.groups).toEqual([])
    expect(store.current.rows).toHaveLength(figure.rows.length)
    store.undo()
    expect(store.current.groups![0].appearance?.groupLabelYmm).toBe(3)
    const reopened = normalizeFigureDocument(JSON.parse(JSON.stringify(store.current)))
    expect(reopened.groups).toEqual(store.current.groups)
  })

  it('moves complete groups and uses current stack member order for both plotting and legends', () => {
    const { figure } = fixture()
    const row = figure.rows.find((row) => row.trackIds.includes('a'))!, other = figure.rows.find((row) => row.trackIds.includes('c'))!
    setFigureRowGroup(figure, other.id, figure.groups![0].id)
    const group = figure.groups![0]
    moveFigureGroup(figure, group.id, 1)
    expect(figure.rows.slice(-2).map((row) => row.id)).toEqual([row.id, other.id])
    figure.sourceDocument.tracks.reverse()
    expect(figureAssignedTrackIds(figure, figure.columns[0], row.id)).toEqual(['b', 'a'])
  })

  it('excludes disabled ordinary tracks from a new composition while retaining a restorable source row', () => {
    const source = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addSignalTrack(source, { id: 'a', name: 'a', format: 'bedgraph', files: [] }, { id: 'a' }).enabled = false
    expect(createFigureDocument(source).rows.find((row) => row.trackIds.includes('a'))?.included).toBe(false)
  })

  it('draws section values by default when the imported view contains dividers', async () => {
    const source = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addSignalTrack(source, { id: 'a', name: 'a', format: 'bedgraph', files: [] }, { id: 'a' })
    source.comparisonDividers.push({ id: 'split', chr: 'chr1', position: 500, color: '#777777', lineStyle: 'solid' })
    const figure = createFigureDocument(source)
    figure.rows.forEach((row) => { row.included = row.trackIds.includes('a') })
    const reader: TrackSource = { name: 'a', chromosomes: new Map(), async getFeatures() { return [{ start: 0, end: 500, score: 5 }, { start: 500, end: 1000, score: 12 }] } }
    const result = await new FigureRenderSession().render(figure, new Map([['a', reader]]))
    expect(result.svg).toContain('data-scale-start="0" data-scale-min="0" data-scale-max="5"')
    expect(result.svg).toContain('data-scale-start="500" data-scale-min="0" data-scale-max="12"')
    expect(result.svg).toContain('>5</text>')
    expect(result.svg).toContain('>12</text>')
  })

  it('keeps the entire color bar and its labels outside the triangle for either orientation', () => {
    const bounds = { x: 17, y: 12, width: 40, height: 20 }
    for (const down of [false, true]) for (const showMinimum of [false, true]) {
      const bar = matrixLegendLayout(bounds, { width: 1, gap: 1, top: 1.5, font: 1.8, height: 100, showMinimum, maximumLabel: '25', minimumLabel: '0', down, inside: true })!
      expect(bar).toBeDefined()
      expect(bar.footprint.x).toBeGreaterThan(bounds.x)
      expect(bar.footprint.y).toBeGreaterThanOrEqual(bounds.y)
      expect(bar.footprint.y + bar.footprint.height).toBeLessThanOrEqual(bounds.y + bounds.height)
      const right = bar.footprint.x + bar.footprint.width - bounds.x
      const clearance = down ? bar.footprint.y - bounds.y : bounds.y + bounds.height - bar.footprint.y - bar.footprint.height
      expect(clearance).toBeGreaterThan(right)
    }
  })
})
