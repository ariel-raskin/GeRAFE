import { describe, expect, it } from 'vitest'
import { isSupportedPickerFile, joinNativeFolderFile, nativeSaveFileNameError } from './desktop-track-picker.ts'

describe('desktop file browser paths', () => {
  it('keeps track-file filtering specific to supported genomics formats', () => {
    for (const name of ['signal.bw', 'signal.bigWig', 'signal.bedGraph.gz', 'sample.bam', 'sample.bam.bai', 'loops.bedpe', 'map.mcool']) {
      expect(isSupportedPickerFile(name)).toBe(true)
    }
    for (const name of ['notes.txt', 'data.fastq.gz', 'workspace.json', 'sample.bam.tmp']) {
      expect(isSupportedPickerFile(name)).toBe(false)
    }
  })

  it('joins save paths without changing the chosen folder', () => {
    expect(joinNativeFolderFile('C:\\Figures\\', 'study.gerafe.json')).toBe('C:\\Figures\\study.gerafe.json')
    expect(joinNativeFolderFile('/data/figures/', 'study.gerafe.json')).toBe('/data/figures/study.gerafe.json')
  })

  it('rejects names that could escape the folder or fail on Windows', () => {
    for (const name of ['', '..\\elsewhere.json', 'other/path.json', 'CON.json', 'bad?.json', 'name.']) {
      expect(nativeSaveFileNameError(name)).toBeTruthy()
    }
    expect(nativeSaveFileNameError('study.gerafe.json')).toBeUndefined()
  })
})
