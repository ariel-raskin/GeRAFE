import { BamFile } from '@gmod/bam'
import type { BamRecord } from '@gmod/bam'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import type { AlignmentCoverageFeature, AlignmentDifference, AlignmentFeature, Region, TrackFeature, TrackQueryOptions, TrackSource } from '../types.ts'

const MAX_QUERY_SPAN = 2_000_000
const ALIGNMENT_VISIBILITY_SPAN = 250_000
const MAX_RECORDS = 500_000
const MAX_DRAWN_ALIGNMENTS = 20_000

export class BamAlignmentSource implements TrackSource {
  readonly name: string
  readonly chromosomes = new Map<string, number>()
  private readonly reader: BamFile

  private constructor(name: string, bamFilehandle: GenericFilehandle, indexFilehandle: GenericFilehandle, isCsi: boolean) {
    this.name = name
    this.reader = new BamFile({
      bamFilehandle,
      ...(isCsi ? { csiFilehandle: indexFilehandle } : { baiFilehandle: indexFilehandle }),
      maxCacheBytes: 256 * 1024 * 1024,
      cacheIdleTimeoutMs: 60_000,
    })
  }

  static async fromFiles(bamFile: File, indexFile: File): Promise<BamAlignmentSource> {
    return BamAlignmentSource.fromFilehandles(bamFile.name, new BlobFile(bamFile), indexFile.name, new BlobFile(indexFile))
  }

  static async fromFilehandles(name: string, bamFilehandle: GenericFilehandle, indexName: string, indexFilehandle: GenericFilehandle): Promise<BamAlignmentSource> {
    const source = new BamAlignmentSource(name, bamFilehandle, indexFilehandle, indexName.toLowerCase().endsWith('.csi'))
    const header = await source.reader.getHeader()
    for (const row of header) {
      if (row.tag !== 'SQ') continue
      const sequenceName = row.data.find((field) => field.tag === 'SN')?.value
      const length = Number(row.data.find((field) => field.tag === 'LN')?.value)
      if (sequenceName && Number.isFinite(length)) source.chromosomes.set(sequenceName, length)
    }
    if (source.chromosomes.size === 0) throw new Error('The BAM header did not contain any reference sequences.')
    return source
  }

  async getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal, options: TrackQueryOptions = {}): Promise<TrackFeature[]> {
    const span = region.end - region.start
    if (span > MAX_QUERY_SPAN) throw new Error(`Zoom below ${(MAX_QUERY_SPAN / 1_000_000).toFixed(0)} Mb to view BAM data.`)
    const viewMode = options.bamViewMode ?? 'both'
    const records = await this.reader.getRecordsForRange(region.chr, Math.floor(region.start), Math.ceil(region.end), {
      signal,
      viewAsPairs: options.bamViewAsPairs ?? false,
      pairAcrossChr: false,
      maxInsertSize: 100_000,
    }) as BamRecord[]
    const filtered = records.filter((record) => includeRecord(record, options))
    if (filtered.length > MAX_RECORDS) throw new Error('This locus contains over 500,000 passing reads. Zoom in or raise the MAPQ filter.')
    const output: TrackFeature[] = []
    const alignmentBlocks = new Map<BamRecord, Array<{ start: number; end: number }>>()
    for (const record of filtered) alignmentBlocks.set(record, cigarBlocks(record.start, record.CIGAR))
    if (viewMode !== 'alignments') output.push(...coverageFeatures(filtered, alignmentBlocks, region, pixelWidth))
    if (viewMode !== 'coverage' && span <= ALIGNMENT_VISIBILITY_SPAN) {
      const sampled = stableDownsample(filtered, MAX_DRAWN_ALIGNMENTS)
      output.push(...sampled.map((record) => alignmentFeature(record, alignmentBlocks.get(record) ?? [], region)))
    }
    return output
  }
}

function includeRecord(record: BamRecord, options: TrackQueryOptions): boolean {
  if (record.isSegmentUnmapped() || record.isFailedQc()) return false
  if (!options.bamIncludeDuplicates && record.isDuplicate()) return false
  if (!options.bamIncludeSecondary && record.isSecondary()) return false
  if (!options.bamIncludeSupplementary && record.isSupplementary()) return false
  return (record.mq ?? 0) >= (options.bamMinMapq ?? 0)
}

function alignmentFeature(record: BamRecord, blocks: Array<{ start: number; end: number }>, region: Region): AlignmentFeature {
  const differences: AlignmentDifference[] = []
  try {
    record.forEachMismatch((code, position, length, bases, quality, _referenceBase, clipLength) => {
      const kind = differenceKind(code)
      if (!kind) return
      differences.push({ kind, position, length: length || clipLength, bases: bases || undefined, quality: quality >= 0 ? quality : undefined })
    }, { start: region.start, end: region.end })
  } catch { /* malformed optional tags should not hide the alignment */ }
  const readGroup = record.getTag('RG')
  return {
    featureType: 'alignment',
    start: record.start,
    end: record.end,
    name: record.name,
    mapq: record.mq ?? 0,
    strand: record.isReverseComplemented() ? '-' : '+',
    flags: record.flags,
    cigar: record.CIGAR,
    blocks,
    differences,
    paired: record.isPaired(),
    properPair: record.isProperlyPaired(),
    readNumber: record.isRead1() ? 1 : record.isRead2() ? 2 : undefined,
    mateStart: record.isPaired() && !record.isMateUnmapped() ? record.next_pos : undefined,
    mateOnSameChromosome: record.next_refid === record.ref_id,
    templateLength: record.template_length,
    pairOrientation: record.pair_orientation,
    readGroup: typeof readGroup === 'string' ? readGroup : undefined,
  }
}

function differenceKind(code: number): AlignmentDifference['kind'] | undefined {
  if (code === 88) return 'substitution'
  if (code === 73) return 'insertion'
  if (code === 68) return 'deletion'
  if (code === 78) return 'skip'
  if (code === 83) return 'soft-clip'
  if (code === 72) return 'hard-clip'
  return undefined
}

export function cigarBlocks(start: number, cigar: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = []
  let reference = start
  for (const match of cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    const length = Number(match[1])
    const operation = match[2]
    if (operation === 'M' || operation === '=' || operation === 'X') {
      blocks.push({ start: reference, end: reference + length })
      reference += length
    } else if (operation === 'D' || operation === 'N') reference += length
  }
  return blocks
}

function coverageFeatures(records: BamRecord[], blocksByRecord: ReadonlyMap<BamRecord, Array<{ start: number; end: number }>>, region: Region, pixelWidth: number): AlignmentCoverageFeature[] {
  const binCount = Math.max(1, Math.ceil(pixelWidth))
  const span = region.end - region.start
  const deltas = new Int32Array(binCount + 1)
  for (const record of records) for (const block of blocksByRecord.get(record) ?? []) {
    if (block.end <= region.start || block.start >= region.end) continue
    const from = Math.max(0, Math.min(binCount - 1, Math.floor(((block.start - region.start) / span) * binCount)))
    const to = Math.max(from, Math.min(binCount, Math.ceil(((block.end - region.start) / span) * binCount)))
    deltas[from] += 1
    deltas[to] -= 1
  }
  const binWidth = span / binCount
  const output: AlignmentCoverageFeature[] = []
  let coverage = 0
  for (let index = 0; index < binCount; index += 1) {
    coverage += deltas[index]
    const start = region.start + index * binWidth
    output.push({ featureType: 'coverage', start, end: start + binWidth, score: coverage })
  }
  return output
}

function stableDownsample(records: BamRecord[], limit: number): BamRecord[] {
  if (records.length <= limit) return records
  return [...records]
    .sort((a, b) => stableHash(a.name, a.start, a.flags) - stableHash(b.name, b.start, b.flags))
    .slice(0, limit)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function stableHash(name: string, start: number, flags: number): number {
  let hash = (start ^ flags) >>> 0
  for (let index = 0; index < name.length; index += 1) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619) >>> 0
  return hash
}

export function findBamIndex(bam: File, files: readonly File[]): File | undefined {
  const lower = bam.name.toLowerCase()
  const base = lower.endsWith('.bam') ? lower.slice(0, -4) : lower
  const accepted = new Set([`${lower}.bai`, `${base}.bai`, `${lower}.csi`, `${base}.csi`])
  return files.find((file) => accepted.has(file.name.toLowerCase()))
}
