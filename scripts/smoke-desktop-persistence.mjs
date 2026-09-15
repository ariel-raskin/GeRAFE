import { chromium } from 'playwright-core'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

const bedPath = process.argv[2]
if (!bedPath) throw new Error('Usage: node scripts/smoke-desktop-persistence.mjs <bed-path>')
const file = await stat(bedPath)
const browser = await chromium.connectOverCDP(process.env.GERAFE_CDP_URL ?? 'http://127.0.0.1:9333')
const context = browser.contexts()[0]
const page = context.pages()[0]
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.waitForSelector('#track-status')
await page.evaluate(({ path, name, size, lastModified }) => {
  localStorage.setItem('locus-glide-track-document', JSON.stringify({
    schemaVersion: 3,
    referenceId: 'hg38',
    region: { chr: 'chr1', start: 0, end: 200000 },
    sources: [{
      id: 'persistence-bed-source',
      name,
      format: 'bed',
      files: [{ name, size, lastModified, role: 'signal', path }],
    }],
    tracks: [
      { id: 'persistence-bed-track', kind: 'interval', sourceIds: ['persistence-bed-source'], label: name, color: '#6d55e0', enabled: true, height: 32, pane: 'main', intervalDisplayMode: 'expanded' },
      { id: 'reference-genes', kind: 'genes', sourceIds: [], label: 'RefSeq genes', color: '#6652c9', enabled: true, height: 32, pane: 'bottom', geneDisplayMode: 'collapsed' },
    ],
    groups: [],
    scales: [],
  }))
}, { path: bedPath, name: basename(bedPath), size: file.size, lastModified: file.mtimeMs })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => document.querySelector('#track-status')?.textContent?.includes('1 track loaded'), undefined, { timeout: 30_000 })
const result = await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}')
  return {
    status: document.querySelector('#track-status')?.textContent,
    path: saved.sources?.[0]?.files?.[0]?.path,
    kind: saved.tracks?.[0]?.kind,
    mode: saved.tracks?.[0]?.intervalDisplayMode,
    migrated: localStorage.getItem('gerafe-track-document') !== null,
  }
})
console.log(JSON.stringify({ ...result, errors }, null, 2))
await browser.close()
if (result.status !== '1 track loaded' || result.path !== bedPath || result.kind !== 'interval' || result.mode !== 'expanded' || !result.migrated || errors.length) process.exitCode = 1
