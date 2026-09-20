import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function viteCacheDirectory(localAppData = process.env.LOCALAPPDATA, temporaryDirectory = tmpdir()): string {
  return join(localAppData || temporaryDirectory, 'GeRAFE', 'vite-cache')
}
