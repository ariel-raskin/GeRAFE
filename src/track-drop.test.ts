import { describe, expect, it } from 'vitest'
import { trackDropPosition, type DropRow } from './track-drop.ts'
import { addSignalTrack, assignDisplayGroup, createTrackDocument, reorderTracks } from './track-document.ts'

const row = (id: string, displayGroupId?: string, height = 80): DropRow => ({ id, displayGroupId, height })

describe('track drop positions', () => {
  it('uses the lifted-row preview for adjacent downward and upward group moves', () => {
    const rows = [row('a', 'g'), row('b', 'g'), row('c', 'g'), row('d')]
    expect(trackDropPosition(rows, rows, new Set(['a']), 60, 'g')).toEqual({ insertionIndex: 1, guideY: 80 })
    expect(trackDropPosition(rows, rows, new Set(['c']), 100, 'g')).toEqual({ insertionIndex: 1, guideY: 80 })
    expect(trackDropPosition(rows, rows, new Set(['a']), 300, 'g')).toEqual({ insertionIndex: 2, guideY: 160 })
    expect(trackDropPosition(rows, rows, new Set(['c']), -10, 'g')).toEqual({ insertionIndex: 0, guideY: 0 })
  })

  it('keeps whole-group destinations outside other groups', () => {
    const rows = [row('a', 'one'), row('b', 'one'), row('c', 'two'), row('d', 'two'), row('e')]
    expect(trackDropPosition(rows, rows, new Set(['a', 'b']), 70)).toEqual({ insertionIndex: 0, guideY: 0 })
    expect(trackDropPosition(rows, rows, new Set(['a', 'b']), 100)).toEqual({ insertionIndex: 2, guideY: 160 })
    expect(trackDropPosition(rows, rows, new Set(['a', 'b']), 250)).toEqual({ insertionIndex: 3, guideY: 240 })
  })

  it('maps visible destinations to document indexes around disabled tracks and collapsed stacks', () => {
    const all = [row('hidden'), row('a'), row('stack-hidden', 'g'), row('stack-visible', 'g'), row('stack-tail', 'g'), row('last')]
    const visible = [all[1]!, all[3]!, all[5]!]
    expect(trackDropPosition(visible, all, new Set(['last']), 10)).toEqual({ insertionIndex: 1, guideY: 0 })
    expect(trackDropPosition(visible, all, new Set(['last']), 100)).toEqual({ insertionIndex: 2, guideY: 80 })
    expect(trackDropPosition(visible, all, new Set(['a']), 100)).toEqual({ insertionIndex: 4, guideY: 80 })
  })

  it('puts the released track at the displayed slot, including at either end', () => {
    for (const [moving, y, expected] of [['a', 60, ['b', 'a', 'c']], ['c', 10, ['c', 'a', 'b']], ['a', 300, ['b', 'c', 'a']]] as const) {
      const doc = createTrackDocument('test', { chr: 'chr1', start: 0, end: 100 })
      doc.tracks = []
      for (const id of ['a', 'b', 'c']) addSignalTrack(doc, { id: `s-${id}`, name: id, format: 'bigwig', files: [] }, { id, autoPair: false })
      assignDisplayGroup(doc, ['a', 'b', 'c'], 'Group')
      const group = doc.groups[0]!.id
      const rows = doc.tracks.map((track) => row(track.id, group))
      const target = trackDropPosition(rows, doc.tracks, new Set([moving]), y, group)
      reorderTracks(doc, [moving], 'main', target.insertionIndex, group)
      expect(doc.tracks.map((track) => track.id)).toEqual(expected)
      expect(doc.tracks.findIndex((track) => track.id === moving) * 80).toBe(target.guideY)
    }
  })

  it('supports empty destination panes and unequal track heights', () => {
    expect(trackDropPosition([], [], new Set(['moving']), 200)).toEqual({ insertionIndex: 0, guideY: 0 })
    const rows = [row('a', undefined, 30), row('b', undefined, 140), row('c', undefined, 60)]
    expect(trackDropPosition(rows, rows, new Set(['a']), 80)).toEqual({ insertionIndex: 1, guideY: 140 })
  })
})
