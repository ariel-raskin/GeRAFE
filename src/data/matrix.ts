import { invoke } from '@tauri-apps/api/core'
import type { MatrixFeature, Region, TrackQueryOptions, TrackSource } from '../types.ts'

export type MatrixFormat = 'hic' | 'cool' | 'mcool'

export interface ContactMatrixMetadata {
  format: MatrixFormat
  chromosomes: Array<{ name: string; length: number }>
  resolutions: number[]
  normalizations: string[]
  defaultNormalization: string
}

interface ContactMatrixResult {
  resolution: number
  cells: Array<{ bin1: number; bin2: number; value: number }>
}

export class NativeMatrixSource implements TrackSource {
  readonly chromosomes: ReadonlyMap<string, number>

  private constructor(
    readonly name: string,
    readonly path: string,
    readonly format: MatrixFormat,
    readonly matrixMetadata: ContactMatrixMetadata,
  ) {
    this.chromosomes = new Map(matrixMetadata.chromosomes.map((chromosome) => [chromosome.name, chromosome.length]))
  }

  static async open(name: string, path: string, format: MatrixFormat): Promise<NativeMatrixSource> {
    const metadata = await invoke<ContactMatrixMetadata>('contact_matrix_metadata', { path, format })
    return new NativeMatrixSource(name, path, format, metadata)
  }

  async getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal, options?: TrackQueryOptions): Promise<MatrixFeature[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const chromosome = resolveFileChromosome(region.chr, this.matrixMetadata.chromosomes)
    if (!chromosome) throw new Error(`No chromosome named ${region.chr} in this matrix.`)
    const result = await invoke<ContactMatrixResult>('query_contact_matrix', {
      options: {
        path: this.path,
        format: this.format,
        chromosome,
        start: Math.max(0, Math.floor(region.start)),
        end: Math.ceil(region.end),
        pixelWidth: Math.max(1, Math.round(pixelWidth)),
        resolution: options?.matrixResolution,
        normalization: options?.matrixNormalization ?? this.matrixMetadata.defaultNormalization,
        maxDistance: options?.matrixMaxDistance,
      },
    })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return [{
      featureType: 'matrix',
      start: region.start,
      end: region.end,
      resolution: result.resolution,
      cells: result.cells,
    }]
  }
}

export function isNativeMatrixSource(source: TrackSource | undefined): source is NativeMatrixSource {
  return source instanceof NativeMatrixSource
}

function resolveFileChromosome(requested: string, chromosomes: readonly { name: string }[]): string | undefined {
  const exact = chromosomes.find((chromosome) => chromosome.name === requested)
  if (exact) return exact.name
  const lower = requested.toLocaleLowerCase()
  const insensitive = chromosomes.find((chromosome) => chromosome.name.toLocaleLowerCase() === lower)
  if (insensitive) return insensitive.name
  const alternate = /^chr/i.test(requested) ? requested.slice(3) : `chr${requested}`
  return chromosomes.find((chromosome) => chromosome.name.toLocaleLowerCase() === alternate.toLocaleLowerCase())?.name
}
