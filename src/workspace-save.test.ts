import { describe, expect, it } from 'vitest'
import { workspaceDirectory, workspaceFileName, workspaceSaveDefaultPath } from './workspace-save.ts'

describe('workspace save paths', () => {
  it('uses a clear, portable default workspace file name', () => {
    expect(workspaceFileName('hg38')).toBe('gerafe-hg38.gerafe.json')
    expect(workspaceFileName('Custom reference (v2)')).toBe('gerafe-Custom-reference-v2.gerafe.json')
  })

  it('retains the parent directory for Windows and POSIX workspace paths', () => {
    expect(workspaceDirectory('C:\\Figures\\example.gerafe.json')).toBe('C:\\Figures\\')
    expect(workspaceDirectory('/home/ariel/Figures/example.gerafe.json')).toBe('/home/ariel/Figures/')
    expect(workspaceDirectory('example.gerafe.json')).toBeUndefined()
  })

  it('starts Save As in the remembered directory', () => {
    expect(workspaceSaveDefaultPath('C:\\Figures\\', 'gerafe-hg38.gerafe.json'))
      .toBe('C:\\Figures\\gerafe-hg38.gerafe.json')
    expect(workspaceSaveDefaultPath('/home/ariel/Figures', 'gerafe-hg38.gerafe.json'))
      .toBe('/home/ariel/Figures/gerafe-hg38.gerafe.json')
  })
})
