import type { MatrixCell, MatrixCellPosition, MatrixFeature } from '../types.ts'

export type MatrixComparisonMode = 'difference' | 'ratio' | 'log2-ratio'

/** Both inputs must use the same genomic bin coordinates and resolution. Omitted sparse pixels are zero. */
export function compareMatrixFeatures(first: MatrixFeature, second: MatrixFeature, mode: MatrixComparisonMode): MatrixFeature {
  if (first.resolution !== second.resolution) throw new Error('Matrix comparison requires matching resolutions.')
  const key = (bin1: number, bin2: number): string => `${bin1}:${bin2}`
  const firstCells = new Map(first.cells.map((cell) => [key(cell.bin1, cell.bin2), cell.value]))
  const secondCells = new Map(second.cells.map((cell) => [key(cell.bin1, cell.bin2), cell.value]))
  const absent = new Set([...first.missingCells, ...second.missingCells].map((cell) => key(cell.bin1, cell.bin2)))
  const masked = new Set([...first.maskedBins, ...second.maskedBins])
  const cells: MatrixCell[] = []
  const missingCells: MatrixCellPosition[] = []
  const all = new Set([...firstCells.keys(), ...secondCells.keys(), ...absent])
  for (const position of all) {
    const [bin1, bin2] = position.split(':').map(Number)
    if (masked.has(bin1) || masked.has(bin2)) continue
    const a = firstCells.get(position) ?? 0
    const b = secondCells.get(position) ?? 0
    if (absent.has(position) || (mode !== 'difference' && b === 0 && a !== 0) || (mode === 'log2-ratio' && (a <= 0 || b <= 0))) {
      missingCells.push({ bin1, bin2 })
      continue
    }
    const value = mode === 'difference' ? a - b : mode === 'ratio' ? b === 0 ? 0 : a / b : Math.log2(a / b)
    if (!Number.isFinite(value)) missingCells.push({ bin1, bin2 })
    else if (value !== 0) cells.push({ bin1, bin2, value })
  }
  return { ...first, cells, missingCells, maskedBins: [...masked].sort((a, b) => a - b) }
}
