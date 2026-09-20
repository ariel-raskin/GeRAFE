export const WORKSPACE_FILE_EXTENSION = '.gerafe.json'

export function workspaceFileName(referenceId: string): string {
  const stem = referenceId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'workspace'
  return `gerafe-${stem}${WORKSPACE_FILE_EXTENSION}`
}

export function workspaceDirectory(path: string): string | undefined {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separator < 0) return undefined
  return path.slice(0, separator + 1)
}

export function workspaceSaveDefaultPath(lastDirectory: string | undefined, fileName: string): string {
  if (!lastDirectory) return fileName
  const separator = lastDirectory.includes('\\') ? '\\' : '/'
  return `${lastDirectory.replace(/[\\/]+$/, '')}${separator}${fileName}`
}
