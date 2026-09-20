import { describe, expect, it } from 'vitest'
import { LEGACY_STORAGE_KEYS, migrateLegacyStorage, STORAGE_KEYS } from './storage.ts'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('GeRAFE storage migration', () => {
  it('copies legacy Locus Glide values to the GeRAFE keys', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_STORAGE_KEYS.workspace, '{"schemaVersion":4}')
    storage.setItem(LEGACY_STORAGE_KEYS.workspacePath, 'C:\\Figures\\saved.gerafe.json')
    storage.setItem(LEGACY_STORAGE_KEYS.workspaceDirectory, 'C:\\Figures\\')
    storage.setItem(LEGACY_STORAGE_KEYS.theme, 'light')
    storage.setItem(LEGACY_STORAGE_KEYS.upperPaneAutoFit, 'true')
    storage.setItem(LEGACY_STORAGE_KEYS.interactionGuideSeen, 'true')

    migrateLegacyStorage(storage)

    expect(storage.getItem(STORAGE_KEYS.workspace)).toBe('{"schemaVersion":4}')
    expect(storage.getItem(STORAGE_KEYS.workspacePath)).toBe('C:\\Figures\\saved.gerafe.json')
    expect(storage.getItem(STORAGE_KEYS.workspaceDirectory)).toBe('C:\\Figures\\')
    expect(storage.getItem(STORAGE_KEYS.theme)).toBe('light')
    expect(storage.getItem(STORAGE_KEYS.upperPaneAutoFit)).toBe('true')
    expect(storage.getItem(STORAGE_KEYS.interactionGuideSeen)).toBe('true')
  })

  it('does not overwrite values already saved by GeRAFE', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_STORAGE_KEYS.theme, 'light')
    storage.setItem(STORAGE_KEYS.theme, 'dark')

    migrateLegacyStorage(storage)

    expect(storage.getItem(STORAGE_KEYS.theme)).toBe('dark')
  })
})
