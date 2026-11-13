/** Figure-only settings shared by validation, the inspector, and the SVG renderer. */
export interface AppearanceField {
  label: string
  group: string
  value: string | number | boolean
  min?: number
  max?: number
  step?: number | 'any'
  options?: readonly string[]
  kind?: 'color' | 'text'
  tracks?: readonly string[]
}
const num = (label: string, group: string, value: number, min = 0, max = 100, step: number | 'any' = 'any'): AppearanceField & { value: number } => ({ label, group, value, min, max, step })
const color = (label: string, group: string, value: string): AppearanceField & { value: string } => ({ label, group, value, kind: 'color' })
const select = (label: string, group: string, value: string, options: string[]): AppearanceField & { value: string } => ({ label, group, value, options })
const flag = (label: string, group: string, value: boolean): AppearanceField & { value: boolean } => ({ label, group, value })

export const pageFields = {
  titleSizePt: num('Figure title (pt; 0 = automatic)', 'Typography', 0, 0, 60),
  titleHeightMm: num('Title area (mm)', 'Typography', 12),
  headingSizePt: num('Column heading (pt; 0 = automatic)', 'Typography', 0, 0, 60),
  headingHeightMm: num('Heading area (mm)', 'Typography', 8),
  headingColor: color('Heading color', 'Typography', '#111111'),
  headingWeight: select('Heading weight', 'Typography', '700', ['400', '500', '600', '700']),
  rulerStyle: select('Ruler style', 'Ruler', 'ticks', ['ticks', 'endpoints', 'none']),
  rulerUnits: select('Coordinate units', 'Ruler', 'Mb', ['Mb', 'kb', 'bp']),
  rulerDecimals: num('Coordinate decimals', 'Ruler', 3, 0, 8, 1),
  rulerFontPt: num('Coordinates (pt; 0 = automatic)', 'Ruler', 0, 0, 40),
  chromosomeFontPt: num('Chromosome (pt; 0 = automatic)', 'Ruler', 0, 0, 40),
  showChromosome: flag('Show chromosome', 'Ruler', true),
  rulerColor: color('Ruler and coordinate color', 'Ruler', '#475467'),
  rulerBackground: color('Ruler background', 'Ruler', '#f1f2f4'),
  shadeRuler: flag('Shade ruler background', 'Ruler', false),
  rulerLinePt: num('Ruler line (pt)', 'Ruler', 0.55, 0, 4),
  scaleBarBp: num('Scale bar (bp; 0 = automatic)', 'Ruler', 0, 0, 1e9, 1),
  scaleBarFontPt: num('Scale bar label (pt; 0 = automatic)', 'Ruler', 0, 0, 40),
  rulerGapMm: num('Gap below ruler (mm)', 'Ruler', 2, 0, 30),
} satisfies Record<string, AppearanceField>

export const rowFields = {
  labelOrientation: select('Label orientation', 'Labels and bracket', 'horizontal', ['horizontal', 'vertical']),
  labelWeight: select('Label weight', 'Labels and bracket', '600', ['400', '500', '600', '700']),
  labelOffsetXmm: num('Label X offset (mm)', 'Labels and bracket', 0, -100, 100),
  labelOffsetYmm: num('Label Y offset (mm)', 'Labels and bracket', 0, -100, 100),
  labelGapMm: num('Label distance from plot (mm)', 'Labels and bracket', 2, 0, 100),
  groupFontPt: num('Group label (pt; 0 = automatic)', 'Labels and bracket', 0, 0, 40),
  groupColor: color('Group label / bracket color', 'Labels and bracket', '#111111'),
  groupLabelXmm: num('Group label X from margin (mm)', 'Labels and bracket', 5, -100, 100),
  groupBracketXmm: num('Bracket X from margin (mm)', 'Labels and bracket', 7, -100, 100),
  groupLinePt: num('Bracket width (pt; 0 = hide)', 'Labels and bracket', 0.55, 0, 8),
  background: color('Plot background', 'Plot and axes', '#ffffff'),
  paddingMm: num('Vertical plot padding (mm)', 'Plot and axes', 0, 0, 20),
  showAnnotations: flag('Show region / divider annotations', 'Plot and axes', true),
  showRegions: flag('Show saved region shading / boundaries', 'Plot and axes', true),
  showDividers: flag('Show divider lines', 'Plot and axes', true),
  showOutlines: flag('Show matrix outlines', 'Plot and axes', true),
  segmentedScales: flag('Scale each divider section separately', 'Plot and axes', false),
  scaleFontPt: num('Scale values (pt)', 'Plot and axes', 5.4, 1, 40),
  scaleColor: color('Scale value color', 'Plot and axes', '#222222'),
  scaleLabelBackground: flag('Background behind scale values', 'Plot and axes', false),
  scaleBackgroundColor: color('Scale label background color', 'Plot and axes', '#ffffff'),
  scalePrecision: num('Scale significant digits', 'Plot and axes', 3, 1, 10, 1),
  scaleInsetMm: num('Scale label inset (mm)', 'Plot and axes', 0.8, 0, 20),
  baselineColor: color('Zero line color', 'Plot and axes', '#555555'),
  baselineWidthPt: num('Zero line width (pt; 0 = hide)', 'Plot and axes', 0.4, 0, 8),
} satisfies Record<string, AppearanceField>

export const cellFields = {
  lineWidthPt: { ...num('Signal line width (pt)', 'Signal', 0.8, 0.05, 8), tracks: ['signal', 'stranded'] },
  positiveFraction: { ...num('Positive strand height (%)', 'Signal', 50, 5, 95, 1), tracks: ['stranded'] },
  geneNames: { label: 'Genes to include (comma separated; blank = all)', group: 'Gene models', value: '', kind: 'text', tracks: ['genes'] },
  geneMode: { ...select('Gene display', 'Gene models', 'source', ['source', 'collapsed', 'expanded', 'squished']), tracks: ['genes'] },
  geneTranscripts: { ...select('Transcripts', 'Gene models', 'source', ['source', 'canonical', 'all']), tracks: ['genes'] },
  geneLabels: { ...flag('Show gene names', 'Gene models', true), tracks: ['genes'] },
  geneFontPt: { ...num('Gene name (pt; 0 = automatic)', 'Gene models', 0, 0, 40), tracks: ['genes'] },
  geneLabelColor: { ...color('Gene name color', 'Gene models', '#1f2937'), tracks: ['genes'] },
  geneItalic: { ...flag('Italic gene names', 'Gene models', false), tracks: ['genes'] },
  geneLabelPosition: { ...select('Gene name position', 'Gene models', 'below', ['below', 'above']), tracks: ['genes'] },
  exonHeightMm: { ...num('Exon height (mm)', 'Gene models', 1, 0.1, 10), tracks: ['genes'] },
  cdsHeightMm: { ...num('CDS height (mm)', 'Gene models', 1.6, 0.1, 10), tracks: ['genes'] },
  intronWidthPt: { ...num('Intron line (pt)', 'Gene models', 0.5, 0.05, 8), tracks: ['genes'] },
  arrowSizeMm: { ...num('Strand arrow size (mm; 0 = hide)', 'Gene models', 0.7, 0, 5), tracks: ['genes'] },
  geneLaneMm: { ...num('Transcript spacing (mm; 0 = automatic)', 'Gene models', 0, 0, 20), tracks: ['genes'] },
  geneLabelGapMm: { ...num('Gene name gap (mm)', 'Gene models', 0.6, 0, 10), tracks: ['genes'] },
  geneTopMm: { ...num('Gene top offset (mm)', 'Gene models', 1.6, 0, 20), tracks: ['genes'] },
  arcWidthPt: { ...num('Arc line (pt; 0 = source)', 'Interactions', 0, 0, 8), tracks: ['interaction'] },
  arcHeight: { ...num('Arc height multiplier', 'Interactions', 1, 0.1, 3), tracks: ['interaction'] },
  arcMaxDistanceBp: { ...num('Maximum distance (bp; 0 = source)', 'Interactions', 0, 0, 1e9, 1), tracks: ['interaction'] },
  arcMaxFeatures: { ...num('Maximum interactions (0 = source)', 'Interactions', 0, 0, 10000, 1), tracks: ['interaction'] },
  arcDirection: { ...select('Arc direction', 'Interactions', 'source', ['source', 'up', 'down']), tracks: ['interaction'] },
  arcGeometry: { ...select('Arc geometry', 'Interactions', 'line', ['line', 'ribbon']), tracks: ['interaction'] },
  arcGenes: { label: 'Focus genes (comma separated; blank = source filter)', group: 'Interactions', value: '', kind: 'text', tracks: ['interaction'] },
  matrixTransform: { ...select('Value transform', 'Contact matrix', 'source', ['source', 'linear', 'log1p']), tracks: ['matrix'] },
  matrixResolutionBp: { ...num('Resolution (bp; 0 = source)', 'Contact matrix', 0, 0, 1e8, 1), tracks: ['matrix'] },
  matrixNormalization: { label: 'Normalization (blank = source; raw = unnormalized)', group: 'Contact matrix', value: '', kind: 'text', tracks: ['matrix'] },
  matrixDirection: { ...select('Triangle direction', 'Contact matrix', 'source', ['source', 'up', 'down']), tracks: ['matrix'] },
  matrixMaxDistanceBp: { ...num('Triangle depth (bp; 0 = source)', 'Contact matrix', 0, 0, 1e9, 1), tracks: ['matrix'] },
  matrixColors: { label: 'Custom palette (comma separated hex colors)', group: 'Contact matrix', value: '', kind: 'text', tracks: ['matrix'] },
  matrixReverse: { ...select('Palette direction', 'Contact matrix', 'source', ['source', 'forward', 'reverse']), tracks: ['matrix'] },
  matrixLegend: { ...select('Color legend', 'Contact matrix', 'inline', ['inline', 'right', 'last-column', 'none']), tracks: ['matrix'] },
  legendWidthMm: { ...num('Legend bar width (mm)', 'Contact matrix', 1.2, 0.2, 10), tracks: ['matrix'] },
  legendGapMm: { ...num('Legend gap (mm)', 'Contact matrix', 1, 0, 20), tracks: ['matrix'] },
  legendFontPt: { ...num('Legend labels (pt)', 'Contact matrix', 5.4, 1, 40), tracks: ['matrix'] },
} satisfies Record<string, AppearanceField>

type Values<T> = { [K in keyof T]: T[K] extends { value: number } ? number : T[K] extends { value: boolean } ? boolean : string }
export type PageAppearance = Values<typeof pageFields>
export type RowAppearance = Values<typeof rowFields>
export type CellAppearance = Values<typeof cellFields>

export function resolveAppearance<T extends Record<string, AppearanceField>>(fields: T, value?: Partial<Values<T>>): Values<T> {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, (value as Record<string, unknown> | undefined)?.[key] ?? field.value])) as Values<T>
}

export function normalizeAppearance<T extends Record<string, AppearanceField>>(fields: T, value: unknown): Partial<Values<T>> {
  if (!value || typeof value !== 'object') return {}
  const output: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    const candidate = (value as Record<string, unknown>)[key]
    if (candidate === undefined) continue
    if (typeof field.value === 'number' && typeof candidate === 'number' && Number.isFinite(candidate)) {
      const bounded = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, candidate))
      output[key] = field.step === 1 ? Math.round(bounded) : bounded
    } else if (typeof field.value === 'boolean' && typeof candidate === 'boolean') output[key] = candidate
    else if (typeof field.value === 'string' && typeof candidate === 'string'
      && (!field.options || field.options.includes(candidate))
      && (field.kind !== 'color' || /^#[0-9a-f]{6}$/i.test(candidate))) output[key] = candidate.slice(0, 2000)
  }
  return output as Partial<Values<T>>
}
