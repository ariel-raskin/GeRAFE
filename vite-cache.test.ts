import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { viteCacheDirectory } from './vite-cache.ts'

describe('Vite cache directory', () => {
  it('uses the per-user local application directory when available', () => {
    expect(viteCacheDirectory('C:\\Users\\ariel\\AppData\\Local', 'C:\\Temp'))
      .toBe(join('C:\\Users\\ariel\\AppData\\Local', 'GeRAFE', 'vite-cache'))
  })

  it('falls back to the operating system temporary directory', () => {
    expect(viteCacheDirectory('', 'C:\\Temp'))
      .toBe(join('C:\\Temp', 'GeRAFE', 'vite-cache'))
  })
})
