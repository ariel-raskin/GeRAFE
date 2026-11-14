import { chromium } from 'playwright-core'
import { access, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.argv[2] ?? 'http://127.0.0.1:5173'
const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'] : ['/usr/bin/google-chrome', '/usr/bin/chromium']
let executablePath
for (const path of candidates) { try { await access(path); executablePath = path; break } catch {} }
if (!executablePath) throw new Error('Chrome or Edge is required.')
const browser = await chromium.launch({ executablePath, headless: true })
try {
  for (const dpr of [1, 1.25, 2]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: dpr })
    const page = await context.newPage(), errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('gerafe-track-document')))
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const waitState = (predicate, arg) => page.waitForFunction(predicate, arg)
    page.setDefaultTimeout(15000)
    await page.goto(url, { waitUntil: 'networkidle' })
    const stripeCount = await page.evaluate(async () => {
      const { canvasStackPattern } = await import('/src/signal-stack-style.ts')
      const canvas = document.createElement('canvas'), ratio = devicePixelRatio
      canvas.width = 500 * ratio; canvas.height = 10 * ratio
      const paint = canvas.getContext('2d'); paint.scale(ratio, ratio)
      paint.fillStyle = canvasStackPattern(paint, 'vertical', '#000000', 5)
      paint.fillRect(0, 0, 500, 10)
      const pixels = paint.getImageData(0, Math.floor(3 * ratio), canvas.width, 1).data
      let count = 0, inside = false
      for (let index = 3; index < pixels.length; index += 4) {
        const filled = pixels[index] > 40
        if (filled && !inside) count++
        inside = filled
      }
      return count
    })
    assert.equal(stripeCount, 100, 'Pattern spacing must retain CSS dimensions at fractional display scaling.')
    await page.locator('#file-input').setInputFiles([0, 1, 2].map((member) => ({ name: `Replicate-${member + 1}.bedGraph`, mimeType: 'text/plain', buffer: Buffer.from(Array.from({ length: 100 }, (_, bin) => `chr21\t${35000000 + bin * 100}\t${35000100 + bin * 100}\t${(Math.sin(bin / 12 + member) * (10 + member * 3)).toFixed(3)}`).join('\n')) })))
    await waitState(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').tracks?.filter((track) => track.kind === 'signal').length === 3)
    await page.locator('#locus-input').fill('chr21:35000001-35010000')
    await page.locator('#locus-form').evaluate((form) => form.requestSubmit()); await settle()
    await page.locator('#fit-tracks').click(); await page.waitForTimeout(220)
    const canvas = page.locator('#genome-canvas'), box = await canvas.boundingBox()
    await page.mouse.click(box.x + 60, box.y + 20)
    await page.keyboard.down('Shift'); await page.mouse.click(box.x + 60, box.y + box.height * 0.83); await page.keyboard.up('Shift')
    await page.mouse.click(box.x + 60, box.y + 20, { button: 'right' })
    await page.locator('[data-context-submenu="grouping"]').hover()
    await page.locator('[data-context-action="signal-stack-collapse"]').click()
    await waitState(() => JSON.parse(localStorage.getItem('gerafe-track-document') ?? '{}').groups?.some((group) => group.signalStackMode === 'collapsed'))
    console.log(`Signal stacks DPR ${dpr}: imported and collapsed 3 signed bedGraph tracks.`)
    const group = (await state()).groups[0], ids = (await state()).tracks.filter((track) => track.kind === 'signal').map((track) => track.id)
    const open = async () => {
      await page.mouse.click(box.x + 60, box.y + 35, { button: 'right' })
      await page.locator('[data-context-submenu="signal-stack"]').hover()
      await page.locator('[data-context-action="signal-stack-appearance"]').click()
      await page.locator('.signal-stack-menu').waitFor()
    }
    await open()
    assert.equal(await page.locator('.signal-stack-menu').evaluate((element) => element.matches(':modal')), false)
    assert.equal(await page.locator('[data-stack="renderStyle"]').inputValue(), 'fill-line')
    assert.equal(await page.locator('[data-stack="colorMode"]').inputValue(), 'same')
    await page.locator('[data-preset="outlines"]').click()
    assert(await page.locator('[data-stack="opacity"]').isDisabled())
    await page.locator('[data-preset="patterned"]').click()
    const commitRange = async (key, value) => {
      await page.locator(`[data-stack="${key}"]`).evaluate((input, value) => { input.value = String(value) }, value)
      await page.locator(`[data-stack="${key}"]`).dispatchEvent('input')
      await page.locator(`[data-stack="${key}"]`).dispatchEvent('change'); await settle()
    }
    await page.locator('[data-stack="color"]').fill('#2855cc'); await page.locator('[data-stack="color"]').dispatchEvent('change')
    await page.locator('[data-stack="fillPatterns"]').selectOption('none')
    const pixels = () => canvas.evaluate((node) => {
      const width = node.width, height = node.height, ratio = width / node.getBoundingClientRect().width
      const images = window.__stackImages ??= []
      images.push(node.getContext('2d').getImageData(Math.round(190 * ratio), 0, width - Math.round(200 * ratio), height).data)
      return images.length - 1
    })
    const changed = (a, b) => page.evaluate(([a, b]) => {
      const first = window.__stackImages[a], second = window.__stackImages[b]
      let changed = 0
      for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) changed++
      return changed
    }, [a, b])
    await page.locator('[data-stack="renderStyle"]').selectOption('line'); await settle()
    const outlines = await pixels()
    await page.locator('[data-stack="renderStyle"]').selectOption('fill'); await settle()
    const transparent = await pixels()
    assert(await changed(outlines, transparent) > 10000 * dpr, 'Transparent areas must change the plotted area, not only the legend.')
    await commitRange('opacity', 100)
    const opaque = await pixels()
    assert(await changed(transparent, opaque) > 10000 * dpr, 'Opacity must affect overlapping filled data.')
    await commitRange('opacity', 30)
    await page.locator('[data-stack="renderStyle"]').selectOption('fill-line')
    await page.locator('[data-stack="fillPatterns"]').selectOption('mixed')
    await page.locator(`[data-pattern="${ids[1]}"]`).selectOption('crosshatch')
    await settle()
    const patterned = await pixels()
    assert(await changed(transparent, patterned) > 1000 * dpr)
    const styles = () => page.evaluate(async () => {
      const { signalStackDisplayEntries } = await import('/src/browser.ts')
      const state = JSON.parse(localStorage.getItem('gerafe-track-document'))
      return signalStackDisplayEntries(state.groups[0], state.tracks.filter((track) => track.displayGroupId === state.groups[0].id))
    })
    await page.waitForTimeout(200)
    const before = await styles()
    await page.locator(`[data-move="${ids[1]}"][data-delta="-1"]`).click()
    await page.waitForTimeout(200)
    for (const entry of before) assert.deepEqual((await styles()).find((item) => item.id === entry.id), entry)
    await page.locator(`[data-visible="${ids[2]}"]`).uncheck()
    await page.locator('.signal-stack-menu [data-action="undo"]').click()
    assert(await page.locator(`[data-visible="${ids[2]}"]`).isChecked())
    await page.locator('.signal-stack-menu [data-action="redo"]').click()
    assert(!await page.locator(`[data-visible="${ids[2]}"]`).isChecked())
    await page.keyboard.press('Control+z')
    assert(await page.locator(`[data-visible="${ids[2]}"]`).isChecked())
    await page.keyboard.press('Control+Shift+z')
    assert(!await page.locator(`[data-visible="${ids[2]}"]`).isChecked())
    await page.locator(`[data-visible="${ids[1]}"]`).uncheck()
    assert(await page.locator(`[data-visible="${ids[0]}"]`).isDisabled())
    await page.locator(`[data-visible="${ids[1]}"]`).check()
    await page.locator('[data-stack="outlinePatterns"]').check()
    await page.screenshot({ path: `dist/signal-stack-patterns-dpr${dpr}.png` })
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.signal-stack-menu').count(), 0)
    await open(); await page.mouse.click(1300, 1000); assert.equal(await page.locator('.signal-stack-menu').count(), 0)
    await page.waitForTimeout(200)
    const saved = (await state()).groups[0]
    assert.equal(saved.signalStackOpacity, 30)
    assert.equal(saved.signalStackAppearance.memberPatterns[ids[1]], 'crosshatch')
    // A saved figure must export this presentation from real, parsed bedGraph inputs.
    await page.locator('#create-figure').click(); await page.locator('.fe-page [data-stack-fill]').first().waitFor()
    assert.equal(await page.locator('.fe-page [data-stack-fill]').count() > 0, true)
    await page.locator('.fe-sidebar [data-select="row"]').first().click()
    assert.equal(await page.locator('.fe-inspector [data-edit="cell-opacity"]').first().inputValue(), '30')
    assert.equal(await page.locator('.fe-inspector [data-property="lineWidthPt"]').first().inputValue(), '1.3125')
    assert.equal(await page.locator(`.fe-page [data-stack-fill="${ids[2]}"]`).count(), 0)
    const [svgDownload] = await Promise.all([page.waitForEvent('download'), page.locator('.figure-editor [data-action="export-svg"]').click()])
    const svg = await readFile(await svgDownload.path(), 'utf8')
    assert(svg.includes('data-stack-pattern="crosshatch"') && svg.includes('fill="#2855cc" opacity="0.3"'))
    await page.locator('.figure-editor [data-action="export-png"]').click()
    const [pngDownload] = await Promise.all([page.waitForEvent('download'), page.locator('.fe-confirm [value="300"]').click()])
    await writeFile(`dist/signal-stack-export-dpr${dpr}.png`, await readFile(await pngDownload.path()))
    await page.locator('.figure-editor [data-action="back"]').click()
    await page.reload({ waitUntil: 'networkidle' })
    assert.deepEqual((await state()).groups.find((item) => item.id === group.id).signalStackAppearance, saved.signalStackAppearance)
    await open(); assert.equal(await page.locator('[data-stack="opacity"]').inputValue(), '30')
    await page.keyboard.press('Escape')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Signal stacks DPR ${dpr}: parsed signed bedGraph overlaps, opacity, patterns, member order/hide, undo/redo, click-away/Escape, save/reload and FE SVG/PNG passed.`)
  }
} finally { await browser.close() }
