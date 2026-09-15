import { mkdir, writeFile } from 'node:fs/promises'

const source = 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBandIdeo.txt.gz'
const response = await fetch(source)
if (!response.ok || !response.body) throw new Error(`UCSC cytoband download failed: ${response.status}`)
const text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text()
const rows = text.split(/\r?\n/).filter((row) => /^chr(?:[1-9]|1\d|2[0-2]|X|Y)\t/.test(row))
await mkdir(new URL('../static/reference/', import.meta.url), { recursive: true })
await writeFile(new URL('../static/reference/hg38-cytobands.tsv', import.meta.url), `${rows.join('\n')}\n`)
console.log(`Wrote ${rows.length} hg38 cytobands from ${source}`)
