import type { InteractionFeature, Region, TrackSource } from '../types.ts'

export const MAX_BEDPE_BYTES = 50 * 1024 * 1024

export interface BedPeTextInput {
  name: string
  size: number
  text(): Promise<string>
}

interface IndexedInteraction {
  feature: InteractionFeature
  start: number
  end: number
}

export class BedPeSource implements TrackSource {
  readonly name: string
  readonly chromosomes = new Map<string, number>()
  private readonly byChromosome = new Map<string, IndexedInteraction[]>()
  private readonly prefixMaxEnds = new Map<string, number[]>()

  private constructor(name: string) {
    this.name = name
  }

  static async fromFile(file: BedPeTextInput): Promise<BedPeSource> {
    if (file.size > MAX_BEDPE_BYTES) throw new Error('Unindexed BEDPE loading is limited to 50 MB. Split or index this file before browsing it.')
    const source = new BedPeSource(file.name)
    source.parse(await file.text())
    if (source.chromosomes.size === 0) throw new Error('No valid BEDPE rows were found.')
    return source
  }

  async getFeatures(region: Region, _pixelWidth: number, signal?: AbortSignal): Promise<InteractionFeature[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const entries = this.byChromosome.get(region.chr) ?? []
    const prefixMaxEnds = this.prefixMaxEnds.get(region.chr) ?? []
    const first = firstGreaterThan(prefixMaxEnds, region.start)
    const result: InteractionFeature[] = []
    for (let index = first; index < entries.length; index += 1) {
      const entry = entries[index]
      if (entry.start >= region.end) break
      if (entry.end > region.start) result.push({ ...entry.feature, start: entry.start, end: entry.end })
    }
    return result
  }

  private parse(text: string): void {
    let header: Map<string, number> | undefined
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('track') || line.startsWith('browser')) continue
      const fields = line.replace(/^#/, '').split(line.includes('\t') ? '\t' : / +/)
      if (isHeader(fields)) {
        header = new Map(fields.map((field, index) => [normalizeHeader(field), index]))
        continue
      }
      if (line.startsWith('#')) continue

      const chrom1 = field(fields, header, ['chrom1', 'chr1'], 0)
      const start1 = Number(field(fields, header, ['start1'], 1))
      const end1 = Number(field(fields, header, ['end1'], 2))
      const chrom2 = field(fields, header, ['chrom2', 'chr2'], 3)
      const start2 = Number(field(fields, header, ['start2'], 4))
      const end2 = Number(field(fields, header, ['end2'], 5))
      if (!chrom1 || !chrom2 || !validInterval(start1, end1) || !validInterval(start2, end2)) continue

      const feature: InteractionFeature = {
        featureType: 'interaction',
        start: Math.min(start1, start2),
        end: Math.max(end1, end2),
        chrom1, start1, end1, chrom2, start2, end2,
      }
      const name = field(fields, header, ['name', 'namea', 'interaction', 'id'], 6)
      if (name && name !== '.') feature.name = name
      const score = Number(field(fields, header, ['score', 'maxscore', 'scorea', 'value'], 7))
      if (Number.isFinite(score)) feature.score = score
      const strand1 = field(fields, header, ['strand1'], 8)
      const strand2 = field(fields, header, ['strand2'], 9)
      if (strand1 === '+' || strand1 === '-') feature.strand1 = strand1
      if (strand2 === '+' || strand2 === '-') feature.strand2 = strand2
      const explicitColor = field(fields, header, ['color', 'itemrgb', 'rgb'])
      feature.itemRgb = parseItemRgb(explicitColor) ?? fields.slice(10).map(parseItemRgb).find(Boolean)

      this.chromosomes.set(chrom1, Math.max(this.chromosomes.get(chrom1) ?? 0, end1))
      this.chromosomes.set(chrom2, Math.max(this.chromosomes.get(chrom2) ?? 0, end2))
      if (chrom1 === chrom2) {
        this.add(chrom1, feature, Math.min(start1, start2), Math.max(end1, end2))
      } else {
        this.add(chrom1, feature, start1, end1)
        this.add(chrom2, feature, start2, end2)
      }
    }
    for (const [chromosome, entries] of this.byChromosome) {
      entries.sort((a, b) => a.start - b.start || a.end - b.end)
      let maxEnd = 0
      this.prefixMaxEnds.set(chromosome, entries.map((entry) => (maxEnd = Math.max(maxEnd, entry.end))))
    }
  }

  private add(chromosome: string, feature: InteractionFeature, start: number, end: number): void {
    const entries = this.byChromosome.get(chromosome)
    const entry = { feature, start, end }
    if (entries) entries.push(entry)
    else this.byChromosome.set(chromosome, [entry])
  }
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isHeader(fields: readonly string[]): boolean {
  const normalized = fields.slice(0, 6).map(normalizeHeader)
  return normalized.length >= 6
    && ['chrom1', 'chr1'].includes(normalized[0])
    && normalized[1] === 'start1' && normalized[2] === 'end1'
    && ['chrom2', 'chr2'].includes(normalized[3])
    && normalized[4] === 'start2' && normalized[5] === 'end2'
}

function field(fields: readonly string[], header: ReadonlyMap<string, number> | undefined, names: readonly string[], fallback?: number): string | undefined {
  if (header) {
    for (const name of names) {
      const index = header.get(name)
      if (index !== undefined) return fields[index]
    }
    return undefined
  }
  return fallback === undefined ? undefined : fields[fallback]
}

function validInterval(start: number, end: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
}

function parseItemRgb(value: string | undefined): string | undefined {
  if (!value || value === '0' || value === '.') return undefined
  const parts = value.split(',').map(Number)
  return parts.length === 3 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? `rgb(${parts.join(',')})`
    : undefined
}

function firstGreaterThan(values: readonly number[], coordinate: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (values[middle] <= coordinate) low = middle + 1
    else high = middle
  }
  return low
}
