import { describe, expect, it } from 'vitest'
import { groupSelection } from './track-selection.ts'

describe('track group selection', () => {
  it('replaces an unrelated selection on a plain group click', () => {
    expect([...groupSelection(new Set(['outside']), ['first', 'second'], false)]).toEqual(['first', 'second'])
  })

  it('adds or removes a group only for an additive click', () => {
    expect([...groupSelection(new Set(['outside']), ['first', 'second'], true)]).toEqual(['outside', 'first', 'second'])
    expect([...groupSelection(new Set(['outside', 'first', 'second']), ['first', 'second'], true)]).toEqual(['outside'])
  })
})
