import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'

const appUrl = process.argv[2]
const tdfPath = process.argv[3]
if (!appUrl || !tdfPath) throw new Error('Usage: node scripts/smoke-tdf.mjs <app-url> <tdf-path>')
const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
let executablePath
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break } catch { /* continue */ } }
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => errors.push(error.message))
await page.goto(appUrl, { waitUntil: 'networkidle' })
await page.locator('#file-input').setInputFiles(tdfPath)
await page.waitForTimeout(2000)
const result = await page.evaluate(() => ({
  status: document.querySelector('#track-status')?.textContent,
  toast: document.querySelector('#toast')?.textContent,
  workspace: JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}'),
  features: document.querySelector('#feature-value')?.textContent,
}))
console.log(JSON.stringify({ ...result, errors }, null, 2))
await browser.close()
if (!result.status?.includes('1 track loaded') || result.workspace.sources?.[0]?.format !== 'tdf' || errors.length) process.exitCode = 1
