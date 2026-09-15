import type { Region, SignalFeature, SignalSource } from '../types.ts'

export class SyntheticSource implements SignalSource {
  readonly chromosomes: ReadonlyMap<string, number>

  constructor(
    readonly name: string,
    chromosomes: ReadonlyMap<string, number>,
    private readonly phase: number,
  ) {
    this.chromosomes = chromosomes
  }

  async getFeatures(region: Region, pixelWidth: number): Promise<SignalFeature[]> {
    const bins = Math.max(80, Math.ceil(pixelWidth * 1.5))
    const step = (region.end - region.start) / bins
    const features: SignalFeature[] = new Array(bins)
    for (let index = 0; index < bins; index += 1) {
      const start = region.start + index * step
      const wave = Math.sin(index * 0.091 + this.phase) * 0.18 + Math.sin(index * 0.017 + this.phase * 2) * 0.11
      const peakA = Math.exp(-Math.pow((index - bins * 0.31) / (bins * 0.045), 2))
      const peakB = 0.65 * Math.exp(-Math.pow((index - bins * 0.72) / (bins * 0.075), 2))
      const noise = hash(index + Math.floor(region.start / Math.max(step, 1)) + this.phase * 100) * 0.15
      features[index] = { start, end: start + step, score: Math.max(0, 0.15 + wave + peakA + peakB + noise) }
    }
    return features
  }
}

function hash(value: number): number {
  const x = Math.sin(value * 12.9898) * 43_758.5453
  return (x - Math.floor(x)) * 2 - 1
}
