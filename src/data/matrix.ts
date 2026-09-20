import { invoke } from '@tauri-apps/api/core'
import type { MatrixFeature, Region, SignalFeature, TrackQueryOptions, TrackSource } from '../types.ts'
import { describeNativeFile } from '../native-file.ts'
import { deriveCompartment, deriveInsulation, type MatrixDerivedMode } from './matrix-derived.ts'
import { compareMatrixFeatures } from './matrix-comparison.ts'

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
  missingCells: Array<{ bin1: number; bin2: number }>
  maskedBins: number[]
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
        valueMode: options?.matrixValueMode ?? 'observed',
      },
    })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return [{
      featureType: 'matrix',
      start: region.start,
      end: region.end,
      resolution: result.resolution,
      cells: result.cells,
      missingCells: result.missingCells,
      maskedBins: result.maskedBins,
      valueMode: options?.matrixValueMode ?? 'observed',
    }]
  }
}

export function isNativeMatrixSource(source: TrackSource | undefined): source is NativeMatrixSource {
  return source instanceof NativeMatrixSource
}

/** One runtime source, backed by two independently cached native matrix readers. */
export class MatrixComparisonSource implements TrackSource {
  readonly chromosomes: ReadonlyMap<string, number>
  readonly matrixMetadata: ContactMatrixMetadata

  constructor(readonly name: string, readonly first: NativeMatrixSource, readonly second: NativeMatrixSource) {
    const resolutions = first.matrixMetadata.resolutions.filter((value) => second.matrixMetadata.resolutions.includes(value))
    if (!resolutions.length) throw new Error('The matrices have no shared resolution; comparison needs matching bin sizes.')
    const firstNormalizations = first.matrixMetadata.normalizations.map((value) => value === 'NONE' ? 'raw' : value)
    const secondNormalizations = second.matrixMetadata.normalizations.map((value) => value === 'NONE' ? 'raw' : value)
    const normalizations = [...new Set(firstNormalizations.filter((value) => secondNormalizations.includes(value)))]
    if (!normalizations.length) throw new Error('The matrices have no shared normalization.')
    this.chromosomes = new Map([...first.chromosomes].flatMap(([name, length]) => {
      const counterpart = resolveFileChromosome(name, second.matrixMetadata.chromosomes)
      const secondLength = counterpart ? second.chromosomes.get(counterpart) : undefined
      return secondLength ? [[name, Math.min(length, secondLength)] as const] : []
    }))
    if (!this.chromosomes.size) throw new Error('The matrices have no shared chromosomes.')
    this.matrixMetadata = {
      format: first.format, chromosomes: [...this.chromosomes].map(([name, length]) => ({ name, length })),
      resolutions, normalizations, defaultNormalization: normalizations.includes('raw') ? 'raw' : normalizations[0],
    }
  }

  async getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal, options?: TrackQueryOptions): Promise<MatrixFeature[]> {
    const available = this.matrixMetadata.resolutions
    const target = Math.ceil((region.end - region.start) / Math.max(1, Math.min(1_200, Math.round(pixelWidth / 2))))
    const resolution = options?.matrixResolution ?? available.filter((value) => value >= target).sort((a, b) => a - b)[0] ?? Math.max(...available)
    if (!available.includes(resolution)) throw new Error(`The ${resolution} bp resolution is not shared by the matrices.`)
    const normalization = options?.matrixNormalization ?? this.matrixMetadata.defaultNormalization
    if (!this.matrixMetadata.normalizations.includes(normalization)) throw new Error(`The ${normalization} normalization is not shared by the matrices.`)
    const commonOptions = {
      ...options, matrixResolution: resolution, matrixNormalization: normalization,
      matrixValueMode: options?.matrixValueMode === 'log2-observed-expected' ? 'observed-expected' as const : options?.matrixValueMode,
    }
    const query = (source: NativeMatrixSource): Promise<MatrixFeature[]> => source.getFeatures(region, pixelWidth, signal, {
      ...commonOptions, matrixNormalization: normalization === 'raw' && source.format === 'hic' ? 'NONE' : normalization,
    })
    const [first, second] = await Promise.all([query(this.first), query(this.second)])
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return [compareMatrixFeatures(first[0], second[0], options?.matrixComparisonMode ?? 'difference')]
  }
}

export function isMatrixSource(source: TrackSource | undefined): source is NativeMatrixSource | MatrixComparisonSource {
  return source instanceof NativeMatrixSource || source instanceof MatrixComparisonSource
}

/** Derives stable chromosome-wide signal, cached until the underlying file stamp changes. */
export class NativeMatrixDerivedSource implements TrackSource {
  readonly chromosomes: ReadonlyMap<string, number>
  private readonly cache = new Map<string, Promise<SignalFeature[]>>()

  constructor(readonly name: string, readonly matrix: NativeMatrixSource, readonly mode: MatrixDerivedMode,
    readonly normalization: string, readonly preferredResolution?: number) {
    this.chromosomes = matrix.chromosomes
  }

  async getFeatures(region: Region, _pixelWidth: number, signal?: AbortSignal): Promise<SignalFeature[]> {
    const chromosome = resolveFileChromosome(region.chr, this.matrix.matrixMetadata.chromosomes)
    if (!chromosome) throw new Error(`No chromosome named ${region.chr} in this matrix.`)
    const length = this.chromosomes.get(chromosome)!
    const available = this.matrix.matrixMetadata.resolutions
    const minimum = Math.ceil(length / 1_000)
    const resolution = this.preferredResolution && this.preferredResolution >= minimum && available.includes(this.preferredResolution)
      ? this.preferredResolution : available.filter((value) => value >= minimum).sort((a, b) => a - b)[0]
    if (!resolution) throw new Error('No suitable matrix resolution: chromosome analysis needs at most 1,000 bins.')
    const { size, lastModified } = await describeNativeFile(this.matrix.path)
    const key = `${chromosome}:${length}:${resolution}:${this.normalization}:${this.mode}:${size}:${lastModified}`
    let computed = this.cache.get(key)
    if (!computed) {
      this.cache.clear()
      computed = (async () => {
        const windowBins = Math.max(2, Math.min(25, Math.round(500_000 / resolution)))
        const [matrix] = await this.matrix.getFeatures({ chr: chromosome, start: 0, end: length }, 2_400, undefined, {
          matrixResolution: resolution,
          matrixNormalization: this.normalization,
          matrixValueMode: 'observed-expected',
          matrixMaxDistance: this.mode === 'insulation' ? 2 * windowBins * resolution : undefined,
        })
        return this.mode === 'insulation'
          ? deriveInsulation(matrix, length, windowBins)
          : deriveCompartment(matrix, length)
      })()
      this.cache.set(key, computed)
      void computed.catch(() => { if (this.cache.get(key) === computed) this.cache.delete(key) })
    }
    const features = await computed
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return features.filter((feature) => feature.end > region.start && feature.start < region.end)
  }
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
