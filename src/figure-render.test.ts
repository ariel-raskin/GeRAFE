import { describe, expect, it } from 'vitest'
import { createFigureDocument } from './figure-document.ts'
import { embedPngDpi, FigureRenderSession, figureCellBounds, layoutFigure } from './figure-render.ts'
import { addAlignmentTrack, addInteractionTrack, addIntervalTrack, addMatrixTrack, addSignalTrack, createTrackDocument } from './track-document.ts'
import type { TrackSource } from './types.ts'

describe('figure rendering', () => {
  it('records physical PNG output resolution without changing pixel data', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...Array(17).fill(0), 0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0])
    const output = embedPngDpi(png, 300)
    expect(String.fromCharCode(...output.subarray(37, 41))).toBe('pHYs')
    expect(new DataView(output.buffer).getUint32(41)).toBe(Math.round(300 / 0.0254))
    expect(output.length).toBe(png.length + 21)
    expect(output.slice(54)).toEqual(png.slice(33))
    expect(embedPngDpi(output, 600).length).toBe(output.length)
  })
  it('keeps rows aligned across independent columns and queries source data at output resolution', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addSignalTrack(document, { id: 'signal', name: 'signal.bw', format: 'bigwig', files: [] }, { id: 'track', autoPair: false })
    const figure = createFigureDocument(document)
    const first = figure.columns[0]
    figure.columns.push({ id: 'second', title: 'Downstream', region: { chr: 'chr1', start: 2000, end: 3000 }, assignments: structuredClone(first.assignments) })
    const layout = layoutFigure(figure)
    const row = figure.rows.find((item) => item.trackIds.includes('track'))!
    expect(figureCellBounds(layout, row.id, first.id)?.y).toBe(figureCellBounds(layout, row.id, 'second')?.y)
    const queried: Array<{ start: number; width: number }> = []
    const source: TrackSource = {
      name: 'signal.bw', chromosomes: new Map([['chr1', 10_000]]),
      async getFeatures(region, pixelWidth) { queried.push({ start: region.start, width: pixelWidth }); return [{ start: region.start + 100, end: region.start + 200, score: 5 }] },
    }
    const session = new FigureRenderSession()
    const result = await session.render(figure, new Map([['signal', source]]), undefined, 300)
    expect(result.issues).toEqual(['Column / RefSeq genes: gene annotation is unavailable.', 'Downstream / RefSeq genes: gene annotation is unavailable.'])
    expect(result.svg).toContain('data-fe-row=')
    expect(result.svg).toContain('signal.bw')
    expect(queried.map((query) => query.start).sort()).toEqual([0, 2000])
    expect(queried[0].width).toBeGreaterThan(400)
    await session.render(figure, new Map([['signal', source]]), undefined, 300)
    expect(queried).toHaveLength(2)
  })

  it('keeps per-column signal color and fixed scale in source-rendered SVG', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addSignalTrack(document, { id: 'signal', name: 'signal.bw', format: 'bigwig', files: [] }, { id: 'track', autoPair: false })
    const figure = createFigureDocument(document)
    const rowId = figure.rows.find((row) => row.trackIds.includes('track'))!.id
    const first = figure.columns[0]
    first.styles = { [rowId]: { color: '#ff1100', scaleMode: 'fixed', scaleMin: 0, scaleMax: 10 } }
    figure.columns.push({ id: 'second', title: 'Treatment', region: { ...first.region }, assignments: structuredClone(first.assignments), styles: { [rowId]: { color: '#0011ff', scaleMode: 'fixed', scaleMin: 0, scaleMax: 10 } } })
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    const source: TrackSource = { name: 'signal.bw', chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return [{ start: 100, end: 150, score: 5 }] } }
    const result = await new FigureRenderSession().render(figure, new Map([['signal', source]]))
    expect(result.issues).toEqual([])
    expect(result.svg).toContain('fill="#ff1100"')
    expect(result.svg).toContain('fill="#0011ff"')
    expect(result.svg).toContain('>10</text>')
  })

  it('renders interval, BEDPE, matrix outline, and BAM coverage geometry without source omissions', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addIntervalTrack(document, { id: 'bed', name: 'peaks.bed', format: 'bed', files: [] }, { id: 'bed-track' })
    addInteractionTrack(document, { id: 'bedpe', name: 'arcs.bedpe', format: 'bedpe', files: [] }, { id: 'arc-track' })
    addMatrixTrack(document, { id: 'cool', name: 'contacts.cool', format: 'cool', files: [] }, { id: 'matrix-track' })
    addAlignmentTrack(document, { id: 'bam', name: 'reads.bam', format: 'bam', files: [] }, { id: 'bam-track' })
    document.matrixOutlines.push({ id: 'outline', label: 'Contact box', axis1: { chr: 'chr1', start: 100, end: 200 }, axis2: { chr: 'chr1', start: 300, end: 400 }, color: '#123456', visible: true, sourceTrackId: 'matrix-track', targetTrackIds: [] })
    const figure = createFigureDocument(document)
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    const featureSets: Record<string, unknown[]> = {
      bed: [{ start: 100, end: 200, name: 'peak' }],
      bedpe: [{ featureType: 'interaction', start: 100, end: 400, chrom1: 'chr1', start1: 100, end1: 150, chrom2: 'chr1', start2: 350, end2: 400 }],
      cool: [{ featureType: 'matrix', start: 0, end: 1000, resolution: 100, cells: [{ bin1: 100, bin2: 300, value: 5 }], missingCells: [], maskedBins: [] }],
      bam: [{ featureType: 'coverage', start: 100, end: 200, score: 3 }],
    }
    const sources = new Map(Object.entries(featureSets).map(([id, features]) => [id, { name: id, chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return features } } as TrackSource]))
    const result = await new FigureRenderSession().render(figure, sources)
    expect(result.issues).toEqual([])
    expect(result.svg).toContain('peak')
    expect(result.svg).toContain('<path d="M ')
    expect(result.svg).toContain('<polygon points=')
    expect(result.svg).toContain('stroke="#123456"')
    expect(result.svg).toContain('reads.bam')
  })

  it('preflights a contact map too dense for safe SVG export', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addMatrixTrack(document, { id: 'cool', name: 'dense.cool', format: 'cool', files: [] }, { id: 'matrix-track' })
    const figure = createFigureDocument(document)
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    const source: TrackSource = { name: 'dense.cool', chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return [{ featureType: 'matrix', start: 0, end: 1000, resolution: 1, cells: Array.from({ length: 80_001 }, (_, index) => ({ bin1: index % 1000, bin2: index % 1000, value: 1 })), missingCells: [], maskedBins: [] }] } }
    const result = await new FigureRenderSession().render(figure, new Map([['cool', source]]))
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toContain('80,000-cell SVG safety limit')
  })
})
