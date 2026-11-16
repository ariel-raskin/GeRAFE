import { groupFields, resolveAppearance } from './figure-appearance.ts'
import { moveFigureGroup, removeFigureGroup, renameFigureGroup, setFigureRowGroup, type FigureDocument } from './figure-document.ts'
import { openSignalStackMenu } from './signal-stack-menu.ts'
import { stackAppearance, STACK_PATTERNS } from './signal-stack-style.ts'
import { setSignalStackTrackVisible, type TrackDocument } from './track-document.ts'

export type LabelSelection = { kind: 'group'; groupId: string } | { kind: 'member'; rowId: string; trackId: string } | { kind: 'row'; rowId: string }
interface Options {
  root: HTMLElement; current(): FigureDocument
  edit(change: (draft: FigureDocument) => void): void
  select(selection: LabelSelection): void
  previewSource(source: TrackDocument): void
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean
}
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const field = (label: string, key: string, value: string | number, type = 'text') => `<label class="fe-field"><span>${label}</span><input data-label-edit="${key}" type="${type}" value="${esc(String(value))}" ${type === 'number' ? 'step="any"' : ''}/></label>`

export class FigureLabelControls {
  private selectedRows = new Set<string>()
  private lastRow?: string
  private selection?: LabelSelection
  private menu?: HTMLElement
  private dragCleanup?: () => void
  private suppressClick = false
  constructor(private options: Options) {
    options.root.addEventListener('click', (event) => this.click(event), true)
    options.root.addEventListener('contextmenu', (event) => this.context(event))
    options.root.addEventListener('pointerdown', (event) => this.pointer(event))
    options.root.addEventListener('change', (event) => this.change(event))
  }

  renderInspector(selection: LabelSelection): string {
    this.selection = selection
    const doc = this.options.current()
    if (selection.kind === 'group') {
      const group = doc.groups?.find((group) => group.id === selection.groupId)
      if (!group) return '<p>Choose a group or track label.</p>'
      this.selectedRows = new Set(group.rowIds)
      const a = resolveAppearance(groupFields, group.appearance)
      return `<h2>Group label</h2>${field('Group name', 'group-name', group.label)}<p class="fe-help">Drag the vertical label in the preview. The bracket stays aligned to the plotted rows.</p>${Object.entries(groupFields).map(([key, definition]) => typeof definition.value === 'boolean'
        ? `<label class="fe-checkbox"><input type="checkbox" data-label-edit="group-${key}" ${a[key as keyof typeof a] ? 'checked' : ''}/> ${definition.label}</label>`
        : field(definition.label, `group-${key}`, a[key as keyof typeof a] as string | number, definition.kind === 'color' ? 'color' : 'number')).join('')}<div class="fe-inline-actions"><button data-label-action="group-up">Move group up</button><button data-label-action="group-down">Move group down</button><button data-label-action="ungroup">Ungroup rows</button></div><h3>Rows</h3>${doc.rows.filter((row) => group.rowIds.includes(row.id)).map((row) => `<button class="fe-member-select" data-label-row="${esc(row.id)}">${esc(row.label || doc.sourceDocument.tracks.find((track) => track.id === row.trackIds[0])?.label || 'Stack')}</button>`).join('')}`
    }
    if (selection.kind !== 'member') return ''
    const track = doc.sourceDocument.tracks.find((track) => track.id === selection.trackId)
    if (!track) return '<p>Choose a track label.</p>'
    const group = doc.sourceDocument.groups.find((group) => group.id === track.displayGroupId && group.signalStackMode === 'collapsed')
    const a = group ? stackAppearance(group, doc.sourceDocument.tracks.filter((track) => track.displayGroupId === group.id)) : undefined
    const row = doc.rows.find((row) => row.id === selection.rowId)
    const displayedName = row?.trackIds.length === 1 ? row.label : track.label
    return `<h2>Track label</h2>${field('Track name', 'track-name', displayedName)}${field('Track color', 'track-color', track.color, 'color')}<p class="fe-help">These name and color changes belong to this figure. The GeR workspace keeps its own settings.</p>${group && a ? `<label class="fe-checkbox"><input type="checkbox" data-label-edit="track-visible" ${track.enabled && !(group.signalStackHiddenTrackIds ?? []).includes(track.id) ? 'checked' : ''}/> Show member</label>${field('Member opacity (%)', 'member-opacity', a.memberOpacity[track.id] ?? track.signalOpacity ?? 100, 'number')}<label class="fe-field"><span>Fill pattern</span><select data-label-edit="member-pattern"><option value="auto">Automatic</option>${STACK_PATTERNS.map((pattern) => `<option value="${pattern}" ${a.memberPatterns[track.id] === pattern ? 'selected' : ''}>${pattern}</option>`).join('')}</select></label><button data-label-action="stack-appearance">Stack appearance…</button>` : ''}<button data-label-action="row-properties">Row appearance and column assignments</button>`
  }

  highlight(): void {
    for (const node of this.options.root.querySelectorAll<HTMLElement>('[data-fe-row-label], .fe-layer-line [data-select="row"]')) node.classList.toggle('fe-label-selected', this.selectedRows.has(node.dataset.feRowLabel ?? node.dataset.row ?? ''))
  }

  selectRow(rowId: string): void { this.selection = { kind: 'row', rowId }; if (!this.selectedRows.has(rowId)) this.selectedRows = new Set([rowId]) }

  clearSelection(): void { this.selectedRows.clear(); this.selection = undefined; this.highlight() }

  close(): void { this.closeMenu(); this.dragCleanup?.() }

  private pickRow(rowId: string, event: MouseEvent): void {
    const rows = this.options.current().rows.filter((row) => row.included)
    if (event.shiftKey && this.lastRow) {
      const from = rows.findIndex((row) => row.id === this.lastRow), to = rows.findIndex((row) => row.id === rowId)
      for (const row of rows.slice(Math.max(0, Math.min(from, to)), Math.max(from, to) + 1)) this.selectedRows.add(row.id)
    } else if (event.ctrlKey || event.metaKey) { if (this.selectedRows.has(rowId)) this.selectedRows.delete(rowId); else this.selectedRows.add(rowId) }
    else { this.selectedRows = new Set([rowId]); this.lastRow = rowId }
  }

  private click(event: MouseEvent): void {
    const target = event.target as Element
    if (this.suppressClick && target.closest('.fe-page')) { this.suppressClick = false; event.stopImmediatePropagation(); return }
    const action = target.closest<HTMLElement>('[data-label-action]')
    if (action) { event.stopImmediatePropagation(); void this.action(action.dataset.labelAction!); return }
    const memberButton = target.closest<HTMLElement>('[data-label-member]')
    if (memberButton) {
      event.stopImmediatePropagation()
      const rowId = memberButton.dataset.labelRowId!
      this.selectedRows = new Set([rowId]); this.selection = { kind: 'member', rowId, trackId: memberButton.dataset.labelMember! }
      this.options.select(this.selection); this.highlight(); return
    }
    const rowButton = target.closest<HTMLElement>('[data-label-row]')
    if (rowButton) { event.stopImmediatePropagation(); this.options.select({ kind: 'row', rowId: rowButton.dataset.labelRow! }); return }
    const group = target.closest<SVGElement>('[data-fe-group]')
    if (group) { event.stopImmediatePropagation(); this.selection = { kind: 'group', groupId: group.dataset.feGroup! }; this.options.select(this.selection); return }
    const row = target.closest<HTMLElement>('[data-fe-row-label], [data-select="row"]')
    if (!row) return
    const rowId = row.dataset.feRowLabel ?? row.dataset.row!
    event.stopImmediatePropagation(); this.pickRow(rowId, event)
    const member = target.closest<SVGElement>('[data-fe-track-label]')
    this.selection = member?.dataset.feTrackLabel && !event.ctrlKey && !event.shiftKey ? { kind: 'member', rowId, trackId: member.dataset.feTrackLabel } : { kind: 'row', rowId }
    this.options.select(this.selection); this.highlight()
  }

  private context(event: MouseEvent): void {
    const target = event.target as Element
    const group = target.closest<SVGElement>('[data-fe-group]')
    const row = target.closest<HTMLElement>('[data-fe-row-label], [data-select="row"]')
    if (!group && !row) return
    event.preventDefault(); event.stopPropagation(); this.closeMenu()
    const rowId = row?.dataset.feRowLabel ?? row?.dataset.row
    const member = target.closest<SVGElement>('[data-fe-track-label]')
    this.selection = group ? { kind: 'group', groupId: group.dataset.feGroup! } : member?.dataset.feTrackLabel ? { kind: 'member', rowId: rowId!, trackId: member.dataset.feTrackLabel } : { kind: 'row', rowId: rowId! }
    if (rowId && !this.selectedRows.has(rowId)) this.selectedRows = new Set([rowId])
    this.options.select(this.selection); this.highlight()
    const button = (id: string, label: string) => `<button class="context-item" role="menuitem" data-label-action="${id}">${label}</button>`
    this.menu = document.createElement('div'); this.menu.className = 'track-context-menu fe-label-menu'; this.menu.setAttribute('role', 'menu')
    this.menu.innerHTML = this.selection.kind === 'group' ? button('rename', 'Rename group…') + button('properties', 'Group label appearance') + button('group-up', 'Move group up') + button('group-down', 'Move group down') + button('ungroup', 'Ungroup rows · keep plots')
      : button('rename', 'Rename track…') + button('properties', 'Track label appearance') + button('row-properties', 'Row appearance and sources') + button('group-selected', `Group ${this.selectedRows.size > 1 ? `${this.selectedRows.size} selected rows` : 'this row'}…`) + button('remove-row-group', 'Remove row from group')
    this.menu.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const buttons = [...this.menu!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[index]?.focus()
    })
    this.options.root.append(this.menu)
    this.menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - this.menu.offsetWidth - 8))}px`
    this.menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - this.menu.offsetHeight - 8))}px`
    document.addEventListener('pointerdown', this.outside, true)
    this.menu.querySelector<HTMLElement>('button')?.focus()
  }
  private outside = (event: PointerEvent) => { if (!this.menu?.contains(event.target as Node)) this.closeMenu() }
  private closeMenu(): void { document.removeEventListener('pointerdown', this.outside, true); this.menu?.remove(); this.menu = undefined }

  private async action(action: string): Promise<void> {
    this.closeMenu()
    const selected = this.selection
    if (!selected) return
    if (action === 'rename') {
      const doc = this.options.current()
      const row = selected.kind === 'group' ? undefined : doc.rows.find((row) => row.id === selected.rowId)
      const initial = selected.kind === 'group' ? doc.groups?.find((group) => group.id === selected.groupId)?.label : selected.kind === 'member' && row?.trackIds.length !== 1 ? doc.sourceDocument.tracks.find((track) => track.id === selected.trackId)?.label : row?.label
      const name = await this.nameDialog(selected.kind === 'group' ? 'Rename group' : 'Rename track', initial ?? '')
      if (name) this.options.edit((draft) => {
        if (selected.kind === 'group') renameFigureGroup(draft, selected.groupId, name)
        else if (selected.kind === 'member') this.renameTrack(draft, selected.rowId, selected.trackId, name)
        else draft.rows.find((row) => row.id === selected.rowId)!.label = name
      })
    } else if (action === 'group-selected') {
      const name = await this.nameDialog('Group selected rows', '')
      if (!name) return
      const id = crypto.randomUUID()
      this.options.edit((draft) => {
        for (const rowId of this.selectedRows) setFigureRowGroup(draft, rowId, undefined)
        ;(draft.groups ??= []).push({ id, label: name, rowIds: [...this.selectedRows], appearance: {} })
        for (const row of draft.rows) if (this.selectedRows.has(row.id)) row.groupLabel = name
      })
      this.selection = { kind: 'group', groupId: id }; this.options.select(this.selection)
    } else if (action === 'row-properties' && selected.kind !== 'group') this.options.select({ kind: 'row', rowId: selected.rowId })
    else if (action === 'properties') this.options.select(selected)
    else if (action === 'remove-row-group' && selected.kind !== 'group') this.options.edit((draft) => setFigureRowGroup(draft, selected.rowId, undefined))
    else if (selected.kind === 'group' && ['ungroup', 'group-up', 'group-down'].includes(action)) this.options.edit((draft) => { if (action === 'ungroup') removeFigureGroup(draft, selected.groupId); else moveFigureGroup(draft, selected.groupId, action === 'group-up' ? -1 : 1) })
    else if (action === 'stack-appearance' && selected.kind === 'member') {
      const groupId = this.options.current().sourceDocument.tracks.find((track) => track.id === selected.trackId)?.displayGroupId
      if (!groupId) return
      openSignalStackMenu({ groupId, x: window.innerWidth - 440, y: 60, current: () => this.options.current().sourceDocument, edit: (change) => this.options.edit((draft) => change(draft.sourceDocument)), preview: this.options.previewSource, undo: this.options.undo, redo: this.options.redo, canUndo: this.options.canUndo, canRedo: this.options.canRedo })
      document.querySelector<HTMLElement>('.signal-stack-menu')!.style.zIndex = '190'
    }
    this.highlight()
  }

  private renameTrack(draft: FigureDocument, rowId: string, id: string, name: string): void {
    const track = draft.sourceDocument.tracks.find((track) => track.id === id)
    if (track) track.label = name
    const row = draft.rows.find((row) => row.id === rowId)
    if (row?.trackIds.length === 1) row.label = name
  }

  private change(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLSelectElement
    const key = input.dataset.labelEdit, selected = this.selection
    if (!key || !selected) return
    this.options.edit((draft) => {
      if (selected.kind === 'group') {
        const group = draft.groups?.find((group) => group.id === selected.groupId)
        if (!group) return
        if (key === 'group-name') { if (!input.value.trim()) throw new Error('Enter a group name.'); renameFigureGroup(draft, group.id, input.value.trim()) }
        else if (key.startsWith('group-')) {
          const property = key.slice(6) as keyof typeof groupFields, definition = groupFields[property]
          if (definition) (group.appearance ??= {})[property] = (typeof definition.value === 'boolean' ? (input as HTMLInputElement).checked : typeof definition.value === 'number' ? Number(input.value) : input.value) as never
        }
      } else if (selected.kind === 'member') {
        const track = draft.sourceDocument.tracks.find((track) => track.id === selected.trackId)!
        const group = draft.sourceDocument.groups.find((group) => group.id === track.displayGroupId)
        if (key === 'track-name') { if (!input.value.trim()) throw new Error('Enter a track name.'); this.renameTrack(draft, selected.rowId, track.id, input.value.trim()) }
        if (key === 'track-color') { track.color = input.value; for (const column of draft.columns) if (column.styles?.[selected.rowId]) delete column.styles[selected.rowId].color; if (group) (group.signalStackAppearance ??= {}).colorMode = 'original' }
        if (key === 'track-visible' && group) { track.enabled = true; setSignalStackTrackVisible(draft.sourceDocument, group.id, track.id, (input as HTMLInputElement).checked) }
        if (key === 'member-opacity' && group) ((group.signalStackAppearance ??= {}).memberOpacity ??= {})[track.id] = Number(input.value)
        if (key === 'member-pattern' && group) { const patterns = (group.signalStackAppearance ??= {}).memberPatterns ??= {}; if (input.value === 'auto') delete patterns[track.id]; else patterns[track.id] = input.value as typeof STACK_PATTERNS[number] }
      }
    })
    this.highlight()
  }

  private pointer(event: PointerEvent): void {
    const target = (event.target as Element).closest<SVGTextElement>('[data-fe-group-label]')
    if (!target || event.button !== 0) return
    const group = this.options.current().groups?.find((group) => group.id === target.dataset.feGroupLabel)
    const inverse = target.ownerSVGElement?.getScreenCTM()?.inverse()
    if (!group || !inverse) return
    const start = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse), a = resolveAppearance(groupFields, group.appearance)
    const nodes = [...this.options.root.querySelectorAll<SVGTextElement>(`[data-fe-group-label="${CSS.escape(group.id)}"]`)].map((node) => ({ node, transform: node.getAttribute('transform') ?? '' }))
    let dx = 0, dy = 0, moved = false
    const move = (event: PointerEvent) => {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse)
      dx = point.x - start.x; dy = point.y - start.y
      moved ||= Math.hypot(dx, dy) > 0.6
      if (moved) { event.preventDefault(); for (const item of nodes) item.node.setAttribute('transform', `translate(${dx} ${dy}) ${item.transform}`) }
    }
    const cleanup = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); this.dragCleanup = undefined }
    const cancel = () => { for (const item of nodes) item.node.setAttribute('transform', item.transform); cleanup() }
    const up = () => {
      cleanup()
      if (moved) { this.suppressClick = true; window.setTimeout(() => { this.suppressClick = false }, 0); this.options.edit((draft) => { const group = draft.groups?.find((group) => group.id === target.dataset.feGroupLabel); if (group) Object.assign(group.appearance ??= {}, { groupLabelXmm: a.groupLabelXmm + dx, groupLabelYmm: a.groupLabelYmm + dy }) }); this.selection = { kind: 'group', groupId: group.id }; this.options.select(this.selection) }
    }
    this.dragCleanup?.(); this.dragCleanup = cancel
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel)
    event.preventDefault()
  }

  private nameDialog(title: string, initial: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog'); dialog.className = 'fe-confirm fe-label-dialog'
      dialog.innerHTML = `<form><h2>${title}</h2><label class="fe-field">Name<input name="name" value="${esc(initial)}" required/></label><footer><button type="button">Cancel</button><button type="submit">Save</button></footer></form>`
      const finish = (value?: string) => { dialog.close(); dialog.remove(); resolve(value) }
      dialog.querySelector('form')!.addEventListener('submit', (event) => { event.preventDefault(); const value = dialog.querySelector('input')!.value.trim(); if (value) finish(value) })
      dialog.querySelector('button')!.addEventListener('click', () => finish())
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish() })
      dialog.addEventListener('click', (event) => { const bounds = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) finish() })
      this.options.root.append(dialog); dialog.showModal(); dialog.querySelector('input')!.select()
    })
  }
}
