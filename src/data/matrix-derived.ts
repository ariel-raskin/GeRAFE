import type { MatrixFeature, SignalFeature } from '../types.ts'

export type MatrixDerivedMode = 'insulation' | 'compartment'

/** A chromosome-wide diamond, crossing each boundary. Missing/masked pairs are excluded; sparse zeros count. */
export function deriveInsulation(matrix: MatrixFeature, chromosomeLength: number, windowBins: number): SignalFeature[] {
  const resolution = matrix.resolution
  const count = Math.ceil(chromosomeLength / resolution)
  const window = Math.max(2, Math.min(25, Math.round(windowBins)))
  const masked = new Set(matrix.maskedBins.map((value) => Math.floor(value / resolution)))
  const missing = new Set(matrix.missingCells.map((cell) => `${Math.floor(cell.bin1 / resolution)}:${Math.floor(cell.bin2 / resolution)}`))
  const values = new Map(matrix.cells.map((cell) => [`${Math.floor(cell.bin1 / resolution)}:${Math.floor(cell.bin2 / resolution)}`, cell.value]))
  const means: Array<number | undefined> = []
  for (let boundary = 1; boundary < count; boundary += 1) {
    let sum = 0
    let pairs = 0
    for (let first = Math.max(0, boundary - window); first < boundary; first += 1) {
      if (masked.has(first)) continue
      for (let second = boundary; second < Math.min(count, boundary + window); second += 1) {
        if (masked.has(second) || missing.has(`${first}:${second}`)) continue
        sum += values.get(`${first}:${second}`) ?? 0
        pairs += 1
      }
    }
    means[boundary] = pairs ? sum / pairs : undefined
  }
  const positive = means.filter((value): value is number => value !== undefined && value > 0)
  const baseline = positive.length ? positive.reduce((sum, value) => sum + value, 0) / positive.length : 0
  if (!baseline) return []
  const features: SignalFeature[] = []
  for (let boundary = 1; boundary < count; boundary += 1) {
    const mean = means[boundary]
    if (mean === undefined || masked.has(boundary)) continue
    features.push({ start: boundary * resolution, end: Math.min(chromosomeLength, (boundary + 1) * resolution),
      score: Math.max(-10, Math.min(10, Math.log2(Math.max(mean, baseline / 1024) / baseline))) })
  }
  return features
}

/** Principal eigenvector of chromosome-wide row correlations from observed/expected contacts. Its sign is arbitrary. */
export async function deriveCompartment(matrix: MatrixFeature, chromosomeLength: number, signal?: AbortSignal): Promise<SignalFeature[]> {
  const resolution = matrix.resolution
  const count = Math.ceil(chromosomeLength / resolution)
  if (count > 1_200) throw new Error('Compartment analysis needs a coarser resolution (at most 1,200 bins).')
  const excluded = new Set(matrix.maskedBins.map((value) => Math.floor(value / resolution)))
  const rows = Array.from({ length: count }, () => new Float32Array(count))
  for (const cell of matrix.cells) {
    const first = Math.floor(cell.bin1 / resolution)
    const second = Math.floor(cell.bin2 / resolution)
    if (first >= count || second >= count || excluded.has(first) || excluded.has(second)) continue
    rows[first][second] = cell.value
    rows[second][first] = cell.value
  }
  const missing = Array.from({ length: count }, () => new Set<number>())
  for (const cell of matrix.missingCells) {
    const first = Math.floor(cell.bin1 / resolution)
    const second = Math.floor(cell.bin2 / resolution)
    if (first >= count || second >= count) continue
    missing[first].add(second)
    missing[second].add(first)
  }
  const valid = Array.from({ length: count }, (_, index) => !excluded.has(index))
  for (let row = 0; row < count; row += 1) {
    if (!valid[row]) continue
    let sum = 0
    let columns = 0
    for (let column = 0; column < count; column += 1) {
      if (!valid[column] || missing[row].has(column)) continue
      sum += rows[row][column]
      columns += 1
    }
    const mean = columns ? sum / columns : 0
    let squared = 0
    for (let column = 0; column < count; column += 1) {
      if (!valid[column] || missing[row].has(column)) { rows[row][column] = 0; continue }
      rows[row][column] -= mean
      squared += rows[row][column] ** 2
    }
    if (squared < 1e-12) { valid[row] = false; continue }
    const norm = Math.sqrt(squared)
    for (let column = 0; column < count; column += 1) rows[row][column] /= norm
  }
  let vector = new Float64Array(count)
  for (let index = 0; index < count; index += 1) if (valid[index]) vector[index] = Math.sin(index * 12.9898) + 0.37
  for (let iteration = 0; iteration < 40; iteration += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const column = new Float64Array(count)
    for (let row = 0; row < count; row += 1) if (valid[row]) {
      const weight = vector[row]
      for (let index = 0; index < count; index += 1) column[index] += rows[row][index] * weight
    }
    const next = new Float64Array(count)
    for (let row = 0; row < count; row += 1) if (valid[row]) {
      for (let index = 0; index < count; index += 1) next[row] += rows[row][index] * column[index]
    }
    const norm = Math.hypot(...next)
    if (norm < 1e-12) return []
    for (let index = 0; index < count; index += 1) next[index] /= norm
    vector = next
    if (iteration % 4 === 3) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const firstNonzero = vector.find((value) => Math.abs(value) > 1e-7)
  const sign = firstNonzero !== undefined && firstNonzero < 0 ? -1 : 1
  const amplitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0) / Math.max(1, valid.filter(Boolean).length))
  return [...vector].flatMap((value, index) => valid[index] ? [{ start: index * resolution, end: Math.min(chromosomeLength, (index + 1) * resolution), score: sign * value / Math.max(amplitude, 1e-9) }] : [])
}
