import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const input = resolve(process.argv[2] ?? '../hic_cool_read/hg38.ncbiRefSeq.gtf')
const outputDirectory = resolve(process.argv[3] ?? 'static/reference/refseq')
await mkdir(outputDirectory, { recursive: true })

const header = '#chrom\tstart\tend\tstrand\tgene\tgene_id\ttranscript_id\texons\tcds\n'
const rowsByChromosome = new Map()
let current
let written = 0
const flush = () => {
  if (!current) return
  const exons = current.exons.length ? current.exons.join(',') : `${current.start}-${current.end}`
  const row = [current.chr, current.start, current.end, current.strand, current.gene, current.geneId, current.id, exons, current.cds.join(',')].join('\t') + '\n'
  const rows = rowsByChromosome.get(current.chr) ?? []
  rows.push(row)
  rowsByChromosome.set(current.chr, rows)
  written += 1
}

const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity })
for await (const line of lines) {
  if (!line || line[0] === '#') continue
  const fields = line.split('\t')
  if (fields.length < 9) continue
  const featureType = fields[2]
  if (featureType !== 'transcript' && featureType !== 'exon' && featureType !== 'CDS') continue
  const attributes = fields[8]
  const transcriptId = attribute(attributes, 'transcript_id')
  if (!transcriptId) continue
  if (featureType === 'transcript') {
    flush()
    current = undefined
    if (!/^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)$/.test(fields[0])) continue
    const geneId = attribute(attributes, 'gene_id') || transcriptId
    current = {
      chr: fields[0], start: Number(fields[3]) - 1, end: Number(fields[4]), strand: fields[6] === '-' ? '-' : '+',
      gene: attribute(attributes, 'gene_name') || geneId, geneId, id: transcriptId, exons: [], cds: [],
    }
    continue
  }
  if (!current || current.id !== transcriptId) continue
  const range = `${Number(fields[3]) - 1}-${Number(fields[4])}`
  if (featureType === 'exon') current.exons.push(range)
  else current.cds.push(range)
}
flush()

for (const [chromosome, rows] of rowsByChromosome) {
  const output = resolve(outputDirectory, `hg38-${chromosome}.tsv.gz`)
  await writeFile(output, gzipSync(header + rows.join(''), { level: 9 }))
}
console.log(`Wrote ${written.toLocaleString()} transcripts across ${rowsByChromosome.size} chromosome indexes to ${outputDirectory}`)

function attribute(text, name) {
  return text.match(new RegExp(`(?:^|;\\s*)${name} "([^"]+)"`))?.[1] ?? ''
}
