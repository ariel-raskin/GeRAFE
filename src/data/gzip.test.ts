import { gzip } from 'pako-esm2'
import { describe, expect, it } from 'vitest'
import { gzipText } from './gzip.ts'

describe('gzip text', () => {
  it('decodes compressed UTF-8 text', async () => {
    const compressed = gzip(new TextEncoder().encode('chr1\t0\t10\t2\n'), undefined)
    await expect(gzipText(async () => compressed)).resolves.toBe('chr1\t0\t10\t2\n')
  })
})
