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
  const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.goto(url, { waitUntil: 'networkidle' })
  const seed = async (ids = ['a', 'b', 'c', 'd', 'e'], groups = [['a', 'b', 'c']], collapsed = false) => {
    await page.evaluate(async ({ ids, groups, collapsed }) => {
      const { createTrackDocument, addSignalTrack, assignDisplayGroup } = await import('/src/track-document.ts')
      const doc = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 10000 })
      for (const id of ids) {
        const track = addSignalTrack(doc, { id: `s-${id}`, name: `Track ${id}`, format: 'bigwig', files: [] }, { id, autoPair: false })
        track.manualPixelHeight = 80
      }
      groups.forEach((members, index) => assignDisplayGroup(doc, members, `Group ${index + 1}`))
      if (collapsed) { doc.groups[0].signalStackMode = 'collapsed'; doc.groups[0].signalStackHiddenTrackIds = ['a'] }
      localStorage.setItem('gerafe-auto-fit-upper-tracks', 'false')
      localStorage.setItem('gerafe-theme', 'light')
      localStorage.setItem('gerafe-track-document', JSON.stringify(doc))
    }, { ids, groups, collapsed })
    await page.reload({ waitUntil: 'networkidle' }); await settled()
  }
  const point = (id, group = false) => page.evaluate(({ id, group }) => {
    const doc = JSON.parse(localStorage.getItem('gerafe-track-document'))
    const seen = new Set()
    const rows = doc.tracks.filter((track) => {
      if (!track.enabled || track.pane !== 'main') return false
      const stack = doc.groups.find((item) => item.id === track.displayGroupId && item.signalStackMode === 'collapsed')
      if (!stack) return true
      if (stack.signalStackHiddenTrackIds?.includes(track.id) || seen.has(stack.id)) return false
      seen.add(stack.id); return true
    })
    const box = document.querySelector('#genome-canvas').getBoundingClientRect()
    const index = rows.findIndex((row) => row.id === id)
    if (index < 0) throw new Error(`Missing visible row ${id}`)
    return { x: box.left + (group ? 10 : 60), y: box.top + index * 80 + 40 }
  }, { id, group })
  const order = () => page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.filter((track) => track.pane === 'main').map((track) => track.id))
  const start = async (id, group = false) => {
    const source = await point(id, group)
    await page.mouse.move(source.x, source.y); await page.mouse.down()
    await page.mouse.move(source.x + 7, source.y); await settled()
    assert(await page.locator('.track-drag-ghost').isVisible())
  }
  const drop = async (y, guideY, expected, cancel = false) => {
    const box = await page.locator('#genome-canvas').boundingBox()
    await page.mouse.move(box.x + 60, box.y + y, { steps: 6 }); await settled()
    const pixel = await page.locator('#genome-canvas').evaluate((canvas, y) => [...canvas.getContext('2d').getImageData(canvas.width - 6, Math.max(1, y), 1, 1).data], guideY)
    assert.deepEqual(pixel.slice(0, 3), [104, 78, 224], `Drop guide must appear at the eventual row top ${guideY}.`)
    if (cancel) await page.locator('#genome-canvas').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' })
    await page.mouse.up(); await settled()
    await page.waitForFunction((expected) => JSON.stringify(JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.filter((track) => track.pane === 'main').map((track) => track.id)) === JSON.stringify(expected), expected)
    assert.deepEqual(await order(), expected)
    assert(await page.locator('.track-drag-ghost').isHidden())
  }

  await seed(); await start('a'); await drop(60, 80, ['b', 'a', 'c', 'd', 'e'])
  await start('c'); await drop(20, 0, ['c', 'b', 'a', 'd', 'e'])
  await start('c'); await drop(150, 160, ['b', 'a', 'c', 'd', 'e'])
  await seed(['a', 'b', 'c', 'd', 'e'], []); await start('d'); await drop(300, 320, ['a', 'b', 'c', 'e', 'd'])
  await start('d'); await drop(260, 240, ['a', 'b', 'c', 'd', 'e'])
  await seed(); await start('a', true); await drop(60, 80, ['d', 'a', 'b', 'c', 'e'])
  await seed(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['c', 'd']]); await start('a', true); await drop(100, 160, ['c', 'd', 'a', 'b', 'e'])
  await seed(['a', 'b', 'c', 'd', 'e'], [['a', 'b', 'c']], true); await start('e'); await drop(20, 0, ['e', 'a', 'b', 'c', 'd'])
  await seed(); await start('a'); await drop(60, 80, ['a', 'b', 'c', 'd', 'e'], true)

  // A group member can move to the other pane and detach from the source group.
  await seed(); await start('b')
  const bottom = await page.locator('#bottom-canvas').boundingBox()
  await page.mouse.move(bottom.x + 60, bottom.y + 15, { steps: 6 }); await page.mouse.up(); await settled()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.find((track) => track.id === 'b').pane === 'bottom')
  assert.deepEqual(await page.evaluate(() => {
    const track = JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.find((track) => track.id === 'b')
    return { pane: track.pane, group: track.displayGroupId ?? null }
  }), { pane: 'bottom', group: null })

  // The pointer can reach lower off-screen destinations without dropping the track.
  await seed(Array.from({ length: 16 }, (_, i) => `t${i}`), [])
  await start('t0')
  const viewport = await page.locator('#main-track-scroll').boundingBox()
  await page.mouse.move(viewport.x + 60, viewport.y + viewport.height - 5, { steps: 6 })
  await page.waitForFunction(() => document.querySelector('#main-track-scroll').scrollTop > 180)
  await page.mouse.up(); await settled()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gerafe-track-document')).tracks.filter((track) => track.pane === 'main').findIndex((track) => track.id === 't0') > 7)
  assert((await order()).indexOf('t0') > 7, 'Dragging near the lower edge should reach later tracks.')

  // Sample opaque buffers after ResizeObserver layout changes, before the next paint.
  await seed(['a', 'b', 'c'], [])
  await page.evaluate(() => {
    window.__resizeSamples = []
    const observer = new ResizeObserver(() => {
      const colors = ['#genome-header', '#genome-canvas', '#bottom-canvas'].map((selector) => {
        const canvas = document.querySelector(selector)
        return [...canvas.getContext('2d').getImageData(1, 1, 1, 1).data].slice(0, 3)
      })
      window.__resizeSamples.push(colors)
    })
    observer.observe(document.querySelector('#main-track-scroll'))
    observer.observe(document.querySelector('#bottom-track-scroll'))
    window.__resizeObserver = observer
  })
  const resizer = await page.locator('#pane-resizer').boundingBox()
  const origin = { x: resizer.x + resizer.width / 2, y: resizer.y + 5 }
  await page.mouse.move(origin.x, origin.y); await page.mouse.down()
  for (const delta of [-50, -100, -160, -220, -100, -40, -180, -70]) {
    await page.mouse.move(origin.x, origin.y + delta, { steps: 3 }); await settled()
  }
  await page.screenshot({ path: 'dist/smoke-live-pane-resize.png', fullPage: true })
  await page.mouse.up(); await settled()
  const samples = await page.evaluate(() => { window.__resizeObserver.disconnect(); return window.__resizeSamples })
  assert(samples.length >= 8, 'Resize should exercise multiple layout/paint frames.')
  assert(!samples.some((colors) => colors.some((color) => color.every((channel) => channel === 0))), `A canvas was presented black while resizing: ${JSON.stringify(samples)}`)
  assert.equal(await page.locator('#bottom-pane').evaluate((element) => element.classList.contains('is-resizing')), false)
  assert.deepEqual(errors, [])
  console.log('Viewer editing passed: adjacent/group/tail/stack/cross-pane drops, exact preview guides, cancellation, edge scrolling, and painted canvases throughout pane resizing.')
} finally { await browser.close() }
