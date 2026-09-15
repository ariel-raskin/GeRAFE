import type { DownloadEvent } from '@tauri-apps/plugin-updater'

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'restarting'
  | 'error'

export interface AppUpdateCandidate {
  currentVersion: string
  version: string
  date?: string
  body?: string
  downloadAndInstall(
    onEvent?: (event: DownloadEvent) => void,
    options?: { restartAfterInstall?: boolean },
  ): Promise<void>
  close(): Promise<void>
}

export interface AppUpdateBackend {
  check(): Promise<AppUpdateCandidate | null>
  relaunch(): Promise<void>
}

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  candidate?: AppUpdateCandidate
  downloadedBytes: number
  totalBytes?: number
  error?: string
}

type AppUpdateListener = (state: Readonly<AppUpdateState>) => void

export class AppUpdateController {
  private readonly listeners = new Set<AppUpdateListener>()
  private stateValue: AppUpdateState

  constructor(
    private readonly backend: AppUpdateBackend,
    currentVersion: string,
  ) {
    this.stateValue = {
      phase: 'idle',
      currentVersion,
      downloadedBytes: 0,
    }
  }

  get state(): Readonly<AppUpdateState> {
    return this.stateValue
  }

  subscribe(listener: AppUpdateListener): () => void {
    this.listeners.add(listener)
    listener(this.stateValue)
    return () => this.listeners.delete(listener)
  }

  async check(): Promise<Readonly<AppUpdateState>> {
    if (this.stateValue.phase === 'checking' || this.stateValue.phase === 'downloading' || this.stateValue.phase === 'restarting') {
      return this.stateValue
    }

    const previousCandidate = this.stateValue.candidate
    this.setState({ phase: 'checking', candidate: previousCandidate, downloadedBytes: 0 })
    try {
      const candidate = await this.backend.check()
      if (previousCandidate && previousCandidate !== candidate) void previousCandidate.close().catch(() => undefined)
      this.setState(candidate
        ? { phase: 'available', candidate, downloadedBytes: 0 }
        : { phase: 'current', downloadedBytes: 0 })
    } catch (error) {
      this.setState({
        phase: 'error',
        downloadedBytes: 0,
        error: updateErrorMessage(error),
      })
    }
    return this.stateValue
  }

  async install(beforeInstall: () => void | Promise<void>): Promise<Readonly<AppUpdateState>> {
    const candidate = this.stateValue.candidate
    if (!candidate || this.stateValue.phase === 'downloading' || this.stateValue.phase === 'restarting') return this.stateValue

    this.setState({ phase: 'downloading', candidate, downloadedBytes: 0 })
    try {
      await beforeInstall()
      await candidate.downloadAndInstall((event) => this.handleDownloadEvent(candidate, event), {
        restartAfterInstall: true,
      })
      this.setState({
        phase: 'restarting',
        candidate,
        downloadedBytes: this.stateValue.totalBytes ?? this.stateValue.downloadedBytes,
        totalBytes: this.stateValue.totalBytes,
      })
      // Windows normally exits and restarts from the installer before this line
      // resolves. This handles platforms where installation returns to the app.
      await this.backend.relaunch()
    } catch (error) {
      this.setState({
        phase: 'error',
        candidate,
        downloadedBytes: this.stateValue.downloadedBytes,
        totalBytes: this.stateValue.totalBytes,
        error: updateErrorMessage(error),
      })
    }
    return this.stateValue
  }

  private handleDownloadEvent(candidate: AppUpdateCandidate, event: DownloadEvent): void {
    if (event.event === 'Started') {
      this.setState({
        phase: 'downloading',
        candidate,
        downloadedBytes: 0,
        totalBytes: event.data.contentLength,
      })
      return
    }
    if (event.event === 'Progress') {
      this.setState({
        phase: 'downloading',
        candidate,
        downloadedBytes: this.stateValue.downloadedBytes + event.data.chunkLength,
        totalBytes: this.stateValue.totalBytes,
      })
      return
    }
    this.setState({
      phase: 'downloading',
      candidate,
      downloadedBytes: this.stateValue.totalBytes ?? this.stateValue.downloadedBytes,
      totalBytes: this.stateValue.totalBytes,
    })
  }

  private setState(next: Omit<AppUpdateState, 'currentVersion'>): void {
    this.stateValue = { currentVersion: this.stateValue.currentVersion, ...next }
    for (const listener of this.listeners) listener(this.stateValue)
  }
}

export async function createTauriUpdateBackend(): Promise<AppUpdateBackend> {
  const [{ check }, { relaunch }] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ])
  return {
    check: () => check({ timeout: 15_000 }),
    relaunch,
  }
}

export function updateProgressPercent(state: Readonly<AppUpdateState>): number | undefined {
  if (!state.totalBytes || state.totalBytes <= 0) return undefined
  return Math.min(100, Math.max(0, state.downloadedBytes / state.totalBytes * 100))
}

function updateErrorMessage(error: unknown): string {
  console.error('GeRAFE update failed', error)
  return 'GeRAFE could not reach or validate the update service. Check your internet connection and try again.'
}
