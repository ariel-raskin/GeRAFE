import { describe, expect, it } from 'vitest'
import { cloudProgressPercent } from './cloud-file-progress.ts'

describe('cloud-file progress', () => {
  it('is indeterminate until a positive amount of file data has been read', () => {
    expect(cloudProgressPercent(0, 100)).toBeUndefined()
    expect(cloudProgressPercent(10, 0)).toBeUndefined()
    expect(cloudProgressPercent(Number.NaN, 100)).toBeUndefined()
  })

  it('rounds and bounds the prepared-byte percentage', () => {
    expect(cloudProgressPercent(17, 100)).toBe(17)
    expect(cloudProgressPercent(12, 37)).toBe(32)
    expect(cloudProgressPercent(110, 100)).toBe(100)
  })
})
