/** Entirely synthetic example. No manuscript data or private file locations. */
import { addFigureColumn, applyManuscriptPreset, createFigureDocument, normalizeFigureDocument } from '../../src/figure-document.ts'
import { addSignalTrack, addMatrixTrack, addInteractionTrack, createTrackDocument, pairStrandedTracks } from '../../src/track-document.ts'
import { GeneSource } from '../../src/reference.ts'
import type { TrackSource, TrackFeature, SignalFeature } from '../../src/types.ts'

export function createManuscriptFixture() {
  const region = { chr: 'chr1', start: 1000000, end: 1200000 }
  const sourceDocument = createTrackDocument('hg38', region)
  const sources = new Map<string, TrackSource>()
  const source = (id: string, features: TrackFeature[]) => {
    sources.set(id, { name: id, chromosomes: new Map([['chr1', 3000000]]), async getFeatures() { return features } })
    return { id, name: id, format: 'bigwig' as const, files: [] }
  }
  for (let condition = 0; condition < 3; condition++) {
    const cells = []
    for (let i = 0; i < 40; i++) for (let j = i; j < 40; j++) cells.push({ bin1: region.start + i * 5000, bin2: region.start + j * 5000, value: 20 * Math.exp(-(j - i) / 7) + 5 * (1 + Math.sin(i + j + condition)) })
    const matrix = source(`matrix-${condition}`, [{ featureType: 'matrix', ...region, resolution: 5000, cells, missingCells: [], maskedBins: [] }])
    addMatrixTrack(sourceDocument, { ...matrix, format: 'cool' }, { id: matrix.id })
    const arcs = source(`arcs-${condition}`, [0, 1, 2, 3].map((index) => ({ featureType: 'interaction', start: region.start + 20000 + index * 15000, end: region.start + 140000 + index * 15000, chrom1: 'chr1', chrom2: 'chr1', start1: region.start + 20000 + index * 15000, end1: region.start + 25000 + index * 15000, start2: region.start + 135000 + index * 15000, end2: region.start + 140000 + index * 15000 })))
    addInteractionTrack(sourceDocument, { ...arcs, format: 'bedpe' }, { id: arcs.id })
    const signal = (amplitude: number, phase: number): SignalFeature[] => Array.from({ length: 400 }, (_, index) => ({ start: region.start + index * 500, end: region.start + (index + 1) * 500, score: amplitude * Math.pow(Math.max(0, Math.sin(index * 0.13 + phase)), 8) * (0.3 + 0.7 * Math.abs(Math.sin(index * 0.71))) }))
    const plus = addSignalTrack(sourceDocument, source(`pro-${condition}-plus`, signal(50 + condition * 5, condition * 0.7)), { id: `pro-${condition}`, autoPair: false })
    const minus = addSignalTrack(sourceDocument, source(`pro-${condition}-minus`, signal(70 - condition * 5, condition + 1)), { id: `minus-${condition}`, autoPair: false })
    plus.signalStrand = 'plus'; minus.signalStrand = 'minus'; plus.strandBaseLabel = minus.strandBaseLabel = `PRO ${condition}`
    pairStrandedTracks(sourceDocument, plus.id, minus.id, { autoColors: true })
    for (const [index, assay] of ['Factor A', 'Factor B'].entries()) {
      const id = `factor-${index}-${condition}`
      const track = addSignalTrack(sourceDocument, source(id, signal(180 - condition * 20, condition + index + 3)), { id, autoPair: false })
      track.color = index ? '#2878b5' : '#e98728'; track.label = assay
    }
  }
  sourceDocument.comparisonDividers.push({ id: 'split', chr: 'chr1', position: 1100000, color: '#777777', lineStyle: 'solid' })
  const figure = createFigureDocument(sourceDocument)
  addFigureColumn(figure, 'Treatment A'); addFigureColumn(figure, 'Treatment B'); figure.columns[0].title = 'Control'
  const ordered = ['matrix-0', 'arcs-0', 'reference-genes', 'pro-0', 'factor-0-0', 'factor-1-0']
  figure.rows.sort((a, b) => ordered.indexOf(a.trackIds[0]) - ordered.indexOf(b.trackIds[0]))
  for (const row of figure.rows) row.included = ordered.includes(row.trackIds[0])
  for (const [index, column] of figure.columns.entries()) for (const row of figure.rows.filter((row) => row.included)) {
    const id = row.trackIds[0]
    column.assignments[row.id] = [id === 'reference-genes' ? id : id.replace(/0$/, String(index))]
  }
  figure.name = 'Synthetic manuscript comparison'
  applyManuscriptPreset(figure)
  const labels = ['', '', '', 'PRO-seq', 'Factor A', 'Factor B']
  for (const [index, id] of ordered.entries()) {
    const row = figure.rows.find((row) => row.trackIds[0] === id)!
    row.label = labels[index]
    if (index < 2) row.groupLabel = 'Micro-C | 5 kb'
    for (const column of figure.columns) {
      const style = column.styles![row.id]
      if (index === 0) Object.assign(style, { scaleMode: 'fixed', scaleMin: 0, scaleMax: 30 })
      if (index === 1) { style.color = '#6f899c'; style.opacity = 50; style.appearance!.arcGeometry = 'ribbon' }
      if (index === 2) style.color = '#27669b'
    }
  }
  const genes = new GeneSource('Synthetic genes', [
    { chr: 'chr1', start: 1020000, end: 1080000, strand: '+' as const, name: 'GENE_A', id: 'a' },
    { chr: 'chr1', start: 1120000, end: 1180000, strand: '-' as const, name: 'GENE_B', id: 'b' },
  ].map((gene) => ({ ...gene, transcripts: 1, transcriptModels: [{ id: gene.id, start: gene.start, end: gene.end, exons: [0, 1, 2, 3].map((index) => ({ start: gene.start + index * 15000, end: gene.start + index * 15000 + 5000 })), cds: [{ start: gene.start + 16000, end: gene.start + 20000 }] }] })))
  return { document: normalizeFigureDocument(figure), sources, genes }
}
