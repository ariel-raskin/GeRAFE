import { describe, expect, it } from 'vitest'
import { annotationFormat, parseGeneAnnotation, readGeneAnnotation } from './gene-annotation.ts'
import { addGeneTrack, createTrackDocument, normalizeTrackDocument, TRACK_DOCUMENT_VERSION } from './track-document.ts'
import { GeneSource } from './reference.ts'
import { createFigureDocument, figureRequiredSourceIds, normalizeFigureDocument } from './figure-document.ts'
import { FigureRenderSession } from './figure-render.ts'
import { copyableRegion } from './genome.ts'
import { isSupportedPickerFile } from './desktop-track-picker.ts'
import { ANNOTATION_CATALOG, referenceAssembly } from './annotation-library.ts'

const chromosomes = new Map([['chr1', 1000], ['chrM', 100]])
const gtf = [
  '1\tEnsembl\tgene\t101\t500\t.\t-\t.\tgene_id "g1"; gene_name "GENE1";',
  '1\tEnsembl\ttranscript\t101\t500\t.\t-\t.\tgene_id "g1"; transcript_id "t1"; gene_name "GENE1";',
  '1\tEnsembl\texon\t401\t500\t.\t-\t.\tgene_id "g1"; transcript_id "t1";',
  '1\tEnsembl\texon\t101\t200\t.\t-\t.\tgene_id "g1"; transcript_id "t1";',
  '1\tEnsembl\tCDS\t151\t200\t.\t-\t0\tgene_id "g1"; transcript_id "t1";',
  '1\tEnsembl\tCDS\t401\t450\t.\t-\t0\tgene_id "g1"; transcript_id "t1";',
  '1\tEnsembl\texon\t201\t300\t.\t-\t.\tgene_id "g1"; transcript_id "t2";',
].join('\n')

describe('gene annotation imports', () => {
  it('converts GTF coordinates, preserves transcripts and CDS, and searches names and IDs', () => {
    const source = parseGeneAnnotation(gtf, 'gtf', 'Ensembl', chromosomes)
    const gene = source.find('GENE1')!
    expect(gene).toMatchObject({ chr: 'chr1', start: 100, end: 500, strand: '-', transcripts: 2 })
    expect(source.find('g1')).toBe(gene)
    expect(source.find('t1')).toBe(gene)
    expect(gene.transcriptModels[0].exons).toEqual([{ start: 100, end: 200 }, { start: 400, end: 500 }])
    expect(gene.transcriptModels[0].cds).toEqual([{ start: 150, end: 200 }, { start: 400, end: 450 }])
    expect(source.featuresFor({ chr: 'chr1', start: 500, end: 600 })).toEqual([])
  })

  it('handles out-of-order GFF3 parents, shared exons, escaped IDs, and a FASTA section', () => {
    const text = [
      '##gff-version 3',
      'chr1\tx\texon\t101\t200\t.\t+\t.\tParent=t%2C1,t2',
      'chr1\tx\tCDS\t121\t180\t.\t+\t0\tParent=t%2C1',
      'chr1\tx\tmRNA\t101\t300\t.\t+\t.\tID=t%2C1;Parent=g1',
      'chr1\tx\tmRNA\t101\t400\t.\t+\t.\tID=t2;Parent=g1',
      'chr1\tx\tgene\t101\t400\t.\t+\t.\tID=g1;Name=Gene%20One',
      '##FASTA', '>chr1', 'ACGT',
    ].join('\n')
    const gene = parseGeneAnnotation(text, 'gff3', 'GFF', chromosomes).find('Gene One')!
    expect(gene.transcripts).toBe(2)
    expect(gene.transcriptModels[0]).toMatchObject({ id: 't,1', exons: [{ start: 100, end: 200 }], cds: [{ start: 120, end: 180 }] })
    expect(gene.transcriptModels[1].exons).toEqual([{ start: 100, end: 200 }])
  })

  it('supports GFF gene-only annotations and exons parented directly to a gene', () => {
    const text = 'chr1\tx\tgene\t1\t100\t.\t+\t.\tID=g1;Name=ONE\nchr1\tx\texon\t1\t50\t.\t+\t.\tParent=g1'
    expect(parseGeneAnnotation(text, 'gff3', 'GFF', chromosomes).find('ONE')?.transcriptModels[0].exons).toEqual([{ start: 0, end: 50 }])
    expect(parseGeneAnnotation(text.split('\n')[0], 'gff3', 'GFF', chromosomes).find('ONE')?.start).toBe(0)
  })

  it('reads genePredExt with or without UCSC bin and intersects CDS with exons', () => {
    const row = 'NM_1\tchr1\t-\t100\t500\t150\t450\t2\t100,400,\t200,500,\t0\tGENE1\tcmpl\tcmpl\t0,0,'
    for (const text of [row, `585\t${row}`]) {
      const gene = parseGeneAnnotation(text, 'genepred', 'RefSeq', chromosomes).find('GENE1')!
      expect(gene.transcriptModels[0].cds).toEqual([{ start: 150, end: 200 }, { start: 400, end: 450 }])
      expect(gene.start).toBe(100)
    }
  })

  it('reports bad ranges and dangling parents, and skips unrepresented contigs', () => {
    expect(() => parseGeneAnnotation(gtf.replace('101\t500', '0\t500'), 'gtf', 'bad', chromosomes)).toThrow(/line 1.*Invalid coordinates/)
    expect(() => parseGeneAnnotation(gtf.replaceAll('500', '5000'), 'gtf', 'bad', chromosomes)).toThrow(/reference assembly/)
    expect(() => parseGeneAnnotation('chr1\tx\texon\t1\t20\t.\t+\t.\tParent=missing', 'gff3', 'bad', chromosomes)).toThrow(/Parent IDs/)
    expect(() => parseGeneAnnotation(gtf.replaceAll('1\tEnsembl', 'unknown\tEnsembl'), 'gtf', 'bad', chromosomes)).toThrow(/No gene models match/)
    expect(parseGeneAnnotation('MT\tx\texon\t1\t10\t.\t+\t.\tgene_id "mt"; transcript_id "mt1";', 'gtf', 'mito', chromosomes).find('mt')?.chr).toBe('chrM')
  })

  it('streams plain and gzip annotations across UTF-8 and line boundaries', async () => {
    const bytes = new TextEncoder().encode(gtf.replaceAll('GENE1', 'GÈNE1'))
    const chunks = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close() } })
    expect((await readGeneAnnotation(chunks, false, 'gtf', 'plain', chromosomes)).find('GÈNE1')?.transcripts).toBe(2)
    const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
    expect((await readGeneAnnotation(compressed, true, 'gtf', 'gzip', chromosomes)).find('GÈNE1')?.transcripts).toBe(2)
    const signal = AbortSignal.abort()
    await expect(readGeneAnnotation(new Blob([bytes]).stream(), false, 'gtf', 'cancelled', chromosomes, undefined, signal)).rejects.toThrow(/cancelled/)
  })

  it('recognizes imports in the picker and keeps assemblies explicit in the catalog', () => {
    for (const name of ['genes.gtf', 'genes.gtf.gz', 'genes.gff3', 'genes.gff.gz', 'refGene.genepred.gz', 'gene.gp']) expect(isSupportedPickerFile(name)).toBe(true)
    expect(annotationFormat('notes.txt')).toBeUndefined()
    expect(isSupportedPickerFile('notes.txt')).toBe(false)
    expect(referenceAssembly({ id: 'custom', name: 'Human', chromosomes: new Map([['1', 248956422]]) })).toBe('hg38')
    expect(ANNOTATION_CATALOG.some((item) => item.provider === 'UCSC')).toBe(true)
  })

  it('round-trips annotation provenance and migrates schema 32 without changing existing tracks', () => {
    const doc = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    addGeneTrack(doc, { id: 'g', name: 'Imported genes', format: 'gtf', files: [{ name: 'genes.gtf.gz', size: 200, lastModified: 1, role: 'signal' }], annotationUrl: 'https://example.org/genes.gtf.gz', annotationReferenceId: 'hg38', annotationDownloadedAt: '2026-11-12T00:00:00Z' }, { id: 'gene-track' })
    const roundTrip = normalizeTrackDocument(JSON.parse(JSON.stringify(doc)))
    expect(roundTrip.sources[0]).toEqual(doc.sources[0])
    expect(roundTrip.tracks.find((track) => track.id === 'gene-track')?.sourceIds).toEqual(['g'])
    const old = normalizeTrackDocument({ ...createTrackDocument('hg38', doc.region), schemaVersion: 32 })
    expect(old.schemaVersion).toBe(TRACK_DOCUMENT_VERSION)
    expect(old.tracks[0].sourceIds).toEqual([])
  })

  it('renders each figure gene row from its own source and reports missing imports', async () => {
    const doc = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
    doc.tracks = []
    addGeneTrack(doc, { id: 'one', name: 'First annotation', format: 'gtf', files: [] }, { id: 'first' })
    addGeneTrack(doc, { id: 'two', name: 'Second annotation', format: 'gff3', files: [] }, { id: 'second' })
    const figure = normalizeFigureDocument(JSON.parse(JSON.stringify(createFigureDocument(doc))))
    expect([...figureRequiredSourceIds(figure)]).toEqual(['one', 'two'])
    const sources = new Map<string, GeneSource>([['one', parseGeneAnnotation(gtf, 'gtf', 'one', chromosomes)], ['two', parseGeneAnnotation(gtf.replaceAll('GENE1', 'GENE2'), 'gtf', 'two', chromosomes)]])
    const session = new FigureRenderSession()
    const result = await session.render(figure, sources)
    expect(result.issues).toEqual([])
    expect(result.svg).toContain('GENE1')
    expect(result.svg).toContain('GENE2')
    const missing = await session.render(figure, new Map([['one', sources.get('one')!]]), sources.get('one'))
    expect(missing.issues.join(' ')).toContain('Second annotation')
    expect(missing.issues.join(' ')).toContain('Reopen or relink')
  })
})

describe('copying region coordinates', () => {
  it('labels a base once in inclusive notation and preserves BED zero-based bounds', () => {
    expect(copyableRegion({ chr: 'chr1', start: 0, end: 1 })).toBe('chr1:1-1')
    expect(copyableRegion({ chr: 'chr1', start: 99, end: 200 })).toBe('chr1:100-200')
    expect(copyableRegion({ chr: 'chr1', start: 99, end: 200 }, 'bed')).toBe('chr1\t99\t200')
    expect(copyableRegion({ chr: 'contigA', start: 99.25, end: 200.5 }, 'bed')).toBe('contigA\t99\t201')
  })
})
