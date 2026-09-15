import { chromium } from 'playwright-core'

const dataPath = process.argv[2]
if (!dataPath) throw new Error('Usage: node scripts/smoke-desktop.mjs "C:\\path\\track.bw"')

const browser = await chromium.connectOverCDP(process.env.GERAFE_CDP_URL ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages()[0]
const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

await page.waitForSelector('#file-input')
await page.locator('#locus-input').fill('RUNX1')
await page.locator('#locus-form').press('Enter')
await page.waitForFunction(() => document.querySelector('#locus-input')?.value?.startsWith('chr21:'), undefined, { timeout: 30_000 })
const geneLocus = await page.locator('#locus-input').inputValue()
await page.locator('#file-menu-button').click()
const fileMenuVisible = await page.locator('#file-menu-popup').isVisible()
const fileMenuText = await page.locator('#file-menu-popup').textContent()
await page.keyboard.press('Escape')
// Raw CDP lets the desktop WebView open the file from its own machine without
// Playwright trying to transfer a large local genomics file through the socket.
const session = await context.newCDPSession(page)
const { root } = await session.send('DOM.getDocument')
const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' })
await session.send('DOM.setFileInputFiles', { files: [dataPath], nodeId })
await page.waitForFunction(() => document.querySelector('#track-status')?.textContent?.includes('1 track loaded'), undefined, { timeout: 30_000 })
const result = await page.evaluate(() => ({
  url: location.href,
  trackStatus: document.querySelector('#track-status')?.textContent,
  renderMs: document.querySelector('#render-value')?.textContent,
  features: document.querySelector('#feature-value')?.textContent,
  theme: document.documentElement.dataset.theme,
  reference: document.querySelector('#reference-select')?.value,
}))
await page.locator('#theme-toggle').click()
const themeAfterToggle = await page.locator('html').getAttribute('data-theme')
await page.reload({ waitUntil: 'domcontentloaded' })
const themeAfterReload = await page.locator('html').getAttribute('data-theme')
console.log(JSON.stringify({ ...result, geneLocus, fileMenuVisible, fileMenuText: fileMenuText?.trim(), themeAfterToggle, themeAfterReload, errors }, null, 2))
await browser.close()
if (result.theme === themeAfterToggle || themeAfterToggle !== themeAfterReload) process.exitCode = 1
if (result.reference !== 'hg38' || !fileMenuVisible || !fileMenuText?.includes('Open tracks')) process.exitCode = 1
if (errors.length > 0) process.exitCode = 1
