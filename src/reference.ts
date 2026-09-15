import type { Region } from './types.ts'

export interface ReferenceGenome {
  id: string
  name: string
  chromosomes: ReadonlyMap<string, number>
  builtIn?: boolean
}

export interface StoredReferenceGenome {
  id: string
  name: string
  chromosomes: Array<[string, number]>
}

export interface GeneFeature {
  chr: string
  start: number
  end: number
  strand: '+' | '-'
  name: string
  id: string
  transcripts: number
  transcriptModels: TranscriptFeature[]
}

export interface TranscriptFeature {
  id: string
  start: number
  end: number
  exons: Array<{ start: number; end: number }>
  cds: Array<{ start: number; end: number }>
}

export class GeneSource {
  readonly name: string
  private readonly byChromosome = new Map<string, GeneFeature[]>()
  private readonly byName = new Map<string, GeneFeature[]>()

  constructor(name: string, features: readonly GeneFeature[]) {
    this.name = name
    for (const feature of features) {
      const chromosomeFeatures = this.byChromosome.get(feature.chr) ?? []
      chromosomeFeatures.push(feature)
      this.byChromosome.set(feature.chr, chromosomeFeatures)
      const matches = this.byName.get(feature.name.toLocaleUpperCase()) ?? []
      matches.push(feature)
      this.byName.set(feature.name.toLocaleUpperCase(), matches)
    }
    for (const chromosomeFeatures of this.byChromosome.values()) chromosomeFeatures.sort((a, b) => a.start - b.start)
  }

  static fromTsv(text: string, name = 'NCBI RefSeq genes'): GeneSource {
    const featuresById = new Map<string, GeneFeature>()
    for (const line of text.split(/\r?\n/)) {
      if (!line || line[0] === '#') continue
      const [chr, rawStart, rawEnd, rawStrand, gene, id, rawTranscripts, rawExons, rawCds] = line.split('\t')
      const start = Number(rawStart)
      const end = Number(rawEnd)
      if (!chr || !gene || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue
      const geneId = id || gene
      const key = `${chr}\u0000${geneId}`
      let feature = featuresById.get(key)
      if (!feature) {
        feature = {
          chr, start, end, strand: rawStrand === '-' ? '-' : '+', name: gene, id: geneId,
          transcripts: 0, transcriptModels: [],
        }
        featuresById.set(key, feature)
      }
      feature.start = Math.min(feature.start, start)
      feature.end = Math.max(feature.end, end)
      if (rawExons !== undefined) {
        feature.transcriptModels.push({
          id: rawTranscripts || geneId,
          start,
          end,
          exons: parseRanges(rawExons, start, end),
          cds: parseRanges(rawCds ?? ''),
        })
        feature.transcripts = feature.transcriptModels.length
      } else {
        feature.transcripts = Math.max(1, Number(rawTranscripts) || 1)
        feature.transcriptModels.push({ id: geneId, start, end, exons: [{ start, end }], cds: [] })
      }
    }
    const features = [...featuresById.values()]
    if (features.length === 0) throw new Error('The gene annotation did not contain any valid records.')
    return new GeneSource(name, features)
  }

  featuresFor(region: Region): GeneFeature[] {
    const features = this.byChromosome.get(region.chr) ?? []
    const result: GeneFeature[] = []
    for (const feature of features) {
      if (feature.start >= region.end) break
      if (feature.end > region.start) result.push(feature)
    }
    return result
  }

  find(name: string): GeneFeature | undefined {
    return this.byName.get(name.trim().toLocaleUpperCase())?.[0]
  }

  replaceChromosome(chromosome: string, detailedSource: GeneSource): void {
    const detailed = detailedSource.byChromosome.get(chromosome)
    if (!detailed?.length) return
    this.byChromosome.set(chromosome, detailed)
    this.byName.clear()
    for (const features of this.byChromosome.values()) for (const feature of features) {
      const matches = this.byName.get(feature.name.toLocaleUpperCase()) ?? []
      matches.push(feature)
      this.byName.set(feature.name.toLocaleUpperCase(), matches)
    }
  }
}

function parseRanges(text: string, fallbackStart?: number, fallbackEnd?: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const value of text.split(',')) {
    const [rawStart, rawEnd] = value.split('-')
    const start = Number(rawStart)
    const end = Number(rawEnd)
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start) ranges.push({ start, end })
  }
  if (!ranges.length && fallbackStart !== undefined && fallbackEnd !== undefined) ranges.push({ start: fallbackStart, end: fallbackEnd })
  return ranges
}

export function parseChromosomeIndex(text: string): Map<string, number> {
  const chromosomes = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const [name, rawLength] = line.trim().split(/\s+/, 2)
    const length = Number(rawLength)
    if (!name || !Number.isSafeInteger(length) || length <= 0) continue
    chromosomes.set(name, length)
  }
  if (chromosomes.size === 0) throw new Error('No chromosome names and lengths were found in that file.')
  return chromosomes
}

export function serializeReference(reference: ReferenceGenome): StoredReferenceGenome {
  return { id: reference.id, name: reference.name, chromosomes: [...reference.chromosomes] }
}

export function restoreReference(stored: StoredReferenceGenome): ReferenceGenome | undefined {
  if (!stored || typeof stored.id !== 'string' || typeof stored.name !== 'string' || !Array.isArray(stored.chromosomes)) return
  const chromosomes = new Map(stored.chromosomes.filter((entry): entry is [string, number] =>
    Array.isArray(entry) && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && entry[1] > 0,
  ))
  if (chromosomes.size === 0) return
  return { id: stored.id, name: stored.name, chromosomes }
}
