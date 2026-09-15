import type { Region, SignalFeature, SignalSource } from '../types.ts'

const MAX_BEDGRAPH_BYTES = 50 * 1024 * 1024

export class BedGraphSource implements SignalSource {
  readonly name: string
  readonly chromosomes = new Map<string, number>()
  private readonly byChromosome = new Map<string, SignalFeature[]>()

  private constructor(name: string) {
    this.name = name
  }

  static async fromFile(file: { name: string; size: number; text(): Promise<string> }): Promise<BedGraphSource> {
    if (file.size > MAX_BEDGRAPH_BYTES) {
      throw new Error('Unindexed bedGraph loading is limited to 50 MB. Convert this file to BigWig for fast browsing.')
    }
    const source = new BedGraphSource(file.name)
    source.parse(await file.text())
    if (source.chromosomes.size === 0) throw new Error('No valid bedGraph rows were found.')
    return source
  }

  async getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal): Promise<SignalFeature[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const features = this.byChromosome.get(region.chr) ?? []
    const first = lowerBound(features, region.start)
    const result: SignalFeature[] = []
    for (let index = Math.max(0, first - 1); index < features.length; index += 1) {
      const feature = features[index]
      if (feature.start >= region.end) break
      if (feature.end > region.start) result.push(feature)
    }
    return summarize(result, region, pixelWidth)
  }

  private parse(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) continue
      const [chr, rawStart, rawEnd, rawScore] = line.trim().split(/\s+/, 4)
      const start = Number(rawStart)
      const end = Number(rawEnd)
      const score = Number(rawScore)
      if (!chr || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(score) || end <= start) continue
      let features = this.byChromosome.get(chr)
      if (!features) {
        features = []
        this.byChromosome.set(chr, features)
      }
      features.push({ start, end, score })
      this.chromosomes.set(chr, Math.max(this.chromosomes.get(chr) ?? 0, end))
    }
    for (const features of this.byChromosome.values()) features.sort((a, b) => a.start - b.start)
  }
}

function lowerBound(features: SignalFeature[], coordinate: number): number {
  let low = 0
  let high = features.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (features[middle].start < coordinate) low = middle + 1
    else high = middle
  }
  return low
}

function summarize(features: SignalFeature[], region: Region, pixelWidth: number): SignalFeature[] {
  if (features.length <= pixelWidth * 2) return features
  const binCount = Math.max(1, Math.ceil(pixelWidth))
  const span = region.end - region.start
  const bins: Array<{ min: number; max: number } | undefined> = new Array(binCount)
  for (const feature of features) {
    const index = Math.max(0, Math.min(binCount - 1, Math.floor(((feature.start - region.start) / span) * binCount)))
    const bin = bins[index]
    if (bin) {
      bin.min = Math.min(bin.min, feature.score)
      bin.max = Math.max(bin.max, feature.score)
    } else bins[index] = { min: feature.score, max: feature.score }
  }
  const result: SignalFeature[] = []
  const binWidth = span / binCount
  bins.forEach((bin, index) => {
    if (!bin) return
    const start = region.start + index * binWidth
    result.push({ start, end: start + binWidth, score: bin.max })
    if (bin.min !== bin.max) result.push({ start, end: start + binWidth, score: bin.min })
  })
  return result
}
