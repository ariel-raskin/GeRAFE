import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { BufferEncoding, FilehandleOptions, GenericFilehandle, ReadFileOptions, ReadFileTextOptions } from 'generic-filehandle2'

export interface LocalFileDescriptor {
  name: string
  path: string
  size: number
  lastModified: number
  needsHydration: boolean
}

interface NativeFileStat {
  size: number
  lastModified: number
  needsHydration: boolean
}

export interface NativeFileHydrationProgress {
  bytesRead: number
  totalBytes: number
}

export interface NativeDirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface NativeDirectoryListing {
  path: string
  parent?: string
  drives: string[]
  entries: NativeDirectoryEntry[]
}

export interface PreparedBedGraphCache extends LocalFileDescriptor {
  reused: boolean
}

export function isDesktopApp(): boolean {
  return isTauri()
}

export async function describeNativeFile(path: string): Promise<LocalFileDescriptor> {
  const stat = await invoke<NativeFileStat>('stat_file', { path })
  return { name: fileNameFromPath(path), path, size: stat.size, lastModified: stat.lastModified, needsHydration: stat.needsHydration }
}

export async function hydrateNativeFile(path: string, onProgress: (progress: NativeFileHydrationProgress) => void): Promise<void> {
  const channel = new Channel<NativeFileHydrationProgress>()
  channel.onmessage = onProgress
  await invoke('hydrate_file', { path, onProgress: channel })
}

/** Best-effort Cloud Files API measurement; unavailable for providers outside that API. */
export async function cloudLocalBytes(path: string): Promise<number | undefined> {
  return (await invoke<number | null>('cloud_local_bytes', { path })) ?? undefined
}

export async function listNativeDirectory(path?: string): Promise<NativeDirectoryListing> {
  return invoke<NativeDirectoryListing>('list_directory', { path })
}

export async function readNativeTextFile(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path })
}

export async function writeNativeTextFile(path: string, contents: string): Promise<void> {
  await invoke('write_text_file', { path, contents })
}

export async function prepareBedGraphCache(path: string, chromosomes: ReadonlyMap<string, number>): Promise<PreparedBedGraphCache> {
  const chromosomeSizes = cacheChromosomeSizes(chromosomes)
  const cache = await invoke<Omit<PreparedBedGraphCache, 'name'>>('prepare_bedgraph_cache', { path, chromosomeSizes })
  return { ...cache, name: fileNameFromPath(cache.path), needsHydration: false }
}

function cacheChromosomeSizes(chromosomes: ReadonlyMap<string, number>): Record<string, number> {
  const sizes: Record<string, number> = {}
  const add = (name: string, length: number): void => {
    if (!(name in sizes) && Number.isSafeInteger(length) && length > 0 && length <= 0xffff_ffff) sizes[name] = length
  }
  for (const [name, length] of chromosomes) {
    add(name, length)
    if (/^chr/i.test(name)) add(name.slice(3), length)
    else add(`chr${name}`, length)
    if (/^(?:chr)?m(?:t)?$/i.test(name)) {
      add('chrM', length)
      add('chrMT', length)
      add('M', length)
      add('MT', length)
    }
  }
  return sizes
}

export class NativeFileHandle implements GenericFilehandle {
  readonly source: string

  constructor(path: string) {
    this.source = path
  }

  async read(length: number, position: number, opts?: FilehandleOptions): Promise<Uint8Array<ArrayBuffer>> {
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const bytes = await invoke<ArrayBuffer>('read_file_range', { path: this.source, offset: position, length })
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return new Uint8Array(bytes)
  }

  async readFile(options?: ReadFileOptions): Promise<Uint8Array<ArrayBuffer>>
  async readFile(options: ReadFileTextOptions): Promise<string>
  async readFile(options?: ReadFileOptions | ReadFileTextOptions): Promise<Uint8Array<ArrayBuffer> | string> {
    const { size } = await this.stat()
    const bytes = await this.read(size, 0, typeof options === 'object' ? options : undefined)
    const encoding = typeof options === 'string' ? options : options && 'encoding' in options ? options.encoding : undefined
    return encoding ? decodeText(bytes, encoding) : bytes
  }

  async stat(): Promise<{ size: number }> {
    const stat = await invoke<NativeFileStat>('stat_file', { path: this.source })
    return { size: stat.size }
  }

  async close(): Promise<void> {}
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).at(-1) || path
}

function decodeText(bytes: Uint8Array, encoding: BufferEncoding): string {
  const normalized = encoding.toLowerCase().replace('-', '')
  if (normalized !== 'utf8') throw new Error(`Unsupported text encoding: ${encoding}`)
  return new TextDecoder().decode(bytes)
}
