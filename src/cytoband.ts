export interface Cytoband {
  chr: string
  start: number
  end: number
  name: string
  stain: string
}

export function parseCytobands(text: string): ReadonlyMap<string, readonly Cytoband[]> {
  const byChromosome = new Map<string, Cytoband[]>()
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.startsWith('#')) continue
    const [chr, startText, endText, name, stain] = rawLine.split('\t')
    const start = Number(startText)
    const end = Number(endText)
    if (!chr || !name || !stain || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const band: Cytoband = { chr, start, end, name, stain }
    const bands = byChromosome.get(chr)
    if (bands) bands.push(band)
    else byChromosome.set(chr, [band])
  }
  for (const bands of byChromosome.values()) bands.sort((a, b) => a.start - b.start)
  return byChromosome
}
