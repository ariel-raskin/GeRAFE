import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  publicDir: 'static',
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Dropbox can briefly hold generated reference files open while syncing. Overwrite
  // the deterministic build in place instead of failing while trying to empty it.
  build: { target: 'es2022', outDir: 'app-dist', emptyOutDir: false },
})
