import { describe, expect, it } from 'vitest'
import { nativeFilePathKey, openNativeFiles } from './open-track-files.ts'
import type { TrackSourceSpec, TrackSpec } from './track-document.ts'

const track = (id: string, sourceIds: string[]): TrackSpec => ({
  id, sourceIds, kind: 'signal', label: id, color: '#123456', enabled: true, height: 40, pane: 'main',
})
const source = (id: string, files: TrackSourceSpec['files']): TrackSourceSpec => ({ id, name: id, format: 'bigwig', files })
const file = (path: string | undefined, role: TrackSourceSpec['files'][number]['role'] = 'signal'): TrackSourceSpec['files'][number] => ({
  name: path?.split(/[\\/]/).at(-1) ?? 'browser-only.bw', size: 1, lastModified: 0, path, role,
})

describe('open native track files', () => {
  it('matches complete Windows paths without case or slash differences', () => {
    const open = openNativeFiles({ tracks: [track('one', ['source-one'])], sources: [source('source-one', [file('C:\\Data\\Sample.bw')])] })
    expect(open.get(nativeFilePathKey('c:/data/sample.bw'))).toBe('track')
    expect(open.get(nativeFilePathKey('D:/Data/Sample.bw'))).toBeUndefined()
  })

  it('includes indexes and comparison files but excludes unused and browser-only sources', () => {
    const open = openNativeFiles({
      tracks: [track('one', ['bam', 'comparison'])],
      sources: [
        source('bam', [file('C:\\reads.bam'), file('C:\\reads.bam.bai', 'index')]),
        source('comparison', [file('C:\\a.cool'), file('C:\\b.cool', 'comparison')]),
        source('unused', [file('C:\\unused.bw'), file(undefined)]),
      ],
    })
    expect(open.get(nativeFilePathKey('c:/reads.bam.bai'))).toBe('index')
    expect(open.get(nativeFilePathKey('c:/b.cool'))).toBe('track')
    expect(open.has(nativeFilePathKey('c:/unused.bw'))).toBe(false)
  })

  it('removes the indicator after a track is removed or relinked', () => {
    const tracks = [track('one', ['source-one'])]
    const sources = [source('source-one', [file('C:\\old.bw')])]
    expect(openNativeFiles({ tracks, sources }).has(nativeFilePathKey('C:\\old.bw'))).toBe(true)
    sources[0] = source('source-one', [file('C:\\new.bw')])
    expect(openNativeFiles({ tracks, sources }).has(nativeFilePathKey('C:\\old.bw'))).toBe(false)
    tracks.splice(0)
    expect(openNativeFiles({ tracks, sources }).size).toBe(0)
  })
})
