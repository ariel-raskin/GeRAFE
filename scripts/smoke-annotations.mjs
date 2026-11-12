import { chromium } from 'playwright-core'
import { access, readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import assert from 'node:assert/strict'

const appUrl = process.argv[2] ?? 'http://127.0.0.1:5173'
const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'] : ['/usr/bin/google-chrome', '/usr/bin/chromium']
let executablePath
for (const path of candidates) { try { await access(path); executablePath = path; break } catch {} }
if (!executablePath) throw new Error('Chrome or Edge is needed for the annotation smoke test.')
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copiedCoordinates = text } } }) })
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document')))
  const library = async () => { await page.locator('#file-menu-button').click(); await page.locator('#gene-annotations-menu-item').click() }
  const gtf = 'chr21\ttest\texon\t35000001\t35000100\t.\t+\t.\tgene_id "local1"; transcript_id "local-tx"; gene_name "LOCAL1";\n'
  const genePred = '585\tNM_TEST1\tchr21\t+\t36000000\t36000100\t36000010\t36000080\t2\t36000000,36000070,\t36000030,36000100,\t0\tONLINE1\tcmpl\tcmpl\t0,0,\n'
  let downloads = 0
  await page.route('https://hgdownload.soe.ucsc.edu/**', async (route) => { downloads++; await route.fulfill({ status: 200, contentType: 'application/gzip', headers: { 'access-control-allow-origin': '*' }, body: gzipSync(genePred) }) })
  await page.goto(appUrl, { waitUntil: 'networkidle' })
  await library()
  assert.equal(await page.locator('.annotation-library').evaluate((element) => element.matches(':modal')), false)
  await page.mouse.click(1100, 500)
  assert.equal(await page.locator('.annotation-library').count(), 0, 'Clicking outside should dismiss the annotation menu.')
  await library()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.annotation-library').count(), 0, 'Escape should dismiss the annotation menu.')
  await library()
  await page.locator('.annotation-library select').selectOption('mm39')
  assert(await page.locator('.annotation-library [data-add]').first().isDisabled(), 'Adding a mismatched assembly must be disabled.')
  await page.locator('.annotation-library select').selectOption('hg38')
  assert.equal(await page.locator('.annotation-library article').count(), 4)
  await page.screenshot({ path: 'dist/smoke-annotation-library.png', fullPage: true })
  const choosing = page.waitForEvent('filechooser')
  await page.locator('.annotation-library [data-action="import"]').click()
  await (await choosing).setFiles({ name: 'local.gtf', mimeType: 'text/plain', buffer: Buffer.from(gtf) })
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').sources?.some((source) => source.name === 'local.gtf'))
  assert((await state()).tracks.some((track) => track.kind === 'genes' && track.sourceIds.length))
  assert(await page.locator('#empty-workspace').isHidden())
  await page.locator('#locus-input').fill('LOCAL1')
  await page.locator('#locus-form').evaluate((form) => form.requestSubmit())
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').region?.start === 34995000)

  await page.locator('#region-menu-button').click()
  await page.locator('[data-region-action="copy-current"]').click()
  assert.equal(await page.evaluate(() => window.__copiedCoordinates), 'chr21:34995001-35005100')
  await page.locator('#region-menu-button').click()
  await page.locator('[data-region-action="copy-current-bed"]').click()
  assert.equal(await page.evaluate(() => window.__copiedCoordinates), 'chr21\t34995000\t35005100')

  const header = await page.locator('#genome-header').boundingBox()
  await page.keyboard.down('Control')
  await page.mouse.move(header.x + header.width * 0.4, header.y + 40)
  await page.mouse.down(); await page.mouse.move(header.x + header.width * 0.6, header.y + 40, { steps: 4 }); await page.mouse.up()
  await page.keyboard.up('Control')
  await page.locator('#action-dialog-input').fill('Copied region')
  await page.locator('#action-dialog-submit').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').savedRegions?.length === 1)
  await page.locator('#region-menu-button').click()
  await page.locator('#region-menu-popup [data-region-copy]').click()
  const saved = (await state()).savedRegions[0].region
  assert.equal(await page.evaluate(() => window.__copiedCoordinates), `${saved.chr}:${saved.start + 1}-${saved.end}`)

  await library()
  await page.locator('[data-add="hg38-ncbi-refseq"]').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').sources?.some((source) => source.annotationUrl))
  await page.waitForFunction(() => document.querySelector('.annotation-library-status')?.textContent.includes('Added NCBI RefSeq'))
  await page.locator('[data-copy="hg38-ncbi-refseq"]').click()
  assert.match(await page.evaluate(() => window.__copiedCoordinates), /ncbiRefSeq.txt.gz$/)
  const download = page.waitForEvent('download')
  await page.locator('[data-save="hg38-ncbi-refseq"]').click()
  assert.equal((await download).suggestedFilename(), 'hg38.ncbiRefSeq.genepred.gz')
  assert.equal(downloads, 1, 'Save should reuse the cached download.')
  await page.locator('.annotation-library [data-action="close"]').click()

  // Reopening uses the cached public annotation without another network request.
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('#locus-input').fill('ONLINE1')
  await page.locator('#locus-form').evaluate((form) => form.requestSubmit())
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').region?.start === 35995000)
  await page.locator('#create-figure').click()
  await page.locator('.fe-page svg').waitFor()
  // Inspect rendering through the same sources: the browser-only local file needs relinking after reload.
  assert.equal(downloads, 1)
  await page.locator('.figure-editor [data-action="back"]').click()

  // The local annotation is independently relinkable and removable.
  const local = (await state()).tracks.find((track) => track.label === 'local.gtf')
  const point = await page.evaluate((id) => {
    const doc = JSON.parse(localStorage.getItem('gerafe-track-document'))
    const box = document.querySelector('#bottom-canvas').getBoundingClientRect()
    const tracks = doc.tracks.filter((track) => track.enabled && track.pane === 'bottom')
    // Empty/offline and collapsed single-gene tracks have the same minimum height.
    return { x: box.left + 60, y: box.top + tracks.findIndex((track) => track.id === id) * 44 + 20 }
  }, local.id)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  assert(await page.locator('#track-context-menu [data-context-action="remove"]').isVisible())
  const sourceMenu = page.locator('#track-context-menu [data-context-submenu="source"]')
  if (await sourceMenu.count()) await sourceMenu.hover()
  const previousModified = (await state()).sources.find((source) => source.name === 'local.gtf').files[0].lastModified
  await page.locator('[data-context-action="relink"]:visible').click()
  await page.locator('#relink-file-input').setInputFiles({ name: 'local.gtf', mimeType: 'text/plain', buffer: Buffer.from(gtf) })
  await page.waitForFunction((previousModified) => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').sources?.find((source) => source.name === 'local.gtf')?.files[0].lastModified !== previousModified, previousModified)

  // Optional public real-file inputs exercise the exact browser File import route.
  const realFiles = JSON.parse(process.env.GERAFE_SMOKE_ANNOTATION_PATHS ?? '[]')
  for (const path of realFiles) {
    await page.locator('#file-input').setInputFiles(path)
    const name = path.split(/[\\/]/).at(-1)
    await page.waitForFunction((name) => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').sources?.some((source) => source.name === name), name, { timeout: 120_000 })
    console.log(`Real annotation imported: ${name} (${(await readFile(path)).length} bytes)`)
  }
  await page.screenshot({ path: 'dist/smoke-annotation-tracks.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log('Annotation library, assembly guard, local import, online add/save/cache restore, gene search, source relink, Figure Editor handoff, and coordinate copying passed.')
} finally { await browser.close() }
