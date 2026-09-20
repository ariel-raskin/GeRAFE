import { describe, expect, it } from 'vitest'
import type { MatrixFeature } from '../types.ts'
import { deriveCompartment, deriveInsulation } from './matrix-derived.ts'

const blockMatrix: MatrixFeature = {
  featureType: 'matrix', start: 0, end: 60, resolution: 10, valueMode: 'observed-expected',
  cells: Array.from({ length: 6 }, (_, first) => Array.from({ length: 6 - first }, (_, offset) => ({
    bin1: first * 10, bin2: (first + offset) * 10,
    value: Math.floor(first / 3) === Math.floor((first + offset) / 3) ? 4 : 0,
  }))).flat().filter((cell) => cell.value > 0),
  missingCells: [], maskedBins: [],
}

describe('chromosome-wide derived matrix tracks', () => {
  it('finds a contact-depleted boundary and counts sparse zeros', () => {
    const insulation = deriveInsulation(blockMatrix, 60, 2)
    expect(insulation).toHaveLength(5)
    expect(insulation[2].start).toBe(30)
    expect(insulation[2].score).toBeLessThan(insulation[0].score)
    expect(insulation[2].score).toBeLessThan(-5)
  })

  it('excludes normalization-masked and explicitly missing pairs', () => {
    const insulation = deriveInsulation({ ...blockMatrix, maskedBins: [20], missingCells: [{ bin1: 0, bin2: 30 }] }, 60, 2)
    expect(insulation.some((feature) => feature.start === 20)).toBe(false)
    expect(insulation.every((feature) => Number.isFinite(feature.score))).toBe(true)
  })

  it('assigns opposing PC1 signs to two contact domains and leaves masked bins blank', async () => {
    const compartments = await deriveCompartment(blockMatrix, 60)
    expect(compartments).toHaveLength(6)
    expect(compartments[0].score * compartments[5].score).toBeLessThan(0)
    const masked = await deriveCompartment({ ...blockMatrix, maskedBins: [20] }, 60)
    expect(masked.some((feature) => feature.start === 20)).toBe(false)
  })

  it('bounds compartment memory before constructing a dense chromosome matrix', async () => {
    await expect(deriveCompartment(blockMatrix, 12_010)).rejects.toThrow(/at most 1,200 bins/)
  })
})
