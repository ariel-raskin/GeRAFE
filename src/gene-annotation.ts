import { GeneSource, type GeneFeature, type TranscriptFeature } from './reference.ts'
import { resolveChromosome } from './genome.ts'

export type AnnotationFormat = 'gtf' | 'gff3' | 'genepred'
export function annotationFormat(name: string): AnnotationFormat | undefined {
  const lower = name.toLowerCase().replace(/\.gz$/, '')
  return lower.endsWith('.gtf') ? 'gtf' : /\.gff3?$/.test(lower) ? 'gff3' : /\.(genepred|gp)$/.test(lower) ? 'genepred' : undefined
}

type Range = { start: number; end: number }
type Model = TranscriptFeature & { chr: string; strand: '+' | '-'; geneId: string; name: string; parents: string[] }
type GeneInfo = Range & { chr: string; strand: '+' | '-'; name: string }

/** GFF parents may follow their children, so resolve the graph only after reading. */
class AnnotationBuilder {
  private genes = new Map<string, GeneInfo>()
  private models = new Map<string, Model>()
  private children = new Map<string, { exons: Range[]; cds: Range[] }>()
  private line = 0
  private fasta = false
  private chromosomeCache = new Map<string, string | undefined>()
  skippedChromosomes = new Set<string>()
  constructor(private format: AnnotationFormat, private chromosomes: ReadonlyMap<string, number>) {}

  add(raw: string): void {
    this.line++
    if (raw.startsWith('##FASTA')) this.fasta = true
    if (this.fasta || !raw.trim() || raw.startsWith('#')) return
    try {
      const fields = raw.trimEnd().split('\t')
      if (this.format === 'genepred') { this.addGenePred(fields); return }
      if (fields.length !== 9) throw new Error('Expected nine tab-separated fields.')
      const [sequence, , type, startText, endText, , strand, , attributes] = fields
      const kind = type!.toLowerCase()
      if (!['gene', 'pseudogene', 'transcript', 'mrna', 'ncrna', 'lnc_rna', 'rrna', 'trna', 'exon', 'cds'].includes(kind)) return
      const chr = this.chromosome(sequence!)
      if (!chr) return
      const start = Number(startText) - 1, end = Number(endText)
      this.validateRange(chr, start, end)
      if (strand !== '+' && strand !== '-') throw new Error('Gene models must have a + or - strand.')
      const a: Record<string, string> = Object.create(null)
      if (this.format === 'gtf') {
        for (const match of attributes!.matchAll(/(?:^|;)\s*([^\s;]+)\s+(?:"((?:[^"\\]|\\.)*)"|([^;]*))\s*/g)) a[match[1]!] = (match[2] ?? match[3] ?? '').trim().replace(/\\(["\\])/g, '$1')
      } else {
        for (const part of attributes!.split(';')) {
          const equal = part.indexOf('=')
          if (equal > 0) a[part.slice(0, equal)] = part.slice(equal + 1)
        }
        // Split Parent before URL decoding: an escaped comma can belong to an ID.
      }
      const decode = (value: string) => this.format === 'gff3' ? decodeURIComponent(value) : value
      const geneId = decode(a.gene_id ?? a.gene ?? a.Parent ?? a.ID ?? '')
      const name = decode(a.gene_name ?? a.gene ?? a.Name ?? a.gene_id ?? a.ID ?? '')
      const key = (id: string) => `${chr}\0${strand}\0${id}`
      if (kind === 'gene' || kind === 'pseudogene') {
        const id = decode(a.gene_id ?? a.ID ?? '')
        if (!id) throw new Error('Gene has no gene_id/ID.')
        this.genes.set(key(id), { chr, start, end, strand, name: name || id })
        return
      }
      if (this.format === 'gff3' && kind !== 'exon' && kind !== 'cds') {
        const id = decode(a.ID ?? '')
        if (!id) throw new Error('Transcript has no ID.')
        const model = this.model(key(id), id, chr, strand, start, end)
        model.parents = (a.Parent ?? '').split(',').filter(Boolean).map(decode)
        model.geneId = decode(a.gene_id ?? '')
        model.name = decode(a.gene_name ?? a.gene ?? '')
        return
      }
      if (this.format === 'gtf') {
        const id = a.transcript_id
        if (!id || !geneId) throw new Error('GTF transcript features require gene_id and transcript_id.')
        const model = this.model(key(id), id, chr, strand, start, end)
        model.geneId = geneId
        model.name = name || geneId
        if (kind === 'exon') model.exons.push({ start, end })
        if (kind === 'cds') model.cds.push({ start, end })
      } else {
        const parents = (a.Parent ?? '').split(',').filter(Boolean).map(decode)
        if (!parents.length) throw new Error('GFF3 exon/CDS has no Parent.')
        for (const parent of parents) {
          const k = key(parent)
          const child = this.children.get(k) ?? { exons: [], cds: [] }
          child[kind === 'exon' ? 'exons' : 'cds'].push({ start, end })
          this.children.set(k, child)
        }
      }
    } catch (error) { throw new Error(`Annotation line ${this.line}: ${error instanceof Error ? error.message : String(error)}`) }
  }

  private chromosome(name: string): string | undefined {
    if (this.chromosomeCache.has(name)) return this.chromosomeCache.get(name)
    const chr = resolveChromosome(name, this.chromosomes) ?? (/^(?:chr)?m(?:t)?$/i.test(name) ? ['chrM', 'MT', 'M', 'chrMT'].find((id) => this.chromosomes.has(id)) : undefined)
    this.chromosomeCache.set(name, chr)
    if (!chr) this.skippedChromosomes.add(name)
    return chr
  }
  private validateRange(chr: string, start: number, end: number): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > this.chromosomes.get(chr)!) throw new Error(`Invalid coordinates for ${chr}; check the reference assembly.`)
  }
  private model(key: string, id: string, chr: string, strand: '+' | '-', start: number, end: number): Model {
    let model = this.models.get(key)
    if (!model) { model = { id, chr, strand, start, end, exons: [], cds: [], geneId: '', name: '', parents: [] }; this.models.set(key, model) }
    model.start = Math.min(model.start, start); model.end = Math.max(model.end, end)
    return model
  }
  private addGenePred(raw: string[]): void {
    const f = raw[3] === '+' || raw[3] === '-' ? raw.slice(1) : raw
    if (f.length < 10) throw new Error('Expected genePred/genePredExt fields, optionally preceded by UCSC bin.')
    const [id, sequence, strand, txStart, txEnd, cdsStart, cdsEnd, count, starts, ends] = f
    const chr = this.chromosome(sequence!)
    if (!chr) return
    if (strand !== '+' && strand !== '-') throw new Error('Invalid genePred strand.')
    const start = Number(txStart), end = Number(txEnd)
    this.validateRange(chr, start, end)
    const exonStarts = starts!.replace(/,$/, '').split(',').map(Number)
    const exonEnds = ends!.replace(/,$/, '').split(',').map(Number)
    if (!Number.isSafeInteger(Number(count)) || Number(count) < 1 || exonStarts.length !== Number(count) || exonEnds.length !== exonStarts.length) throw new Error('genePred exon count does not match the exon arrays.')
    const name = f[11] || id!
    const model = this.model(`${chr}\0${strand}\0${id}\0${start}`, id!, chr, strand, start, end)
    model.geneId = name; model.name = name
    const codingStart = Number(cdsStart), codingEnd = Number(cdsEnd)
    if (!Number.isSafeInteger(codingStart) || !Number.isSafeInteger(codingEnd) || codingStart < start || codingEnd > end || codingEnd < codingStart) throw new Error('Invalid genePred CDS bounds.')
    exonStarts.forEach((exonStart, index) => {
      const exonEnd = exonEnds[index]!
      this.validateRange(chr, exonStart, exonEnd)
      if (exonStart < start || exonEnd > end) throw new Error('Exon is outside its transcript.')
      model.exons.push({ start: exonStart, end: exonEnd })
      const left = Math.max(exonStart, codingStart), right = Math.min(exonEnd, codingEnd)
      if (right > left) model.cds.push({ start: left, end: right })
    })
  }

  finish(name: string): GeneSource {
    const grouped = new Map<string, GeneFeature>()
    for (const [key] of this.children) if (!this.models.has(key) && this.genes.has(key)) {
      const info = this.genes.get(key)!, id = key.split('\0').at(-1)!
      const model = this.model(key, id, info.chr, info.strand, info.start, info.end)
      model.geneId = id; model.name = info.name
    }
    for (const [key, model] of this.models) {
      const child = this.children.get(key)
      if (child) { model.exons.push(...child.exons); model.cds.push(...child.cds); this.children.delete(key) }
      const prefix = `${model.chr}\0${model.strand}\0`
      const geneIds = model.geneId ? [model.geneId] : model.parents.length ? model.parents : [model.id]
      for (const geneId of geneIds) {
      const info = this.genes.get(prefix + geneId)
      const geneKey = prefix + geneId
      let gene = grouped.get(geneKey)
      if (!gene) { gene = { chr: model.chr, strand: model.strand, start: model.start, end: model.end, id: geneId, name: info?.name || model.name || geneId, transcripts: 0, transcriptModels: [] }; grouped.set(geneKey, gene) }
      const tidy = (ranges: Range[]) => [...new Map(ranges.map((r) => [`${r.start}:${r.end}`, r])).values()].sort((a, b) => a.start - b.start)
      const exons = tidy(model.exons.length ? model.exons : model.cds.length ? model.cds : [{ start: model.start, end: model.end }])
      const start = Math.min(model.start, exons[0]!.start), end = Math.max(model.end, ...exons.map((r) => r.end))
      gene.start = Math.min(gene.start, start); gene.end = Math.max(gene.end, end)
      gene.transcriptModels.push({ id: model.id, start, end, exons, cds: tidy(model.cds) }); gene.transcripts++
      }
    }
    if (this.children.size) throw new Error('GFF3 contains exon/CDS Parent IDs without matching transcript records.')
    // Gene-only files still provide useful positions and labels.
    for (const [key, gene] of this.genes) if (!grouped.has(key)) grouped.set(key, { ...gene, id: key.split('\0').at(-1)!, transcripts: 1, transcriptModels: [{ id: key.split('\0').at(-1)!, start: gene.start, end: gene.end, exons: [{ start: gene.start, end: gene.end }], cds: [] }] })
    if (!grouped.size) throw new Error('No gene models match the active reference. Check the assembly and chromosome names.')
    return new GeneSource(name, [...grouped.values()])
  }
}

export function parseGeneAnnotation(text: string, format: AnnotationFormat, name: string, chromosomes: ReadonlyMap<string, number>): GeneSource {
  const builder = new AnnotationBuilder(format, chromosomes)
  for (const line of text.split(/\r?\n/)) builder.add(line)
  return builder.finish(name)
}

/** Read in chunks so full GTF/GFF files need no giant decoded string. */
export async function readGeneAnnotation(stream: ReadableStream<Uint8Array<ArrayBuffer>>, compressed: boolean, format: AnnotationFormat, name: string, chromosomes: ReadonlyMap<string, number>, progress?: (lines: number) => void, signal?: AbortSignal): Promise<GeneSource> {
  const builder = new AnnotationBuilder(format, chromosomes)
  const reader = (compressed ? stream.pipeThrough(new DecompressionStream('gzip')) : stream).pipeThrough(new TextDecoderStream()).getReader()
  let pending = '', lines = 0, lastYield = performance.now()
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Annotation import cancelled.', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      pending += value
      let start = 0, newline: number
      while ((newline = pending.indexOf('\n', start)) >= 0) { builder.add(pending.slice(start, newline)); start = newline + 1; lines++ }
      pending = pending.slice(start)
      if (pending.length > 4_000_000) throw new Error('Annotation line is too long; expected a tabular gene annotation.')
      if (performance.now() - lastYield > 40) { progress?.(lines); await new Promise((resolve) => setTimeout(resolve, 0)); lastYield = performance.now() }
    }
    if (pending) builder.add(pending)
    return builder.finish(name)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
