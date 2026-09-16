import type { IntervalFeature, Region, TrackSource } from '../types.ts'

const MAX_BED_BYTES = 50 * 1024 * 1024

export interface BedTextInput {
  name: string
  size: number
  text(): Promise<string>
}

export class BedSource implements TrackSource {
  readonly name: string
  readonly chromosomes = new Map<string, number>()
  private readonly byChromosome = new Map<string, IntervalFeature[]>()
  private readonly prefixMaxEnds = new Map<string, number[]>()

  private constructor(name: string) {
    this.name = name
  }

  static async fromFile(file: BedTextInput): Promise<BedSource> {
    if (file.size > MAX_BED_BYTES) throw new Error('Unindexed BED loading is limited to 50 MB. Split or index this file before browsing it.')
    const source = new BedSource(file.name)
    source.parse(await file.text())
    if (source.chromosomes.size === 0) throw new Error('No valid BED rows were found.')
    return source
  }

  async getFeatures(region: Region, _pixelWidth: number, signal?: AbortSignal): Promise<IntervalFeature[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const features = this.byChromosome.get(region.chr) ?? []
    const prefixMaxEnds = this.prefixMaxEnds.get(region.chr) ?? []
    const first = firstGreaterThan(prefixMaxEnds, region.start)
    const result: IntervalFeature[] = []
    for (let index = first; index < features.length; index += 1) {
      const feature = features[index]
      if (feature.start >= region.end) break
      if (feature.end > region.start) result.push(feature)
    }
    return result
  }

  private parse(text: string): void {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue
      // Standard BED is tab-delimited. Keeping that boundary intact also
      // supports common UCSC exports whose name field itself contains spaces
      // (for example, "CpG: 361"). Whitespace-only BED remains accepted.
      const fields = line.includes('\t') ? line.split('\t') : line.split(/ +/)
      const chr = fields[0]
      const start = Number(fields[1])
      const end = Number(fields[2])
      if (!chr || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue
      const feature: IntervalFeature = { start, end }
      if (fields[3] && fields[3] !== '.') feature.name = fields[3]
      const score = Number(fields[4])
      if (Number.isFinite(score)) feature.score = score
      if (fields[5] === '+' || fields[5] === '-') feature.strand = fields[5]
      const thickStart = Number(fields[6])
      const thickEnd = Number(fields[7])
      if (Number.isFinite(thickStart) && Number.isFinite(thickEnd) && thickEnd > thickStart) {
        feature.thickStart = thickStart
        feature.thickEnd = thickEnd
      }
      feature.itemRgb = parseItemRgb(fields[8])
      const blockCount = Number(fields[9])
      const blockSizes = fields[10]?.split(',').filter(Boolean).map(Number)
      const blockStarts = fields[11]?.split(',').filter(Boolean).map(Number)
      if (Number.isInteger(blockCount) && blockCount > 0 && blockSizes?.length === blockCount && blockStarts?.length === blockCount) {
        const blocks = blockSizes.map((size, index) => ({ start: start + blockStarts[index], end: start + blockStarts[index] + size }))
          .filter((block) => Number.isFinite(block.start) && Number.isFinite(block.end) && block.end > block.start)
        if (blocks.length) feature.blocks = blocks
      }
      let features = this.byChromosome.get(chr)
      if (!features) { features = []; this.byChromosome.set(chr, features) }
      features.push(feature)
      this.chromosomes.set(chr, Math.max(this.chromosomes.get(chr) ?? 0, end))
    }
    for (const [chr, features] of this.byChromosome) {
      features.sort((a, b) => a.start - b.start || a.end - b.end)
      let maxEnd = 0
      this.prefixMaxEnds.set(chr, features.map((feature) => (maxEnd = Math.max(maxEnd, feature.end))))
    }
  }
}

function firstGreaterThan(values: number[], coordinate: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (values[middle] <= coordinate) low = middle + 1
    else high = middle
  }
  return low
}

function parseItemRgb(value: string | undefined): string | undefined {
  if (!value || value === '0' || value === '.') return undefined
  const parts = value.split(',').map(Number)
  return parts.length === 3 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? `rgb(${parts.join(',')})`
    : undefined
}
