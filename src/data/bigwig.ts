import { BigWig } from '@gmod/bbi'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import type { Region, SignalFeature, SignalSource } from '../types.ts'

type BigWigHeader = Awaited<ReturnType<BigWig['getHeader']>>

export class BigWigSource implements SignalSource {
  readonly name: string
  readonly chromosomes = new Map<string, number>()
  private readonly reader: BigWig

  private constructor(name: string, filehandle: GenericFilehandle) {
    this.name = name
    this.reader = new BigWig({ filehandle })
  }

  static async fromFile(file: File): Promise<BigWigSource> {
    return BigWigSource.fromFilehandle(file.name, new BlobFile(file))
  }

  static async fromFilehandle(name: string, filehandle: GenericFilehandle): Promise<BigWigSource> {
    const source = new BigWigSource(name, filehandle)
    try {
      const header = await source.reader.getHeader()
      source.readChromosomes(header)
      if (source.chromosomes.size === 0) throw new Error('the header did not contain any chromosomes')
      return source
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${name} could not be read as BigWig: ${detail}`)
    }
  }

  async getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal): Promise<SignalFeature[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const scale = (region.end - region.start) / Math.max(pixelWidth, 1)
    const features = await this.reader.getFeatures(region.chr, Math.floor(region.start), Math.ceil(region.end), {
      scale,
      signal,
    })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return features.map((feature) => ({
      start: feature.start,
      end: feature.end,
      score: Number(feature.score ?? 0),
    }))
  }

  private readChromosomes(header: BigWigHeader): void {
    for (const reference of Object.values(header.refsByNumber ?? {})) this.chromosomes.set(reference.name, reference.length)
  }
}
