import { BigWig } from '@gmod/bbi'
import { performance } from 'node:perf_hooks'
import { stat } from 'node:fs/promises'

const path = process.argv[2]
if (!path) {
  console.error('Usage: npm run benchmark:data -- "C:\\path\\to\\signal.bw"')
  process.exitCode = 1
} else {
  const reader = new BigWig({ path })
  const headerStart = performance.now()
  const header = await reader.getHeader()
  const headerMs = performance.now() - headerStart
  const references = header.refsByNumber ?? []
  if (references.length === 0) throw new Error('No chromosome references found in the BigWig header')
  const reference = references.find((value) => value.length > 5_000_000) ?? references[0]
  const chr = reference.name
  const chrLength = reference.length
  const span = Math.min(1_000_000, chrLength)
  const start = Math.max(0, Math.floor(chrLength * 0.45))
  const timings = []
  let featureCount = 0

  // Overlapping windows approximate reads triggered by a padded pan cache.
  for (let index = 0; index < 12; index += 1) {
    const windowStart = Math.min(chrLength - span, start + index * Math.floor(span / 4))
    const before = performance.now()
    const features = await reader.getFeatures(chr, windowStart, windowStart + span, { scale: span / 1400 })
    timings.push(performance.now() - before)
    featureCount += features.length
  }

  const sorted = [...timings].sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  console.log(JSON.stringify({
    file: path,
    bytes: (await stat(path)).size,
    chromosome: chr,
    span,
    headerMs: Number(headerMs.toFixed(2)),
    queries: timings.length,
    totalFeatures: featureCount,
    medianQueryMs: Number(percentile(0.5).toFixed(2)),
    p95QueryMs: Number(percentile(0.95).toFixed(2)),
    allQueryMs: timings.map((value) => Number(value.toFixed(2))),
  }, null, 2))
}
