import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import { inflate } from 'pako-esm2'
import type { Region, SignalFeature, SignalSource } from '../types.ts'

const TDF_MAGIC_PREFIX = 0x00464454
const GZIP_FLAG = 0x1

interface IndexEntry { position: number; size: number }
interface Dataset { tileWidth: number; tiles: IndexEntry[] }

/** Indexed TDF signal reader, adapted to the public IGV TDF format and tile model. */
export class TdfSource implements SignalSource {
  readonly name: string
  readonly chromosomes = new Map<string, number>()
  readonly trackNames: string[] = []
  readonly windowFunctions: string[] = []
  private readonly filehandle: GenericFilehandle
  private readonly referenceChromosomes: ReadonlyMap<string, number>
  private readonly datasets = new Map<string, IndexEntry>()
  private readonly groups = new Map<string, IndexEntry>()
  private readonly datasetCache = new Map<string, Dataset | undefined>()
  private version = 0
  private indexPosition = 0
  private indexSize = 0
  private compressed = false
  private maxZoom = -1
  private chromosomeAliases = new Map<string, string>()

  private constructor(name: string, filehandle: GenericFilehandle, referenceChromosomes: ReadonlyMap<string, number>) {
    this.name = name
    this.filehandle = filehandle
    this.referenceChromosomes = referenceChromosomes
  }

  static async fromFile(file: File, referenceChromosomes: ReadonlyMap<string, number>): Promise<TdfSource> {
    return TdfSource.fromFilehandle(file.name, new BlobFile(file), referenceChromosomes)
  }

  static async fromFilehandle(name: string, filehandle: GenericFilehandle, referenceChromosomes: ReadonlyMap<string, number>): Promise<TdfSource> {
    const source = new TdfSource(name, filehandle, referenceChromosomes)
    await source.readHeader()
    await source.readRootGroup()
    return source
  }

  async getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal): Promise<SignalFeature[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const queryChr = this.chromosomeAliases.get(region.chr) ?? region.chr
    const chromosomeLength = this.referenceChromosomes.get(region.chr) ?? this.chromosomes.get(region.chr) ?? region.end
    const bpPerPixel = (region.end - region.start) / Math.max(1, pixelWidth)
    const zoom = Math.max(0, Math.ceil(Math.log2(Math.max(1, chromosomeLength / (bpPerPixel * 700)))))
    const requestedWindow = this.windowFunctions.includes('mean') ? 'mean' : this.windowFunctions[0] ?? 'mean'
    const dataset = await this.readDataset(queryChr, zoom > this.maxZoom ? 'raw' : requestedWindow, zoom, signal)
    if (!dataset) return []
    const startTile = Math.max(0, Math.floor(region.start / dataset.tileWidth))
    const endTile = Math.min(dataset.tiles.length - 1, Math.floor(region.end / dataset.tileWidth))
    const features: SignalFeature[] = []
    for (let index = startTile; index <= endTile; index += 1) {
      const entry = dataset.tiles[index]
      if (!entry || entry.size <= 0) continue
      const bytes = await this.filehandle.read(entry.size, entry.position, { signal })
      const tileBytes = this.compressed ? inflate(bytes, {}) as Uint8Array : bytes
      decodeTile(tileBytes, this.trackNames.length || 1, region, features)
    }
    features.sort((a, b) => a.start - b.start)
    return features
  }

  private async readHeader(): Promise<void> {
    const fixed = await this.filehandle.read(24, 0)
    if (fixed.byteLength < 24) throw new Error(`${this.name} is too short to be a TDF file.`)
    const base = new BinaryReader(fixed)
    if ((base.int32() & 0x00ffffff) !== TDF_MAGIC_PREFIX) throw new Error(`${this.name} does not have a valid TDF header.`)
    this.version = base.int32()
    this.indexPosition = base.int64()
    this.indexSize = base.int32()
    const headerSize = base.int32()
    if (headerSize < 0 || headerSize > 16 * 1024 * 1024) throw new Error(`${this.name} has an invalid TDF header size.`)
    const header = new BinaryReader(await this.filehandle.read(headerSize, 24))
    if (this.version >= 2) {
      let count = header.int32()
      while (count-- > 0) this.windowFunctions.push(header.string())
    }
    header.string() // track type
    header.string() // UCSC track line
    let trackCount = header.int32()
    while (trackCount-- > 0) this.trackNames.push(header.string())
    header.string() // genome id
    this.compressed = (header.int32() & GZIP_FLAG) !== 0

    const index = new BinaryReader(await this.filehandle.read(this.indexSize, this.indexPosition))
    let entries = index.int32()
    while (entries-- > 0) this.datasets.set(index.string(), { position: index.int64(), size: index.int32() })
    entries = index.int32()
    while (entries-- > 0) this.groups.set(index.string(), { position: index.int64(), size: index.int32() })
  }

  private async readRootGroup(): Promise<void> {
    const entry = this.groups.get('/')
    if (!entry) throw new Error(`${this.name} has no TDF root group.`)
    const reader = new BinaryReader(await this.filehandle.read(entry.size, entry.position))
    const attributes = new Map<string, string>()
    let count = reader.int32()
    while (count-- > 0) attributes.set(reader.string(), reader.string())
    this.maxZoom = Number(attributes.get('maxZoom') ?? -1)
    for (const fileChr of (attributes.get('chromosomes') ?? '').split(',').filter(Boolean)) {
      const alias = resolveAlias(fileChr, this.referenceChromosomes)
      this.chromosomeAliases.set(alias, fileChr)
      this.chromosomeAliases.set(fileChr, fileChr)
      this.chromosomes.set(alias, this.referenceChromosomes.get(alias) ?? 1)
    }
    if (!this.chromosomes.size) throw new Error(`${this.name} does not list any chromosomes.`)
  }

  private async readDataset(chr: string, windowFunction: string, zoom: number, signal?: AbortSignal): Promise<Dataset | undefined> {
    const zoomString = chr.toLowerCase() === 'all' ? '0' : String(zoom)
    const name = windowFunction === 'raw' ? `/${chr}/raw` : `/${chr}/z${zoomString}/${windowFunction}`
    if (this.datasetCache.has(name)) return this.datasetCache.get(name)
    const entry = this.datasets.get(name)
    if (!entry) { this.datasetCache.set(name, undefined); return undefined }
    const reader = new BinaryReader(await this.filehandle.read(entry.size, entry.position, { signal }))
    let attributes = reader.int32()
    while (attributes-- > 0) { reader.string(); reader.string() }
    reader.string() // data type
    const tileWidth = reader.float32()
    const tiles: IndexEntry[] = []
    let count = reader.int32()
    while (count-- > 0) tiles.push({ position: reader.int64(), size: reader.int32() })
    const dataset = { tileWidth, tiles }
    this.datasetCache.set(name, dataset)
    return dataset
  }
}

function decodeTile(bytes: Uint8Array, trackCount: number, region: Region, output: SignalFeature[]): void {
  const reader = new BinaryReader(bytes)
  const type = reader.string()
  if (type === 'fixedStep') {
    const count = reader.int32()
    let start = reader.int32()
    const span = reader.float32()
    const values = readFirstTrack(reader, count, trackCount)
    for (let index = 0; index < count; index += 1, start += span) pushSignal(output, start, start + span, values[index], region)
    return
  }
  if (type === 'variableStep') {
    const tileStart = reader.int32()
    void tileStart
    const span = reader.float32()
    const count = reader.int32()
    const starts = Array.from({ length: count }, () => reader.int32())
    reader.int32() // sample count
    const values = readFirstTrack(reader, count, trackCount)
    for (let index = 0; index < count; index += 1) pushSignal(output, starts[index], starts[index] + span, values[index], region)
    return
  }
  if (type === 'bed' || type === 'bedWithName') {
    const count = reader.int32()
    const starts = Array.from({ length: count }, () => reader.int32())
    const ends = Array.from({ length: count }, () => reader.int32())
    reader.int32() // sample count
    const values = readFirstTrack(reader, count, trackCount)
    for (let index = 0; index < count; index += 1) pushSignal(output, starts[index], ends[index], values[index], region)
    return
  }
  throw new Error(`Unsupported TDF tile type: ${type}`)
}

function readFirstTrack(reader: BinaryReader, positions: number, tracks: number): number[] {
  const values = Array.from({ length: positions }, () => reader.float32())
  for (let track = 1; track < tracks; track += 1) for (let index = 0; index < positions; index += 1) reader.float32()
  return values
}

function pushSignal(output: SignalFeature[], start: number, end: number, score: number, region: Region): void {
  if (!Number.isNaN(score) && end > region.start && start < region.end) output.push({ start, end, score })
}

function resolveAlias(fileChr: string, reference: ReadonlyMap<string, number>): string {
  if (reference.has(fileChr)) return fileChr
  const alternate = fileChr.startsWith('chr') ? fileChr.slice(3) : `chr${fileChr}`
  return reference.has(alternate) ? alternate : fileChr
}

class BinaryReader {
  private readonly view: DataView
  private position = 0
  constructor(bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  int32(): number { this.require(4); const value = this.view.getInt32(this.position, true); this.position += 4; return value }
  int64(): number { this.require(8); const value = Number(this.view.getBigInt64(this.position, true)); this.position += 8; return value }
  float32(): number { this.require(4); const value = this.view.getFloat32(this.position, true); this.position += 4; return value }
  string(): string {
    const start = this.position
    while (this.position < this.view.byteLength && this.view.getUint8(this.position) !== 0) this.position += 1
    if (this.position >= this.view.byteLength) throw new Error('Unterminated string in TDF data.')
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + start, this.position - start)
    this.position += 1
    return new TextDecoder().decode(bytes)
  }
  private require(length: number): void { if (this.position + length > this.view.byteLength) throw new Error('Unexpected end of TDF data.') }
}
