import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'

const appUrl = process.argv[2] ?? 'http://127.0.0.1:5173'
const bedPath = process.argv[3]
if (!bedPath) throw new Error('Usage: node scripts/smoke-bed.mjs <app-url> <bed-path>')
const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
let executablePath
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break } catch { /* continue */ }
}
if (!executablePath) throw new Error('Chrome or Edge is required.')
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.goto(appUrl, { waitUntil: 'networkidle' })
const emptyCanvas = await page.locator('#genome-canvas').evaluate((canvas) => canvas.toDataURL())
await page.locator('#file-input').setInputFiles(bedPath)
await page.waitForTimeout(1500)
const status = await page.locator('#track-status').textContent()
const track = JSON.parse(await page.evaluate(() => localStorage.getItem('locus-glide-track-document') ?? '{}')).tracks?.find((item) => item.kind === 'interval')
const box = await page.locator('#genome-canvas').boundingBox()
if (!box) throw new Error('Canvas unavailable')
await page.mouse.click(box.x + 60, box.y + 55, { button: 'right' })
const menu = await page.locator('#track-context-menu').textContent()
await page.locator('[data-context-action="interval-expanded"]').click()
const renderedCanvas = await page.locator('#genome-canvas').evaluate((canvas) => canvas.toDataURL())
console.log(JSON.stringify({ status, track, menu: menu?.trim(), canvasChanged: emptyCanvas !== renderedCanvas, errors }, null, 2))
await browser.close()
if (!status?.includes('1 track loaded') || track?.kind !== 'interval' || !menu?.includes('Expanded interval view') || errors.length) process.exitCode = 1
