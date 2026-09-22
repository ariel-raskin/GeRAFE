export const STORAGE_KEYS = {
  theme: 'gerafe-theme',
  reference: 'gerafe-default-reference',
  customReferences: 'gerafe-custom-references',
  workspace: 'gerafe-track-document',
  workspacePath: 'gerafe-workspace-path',
  workspaceDirectory: 'gerafe-workspace-directory',
  tssIndicators: 'gerafe-show-tss-indicators',
  strandedAutoLink: 'gerafe-auto-link-stranded-signals',
  groupAutoscale: 'gerafe-autoscale-visual-groups',
  strandedAutoColors: 'gerafe-auto-color-stranded-signals',
  upperPaneAutoFit: 'gerafe-auto-fit-upper-tracks',
  interactionGuideSeen: 'gerafe-interaction-guide-seen',
  matrixInspector: 'gerafe-matrix-inspector',
  matrixInspectorValue: 'gerafe-matrix-inspector-value',
  matrixInspectorBins: 'gerafe-matrix-inspector-bins',
  matrixInspectorDetails: 'gerafe-matrix-inspector-details',
  matrixLegend: 'gerafe-matrix-color-scale',
  inputHistory: 'gerafe-input-history',
} as const

export const LEGACY_STORAGE_KEYS = {
  theme: 'locus-glide-theme',
  reference: 'locus-glide-default-reference',
  customReferences: 'locus-glide-custom-references',
  workspace: 'locus-glide-track-document',
  workspacePath: 'locus-glide-workspace-path',
  workspaceDirectory: 'locus-glide-workspace-directory',
  tssIndicators: 'locus-glide-show-tss-indicators',
  strandedAutoLink: 'locus-glide-auto-link-stranded-signals',
  groupAutoscale: 'locus-glide-autoscale-visual-groups',
  strandedAutoColors: 'locus-glide-auto-color-stranded-signals',
  upperPaneAutoFit: 'locus-glide-auto-fit-upper-tracks',
  interactionGuideSeen: 'locus-glide-interaction-guide-seen',
  matrixInspector: 'locus-glide-matrix-inspector',
  matrixInspectorValue: 'locus-glide-matrix-inspector-value',
  matrixInspectorBins: 'locus-glide-matrix-inspector-bins',
  matrixInspectorDetails: 'locus-glide-matrix-inspector-details',
  matrixLegend: 'locus-glide-matrix-color-scale',
  inputHistory: 'locus-glide-input-history',
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
