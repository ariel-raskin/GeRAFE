import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'

const appUrl = process.argv[2]
const bamPath = process.argv[3]
const indexPath = process.argv[4]
if (!appUrl || !bamPath || !indexPath) throw new Error('Usage: node scripts/smoke-bam.mjs <app-url> <bam> <bai-or-csi>')
const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
let executablePath
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break } catch { /* continue */ } }
if (!executablePath) throw new Error('Chrome or Edge is required for the BAM smoke test.')

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.goto(appUrl, { waitUntil: 'networkidle' })
await page.locator('#file-input').setInputFiles([bamPath, indexPath])
await page.waitForFunction(() => document.querySelector('#track-status')?.textContent?.includes('1 track loaded'), undefined, { timeout: 30_000 })
await page.locator('#locus-input').fill('chr21:35,000,000-35,010,000')
await page.locator('#locus-form').press('Enter')
await page.waitForTimeout(1_500)
const canvas = page.locator('#genome-canvas')
const box = await canvas.boundingBox()
if (!box) throw new Error('Genome canvas was not visible.')
const before = await canvas.evaluate((element) => element.toDataURL())
await page.mouse.click(box.x + 60, box.y + 70, { button: 'right' })
const menuText = (await page.locator('#track-context-menu').textContent())?.replace(/\s+/g, ' ').trim()
const menuScrollable = await page.locator('#track-context-menu').evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }))
await page.locator('[data-context-action="bam-pairs"]').click()
await page.waitForTimeout(1_500)
const afterPairs = await canvas.evaluate((element) => element.toDataURL())
await page.mouse.click(box.x + 60, box.y + 70, { button: 'right' })
await page.locator('[data-context-action="bam-color-strand"]').click()
await page.waitForTimeout(350)
const afterColor = await canvas.evaluate((element) => element.toDataURL())
const result = await page.evaluate(() => ({
  status: document.querySelector('#track-status')?.textContent,
  features: document.querySelector('#feature-value')?.textContent,
  workspace: JSON.parse(localStorage.getItem('locus-glide-track-document') ?? '{}'),
}))
await page.screenshot({ path: 'dist/smoke-bam.png', fullPage: true })
await browser.close()
console.log(JSON.stringify({ ...result, menuText, menuScrollable, changedForPairs: before !== afterPairs, changedForColor: afterPairs !== afterColor, errors }, null, 2))
const track = result.workspace.tracks?.find((item) => item.kind === 'alignment')
if (!result.status?.includes('1 track loaded') || !track || track.bamViewAsPairs !== true || track.bamColorMode !== 'strand') process.exitCode = 1
if (!menuText?.includes('Coverage and alignments') || !menuText.includes('Include supplementary alignments')) process.exitCode = 1
if (before === afterPairs || afterPairs === afterColor || errors.length) process.exitCode = 1
