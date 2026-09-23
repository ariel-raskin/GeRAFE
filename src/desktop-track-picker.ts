import { listNativeDirectory, type NativeDirectoryListing } from './native-file.ts'
import { folderCrumbs, folderShortcutLabel, LAST_TRACK_FOLDER_KEY, parseSavedTrackFolders, SAVED_TRACK_FOLDERS_KEY } from './track-picker-state.ts'

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
      <header><div><small>TRACK FILES</small><strong>Open genomics tracks</strong></div><button class="picker-icon-button" type="button" data-action="close" aria-label="Close file browser">×</button></header>
      <div class="track-file-picker-navigation">
        <div class="track-file-picker-breadcrumbs" data-role="breadcrumbs" aria-label="Current folder path"></div>
        <div class="track-file-picker-location">
          <button class="picker-button" type="button" data-action="up" title="Parent folder">↑ <span>Up</span></button>
          <input data-role="path" aria-label="Folder path" spellcheck="false" autocomplete="off" />
          <button class="picker-button" type="button" data-action="go">Go</button>
        </div>
      </div>
      <div class="track-file-picker-shortcuts">
        <span>Quick folders</span>
        <div class="track-file-picker-drives" data-role="drives" aria-label="Drives"></div>
        <div class="track-file-picker-favorites" data-role="favorites" aria-label="Saved folders"></div>
        <button class="picker-button picker-save-folder" type="button" data-action="save-folder" title="Save this folder as a quick button">☆ Save folder</button>
      </div>
      <div class="track-file-picker-search-row"><input class="track-file-picker-search" data-role="search" aria-label="Filter files and folders" placeholder="Filter files and folders in this location…" spellcheck="false" autocomplete="off" /><small>Choose multiple files before opening</small></div>
      <div class="track-file-picker-list" data-role="list" role="listbox" aria-label="Files and folders" aria-multiselectable="true"></div>
      <div class="track-file-picker-summary" data-role="summary"></div>
      <footer><button class="picker-button" type="button" data-action="cancel">Cancel</button><button class="picker-button picker-button-primary" type="button" data-action="open" disabled>Open selected</button></footer>
    </div>`
  document.body.append(dialog)
  const pathInput = dialog.querySelector<HTMLInputElement>('[data-role="path"]')!
  const searchInput = dialog.querySelector<HTMLInputElement>('[data-role="search"]')!
  const list = dialog.querySelector<HTMLElement>('[data-role="list"]')!
  const drives = dialog.querySelector<HTMLElement>('[data-role="drives"]')!
  const favorites = dialog.querySelector<HTMLElement>('[data-role="favorites"]')!
  const breadcrumbs = dialog.querySelector<HTMLElement>('[data-role="breadcrumbs"]')!
  const saveFolderButton = dialog.querySelector<HTMLButtonElement>('[data-action="save-folder"]')!
  const summary = dialog.querySelector<HTMLElement>('[data-role="summary"]')!
  const openButton = dialog.querySelector<HTMLButtonElement>('[data-action="open"]')!
  const upButton = dialog.querySelector<HTMLButtonElement>('[data-action="up"]')!
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const selected = new Map<string, string>()
  let savedFolders = parseSavedTrackFolders(localStorage.getItem(SAVED_TRACK_FOLDERS_KEY))
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
  const renderFavorites = (): void => {
    favorites.replaceChildren()
    for (const path of savedFolders) {
      const chip = document.createElement('div')
      chip.className = 'track-file-picker-favorite'
      const jump = document.createElement('button')
      jump.type = 'button'
      jump.className = 'picker-chip'
      jump.textContent = folderShortcutLabel(path)
      jump.title = path
      jump.addEventListener('click', () => void navigate(path))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'picker-chip-remove'
      remove.textContent = '×'
      remove.title = `Remove saved folder ${path}`
      remove.setAttribute('aria-label', `Remove saved folder ${path}`)
      remove.addEventListener('click', () => {
        savedFolders = savedFolders.filter((saved) => saved !== path)
        localStorage.setItem(SAVED_TRACK_FOLDERS_KEY, JSON.stringify(savedFolders))
        renderFavorites()
      })
      chip.append(jump, remove)
      favorites.append(chip)
    }
    const currentSaved = Boolean(listing && savedFolders.some((path) => path.toLowerCase() === listing!.path.toLowerCase()))
    saveFolderButton.textContent = currentSaved ? '★ Saved' : '☆ Save folder'
    saveFolderButton.disabled = !listing || currentSaved || savedFolders.length >= 16
  }
  const renderBreadcrumbs = (): void => {
    breadcrumbs.replaceChildren()
    if (!listing) return
    const crumbs = folderCrumbs(listing.path)
    for (const [index, crumb] of crumbs.entries()) {
      if (index) {
        const separator = document.createElement('span')
        separator.className = 'track-file-picker-separator'
        separator.textContent = '›'
        breadcrumbs.append(separator)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'picker-crumb'
      button.textContent = crumb.label
      button.title = crumb.path
      button.disabled = index === crumbs.length - 1
      button.addEventListener('click', () => void navigate(crumb.path))
      breadcrumbs.append(button)
    }
    breadcrumbs.scrollLeft = breadcrumbs.scrollWidth
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
      renderBreadcrumbs()
      drives.replaceChildren()
      for (const drive of next.drives) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'picker-chip'
        button.textContent = drive
        button.addEventListener('click', () => void navigate(drive))
        drives.append(button)
      }
      renderFavorites()
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
  saveFolderButton.addEventListener('click', () => {
    if (!listing || savedFolders.some((path) => path.toLowerCase() === listing!.path.toLowerCase()) || savedFolders.length >= 16) return
    savedFolders.push(listing.path)
    localStorage.setItem(SAVED_TRACK_FOLDERS_KEY, JSON.stringify(savedFolders))
    renderFavorites()
  })
  openButton.addEventListener('click', () => {
    if (!selected.size) return
    finish([...selected.keys()])
  })
  void navigate(localStorage.getItem(LAST_TRACK_FOLDER_KEY) || undefined, true)
  return result
}
