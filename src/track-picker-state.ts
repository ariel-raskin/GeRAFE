export const LAST_TRACK_FOLDER_KEY = 'gerafe:last-track-folder'
export const SAVED_TRACK_FOLDERS_KEY = 'gerafe:saved-track-folders'

export interface FolderCrumb { label: string; path: string }

export function parentFolderOfFile(path: string): string | undefined {
  const last = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (last < 0) return undefined
  if (last === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3)
  return last === 0 ? path.slice(0, 1) : path.slice(0, last)
}

export function folderCrumbs(path: string): FolderCrumb[] {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  const normalized = windows ? path.replace(/\//g, '\\') : path
  let root = ''
  let rest = normalized
  if (/^[A-Za-z]:\\/.test(normalized)) { root = normalized.slice(0, 3); rest = normalized.slice(3) }
  else if (normalized.startsWith('\\\\')) {
    const parts = normalized.slice(2).split('\\')
    if (parts.length >= 2) { root = `\\\\${parts[0]}\\${parts[1]}\\`; rest = parts.slice(2).join('\\') }
  } else if (normalized.startsWith('/')) { root = '/'; rest = normalized.slice(1) }
  const crumbs: FolderCrumb[] = root ? [{ label: root, path: root }] : []
  let current = root === '/' ? '' : root.replace(/[\\/]$/, '')
  for (const segment of rest.split(separator).filter(Boolean)) {
    current = current ? `${current}${separator}${segment}` : root === '/' ? `/${segment}` : segment
    crumbs.push({ label: segment, path: current })
  }
  return crumbs
}

export function parseSavedTrackFolders(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.filter((value): value is string => {
      if (typeof value !== 'string' || !value.trim() || seen.has(value.toLowerCase())) return false
      seen.add(value.toLowerCase())
      return true
    }).slice(0, 16)
  } catch { return [] }
}

export function folderShortcutLabel(path: string): string {
  return folderCrumbs(path).at(-1)?.label ?? path
}
