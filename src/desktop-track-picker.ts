import { listNativeDirectory, type NativeDirectoryListing } from './native-file.ts'

const LAST_TRACK_FOLDER_KEY = 'gerafe:last-track-folder'

export function isSupportedPickerFile(name: string): boolean {
  return /\.(?:bw|bigwig|bedgraph|bedgraph\.gz|tdf|bam|bai|csi|bed|bedpe|hic|cool|mcool)$/i.test(name)
}

export async function pickNativeTrackPaths(browse: (path?: string) => Promise<NativeDirectoryListing> = listNativeDirectory): Promise<string[] | null> {
  const dialog = document.createElement('div')
  dialog.className = 'track-file-picker'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Open genomics tracks')
  dialog.innerHTML = `
    <div class="track-file-picker-card">
      <header><strong>Open genomics tracks</strong><button type="button" data-action="close" aria-label="Close file browser">×</button></header>
      <div class="track-file-picker-location">
        <button type="button" data-action="up" title="Parent folder">↑ Up</button>
        <input data-role="path" aria-label="Folder path" spellcheck="false" autocomplete="off" />
        <button type="button" data-action="go">Go</button>
      </div>
      <div class="track-file-picker-drives" data-role="drives" aria-label="Drives"></div>
      <input class="track-file-picker-search" data-role="search" aria-label="Filter files and folders" placeholder="Filter this folder…" spellcheck="false" autocomplete="off" />
      <div class="track-file-picker-list" data-role="list" role="listbox" aria-label="Files and folders" aria-multiselectable="true"></div>
      <div class="track-file-picker-summary" data-role="summary"></div>
      <footer><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="open" disabled>Open selected</button></footer>
    </div>`
  document.body.append(dialog)
  const pathInput = dialog.querySelector<HTMLInputElement>('[data-role="path"]')!
  const searchInput = dialog.querySelector<HTMLInputElement>('[data-role="search"]')!
  const list = dialog.querySelector<HTMLElement>('[data-role="list"]')!
  const drives = dialog.querySelector<HTMLElement>('[data-role="drives"]')!
  const summary = dialog.querySelector<HTMLElement>('[data-role="summary"]')!
  const openButton = dialog.querySelector<HTMLButtonElement>('[data-action="open"]')!
  const upButton = dialog.querySelector<HTMLButtonElement>('[data-action="up"]')!
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const selected = new Map<string, string>()
  let listing: NativeDirectoryListing | undefined
  let requestNumber = 0
  let closed = false
  let settle!: (paths: string[] | null) => void
  const result = new Promise<string[] | null>((resolve) => { settle = resolve })

  const finish = (paths: string[] | null): void => {
    if (closed) return
    closed = true
    dialog.remove()
    window.removeEventListener('keydown', onKeyDown, true)
    previousFocus?.focus()
    settle(paths)
  }
  const updateSelection = (): void => {
    openButton.disabled = selected.size === 0
    summary.textContent = selected.size ? `${selected.size} selected: ${[...selected.values()].slice(0, 3).join(', ')}${selected.size > 3 ? ', …' : ''}` : 'Select one or more files; include a BAM index if it is not beside the BAM.'
  }
  const render = (): void => {
    if (!listing) return
    const term = searchInput.value.trim().toLowerCase()
    const entries = listing.entries.filter((entry) => (entry.isDirectory || isSupportedPickerFile(entry.name)) && entry.name.toLowerCase().includes(term))
    list.replaceChildren()
    for (const entry of entries.slice(0, 600)) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `track-file-picker-entry${entry.isDirectory ? ' is-folder' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(!entry.isDirectory && selected.has(entry.path)))
      row.title = entry.path
      const icon = document.createElement('span')
      icon.className = 'track-file-picker-entry-icon'
      icon.textContent = entry.isDirectory ? '▸' : selected.has(entry.path) ? '✓' : '□'
      const name = document.createElement('span')
      name.textContent = entry.name
      row.append(icon, name)
      row.addEventListener('click', () => {
        if (entry.isDirectory) { void navigate(entry.path); return }
        if (selected.has(entry.path)) selected.delete(entry.path)
        else selected.set(entry.path, entry.name)
        const active = selected.has(entry.path)
        row.setAttribute('aria-selected', String(active))
        icon.textContent = active ? '✓' : '□'
        updateSelection()
      })
      row.addEventListener('dblclick', () => {
        if (entry.isDirectory) return
        selected.set(entry.path, entry.name)
        finish([...selected.keys()])
      })
      list.append(row)
    }
    if (!entries.length) list.textContent = 'No matching files or folders.'
    else if (entries.length > 600) {
      const note = document.createElement('small')
      note.textContent = `Showing the first 600 of ${entries.length} matches. Type a filter to narrow this folder.`
      list.append(note)
    }
  }
  const navigate = async (path?: string, fallback = false): Promise<void> => {
    const request = ++requestNumber
    list.textContent = 'Loading folder…'
    try {
      const next = await browse(path)
      if (closed || request !== requestNumber) return
      listing = next
      pathInput.value = next.path
      upButton.disabled = !next.parent
      searchInput.value = ''
      drives.replaceChildren()
      for (const drive of next.drives) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = drive
        button.addEventListener('click', () => void navigate(drive))
        drives.append(button)
      }
      render()
      updateSelection()
      pathInput.focus()
    } catch (error) {
      if (closed || request !== requestNumber) return
      if (fallback) { void navigate(); return }
      list.textContent = error instanceof Error ? error.message : String(error)
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(null)
    } else if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && document.activeElement?.classList.contains('track-file-picker-entry')) {
      const rows = [...list.querySelectorAll<HTMLButtonElement>('.track-file-picker-entry')]
      const index = rows.indexOf(document.activeElement as HTMLButtonElement)
      const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
      if (next) { event.preventDefault(); next.focus() }
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(null) })
  dialog.querySelector('[data-action="close"]')!.addEventListener('click', () => finish(null))
  dialog.querySelector('[data-action="cancel"]')!.addEventListener('click', () => finish(null))
  dialog.querySelector('[data-action="up"]')!.addEventListener('click', () => { if (listing?.parent) void navigate(listing.parent) })
  dialog.querySelector('[data-action="go"]')!.addEventListener('click', () => void navigate(pathInput.value.trim()))
  pathInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') void navigate(pathInput.value.trim()) })
  searchInput.addEventListener('input', render)
  openButton.addEventListener('click', () => {
    if (!selected.size) return
    if (listing) localStorage.setItem(LAST_TRACK_FOLDER_KEY, listing.path)
    finish([...selected.keys()])
  })
  void navigate(localStorage.getItem(LAST_TRACK_FOLDER_KEY) || undefined, true)
  return result
}
