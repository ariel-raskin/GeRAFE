import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/build-refseq-index.mjs <annotation.gtf> <output.tsv>')
}

const primaryChromosome = /^chr(?:[1-9]|1[0-9]|2[0-2]|X|Y|M)$/
const genes = new Map()
const input = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity })

for await (const line of input) {
  if (!line || line[0] === '#') continue
  const columns = line.split('\t')
  if (columns.length < 9 || columns[2] !== 'transcript' || !primaryChromosome.test(columns[0])) continue
  const geneName = /(?:^|;\s*)gene_name "([^"]+)"/.exec(columns[8])?.[1]
  const geneId = /(?:^|;\s*)gene_id "([^"]+)"/.exec(columns[8])?.[1]
  const name = geneName ?? geneId
  if (!name) continue
  const start = Number(columns[3]) - 1
  const end = Number(columns[4])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue
  const strand = columns[6] === '-' ? '-' : '+'
  const key = `${columns[0]}\t${name}\t${strand}`
  const existing = genes.get(key)
  if (existing) {
    existing.start = Math.min(existing.start, start)
    existing.end = Math.max(existing.end, end)
    existing.transcripts += 1
  } else {
    genes.set(key, { chr: columns[0], start, end, strand, name, id: geneId ?? name, transcripts: 1 })
  }
}

const chromosomeOrder = new Map([
  ...Array.from({ length: 22 }, (_, index) => [`chr${index + 1}`, index]),
  ['chrX', 22], ['chrY', 23], ['chrM', 24],
])
const rows = [...genes.values()].sort((a, b) =>
  (chromosomeOrder.get(a.chr) ?? 99) - (chromosomeOrder.get(b.chr) ?? 99)
  || a.start - b.start
  || a.name.localeCompare(b.name),
)

await mkdir(dirname(outputPath), { recursive: true })
const output = createWriteStream(outputPath)
output.write('#chrom\tstart\tend\tstrand\tgene\tgene_id\ttranscripts\n')
for (const gene of rows) {
  output.write(`${gene.chr}\t${gene.start}\t${gene.end}\t${gene.strand}\t${gene.name}\t${gene.id}\t${gene.transcripts}\n`)
}
await new Promise((resolve, reject) => {
  output.on('error', reject)
  output.end(resolve)
})

console.log(`Wrote ${rows.length.toLocaleString()} genes to ${outputPath}`)
