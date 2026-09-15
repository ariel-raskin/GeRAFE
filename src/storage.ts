export const STORAGE_KEYS = {
  theme: 'gerafe-theme',
  reference: 'gerafe-default-reference',
  customReferences: 'gerafe-custom-references',
  workspace: 'gerafe-track-document',
  tssIndicators: 'gerafe-show-tss-indicators',
  strandedAutoLink: 'gerafe-auto-link-stranded-signals',
} as const

export const LEGACY_STORAGE_KEYS = {
  theme: 'locus-glide-theme',
  reference: 'locus-glide-default-reference',
  customReferences: 'locus-glide-custom-references',
  workspace: 'locus-glide-track-document',
  tssIndicators: 'locus-glide-show-tss-indicators',
  strandedAutoLink: 'locus-glide-auto-link-stranded-signals',
} as const

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function migrateLegacyStorage(storage: StorageLike): void {
  for (const name of Object.keys(STORAGE_KEYS) as (keyof typeof STORAGE_KEYS)[]) {
    const currentKey = STORAGE_KEYS[name]
    if (storage.getItem(currentKey) !== null) continue
    const legacyValue = storage.getItem(LEGACY_STORAGE_KEYS[name])
    if (legacyValue !== null) storage.setItem(currentKey, legacyValue)
  }
}
