import { describe, expect, it } from 'vitest'
import { isSupportedPickerFile } from './desktop-track-picker.ts'

describe('desktop track browser filter', () => {
  it('shows supported tracks and BAM indexes', () => {
    for (const name of ['signal.bw', 'signal.bigWig', 'signal.bedGraph.gz', 'sample.bam', 'sample.bam.bai', 'loops.bedpe', 'map.mcool']) {
      expect(isSupportedPickerFile(name)).toBe(true)
    }
  })

  it('does not offer unrelated files or unsupported gzip input', () => {
    for (const name of ['notes.txt', 'data.fastq.gz', 'workspace.json', 'sample.bam.tmp']) {
      expect(isSupportedPickerFile(name)).toBe(false)
    }
  })
})
