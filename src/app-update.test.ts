import { describe, expect, it, vi } from 'vitest'
import { AppUpdateController, updateProgressPercent } from './app-update.ts'
import type { AppUpdateBackend, AppUpdateCandidate } from './app-update.ts'

function candidate(overrides: Partial<AppUpdateCandidate> = {}): AppUpdateCandidate {
  return {
    currentVersion: '0.1.1',
    version: '0.1.2',
    body: 'Improved update support.',
    downloadAndInstall: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

function backend(result: AppUpdateCandidate | null): AppUpdateBackend {
  return {
    check: vi.fn(async () => result),
    relaunch: vi.fn(async () => undefined),
  }
}

describe('AppUpdateController', () => {
  it('reports that the installed version is current when no update exists', async () => {
    const controller = new AppUpdateController(backend(null), '0.1.1')
    await controller.check()
    expect(controller.state).toMatchObject({ phase: 'current', currentVersion: '0.1.1' })
  })

  it('retains available update metadata', async () => {
    const update = candidate()
    const controller = new AppUpdateController(backend(update), '0.1.1')
    await controller.check()
    expect(controller.state).toMatchObject({ phase: 'available', candidate: update })
  })

  it('persists work before installing and reports download progress', async () => {
    const update = candidate({
      downloadAndInstall: vi.fn(async (onEvent) => {
        onEvent?.({ event: 'Started', data: { contentLength: 100 } })
        onEvent?.({ event: 'Progress', data: { chunkLength: 40 } })
        onEvent?.({ event: 'Progress', data: { chunkLength: 60 } })
        onEvent?.({ event: 'Finished' })
      }),
    })
    const updateBackend = backend(update)
    const beforeInstall = vi.fn()
    const controller = new AppUpdateController(updateBackend, '0.1.1')
    const observed: number[] = []
    controller.subscribe((state) => {
      if (state.phase === 'downloading') observed.push(updateProgressPercent(state) ?? -1)
    })

    await controller.check()
    await controller.install(beforeInstall)

    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(update.downloadAndInstall).toHaveBeenCalledOnce()
    expect(observed).toContain(40)
    expect(observed).toContain(100)
    expect(updateBackend.relaunch).toHaveBeenCalledOnce()
    expect(controller.state.phase).toBe('restarting')
  })

  it('turns check failures into a nontechnical retry message', async () => {
    const updateBackend: AppUpdateBackend = {
      check: vi.fn(async () => { throw new Error('network detail') }),
      relaunch: vi.fn(async () => undefined),
    }
    const controller = new AppUpdateController(updateBackend, '0.1.1')
    await controller.check()
    expect(controller.state.phase).toBe('error')
    expect(controller.state.error).toContain('try again')
    expect(controller.state.error).not.toContain('network detail')
  })
})
