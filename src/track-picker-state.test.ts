import { describe, expect, it } from 'vitest'
import { folderCrumbs, folderShortcutLabel, parentFolderOfFile, parseSavedTrackFolders } from './track-picker-state.ts'

describe('track picker folder state', () => {
  it('builds clickable Windows and UNC path segments', () => {
    expect(folderCrumbs('C:\\Lab\\Cloud\\sample')).toEqual([
      { label: 'C:\\', path: 'C:\\' },
      { label: 'Lab', path: 'C:\\Lab' },
      { label: 'Cloud', path: 'C:\\Lab\\Cloud' },
      { label: 'sample', path: 'C:\\Lab\\Cloud\\sample' },
    ])
    expect(folderCrumbs('\\\\server\\share\\folder').at(-1)).toEqual({ label: 'folder', path: '\\\\server\\share\\folder' })
    expect(folderCrumbs('/data/tracks')).toEqual([
      { label: '/', path: '/' },
      { label: 'data', path: '/data' },
      { label: 'tracks', path: '/data/tracks' },
    ])
  })

  it('keeps saved folders distinct and derives the folder actually opened', () => {
    expect(parseSavedTrackFolders(JSON.stringify(['C:\\Data', 'c:\\data', 'D:\\Cloud']))).toEqual(['C:\\Data', 'D:\\Cloud'])
    expect(parseSavedTrackFolders('{broken')).toEqual([])
    expect(parentFolderOfFile('D:\\Cloud\\sample.bam')).toBe('D:\\Cloud')
    expect(folderShortcutLabel('D:\\Cloud')).toBe('Cloud')
  })
})
