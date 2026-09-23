import { describe, expect, it } from 'vitest'
import { startIndependentSourceRestores } from './independent-source-restores.ts'

describe('independent native source restore', () => {
  it('opens a local source while a cloud source remains pending', async () => {
    let releaseCloud: (() => void) | undefined
    const cloud = new Promise<void>((resolve) => { releaseCloud = resolve })
    const opened: string[] = []
    startIndependentSourceRestores(['cloud', 'local'], async (name) => {
      if (name === 'cloud') await cloud
      opened.push(name)
    }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual(['local'])
    releaseCloud!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual(['local', 'cloud'])
  })

  it('contains a failed source without stopping another', async () => {
    const errors: string[] = []
    const opened: string[] = []
    startIndependentSourceRestores(['missing', 'local'], async (name) => {
      if (name === 'missing') throw new Error('unavailable')
      opened.push(name)
    }, (name) => { errors.push(name) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual(['local'])
    expect(errors).toEqual(['missing'])
  })
})
