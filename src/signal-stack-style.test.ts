import { describe, expect, it } from 'vitest'
import { signalStackDisplayEntries } from './browser.ts'
import { normalizeStackAppearance, stackAppearance, stackMemberPattern, stackPatternGeometry, svgStackPattern } from './signal-stack-style.ts'
import { addSignalTrack, assignDisplayGroup, collapseSignalStack, createTrackDocument, expandSignalStack, normalizeTrackDocument } from './track-document.ts'

function fixture() {
  const doc = createTrackDocument('hg38', { chr: 'chr1', start: 0, end: 1000 })
  for (const [id, color] of [['a', '#663399'], ['b', '#117744'], ['c', '#bb4400']]) addSignalTrack(doc, { id, name: id, format: 'bedgraph', files: [] }, { id, color })
  assignDisplayGroup(doc, ['a', 'b', 'c'], 'Signals')
  const group = doc.groups[0]
  collapseSignalStack(doc, group.id)
  return { doc, group, members: doc.tracks.filter((track) => track.displayGroupId === group.id) }
}

describe('signal stack appearance', () => {
  it('starts new stacks with same-color transparent patterned fills and preserves styles across collapse', () => {
    const { doc, group, members } = fixture()
    expect(stackAppearance(group, members)).toMatchObject({ colorMode: 'same', renderStyle: 'fill-line', opacity: 30, fillPatterns: 'mixed' })
    group.signalStackOpacity = 42
    group.signalStackAppearance = { ...group.signalStackAppearance, color: '#123456', memberPatterns: { b: 'crosshatch' } }
    expandSignalStack(doc, group.id); collapseSignalStack(doc, group.id)
    const reopened = normalizeTrackDocument(JSON.parse(JSON.stringify(doc)))
    expect(reopened.groups[0]).toMatchObject({ signalStackOpacity: 42, signalStackAppearance: { color: '#123456', memberPatterns: { b: 'crosshatch' } } })
    expect(members.map((member) => member.color)).toEqual(['#663399', '#117744', '#bb4400'])
  })

  it('retains version-33 outline appearances instead of applying new-stack defaults', () => {
    const { doc, group, members } = fixture()
    delete group.signalStackAppearance; delete group.signalStackOpacity
    group.signalStackRenderStyle = 'line'; group.signalStackDifferentiation = 'shades-patterns'
    const reopened = normalizeTrackDocument({ ...doc, schemaVersion: 33 })
    expect(reopened.schemaVersion).toBe(34)
    expect(stackAppearance(reopened.groups[0], members)).toMatchObject({ renderStyle: 'line', colorMode: 'distinct', outlinePatterns: true, fillPatterns: 'none' })
  })

  it('keeps shared color, automatic fill patterns and overrides attached to stable member IDs', () => {
    const { group, members } = fixture()
    group.signalStackAppearance!.memberPatterns = { b: 'vertical' }
    const original = signalStackDisplayEntries(group, members)
    const reordered = [members[2], members[0], members[1]]
    const moved = signalStackDisplayEntries(group, reordered)
    expect(new Set(original.map((entry) => entry.color)).size).toBe(1)
    for (const entry of original) expect(moved.find((item) => item.id === entry.id)).toEqual(entry)
    expect(original.find((entry) => entry.id === 'b')?.pattern).toBe('vertical')
    group.signalStackHiddenTrackIds = ['a']
    const hidden = signalStackDisplayEntries(group, reordered)
    expect(hidden.find((entry) => entry.id === 'c')?.pattern).toBe(original.find((entry) => entry.id === 'c')?.pattern)
    expect(hidden.find((entry) => entry.id === 'a')?.hidden).toBe(true)
  })

  it('makes colors independent from fill schemes and outline dash patterns', () => {
    const { group, members } = fixture()
    Object.assign(group.signalStackAppearance!, { colorMode: 'original', fillPatterns: 'hatches', outlinePatterns: false })
    const original = signalStackDisplayEntries(group, members)
    expect(original.map((entry) => entry.color)).toEqual(members.map((member) => member.color))
    expect(original.every((entry) => entry.dash.length === 0)).toBe(true)
    Object.assign(group.signalStackAppearance!, { colorMode: 'distinct', outlinePatterns: true })
    const distinct = signalStackDisplayEntries(group, members)
    expect(distinct[1].dash.length).toBeGreaterThan(0)
    expect(distinct.map((entry) => entry.pattern)).toEqual(original.map((entry) => entry.pattern))
  })

  it('bounds persisted values and shares distinguishable tile geometry across canvas and SVG', () => {
    expect(normalizeStackAppearance({ color: 'bad', colorMode: 'bad', patternOpacity: 200, patternSpacing: -2, lineWidth: 8, memberPatterns: { a: 'dots', b: 'bad' } })).toMatchObject({ color: undefined, colorMode: undefined, patternOpacity: 100, patternSpacing: 4, lineWidth: 4, memberPatterns: { a: 'dots' } })
    expect(new Set(Array.from({ length: 6 }, (_, index) => stackMemberPattern(index, 'mixed'))).size).toBe(6)
    expect(stackPatternGeometry('dots', 8)).toEqual({ lines: [], dots: [[4, 4, 0.96]] })
    expect(stackPatternGeometry('crosshatch', 8).lines).toHaveLength(6)
    expect(svgStackPattern('pattern', 'dots', 'red" invalid="yes', 8, 1)).toContain('red&quot; invalid=&quot;yes')
  })
})
