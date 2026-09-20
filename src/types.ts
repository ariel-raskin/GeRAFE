export interface Region {
  chr: string
  start: number
  end: number
}

export interface SignalFeature {
  start: number
  end: number
  score: number
}

export interface IntervalFeature {
  start: number
  end: number
  name?: string
  score?: number
  strand?: '+' | '-'
  thickStart?: number
  thickEnd?: number
  itemRgb?: string
  blocks?: Array<{ start: number; end: number }>
}

/** A paired genomic interaction. start/end are the query envelope on the active chromosome. */
export interface InteractionFeature {
  featureType: 'interaction'
  start: number
  end: number
  chrom1: string
  start1: number
  end1: number
  chrom2: string
  start2: number
  end2: number
  name?: string
  score?: number
  strand1?: '+' | '-'
  strand2?: '+' | '-'
  itemRgb?: string
}

export interface MatrixCell {
  bin1: number
  bin2: number
  value: number
}

export interface MatrixCellPosition {
  bin1: number
  bin2: number
}

/** Sparse cells from a square cis contact-matrix query. */
export interface MatrixFeature {
  featureType: 'matrix'
  start: number
  end: number
  resolution: number
  cells: MatrixCell[]
  /** Explicit non-finite source pixels. Sparse omitted pixels are zero, not missing. */
  missingCells: MatrixCellPosition[]
  /** Genomic bin starts masked by the active normalization, when exposed by the source. */
  maskedBins: number[]
  valueMode?: 'observed' | 'observed-expected' | 'log2-observed-expected'
}

export interface AlignmentDifference {
  kind: 'substitution' | 'insertion' | 'deletion' | 'skip' | 'soft-clip' | 'hard-clip'
  position: number
  length: number
  bases?: string
  quality?: number
  /** Approximate alternate-allele frequency in the visible coverage bin. */
  alleleFrequency?: number
}

export interface AlignmentFeature {
  featureType: 'alignment'
  start: number
  end: number
  name: string
  mapq: number
  strand: '+' | '-'
  flags: number
  cigar: string
  blocks: Array<{ start: number; end: number }>
  differences: AlignmentDifference[]
  paired: boolean
  properPair: boolean
  readNumber?: 1 | 2
  mateStart?: number
  mateOnSameChromosome: boolean
  templateLength: number
  pairOrientation?: string
  readGroup?: string
  tags?: Record<string, string>
}

export interface AlignmentCoverageFeature extends SignalFeature {
  featureType: 'coverage'
  /** Highest observed alternate-base frequency in this screen-coverage bin. */
  alleleFrequency?: number
}

export type TrackFeature = SignalFeature | IntervalFeature | InteractionFeature | MatrixFeature | AlignmentFeature | AlignmentCoverageFeature

export interface TrackQueryOptions {
  bamViewMode?: 'coverage' | 'alignments' | 'both'
  bamViewAsPairs?: boolean
  bamMinMapq?: number
  bamIncludeDuplicates?: boolean
  bamIncludeSecondary?: boolean
  bamIncludeSupplementary?: boolean
  bamGroupTag?: string
  matrixResolution?: number
  matrixNormalization?: string
  matrixValueMode?: 'observed' | 'observed-expected' | 'log2-observed-expected'
  matrixMaxDistance?: number
}

export interface TrackSource {
  readonly name: string
  readonly chromosomes: ReadonlyMap<string, number>
  getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal, options?: TrackQueryOptions): Promise<TrackFeature[]>
}

export interface SignalSource extends TrackSource {
  readonly name: string
  readonly chromosomes: ReadonlyMap<string, number>
  getFeatures(region: Region, pixelWidth: number, signal?: AbortSignal): Promise<SignalFeature[]>
}

export type TrackStatus = 'offline' | 'idle' | 'loading' | 'ready' | 'error'

/** Runtime-only state. Files and decoded features deliberately never enter the saved document. */
export interface TrackRuntime {
  id: string
  trackId: string
  sourceId: string
  channel?: 'plus' | 'minus'
  source?: TrackSource
  features: TrackFeature[]
  loadedRegion?: Region
  /** Bases represented by one requested data pixel; smaller means a finer source query. */
  loadedBasesPerPixel?: number
  status: TrackStatus
  error?: string
  requestVersion: number
}
