import { invoke, isTauri } from '@tauri-apps/api/core'

type WindowsCursorKind = 'action' | 'resize-x' | 'resize-y'

function cursorValue(url: string, fallback: string, density: number): string {
  return `image-set(url("${url}") ${density.toFixed(2)}x), ${fallback}`
}

async function windowsCursorUrl(kind: WindowsCursorKind): Promise<string> {
  const bytes = await invoke<ArrayBuffer>('windows_cursor_asset', { kind })
  return URL.createObjectURL(new Blob([bytes], { type: 'image/x-icon' }))
}

async function chromiumCursorUrl(fileName: string): Promise<string> {
  const response = await fetch(`/cursors/${fileName}.b64`)
  if (!response.ok) throw new Error(`Could not load ${fileName}`)
  return `data:image/x-icon;base64,${(await response.text()).trim()}`
}

/**
 * WebView2 includes the Windows text-accessibility factor in its rasterization
 * scale. Supplying the standard cursor artwork as a 2x image keeps cursors at
 * their normal visual size without changing the scale of the application UI.
 */
export async function installWindowsCursorScaleCorrection(): Promise<void> {
  if (!isTauri() || !navigator.userAgent.includes('Windows')) return
  try {
    const [action, resizeX, resizeY, grab, grabbing, textScalePercent] = await Promise.all([
      windowsCursorUrl('action'),
      windowsCursorUrl('resize-x'),
      windowsCursorUrl('resize-y'),
      chromiumCursorUrl('chromium-hand-grab.cur'),
      chromiumCursorUrl('chromium-hand-grabbing.cur'),
      invoke<number>('windows_text_scale_percent'),
    ])
    const density = Math.max(1, Math.min(2.25, textScalePercent / 100))
    const style = document.documentElement.style
    style.setProperty('--cursor-action', cursorValue(action, 'pointer', density))
    style.setProperty('--cursor-grab', cursorValue(grab, 'grab', density))
    style.setProperty('--cursor-grabbing', cursorValue(grabbing, 'grabbing', density))
    style.setProperty('--cursor-resize-y', cursorValue(resizeY, 'ns-resize', density))
    style.setProperty('--cursor-resize-x', cursorValue(resizeX, 'ew-resize', density))
  } catch (error) {
    console.warn('Could not apply the Windows cursor scale correction', error)
  }
}
