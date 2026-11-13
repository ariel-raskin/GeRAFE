import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.argv[2] ?? 'http://127.0.0.1:5173'
const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'] : ['/usr/bin/google-chrome', '/usr/bin/chromium']
let executablePath
for (const path of candidates) { try { await access(path); executablePath = path; break } catch {} }
if (!executablePath) throw new Error('Chrome or Edge is required.')
const browser = await chromium.launch({ executablePath, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => { window.__spanCopy = value } } }) })
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document')))
  await page.goto(url, { waitUntil: 'networkidle' })
  const reset = async (grouped = false) => {
    await page.evaluate(async (grouped) => {
      const { createTrackDocument, addSignalTrack, assignDisplayGroup } = await import('/src/track-document.ts')
      const doc = createTrackDocument('hg38', { chr: 'chr1', start: 1000000, end: 1010000 })
      for (const id of grouped ? ['a', 'b', 'c'] : ['a', 'b']) {
        const track = addSignalTrack(doc, { id: `source-${id}`, name: id, format: 'bigwig', files: [] }, { id, autoPair: false })
        track.manualPixelHeight = 100
      }
      if (grouped) assignDisplayGroup(doc, ['a', 'b'], 'Ctrl group')
      localStorage.setItem('gerafe-track-document', JSON.stringify(doc))
      localStorage.setItem('gerafe-auto-fit-upper-tracks', 'false')
    }, grouped)
    await page.reload({ waitUntil: 'networkidle' }); await settle()
  }
  const point = async (selector, fraction, offsetY = 40) => {
    const box = await page.locator(selector).boundingBox()
    return { x: box.x + 176 + (box.width - 176) * fraction, y: box.y + offsetY }
  }
  const cursor = (selector) => page.locator(selector).evaluate((element) => getComputedStyle(element).cursor)
  const spanDrag = async (key, selector = '#genome-header', from = 0.3, to = 0.6) => {
    const a = await point(selector, from), b = await point(selector, to)
    await page.mouse.move(a.x, a.y); await page.keyboard.down(key); await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await page.keyboard.up(key); await settle()
  }
  const context = async (selector = '#genome-canvas', fraction = 0.45) => {
    const p = await point(selector, fraction)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await page.locator('#track-context-menu [data-span-action="create"]').waitFor()
  }

  await reset()
  const header = await point('#genome-header', 0.25)
  await page.mouse.move(header.x, header.y); await page.keyboard.down('Control')
  assert.equal(await cursor('#genome-header'), 'crosshair')
  const toolbar = await page.locator('#region-menu-button').boundingBox()
  await page.mouse.move(toolbar.x + 10, toolbar.y + 10)
  assert(!String(await cursor('#region-menu-button')).includes('crosshair'))
  assert.equal(await page.locator('#genome-header').evaluate((element) => element.classList.contains('is-region-selecting')), false)
  const plot = await point('#genome-canvas', 0.25)
  await page.mouse.move(plot.x, plot.y)
  assert.equal(await cursor('#genome-canvas'), 'crosshair')
  const mainBox = await page.locator('#genome-canvas').boundingBox()
  await page.mouse.move(mainBox.x + 60, mainBox.y + 40)
  assert.equal(await cursor('#genome-canvas'), 'grab', 'Ctrl over a track label must retain the hand.')
  await page.mouse.click(mainBox.x + 60, mainBox.y + 40)
  const beforeLabelDrag = await state()
  await page.mouse.down(); await page.mouse.move(mainBox.x + 68, mainBox.y + 40)
  assert.equal(await cursor('#genome-canvas'), 'grabbing')
  await page.mouse.move(mainBox.x + 60, mainBox.y + 75, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Control')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.filter((track) => track.pane === 'main')[0].id === 'b')
  assert.equal((await state()).comparisonDividers.length, beforeLabelDrag.comparisonDividers.length)
  assert.equal((await state()).savedRegions.length, 0)

  await reset(true)
  const groupBox = await page.locator('#genome-canvas').boundingBox()
  await page.mouse.move(groupBox.x + 10, groupBox.y + 40); await page.keyboard.down('Control')
  assert.equal(await cursor('#genome-canvas'), 'grab')
  await page.mouse.down(); await page.mouse.move(groupBox.x + 17, groupBox.y + 40)
  assert.equal(await cursor('#genome-canvas'), 'grabbing')
  await page.mouse.move(groupBox.x + 10, groupBox.y + 75, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Control')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.filter((track) => track.pane === 'main')[0].id === 'c')
  assert.equal((await state()).comparisonDividers.length, 0)
  assert.equal((await state()).savedRegions.length, 0)

  await reset()
  for (const selector of ['#genome-header', '#genome-canvas', '#bottom-canvas']) {
    const p = await point(selector, 0.2 + 0.15 * (await state()).comparisonDividers.length, selector === '#bottom-canvas' ? 20 : 40)
    const count = (await state()).comparisonDividers.length
    await page.mouse.move(p.x, p.y); await page.keyboard.down('Control')
    await page.mouse.down(); await page.mouse.move(p.x + 1, p.y + 1); await page.mouse.up(); await page.keyboard.up('Control')
    await page.waitForFunction((count) => JSON.parse(localStorage.getItem('gerafe-track-document')).comparisonDividers.length === count + 1, count)
    assert(await page.locator('#action-dialog').isHidden(), 'Ctrl-click should place a divider without a naming dialog.')
  }
  const beforeCtrlDrag = await state()
  await spanDrag('Control', '#genome-header', 0.2, 0.7)
  await page.locator('#action-dialog:not([hidden])').waitFor()
  assert.equal((await state()).comparisonDividers.length, beforeCtrlDrag.comparisonDividers.length)
  await page.locator('#action-dialog-input').fill('Ctrl span')
  await page.locator('#action-dialog-submit').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document')).savedRegions.length === 1)
  assert.deepEqual((await state()).comparisonDividers, beforeCtrlDrag.comparisonDividers, 'Ctrl-drag over an existing divider must select, not move it.')

  await reset()
  const original = await state()
  const p = await point('#genome-header', 0.4)
  await page.mouse.move(p.x, p.y); await page.keyboard.down('Control'); await page.mouse.down()
  await page.keyboard.press('Escape'); await page.mouse.up(); await page.keyboard.up('Control'); await settle()
  assert.deepEqual(await state(), original, 'Cancelling a Ctrl click must not place a divider.')
  await page.mouse.move(p.x, p.y); await page.keyboard.down('Control'); await page.mouse.down()
  await page.locator('#genome-header').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })
  await page.mouse.up(); await page.keyboard.up('Control'); await settle()
  assert.deepEqual(await state(), original)

  await spanDrag('Shift')
  await page.waitForTimeout(220)
  assert.deepEqual(await state(), original, 'Shift selection must not edit persisted state or change the view.')
  assert(await page.locator('#action-dialog').isHidden())
  await context()
  await page.locator('[data-span-action="copy"]').click()
  const copied = await page.evaluate(() => window.__spanCopy)
  const match = /^chr1:(\d+)-(\d+)$/.exec(copied)
  assert(match)
  assert(Math.abs(Number(match[1]) - 1003001) < 10)
  assert(Math.abs(Number(match[2]) - 1006000) < 10)
  await context('#genome-header')
  await page.locator('[data-span-action="copy-bed"]').click()
  assert.equal(await page.evaluate(() => window.__spanCopy), `chr1\t${Number(match[1]) - 1}\t${match[2]}`)
  await context('#bottom-canvas')
  await page.screenshot({ path: 'dist/smoke-selected-span-menu.png', fullPage: true })
  await page.locator('[data-span-action="create"]').click()
  await page.locator('#action-dialog-cancel').click()
  await context()
  await page.locator('[data-span-action="create"]').click()
  await page.locator('#action-dialog-input').fill('Saved from highlight')
  await page.locator('#action-dialog-submit').click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document')).savedRegions.length === 1)
  const saved = (await state()).savedRegions[0]
  assert.equal(saved.region.start, Number(match[1]) - 1)
  assert.equal(saved.region.end, Number(match[2]))
  const middle = await point('#genome-canvas', 0.45)
  await page.mouse.click(middle.x, middle.y, { button: 'right' })
  assert(await page.locator('#track-context-menu').isHidden(), 'Saving the span should remove the temporary selection.')

  await reset()
  await spanDrag('Shift', '#genome-canvas', 0.6, 0.3)
  await context(); await page.locator('[data-span-action="zoom"]').click()
  await page.waitForFunction(() => {
    const region = JSON.parse(localStorage.getItem('gerafe-track-document')).region
    return region.end - region.start < 3100
  })
  await context(); await page.locator('[data-span-action="clear"]').click()
  await page.mouse.click(middle.x, middle.y, { button: 'right' })
  assert(await page.locator('#track-context-menu').isHidden())
  await spanDrag('Shift'); await page.keyboard.press('Escape')
  await page.mouse.click(middle.x, middle.y, { button: 'right' })
  assert(await page.locator('#track-context-menu').isHidden())
  await page.reload({ waitUntil: 'networkidle' })
  await page.mouse.click(middle.x, middle.y, { button: 'right' })
  assert(await page.locator('#track-context-menu').isHidden(), 'Temporary selections must not restore after reload.')
  assert.deepEqual(errors, [])
  console.log('Span gestures passed: scoped plus/hand cursors, Ctrl track dragging, Ctrl click/divider vs drag/region, cancellation, temporary Shift spans, context actions, and non-persistence.')
} finally { await browser.close() }
