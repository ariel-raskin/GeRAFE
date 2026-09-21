import { clampRegion, formatBases, parseLocus, resolveChromosome } from './genome.ts'
import type { Region } from './types.ts'

const MAX_RECTANGULAR_BINS = 1_200
const CHROMOSOME_PREVIEW_SPAN = 2_000_000
const GENE_CONTEXT_SPAN = 500_000

export type MatrixAxisInputResult =
  | { region: Region; kind: 'chromosome' | 'gene' | 'interval'; label?: string }
  | { error: string }

/** Turns a chromosome, gene symbol, or explicit interval into a bounded vertical matrix window. */
export function resolveMatrixAxisInput(input: string, options: {
  chromosomes: ReadonlyMap<string, number>
  resolutions: readonly number[]
  selectedResolution?: number
  enforceBinLimit?: boolean
  findGene?: (name: string) => { name: string; chr: string; start: number; end: number } | undefined
}): MatrixAxisInputResult {
  const value = input.trim()
  if (!value) return { error: 'Enter a chromosome, gene name, or locus such as chr8:50,000,000-52,000,000.' }
  const resolution = options.selectedResolution ?? Math.max(...options.resolutions)
  if (!Number.isSafeInteger(resolution) || resolution <= 0) return { error: 'This matrix has no usable resolution.' }
  const maximumSpan = options.enforceBinLimit === false ? Number.POSITIVE_INFINITY : (MAX_RECTANGULAR_BINS - 2) * resolution

  if (value.includes(':')) {
    const region = parseLocus(value, options.chromosomes)
    if (!region) return { error: 'Enter a valid locus on a chromosome present in this matrix.' }
    const coordinates = /^([^:\s]+):(\d[\d,]*)(?:-(\d[\d,]*))?$/.exec(value)
    if (coordinates && Number(coordinates[2].replaceAll(',', '')) > options.chromosomes.get(region.chr)!) {
      return { error: `This locus starts beyond the end of ${region.chr}.` }
    }
    if (coordinates?.[3] && Number(coordinates[3].replaceAll(',', '')) > options.chromosomes.get(region.chr)!) {
      return { error: `This locus ends beyond the end of ${region.chr}.` }
    }
    const bins = Math.ceil(region.end / resolution) - Math.floor(region.start / resolution)
    if (options.enforceBinLimit !== false && bins > MAX_RECTANGULAR_BINS) return { error: `This interval needs ${bins.toLocaleString()} bins at ${formatBases(resolution)} resolution; rectangular maps allow 1,200. Choose about ${formatBases(maximumSpan)} or less, or select a coarser matrix resolution.` }
    return { region, kind: 'interval' }
  }

  const chromosome = resolveChromosome(value, options.chromosomes)
  if (chromosome) {
    const length = options.chromosomes.get(chromosome)!
    const span = Math.min(length, maximumSpan, CHROMOSOME_PREVIEW_SPAN)
    return { region: centeredWindow(chromosome, length / 2, span, length), kind: 'chromosome' }
  }

  const gene = options.findGene?.(value)
  if (!gene) return { error: options.findGene
    ? `No chromosome or gene named “${value}” was found. Try a locus such as chr8:50,000,000-52,000,000.`
    : 'Gene names require the active hg38 gene index. Enter a chromosome or an explicit chr:start-end locus.' }
  const geneChromosome = resolveChromosome(gene.chr, options.chromosomes)
  if (!geneChromosome) return { error: `${gene.name} is on ${gene.chr}, which is not present in this matrix.` }
  const length = options.chromosomes.get(geneChromosome)!
  if (gene.end > length) return { error: `${gene.name} lies beyond this matrix's ${geneChromosome} coordinates. Check that the matrix and gene reference use the same assembly.` }
  if (gene.end - gene.start > maximumSpan) return { error: `${gene.name} spans more than ${formatBases(maximumSpan)} at this matrix resolution. Select a coarser resolution or enter a smaller interval.` }
  const span = Math.min(length, maximumSpan, Math.max(GENE_CONTEXT_SPAN, gene.end - gene.start + 100_000))
  return { region: centeredWindow(geneChromosome, (gene.start + gene.end) / 2, span, length), kind: 'gene', label: gene.name }
}

function centeredWindow(chr: string, center: number, span: number, chromosomeLength: number): Region {
  const start = Math.max(0, Math.min(Math.round(center - span / 2), chromosomeLength - span))
  return clampRegion({ chr, start, end: start + span }, chromosomeLength)
}
