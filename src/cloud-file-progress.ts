export function cloudProgressPercent(bytesRead: number, totalBytes: number): number | undefined {
  if (!Number.isFinite(bytesRead) || !Number.isFinite(totalBytes) || bytesRead <= 0 || totalBytes <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round(bytesRead / totalBytes * 100)))
}
