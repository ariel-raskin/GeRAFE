import { clampRegion, parseLocus, resolveChromosome } from './genome.ts'
import { nativeFilePathKey } from './open-track-files.ts'
import {
  addAlignmentTrack, addInteractionTrack, addIntervalTrack, addMatrixTrack, addSignalTrack,
  createTrackDocument, linkScales,
  type SourceFormat, type TrackDocument, type TrackSourceSpec, type TrackSpec,
} from './track-document.ts'
import type { LocalFileDescriptor } from './native-file.ts'
import type { Region } from './types.ts'

export interface IgvTrack {
  id: string
  attributes: Record<string, string>
  dataRange?: Record<string, string>
  order: number
  panel: string
}

export interface IgvResource {
  key: string
  path: string
  index?: string
  type?: string
  track?: IgvTrack
  order: number
}

export interface IgvSession {
  genome: string
  locus?: string
  version?: string
  resources: IgvResource[]
  regions: Array<{ chr: string; start: number; end: number; label?: string }>
  notes: string[]
}

export type IgvSourceKind = 'signal' | 'interval' | 'interaction' | 'matrix' | 'alignment'
export type IgvSourceCapability = { kind: IgvSourceKind; format: SourceFormat }
export type IgvImportStatus = 'ready' | 'checking' | 'needs-reference' | 'missing' | 'missing-index' | 'unsupported'

export interface IgvPreviewItem {
  resource: IgvResource
  path: string
  indexPath?: string
  source?: LocalFileDescriptor
  index?: LocalFileDescriptor
  capability?: IgvSourceCapability
  status: IgvImportStatus
  reason?: string
  ignoredSettings: string[]
}

export interface IgvPreview {
  referenceId?: string
  referenceOverride: boolean
  region?: Region
  items: IgvPreviewItem[]
  importedRegions: number
  notes: string[]
}

export interface IgvPreviewOptions {
  sessionPath: string
  references: ReadonlyMap<string, ReadonlyMap<string, number>>
  selectedReferenceId?: string
  overrides?: ReadonlyMap<string, { path?: string; index?: string }>
  files: ReadonlyMap<string, LocalFileDescriptor | null>
  capabilityForPath: (path: string) => IgvSourceCapability | undefined
}

const MAPPED_TRACK_ATTRIBUTES = new Set(['id', 'clazz', 'name', 'color', 'altColor', 'visible', 'height', 'autoScale', 'autoscaleGroup', 'displayMode', 'renderer', 'direction'])
const MAPPED_RANGE_ATTRIBUTES = new Set(['minimum', 'maximum'])

export function parseIgvSessionXml(contents: string): IgvSession {
  if (contents.length > 16 * 1024 * 1024) throw new Error('IGV session exceeds the 16 MB import limit.')
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(contents)) throw new Error('IGV sessions with DTD or entity declarations are not supported.')
  const xml = new DOMParser().parseFromString(contents, 'application/xml')
  if (xml.getElementsByTagName('parsererror').length) throw new Error('This IGV session is not valid XML.')
  const root = xml.documentElement
  if (!root || !['Session', 'Global'].includes(root.localName)) throw new Error('Expected an IGV <Session> XML document.')
  const genome = root.getAttribute('genome')?.trim()
  if (!genome) throw new Error('This IGV session does not name a reference genome.')
  const notes: string[] = []
  const tracks: IgvTrack[] = []
  for (const panel of [...root.getElementsByTagName('Panel')]) {
    const panelName = panel.getAttribute('name') ?? 'IGV panel'
    for (const element of [...panel.children]) {
      if (element.localName !== 'Track') continue
      const dataRange = [...element.children].find((child) => child.localName === 'DataRange')
      tracks.push({
        id: element.getAttribute('id') ?? '', attributes: attributesOf(element),
        dataRange: dataRange ? attributesOf(dataRange) : undefined,
        order: tracks.length, panel: panelName,
      })
    }
  }
  const resources = [...root.getElementsByTagName('Resource')].map((element, index): IgvResource => {
    const path = element.getAttribute('path')?.trim() ?? ''
    const matches = tracks.filter((track) => nativeFilePathKey(track.id) === nativeFilePathKey(path))
    const track = matches.find((candidate) => candidate.attributes.clazz?.endsWith('AlignmentTrack')) ?? matches[0]
    if (matches.length > 1 && !matches.every((candidate) => /(?:Alignment|Coverage|SpliceJunction)Track$/.test(candidate.attributes.clazz ?? ''))) {
      notes.push(`${fileName(path)} has multiple IGV track entries; one source row will be imported.`)
    }
    return {
      key: `resource-${index}`, path, index: element.getAttribute('index') ?? undefined,
      type: element.getAttribute('type') ?? undefined, track,
      order: track?.order ?? tracks.length + index,
    }
  }).sort((a, b) => a.order - b.order)
  const resourceIds = new Set(resources.map((resource) => nativeFilePathKey(resource.path)))
  const extraTracks = tracks.filter((track) => track.id && !resourceIds.has(nativeFilePathKey(track.id)) && !/(?:Sequence|Coverage|SpliceJunction)Track$/.test(track.attributes.clazz ?? ''))
  if (extraTracks.length) notes.push(`${extraTracks.length} IGV panel track${extraTracks.length === 1 ? '' : 's'} without a matching file resource cannot be imported.`)
  if (tracks.some((track) => /SpliceJunctionTrack$/.test(track.attributes.clazz ?? ''))) notes.push('IGV splice-junction subtracks are not reproduced.')
  if (tracks.some((track) => /CoverageTrack$/.test(track.attributes.clazz ?? ''))) notes.push('IGV coverage subtrack settings are not reproduced; GeRAFE shows BAM coverage with its own controls.')
  if ([...root.getElementsByTagName('Panel')].length > 2) notes.push('IGV has more than two panels; GeRAFE will place imported data tracks in its upper pane.')
  const regions = [...root.getElementsByTagName('Region')].flatMap((element) => {
    const start = Number(element.getAttribute('start'))
    const end = Number(element.getAttribute('end'))
    const chr = element.getAttribute('chromosome') ?? ''
    return chr && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start
      ? [{ chr, start, end, label: element.getAttribute('description') ?? undefined }] : []
  })
  return { genome, locus: root.getAttribute('locus') ?? undefined, version: root.getAttribute('version') ?? undefined, resources, regions, notes }
}

export function resolveIgvPath(path: string, sessionPath: string): string {
  const value = path.trim()
  if (!value) return ''
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const decoded = decodeURIComponent(url.pathname)
      return url.hostname ? `\\\\${url.hostname}${decoded.replaceAll('/', '\\')}` : decoded.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\')
    } catch { return value }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value
  if (/^[A-Za-z]:[\\/]|^\\\\|^\//.test(value)) return value.replaceAll('/', '\\')
  const parent = sessionPath.replace(/[\\/][^\\/]*$/, '')
  const combined = `${parent}\\${value.replaceAll('/', '\\')}`
  const prefix = /^([A-Za-z]:|\\\\[^\\]+\\[^\\]+)/.exec(combined)?.[0] ?? ''
  const remainder = combined.slice(prefix.length).split('\\')
  const parts: string[] = []
  for (const part of remainder) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${prefix}\\${parts.join('\\')}`
}

export function isRemoteIgvPath(path: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) && !/^file:\/\//i.test(path)
}

export function igvBamIndexCandidates(path: string): string[] {
  const base = path.replace(/\.bam$/i, '')
  return [`${path}.bai`, `${base}.bai`, `${path}.csi`, `${base}.csi`]
}

export function igvPathsToCheck(session: IgvSession, sessionPath: string, overrides: ReadonlyMap<string, { path?: string; index?: string }> = new Map(), capabilityForPath: (path: string) => IgvSourceCapability | undefined): string[] {
  const paths = new Map<string, string>()
  for (const resource of session.resources) {
    const path = resolveIgvPath(overrides.get(resource.key)?.path ?? resource.path, sessionPath)
    const capability = capabilityForPath(path)
    if (!capability || isRemoteIgvPath(path)) continue
    paths.set(nativeFilePathKey(path), path)
    if (capability.format === 'bam') {
      const explicit = overrides.get(resource.key)?.index ?? resource.index
      for (const index of explicit ? [resolveIgvPath(explicit, sessionPath)] : igvBamIndexCandidates(path)) {
        if (!isRemoteIgvPath(index)) paths.set(nativeFilePathKey(index), index)
      }
    }
  }
  return [...paths.values()]
}

export function previewIgvSession(session: IgvSession, options: IgvPreviewOptions): IgvPreview {
  const matchingReference = [...options.references.keys()].find((id) => id.toLowerCase() === session.genome.toLowerCase())
  const referenceId = options.selectedReferenceId && options.references.has(options.selectedReferenceId) ? options.selectedReferenceId : matchingReference
  const chromosomes = referenceId ? options.references.get(referenceId) : undefined
  const region = chromosomes && session.locus ? parseLocus(session.locus, chromosomes) : undefined
  const items = session.resources.map((resource): IgvPreviewItem => {
    const path = resolveIgvPath(options.overrides?.get(resource.key)?.path ?? resource.path, options.sessionPath)
    const capability = options.capabilityForPath(path)
    const ignoredSettings = ignoredIgvSettings(resource.track, capability)
    const basic = { resource, path, capability, ignoredSettings }
    if (!path || !capability || isRemoteIgvPath(path)) return { ...basic, status: 'unsupported', reason: isRemoteIgvPath(path) ? 'Remote URLs are not supported by native import.' : 'GeRAFE cannot open this file format.' }
    if (!referenceId) return { ...basic, status: 'needs-reference', reason: `Add or choose a reference for ${session.genome}.` }
    const fileCheck = options.files.get(nativeFilePathKey(path))
    if (fileCheck === undefined) return { ...basic, status: 'checking' }
    if (fileCheck === null) return { ...basic, status: 'missing', reason: 'Saved path is not available. Relink this file.' }
    if (capability.format !== 'bam') return { ...basic, source: fileCheck, status: 'ready' }
    const explicit = options.overrides?.get(resource.key)?.index ?? resource.index
    const candidates = explicit ? [resolveIgvPath(explicit, options.sessionPath)] : igvBamIndexCandidates(path)
    const indexPath = candidates.find((candidate) => options.files.get(nativeFilePathKey(candidate)))
    const index = indexPath ? options.files.get(nativeFilePathKey(indexPath)) ?? undefined : undefined
    if (index) return { ...basic, source: fileCheck, index, indexPath, status: 'ready' }
    if (candidates.some((candidate) => !options.files.has(nativeFilePathKey(candidate)))) return { ...basic, source: fileCheck, status: 'checking' }
    return { ...basic, source: fileCheck, status: 'missing-index', reason: 'BAM index is not available. Relink the BAM with its .bai/.csi index.' }
  })
  const importedRegions = chromosomes ? session.regions.filter((candidate) => Boolean(resolveChromosome(candidate.chr, chromosomes))).length : 0
  const notes = [...session.notes]
  if (!referenceId) notes.push(`Reference ${session.genome} is not installed in GeRAFE. Add it first, or explicitly choose another assembly.`)
  else if (referenceId.toLowerCase() !== session.genome.toLowerCase()) notes.push(`Using ${referenceId} for IGV genome ${session.genome}; verify that the assemblies and chromosome coordinates match.`)
  if (session.locus && !region && chromosomes) notes.push(`IGV locus “${session.locus}” cannot be restored; GeRAFE will use its default view.`)
  if (session.regions.length > importedRegions) notes.push(`${session.regions.length - importedRegions} IGV region${session.regions.length - importedRegions === 1 ? '' : 's'} use chromosomes absent from the selected reference.`)
  return { referenceId, referenceOverride: Boolean(referenceId && referenceId.toLowerCase() !== session.genome.toLowerCase()), region, items, importedRegions, notes }
}

export function buildIgvTrackDocument(preview: IgvPreview, session: IgvSession, chromosomes: ReadonlyMap<string, number>, fallbackRegion: Region): TrackDocument {
  if (!preview.referenceId) throw new Error('Choose a reference before importing this IGV session.')
  const draft = createTrackDocument(preview.referenceId, preview.region ?? fallbackRegion)
  const autoscaleGroups = new Map<string, string[]>()
  for (const item of preview.items) {
    if (item.status !== 'ready' || !item.source || !item.capability) continue
    const { resource, capability, source, index } = item
    const style = resource.track?.attributes ?? {}
    const label = style.name || fileName(source.path)
    const color = igvColor(style.color)
    const sourceSpec: TrackSourceSpec = {
      id: crypto.randomUUID(), name: source.name, format: capability.format,
      files: [
        { name: source.name, path: source.path, size: source.size, lastModified: source.lastModified, role: 'signal' },
        ...(index ? [{ name: index.name, path: index.path, size: index.size, lastModified: index.lastModified, role: 'index' as const }] : []),
      ],
    }
    const options = { label, color }
    const track = capability.kind === 'signal' ? addSignalTrack(draft, sourceSpec, { ...options, autoPair: false })
      : capability.kind === 'interval' ? addIntervalTrack(draft, sourceSpec, options)
        : capability.kind === 'interaction' ? addInteractionTrack(draft, sourceSpec, options)
          : capability.kind === 'matrix' ? addMatrixTrack(draft, sourceSpec, options)
            : addAlignmentTrack(draft, sourceSpec, options)
    applyIgvTrackStyle(draft, track, resource.track)
    if (capability.kind === 'signal' && style.autoscaleGroup) {
      autoscaleGroups.set(style.autoscaleGroup, [...autoscaleGroups.get(style.autoscaleGroup) ?? [], track.id])
    }
  }
  for (const ids of autoscaleGroups.values()) if (ids.length > 1) linkScales(draft, ids)
  for (const candidate of session.regions) {
    const chr = resolveChromosome(candidate.chr, chromosomes)
    if (!chr) continue
    const length = chromosomes.get(chr)!
    if (candidate.start >= length) continue
    const region = clampRegion({ chr, start: candidate.start, end: Math.min(candidate.end, length) }, length)
    draft.savedRegions.push({ id: crypto.randomUUID(), label: candidate.label || `${chr}:${candidate.start + 1}-${candidate.end}`, region, color: '#e9af44', highlighted: true, boundaryStyle: 'solid', fill: true, shadeOpacity: 0.16 })
  }
  return draft
}

function attributesOf(element: Element): Record<string, string> {
  return Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]))
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path
}

function igvColor(value?: string): string | undefined {
  if (!value) return
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const rgb = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/.exec(value)
  if (!rgb) return
  const values = rgb.slice(1).map(Number)
  if (values.some((part) => part > 255)) return
  return `#${values.map((part) => part.toString(16).padStart(2, '0')).join('')}`
}

function ignoredIgvSettings(track: IgvTrack | undefined, capability: IgvSourceCapability | undefined): string[] {
  if (!track) return []
  const mapped = new Set(MAPPED_TRACK_ATTRIBUTES)
  if (capability?.kind !== 'signal') mapped.delete('autoScale')
  if (capability?.kind !== 'signal') mapped.delete('autoscaleGroup')
  if (!['interval', 'alignment'].includes(capability?.kind ?? '') || !['collapsed', 'expanded', 'squished'].includes(track.attributes.displayMode?.toLowerCase() ?? '')) mapped.delete('displayMode')
  if (capability?.kind !== 'signal' || !['BAR_CHART', 'LINE_CHART'].includes(track.attributes.renderer ?? '')) mapped.delete('renderer')
  if (capability?.kind !== 'signal') mapped.delete('altColor')
  if (capability?.kind !== 'interaction' || !['up', 'down'].includes(track.attributes.direction?.toLowerCase() ?? '')) mapped.delete('direction')
  const ignored = Object.keys(track.attributes).filter((attribute) => !mapped.has(attribute))
  if (track.dataRange) ignored.push(...Object.keys(track.dataRange).filter((attribute) => capability?.kind !== 'signal' || track.attributes.autoScale?.toLowerCase() !== 'false' || !MAPPED_RANGE_ATTRIBUTES.has(attribute)).map((attribute) => `DataRange.${attribute}`))
  return ignored
}

function applyIgvTrackStyle(draft: TrackDocument, track: TrackSpec, igvTrack?: IgvTrack): void {
  if (!igvTrack) return
  const style = igvTrack.attributes
  if (style.visible?.toLowerCase() === 'false') track.enabled = false
  const height = Number(style.height)
  if (Number.isFinite(height) && height >= 20) track.manualPixelHeight = Math.min(4_000, Math.round(height))
  const displayMode = style.displayMode?.toLowerCase()
  if (track.kind === 'interval' && ['collapsed', 'expanded', 'squished'].includes(displayMode)) track.intervalDisplayMode = displayMode as TrackSpec['intervalDisplayMode']
  if (track.kind === 'alignment' && ['collapsed', 'expanded', 'squished'].includes(displayMode)) track.alignmentDisplayMode = displayMode as TrackSpec['alignmentDisplayMode']
  if (track.kind === 'interaction' && ['up', 'down'].includes(style.direction?.toLowerCase())) track.interactionDirection = style.direction.toLowerCase() as 'up' | 'down'
  if (track.kind === 'signal') {
    if (style.renderer === 'BAR_CHART') track.signalRenderStyle = 'bar'
    else if (style.renderer === 'LINE_CHART') track.signalRenderStyle = 'line'
    const altColor = igvColor(style.altColor)
    if (altColor) track.negativeColor = altColor
    const range = igvTrack.dataRange
    const min = Number(range?.minimum)
    const max = Number(range?.maximum)
    if (style.autoScale?.toLowerCase() === 'false' && range && Number.isFinite(min) && Number.isFinite(max) && max > min) {
      const scale = draft.scales.find((candidate) => candidate.id === track.scaleBindingId)
      if (scale) { scale.mode = 'fixed'; scale.limits = { min, max }; scale.includeZero = min <= 0 && max >= 0 }
    }
  }
}
