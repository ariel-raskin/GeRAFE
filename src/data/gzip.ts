import { ungzip } from 'pako-esm2'

export async function gzipText(read: () => Promise<ArrayBuffer | Uint8Array>): Promise<string> {
  const bytes = await read()
  return new TextDecoder().decode(ungzip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), undefined))
}
