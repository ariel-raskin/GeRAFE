import type { Region } from './types.ts'

export const hg38 = new Map<string, number>([
  ['chr1', 248_956_422], ['chr2', 242_193_529], ['chr3', 198_295_559],
  ['chr4', 190_214_555], ['chr5', 181_538_259], ['chr6', 170_805_979],
  ['chr7', 159_345_973], ['chr8', 145_138_636], ['chr9', 138_394_717],
  ['chr10', 133_797_422], ['chr11', 135_086_622], ['chr12', 133_275_309],
  ['chr13', 114_364_328], ['chr14', 107_043_718], ['chr15', 101_991_189],
  ['chr16', 90_338_345], ['chr17', 83_257_441], ['chr18', 80_373_285],
  ['chr19', 58_617_616], ['chr20', 64_444_167], ['chr21', 46_709_983],
  ['chr22', 50_818_468], ['chrX', 156_040_895], ['chrY', 57_227_415],
  ['chrM', 16_569],
])

export function clampRegion(region: Region, chromosomeLength: number): Region {
  const span = Math.max(10, Math.min(region.end - region.start, chromosomeLength))
  const start = Math.max(0, Math.min(region.start, chromosomeLength - span))
  return { chr: region.chr, start, end: start + span }
}

export interface LocusInputParts {
  chromosome: string
  first?: number
  last?: number
}

/** Recognize common pasted coordinates without changing their 1-based meaning. */
export function parseLocusInputParts(input: string): LocusInputParts | undefined {
  const normalized = input.trim().replaceAll(',', '').replace(/[\u2012-\u2015\u2212]/g, '-')
  const locus = /^([^:\s]+)(?:(?:\s*:\s*|\s+)(.+))?$/.exec(normalized)
  if (!locus) return
  if (locus[2] === undefined) return { chromosome: locus[1] }
  const coordinates = /^(\d+)(?:(?:\s*-\s*|\s*\.\.\s*|\s+to\s+|\s+)(\d+))?$/i.exec(locus[2].trim())
  if (!coordinates) return
  return {
    chromosome: locus[1],
    first: Number(coordinates[1]),
    last: coordinates[2] === undefined ? undefined : Number(coordinates[2]),
  }
}

export function parseLocus(input: string, chromosomes: ReadonlyMap<string, number>): Region | undefined {
  const parts = parseLocusInputParts(input)
  if (!parts) return

  const chr = resolveChromosome(parts.chromosome, chromosomes)
  if (!chr) return
  const chrLength = chromosomes.get(chr)!
  if (parts.first === undefined) return { chr, start: 0, end: chrLength }

  // UI coordinates are conventional 1-based inclusive; internal coordinates are 0-based half-open.
  const first = parts.first
  const last = parts.last ?? first + Math.max(100, Math.round(chrLength / 10_000))
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return
  return clampRegion({ chr, start: first - 1, end: last }, chrLength)
}

export function resolveChromosome(name: string, chromosomes: ReadonlyMap<string, number>): string | undefined {
  if (chromosomes.has(name)) return name
  const lower = name.toLowerCase()
  for (const key of chromosomes.keys()) {
    if (key.toLowerCase() === lower) return key
    if (key.toLowerCase().replace(/^chr/, '') === lower.replace(/^chr/, '')) return key
  }
}

export function formatLocus(region: Region): string {
  return `${region.chr}:${Math.floor(region.start + 1).toLocaleString()}-${Math.ceil(region.end).toLocaleString()}`
}

export function formatBases(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) return `${trim(value / 1_000_000_000)} Gb`
  if (absolute >= 1_000_000) return `${trim(value / 1_000_000)} Mb`
  if (absolute >= 1_000) return `${trim(value / 1_000)} kb`
  return `${Math.round(value)} bp`
}

/** Compact zoom label where 100% represents one full chromosome. */
export function formatZoomPercentage(percentage: number): string {
  if (percentage >= 1_000_000) return `${Number((percentage / 1_000_000).toPrecision(3))}m%`
  if (percentage >= 1_000) return `${Number((percentage / 1_000).toPrecision(3))}k%`
  if (percentage >= 100) return `${Math.round(percentage)}%`
  return `${Number(percentage.toPrecision(3))}%`
}

function trim(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, '')
}
