import { describe, expect, it } from 'vitest'
import { addInputHistory, matchingInputHistory, parseInputHistory } from './input-history.ts'

describe('typed input history', () => {
  it('offers nothing before typing and only returns matching prior entries', () => {
    const history = { genes: ['RUNX1, MYC', 'TP53', 'RUNX1'] }
    expect(matchingInputHistory(history, 'genes', '')).toEqual([])
    expect(matchingInputHistory(history, 'genes', 'run')).toEqual(['RUNX1, MYC', 'RUNX1'])
    expect(matchingInputHistory(history, 'genes', 'myc')).toEqual(['RUNX1, MYC'])
  })

  it('deduplicates recent values and safely parses malformed storage', () => {
    expect(addInputHistory({ field: ['old', 'VALUE'] }, 'field', ' value ')).toEqual({ field: ['value', 'old'] })
    expect(parseInputHistory('{broken')).toEqual({})
  })
})
