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

export interface AlignmentDifference {
  kind: 'substitution' | 'insertion' | 'deletion' | 'skip' | 'soft-clip' | 'hard-clip'
  position: number
  length: number
  bases?: string
  quality?: number
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
}

export interface AlignmentCoverageFeature extends SignalFeature {
  featureType: 'coverage'
}

export type TrackFeature = SignalFeature | IntervalFeature | AlignmentFeature | AlignmentCoverageFeature

export interface TrackQueryOptions {
  bamViewMode?: 'coverage' | 'alignments' | 'both'
  bamViewAsPairs?: boolean
  bamMinMapq?: number
  bamIncludeDuplicates?: boolean
  bamIncludeSecondary?: boolean
  bamIncludeSupplementary?: boolean
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
  source?: TrackSource
  features: TrackFeature[]
  loadedRegion?: Region
  status: TrackStatus
  error?: string
  requestVersion: number
}
