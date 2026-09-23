import type { TrackDocument } from './track-document.ts'

export type OpenNativeFileRole = 'track' | 'index'

export function nativeFilePathKey(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase()
}

/** Files referenced by tracks in the current workspace, including pending sources. */
export function openNativeFiles(document: Pick<TrackDocument, 'tracks' | 'sources'>): ReadonlyMap<string, OpenNativeFileRole> {
  const usedSourceIds = new Set(document.tracks.flatMap((track) => track.sourceIds))
  const files = new Map<string, OpenNativeFileRole>()
  for (const source of document.sources) {
    if (!usedSourceIds.has(source.id)) continue
    for (const file of source.files) {
      if (!file.path) continue
      const key = nativeFilePathKey(file.path)
      if (file.role !== 'index' || !files.has(key)) files.set(key, file.role === 'index' ? 'index' : 'track')
    }
  }
  return files
}
