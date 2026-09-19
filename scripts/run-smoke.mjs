import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const port = 5174
const appUrl = `http://127.0.0.1:${port}`
const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const smokePath = fileURLToPath(new URL('./smoke-browser.mjs', import.meta.url))

const vite = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let viteOutput = ''
vite.stdout.on('data', (chunk) => { viteOutput += chunk })
vite.stderr.on('data', (chunk) => { viteOutput += chunk })

async function waitForServer() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Smoke-test Vite server exited early.\n${viteOutput}`)
    try {
      const response = await fetch(appUrl)
      if (response.ok) return
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for smoke-test Vite server at ${appUrl}.\n${viteOutput}`)
}

async function stopVite() {
  if (vite.exitCode !== null || !vite.pid) return
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill', ['/pid', String(vite.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await once(taskkill, 'exit')
  } else vite.kill('SIGTERM')
  await Promise.race([once(vite, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
}

try {
  await waitForServer()
  const smoke = spawn(process.execPath, [smokePath, appUrl, ...process.argv.slice(2)], { stdio: 'inherit' })
  const [code] = await once(smoke, 'exit')
  process.exitCode = code ?? 1
} finally {
  await stopVite()
}
