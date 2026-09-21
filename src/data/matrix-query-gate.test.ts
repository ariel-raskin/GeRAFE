import { describe, expect, it } from 'vitest'
import { MatrixQueryGate } from './matrix.ts'

describe('native matrix query gate', () => {
  it('runs one read at a time and skips an aborted queued request', async () => {
    const gate = new MatrixQueryGate()
    let finishFirst = (): void => undefined
    const first = gate.run(undefined, () => new Promise<number>((resolve) => { finishFirst = () => resolve(1) }))
    await Promise.resolve()
    const staleController = new AbortController()
    let staleRan = false
    const stale = gate.run(staleController.signal, async () => { staleRan = true; return 2 })
    let latestRan = false
    const latest = gate.run(undefined, async () => { latestRan = true; return 3 })
    staleController.abort()

    expect(staleRan).toBe(false)
    expect(latestRan).toBe(false)
    finishFirst()
    await expect(first).resolves.toBe(1)
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
    await expect(latest).resolves.toBe(3)
    expect(staleRan).toBe(false)
    expect(latestRan).toBe(true)
  })
})
