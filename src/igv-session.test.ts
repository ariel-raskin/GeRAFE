import { describe, expect, it } from 'vitest'
import { buildIgvTrackDocument, igvPathsToCheck, previewIgvSession, resolveIgvPath } from './igv-session.ts'
import type { IgvSession, IgvSourceCapability } from './igv-session.ts'
import type { LocalFileDescriptor } from './native-file.ts'
import { hg38 } from './genome.ts'

const descriptor = (path: string): LocalFileDescriptor => ({
  name: path.split('\\').at(-1)!, path, size: 123, lastModified: 100, needsHydration: false,
})
const session: IgvSession = {
  genome: 'hg38', locus: 'chr8:127,700,001-127,800,000', notes: [],
  resources: [
    { key: 'signal', path: 'signal.bw', order: 1, track: { id: 'signal.bw', order: 1, panel: 'DataPanel', attributes: { name: 'Signal A', color: '10,20,30', renderer: 'LINE_CHART', autoScale: 'false', height: '110', autoscaleGroup: 'shared' }, dataRange: { minimum: '0', maximum: '8' } } },
    { key: 'bed', path: 'regions.bed', order: 0, track: { id: 'regions.bed', order: 0, panel: 'FeaturePanel', attributes: { name: 'Regions', visible: 'false' } } },
    { key: 'bam', path: 'reads.bam', order: 2 },
    { key: 'tdf', path: 'tiles.tdf', order: 3 },
    { key: 'unknown', path: 'mystery.foo', order: 4 },
  ],
  regions: [{ chr: 'chr8', start: 127_710_000, end: 127_720_000, label: 'IGV region' }],
}
const sessionPath = 'C:\\Sessions\\example.xml'
const capabilityForPath = (path: string): IgvSourceCapability | undefined => {
  if (path.endsWith('.bw') || path.endsWith('.tdf')) return { kind: 'signal', format: path.endsWith('.bw') ? 'bigwig' : 'tdf' }
  if (path.endsWith('.bed')) return { kind: 'interval', format: 'bed' }
  if (path.endsWith('.bam')) return { kind: 'alignment', format: 'bam' }
}
const references = new Map([['hg38', hg38]])

describe('IGV session import planning', () => {
  it('resolves relative, drive, and file URL source paths', () => {
    expect(resolveIgvPath('..\\Data\\signal.bw', sessionPath)).toBe('C:\\Data\\signal.bw')
    expect(resolveIgvPath('D:\\Data\\signal.bw', sessionPath)).toBe('D:\\Data\\signal.bw')
    expect(resolveIgvPath('file:///C:/Data/signal.bw', sessionPath)).toBe('C:\\Data\\signal.bw')
  })

  it('checks BAM indexes and classifies missing and unsupported resources', () => {
    const paths = igvPathsToCheck(session, sessionPath, new Map(), capabilityForPath)
    expect(paths).toContain('C:\\Sessions\\reads.bam.bai')
    expect(paths).not.toContain('C:\\Sessions\\mystery.foo')
    const files = new Map<string, LocalFileDescriptor | null>([
      ['c:\\sessions\\regions.bed', descriptor('C:\\Sessions\\regions.bed')],
      ['c:\\sessions\\signal.bw', descriptor('C:\\Sessions\\signal.bw')],
      ['c:\\sessions\\reads.bam', descriptor('C:\\Sessions\\reads.bam')],
      ['c:\\sessions\\reads.bam.bai', descriptor('C:\\Sessions\\reads.bam.bai')],
      ['c:\\sessions\\tiles.tdf', null],
    ])
    const preview = previewIgvSession(session, { sessionPath, references, files, capabilityForPath })
    expect(preview.items.map((item) => item.status)).toEqual(['ready', 'ready', 'ready', 'missing', 'unsupported'])
    expect(preview.importedRegions).toBe(1)
    const document = buildIgvTrackDocument(preview, session, hg38, { chr: 'chr8', start: 0, end: 100_000 })
    expect(document.tracks.filter((track) => track.kind !== 'genes').map((track) => track.label)).toEqual(['Signal A', 'Regions', 'reads.bam'])
    const signal = document.tracks.find((track) => track.label === 'Signal A')!
    expect(signal.color).toBe('#0a141e')
    expect(signal.signalRenderStyle).toBe('line')
    expect(signal.manualPixelHeight).toBe(110)
    expect(document.savedRegions[0].label).toBe('IGV region')
  })

  it('re-evaluates installed references and format capabilities at preview time', () => {
    const noReference = previewIgvSession(session, { sessionPath, references: new Map(), files: new Map(), capabilityForPath })
    expect(noReference.items[0].status).toBe('needs-reference')
    const nowSupported = previewIgvSession(session, {
      sessionPath, references, files: new Map([['c:\\sessions\\mystery.foo', descriptor('C:\\Sessions\\mystery.foo')]]),
      capabilityForPath: (path) => path.endsWith('.foo') ? { kind: 'interval', format: 'bed' } : capabilityForPath(path),
    })
    expect(nowSupported.items.at(-1)?.status).toBe('ready')
  })
})
