import { describe, expect, it } from 'vitest'
import { createFigureDocument } from './figure-document.ts'
import { embedPngDpi, FigureRenderSession, figureCellBounds, figureSvgToPng, layoutFigure } from './figure-render.ts'
import { matrixWarmPaletteColor } from './browser.ts'
import { GeneSource } from './reference.ts'
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

  it('treats a specified page height as exact and reports overflow', () => {
    const figure = createFigureDocument(createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 }))
    figure.page.heightMm = 50
    expect(layoutFigure(figure).heightMm).toBe(50)
    figure.rows[0].heightMm = 80
    expect(() => layoutFigure(figure)).toThrow(/Tracks need/)
  })

  it('rejects oversized PNG pixel dimensions before allocating a canvas', async () => {
    await expect(figureSvgToPng('<svg/>', 600, 600, 600)).rejects.toThrow(/Reduce page size/)
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
    const matrixSpec = document.tracks.find((track) => track.id === 'matrix-track')!
    matrixSpec.matrixScaleMode = 'fixed'; matrixSpec.matrixScaleMax = 10; matrixSpec.matrixTransform = 'linear'; matrixSpec.matrixIgnoreDiagonals = 0
    matrixSpec.matrixMaskedStyle = 'custom'; matrixSpec.matrixMaskedColor = '#aabbcc'
    matrixSpec.matrixOverlayInteractionTrackId = 'arc-track'
    addAlignmentTrack(document, { id: 'bam', name: 'reads.bam', format: 'bam', files: [] }, { id: 'bam-track' })
    document.matrixOutlines.push({ id: 'outline', label: 'Contact box', axis1: { chr: 'chr1', start: 100, end: 200 }, axis2: { chr: 'chr1', start: 300, end: 400 }, color: '#123456', visible: true, sourceTrackId: 'matrix-track', targetTrackIds: [] })
    document.savedRegions.push({ id: 'focus', label: 'Focus', region: { chr: 'chr1', start: 100, end: 400 }, color: '#ef00ef', highlighted: true, boundaryStyle: 'solid', fill: true, shadeOpacity: 0.25 })
    const figure = createFigureDocument(document)
    figure.annotationStyles = { 'region:focus': { lineWidthMm: 0.65 }, 'outline:outline': { lineWidthMm: 0.8 } }
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    const featureSets: Record<string, unknown[]> = {
      bed: [{ start: 100, end: 200, name: 'peak' }],
      bedpe: [{ featureType: 'interaction', start: 100, end: 400, chrom1: 'chr1', start1: 100, end1: 150, chrom2: 'chr1', start2: 350, end2: 400 }],
      cool: [{ featureType: 'matrix', start: 0, end: 1000, resolution: 100, cells: [{ bin1: 100, bin2: 300, value: 5 }], missingCells: [], maskedBins: [100] }],
      bam: [{ featureType: 'coverage', start: 100, end: 200, score: 3 }, { featureType: 'alignment', start: 100, end: 150, name: 'read-1', mapq: 60, strand: '+', flags: 0, cigar: '50M', blocks: [{ start: 100, end: 150 }], differences: [{ kind: 'substitution', position: 110, length: 1, bases: 'A', quality: 30 }, { kind: 'insertion', position: 125, length: 1 }], paired: false, properPair: false, mateOnSameChromosome: false, templateLength: 0 }],
    }
    const sources = new Map(Object.entries(featureSets).map(([id, features]) => [id, { name: id, chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return features } } as TrackSource]))
    const result = await new FigureRenderSession().render(figure, sources)
    expect(result.issues).toEqual([])
    expect(result.svg).toContain('peak')
    expect(result.svg).toContain('<path d="M ')
    expect(result.svg).toContain('<polygon points=')
    expect(result.svg).toContain('stroke="#123456"')
    expect(result.svg).toContain('fill="#ef00ef" opacity="0.25"')
    expect(result.svg).toContain('stroke-width="0.65"')
    expect(result.svg).toContain('stroke-width="0.8"')
    expect(result.svg).toContain('stroke="#ffffff"')
    expect(result.svg).toContain(`fill="${matrixWarmPaletteColor(0.5)}"`)
    expect(result.svg).toContain('stroke="#aabbcc"')
    expect(result.svg).toContain('reads.bam')
    expect(result.svg).toContain('fill="#39a85a"')
    expect(result.svg).toContain('stroke="#9b59e6"')
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

  it('draws gene strand, exons, CDS, and expanded transcript isoforms', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    const geneTrack = document.tracks.find((track) => track.kind === 'genes')!
    geneTrack.geneDisplayMode = 'expanded'; geneTrack.geneTranscriptMode = 'all'
    const figure = createFigureDocument(document)
    figure.rows[0].heightMm = 25
    const genes = new GeneSource('test genes', [{ chr: 'chr1', start: 100, end: 400, strand: '-', name: 'GENE1', id: 'gene-1', transcripts: 2, transcriptModels: [
      { id: 'iso1', start: 100, end: 400, exons: [{ start: 100, end: 150 }, { start: 300, end: 400 }], cds: [{ start: 110, end: 140 }] },
      { id: 'iso2', start: 120, end: 380, exons: [{ start: 120, end: 180 }, { start: 340, end: 380 }], cds: [{ start: 130, end: 170 }] },
    ] }])
    const result = await new FigureRenderSession().render(figure, new Map(), genes)
    expect(result.issues).toEqual([])
    expect(result.svg).toContain('GENE1')
    expect((result.svg.match(/height="1.6"/g) ?? []).length).toBe(2)
    expect((result.svg.match(/fill="#[0-9a-f]{6}"/g) ?? []).length).toBeGreaterThan(3)
  })

  it('applies a BEDPE focus filter to the linked matrix overlay after its BEDPE row is hidden', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addInteractionTrack(document, { id: 'arcs', name: 'arcs.bedpe', format: 'bedpe', files: [] }, { id: 'arc-track' })
    addMatrixTrack(document, { id: 'matrix', name: 'contacts.cool', format: 'cool', files: [] }, { id: 'matrix-track' })
    const matrixSpec = document.tracks.find((track) => track.id === 'matrix-track')!
    matrixSpec.matrixOverlayInteractionTrackId = 'arc-track'
    matrixSpec.matrixOverlayFocusMode = 'region'
    matrixSpec.matrixOverlayFocusRegion = { chr: 'chr1', start: 90, end: 160 }
    const figure = createFigureDocument(document)
    figure.rows.find((row) => row.trackIds.includes('arc-track'))!.included = false
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    const source = (name: string, features: unknown[]): TrackSource => ({ name, chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return features } }) as TrackSource
    const sources = new Map([
      ['arcs', source('arcs', [
        { featureType: 'interaction', start: 100, end: 400, chrom1: 'chr1', start1: 100, end1: 120, chrom2: 'chr1', start2: 380, end2: 400 },
        { featureType: 'interaction', start: 500, end: 800, chrom1: 'chr1', start1: 500, end1: 520, chrom2: 'chr1', start2: 780, end2: 800 },
      ])],
      ['matrix', source('matrix', [{ featureType: 'matrix', start: 0, end: 1000, resolution: 100, cells: [], missingCells: [], maskedBins: [] }])],
    ])
    const result = await new FigureRenderSession().render(figure, sources)
    expect(result.issues).toEqual([])
    expect((result.svg.match(/stroke="#ffffff"/g) ?? []).length).toBe(1)
    expect(result.svg).toContain('queryCounts')
  })

  it('supports same-locus treatment columns and a shared quantitative scale', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addSignalTrack(document, { id: 'untreated', name: 'untreated.bw', format: 'bigwig', files: [] }, { id: 'untreated-track', autoPair: false })
    addSignalTrack(document, { id: 'treated', name: 'treated.bw', format: 'bigwig', files: [] }, { id: 'treated-track', autoPair: false })
    const figure = createFigureDocument(document)
    const row = figure.rows.find((item) => item.trackIds.includes('untreated-track'))!
    figure.rows.find((item) => item.trackIds.includes('treated-track'))!.included = false
    figure.rows.find((item) => item.trackIds.includes('reference-genes'))!.included = false
    figure.columns.push({ id: 'treatment', title: 'Treated', region: { ...figure.columns[0].region }, assignments: { [row.id]: ['treated-track'] } })
    const source = (name: string, score: number): TrackSource => ({ name, chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return [{ start: 100, end: 200, score }] } })
    const result = await new FigureRenderSession().render(figure, new Map([['untreated', source('untreated', 5)], ['treated', source('treated', 10)]]))
    expect(result.issues).toEqual([])
    expect((result.svg.match(/>10<\/text>/g) ?? []).length).toBe(2)
    expect(result.svg).toContain('Treated')
  })

  it('respects GeR BEDPE gene filters in the figure arcs', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addInteractionTrack(document, { id: 'arcs', name: 'arcs.bedpe', format: 'bedpe', files: [] }, { id: 'arc-track' })
    const spec = document.tracks.find((track) => track.id === 'arc-track')!
    spec.interactionFilterMode = 'genes'; spec.interactionFilterGenes = ['GENE1']
    const figure = createFigureDocument(document)
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    const source: TrackSource = { name: 'arcs', chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return [
      { featureType: 'interaction', start: 100, end: 300, chrom1: 'chr1', start1: 100, end1: 120, chrom2: 'chr1', start2: 280, end2: 300, name: 'GENE1 contact' },
      { featureType: 'interaction', start: 500, end: 700, chrom1: 'chr1', start1: 500, end1: 520, chrom2: 'chr1', start2: 680, end2: 700, name: 'GENE2 contact' },
    ] } }
    const result = await new FigureRenderSession().render(figure, new Map([['arcs', source]]))
    expect((result.svg.match(/<path d="M /g) ?? []).length).toBe(1)
  })

  it('queries matrix depth and pixel height from the figure view and export DPI', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addMatrixTrack(document, { id: 'matrix', name: 'contacts.cool', format: 'cool', files: [] }, { id: 'matrix-track' })
    document.tracks.find((track) => track.id === 'matrix-track')!.matrixDepthMode = 'auto'
    const figure = createFigureDocument(document)
    figure.rows.find((row) => row.trackIds.includes('reference-genes'))!.included = false
    let options: { matrixMaxDistance?: number; matrixPixelHeight?: number } | undefined
    const source: TrackSource = { name: 'matrix', chromosomes: new Map([['chr1', 1000]]), async getFeatures(_region, _width, _signal, query) { options = query; return [{ featureType: 'matrix', start: 0, end: 1000, resolution: 100, cells: [], missingCells: [], maskedBins: [] }] } }
    await new FigureRenderSession().render(figure, new Map([['matrix', source]]), undefined, 300)
    expect(options?.matrixMaxDistance).toBe(200)
    expect(options?.matrixPixelHeight).toBe(Math.round(22 * 300 / 25.4))
  })

  it('shares matrix color ranges across columns and applies a single-color override', async () => {
    const document = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addMatrixTrack(document, { id: 'a', name: 'a.cool', format: 'cool', files: [] }, { id: 'a-track' })
    addMatrixTrack(document, { id: 'b', name: 'b.cool', format: 'cool', files: [] }, { id: 'b-track' })
    const figure = createFigureDocument(document)
    const row = figure.rows.find((item) => item.trackIds.includes('a-track'))!
    figure.rows.find((item) => item.trackIds.includes('b-track'))!.included = false
    figure.rows.find((item) => item.trackIds.includes('reference-genes'))!.included = false
    figure.columns.push({ id: 'second', title: '', region: { ...figure.columns[0].region }, assignments: { [row.id]: ['b-track'] }, styles: { [row.id]: { color: '#123abc', matrixPalette: 'single' } } })
    const source = (score: number): TrackSource => ({ name: 'matrix', chromosomes: new Map([['chr1', 1000]]), async getFeatures() { return [{ featureType: 'matrix', start: 0, end: 1000, resolution: 100, cells: [{ bin1: 100, bin2: 500, value: score }], missingCells: [], maskedBins: [] }] } })
    const result = await new FigureRenderSession().render(figure, new Map([['a', source(5)], ['b', source(10)]]))
    expect((result.svg.match(/0–10<\/text>/g) ?? []).length).toBe(2)
    expect(result.svg).toContain('fill="#123abc"')
  })
})
