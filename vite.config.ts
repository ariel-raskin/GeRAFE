import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig({
  clearScreen: false,
  publicDir: 'static',
  define: { __GERAFE_VERSION__: JSON.stringify(packageVersion) },
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Cloud-sync clients can briefly hold generated reference files open. Overwrite
  // the deterministic build in place instead of failing while trying to empty it.
  build: { target: 'es2022', outDir: 'app-dist', emptyOutDir: false },
})
