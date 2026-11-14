import { signalStackDisplayEntries } from './browser.ts'
import { stackAppearance, STACK_PATTERNS, svgStackPattern, type SignalStackAppearance } from './signal-stack-style.ts'
import { cloneDocument, moveSignalStackTrack, setSignalStackTrackVisible, type TrackDocument } from './track-document.ts'

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const patternNames = { none: 'Solid fill', diagonal: 'Diagonal /', reverse: 'Diagonal \\', crosshatch: 'Crosshatch', dots: 'Dots', horizontal: 'Horizontal', vertical: 'Vertical' }

export function openSignalStackMenu(options: {
  groupId: string; x: number; y: number
  current(): TrackDocument
  edit(change: (draft: TrackDocument) => void): void
  preview(document: TrackDocument): void
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean
}): void {
  document.querySelector<HTMLDialogElement>('.signal-stack-menu')?.dispatchEvent(new Event('cancel', { cancelable: true }))
  const panel = document.createElement('dialog')
  panel.className = 'menu-popover signal-stack-menu'
  panel.setAttribute('aria-label', 'Signal stack appearance'); panel.setAttribute('aria-modal', 'false')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true; options.preview(options.current())
    document.removeEventListener('pointerdown', outside)
    document.removeEventListener('keydown', keyboard, true)
    window.removeEventListener('resize', position)
    panel.close(); panel.remove()
  }
  const outside = (event: PointerEvent) => { if (!panel.contains(event.target as Node)) close() }
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close() }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key.toLowerCase() === 'y' || event.shiftKey) options.redo(); else options.undo()
      options.preview(options.current()); render()
    }
  }
  const position = () => {
    panel.style.left = `${Math.max(8, Math.min(options.x, window.innerWidth - panel.offsetWidth - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(options.y, window.innerHeight - panel.offsetHeight - 8))}px`
  }
  const select = (label: string, key: string, value: string, choices: [string, string][], disabled = false) => `<label><span>${label}</span><select data-stack="${key}" ${disabled ? 'disabled' : ''}>${choices.map(([id, name]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`
  const slider = (label: string, key: string, value: number, min: number, max: number, unit: string, disabled = false, step = 1) => `<label class="stack-slider"><span>${label}</span><input type="range" data-stack="${key}" min="${min}" max="${max}" step="${step}" value="${value}" ${disabled ? 'disabled' : ''}/><output>${value}${unit}</output></label>`
  const render = () => {
    const doc = options.current(), group = doc.groups.find((group) => group.id === options.groupId)
    if (!group || group.signalStackMode !== 'collapsed') { close(); return }
    const members = doc.tracks.filter((track) => track.displayGroupId === group.id)
    const a = stackAppearance(group, members), entries = signalStackDisplayEntries(group, members)
    const active = panel.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined
    const focusKey = ['stack', 'pattern', 'visible', 'action', 'preset'].find((key) => active?.dataset[key])
    const focusValue = focusKey ? active?.dataset[focusKey] : undefined
    const scroll = panel.scrollTop
    panel.innerHTML = `<header><div><strong>Signal stack appearance</strong><small>${esc(group.label)}</small></div><button class="menu-item" data-action="close" aria-label="Close stack appearance">×</button></header>
      <div class="stack-presets"><button data-preset="patterned">Same color + patterns</button><button data-preset="colored">Colored fills</button><button data-preset="outlines">Outlines</button></div>
      <section><h3>Rendering</h3>${select('Draw', 'renderStyle', a.renderStyle, [['fill-line', 'Filled + outline'], ['fill', 'Filled only'], ['line', 'Outline only']])}${slider('Fill opacity', 'opacity', a.opacity, 0, 100, '%', a.renderStyle === 'line')}</section>
      <section><h3>Colors</h3>${select('Color mode', 'colorMode', a.colorMode, [['same', 'Same stack color'], ['distinct', 'Distinct colors'], ['original', 'Original track colors']])}<label><span>Stack color</span><input data-stack="color" type="color" value="${esc(a.color)}" ${a.colorMode !== 'same' ? 'disabled' : ''}/></label><p>Original track colors are preserved when you change the stack color.</p></section>
      <section><h3>Patterns and outlines</h3>${select('Automatic fill patterns', 'fillPatterns', a.fillPatterns, [['mixed', 'Mixed hatches and dots'], ['hatches', 'Different hatches'], ['none', 'Solid fills']], a.renderStyle === 'line')}${slider('Pattern opacity', 'patternOpacity', a.patternOpacity, 0, 100, '%', a.renderStyle === 'line')}${slider('Pattern spacing', 'patternSpacing', a.patternSpacing, 4, 24, ' px', a.renderStyle === 'line')}<label class="stack-check"><input data-stack="outlinePatterns" type="checkbox" ${a.outlinePatterns ? 'checked' : ''} ${a.renderStyle === 'fill' ? 'disabled' : ''}/> Different outline dash patterns</label>${slider('Outline width', 'lineWidth', a.lineWidth, 0.5, 4, ' px', a.renderStyle === 'fill', 0.25)}</section>
      <section class="stack-members"><h3>Members <small>Lower rows paint on top</small></h3><p>Patterns stay with their tracks when reordered or hidden. Choose an individual pattern below to override the automatic scheme.</p>${entries.map((entry, index) => {
        const id = `stack-swatch-${index}`
        return `<article data-member="${esc(entry.id)}"><label class="stack-member-name"><input type="checkbox" data-visible="${esc(entry.id)}" ${entry.hidden ? '' : 'checked'} ${!members[index].enabled ? 'disabled title="Enable this source track first"' : !entry.hidden && entries.filter((entry) => !entry.hidden).length === 1 ? 'disabled title="Keep at least one signal visible"' : ''}/><svg width="30" height="18" aria-hidden="true">${svgStackPattern(id, entry.pattern, entry.color, 7, 1)}${a.renderStyle !== 'line' ? `<rect width="30" height="18" fill="${esc(entry.color)}" opacity="${a.opacity / 100}"/><rect width="30" height="18" fill="url(#${id})" opacity="${a.patternOpacity / 100}"/>` : ''}${a.renderStyle !== 'fill' ? `<path d="M0 13 L8 5 L15 9 L24 3 L30 7" fill="none" stroke="${esc(entry.color)}" stroke-width="${a.lineWidth}" stroke-dasharray="${entry.dash.join(' ')}"/>` : ''}</svg><span title="${esc(entry.label)}">${esc(entry.label)}</span></label><div class="stack-member-options"><select aria-label="${esc(entry.label)} fill pattern" data-pattern="${esc(entry.id)}" ${a.renderStyle === 'line' ? 'disabled' : ''}><option value="auto" ${a.memberPatterns[entry.id] === undefined ? 'selected' : ''}>Automatic</option>${STACK_PATTERNS.map((pattern) => `<option value="${pattern}" ${a.memberPatterns[entry.id] === pattern ? 'selected' : ''}>${patternNames[pattern]}</option>`).join('')}</select><button data-move="${esc(entry.id)}" data-delta="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(entry.label)} earlier">↑</button><button data-move="${esc(entry.id)}" data-delta="1" ${index === members.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(entry.label)} later">↓</button></div></article>`
      }).join('')}</section><footer><button data-action="undo" ${options.canUndo() ? '' : 'disabled'}>Undo</button><button data-action="redo" ${options.canRedo() ? '' : 'disabled'}>Redo</button><button data-action="close">Done</button></footer>`
    const focusTarget = focusKey && focusValue ? panel.querySelector<HTMLElement>(`[data-${focusKey}="${CSS.escape(focusValue)}"]`) : undefined
    if (focusTarget && !focusTarget.matches(':disabled')) focusTarget.focus({ preventScroll: true })
    else panel.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true })
    panel.scrollTop = scroll; position()
  }
  const apply = (draft: TrackDocument, input: HTMLInputElement | HTMLSelectElement) => {
    const group = draft.groups.find((group) => group.id === options.groupId)
    if (!group) return
    if (input.dataset.visible) { setSignalStackTrackVisible(draft, group.id, input.dataset.visible, (input as HTMLInputElement).checked); return }
    const style = group.signalStackAppearance ??= {}
    if (input.dataset.pattern) { const patterns = style.memberPatterns ??= {}; if (input.value === 'auto') delete patterns[input.dataset.pattern]; else patterns[input.dataset.pattern] = input.value as typeof STACK_PATTERNS[number]; return }
    const key = input.dataset.stack
    if (key === 'renderStyle') group.signalStackRenderStyle = input.value as typeof group.signalStackRenderStyle
    else if (key === 'opacity') group.signalStackOpacity = Number(input.value)
    else if (key === 'outlinePatterns') style.outlinePatterns = (input as HTMLInputElement).checked
    else if (key === 'color') style.color = input.value
    else if (key === 'colorMode') style.colorMode = input.value as SignalStackAppearance['colorMode']
    else if (key === 'fillPatterns') style.fillPatterns = input.value as SignalStackAppearance['fillPatterns']
    else if (key === 'patternOpacity' || key === 'patternSpacing' || key === 'lineWidth') style[key] = Number(input.value)
  }
  panel.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement
    if (closed || !['range', 'color'].includes(input.type)) return
    const output = input.parentElement?.querySelector('output')
    if (output) output.textContent = input.value + (input.dataset.stack === 'opacity' || input.dataset.stack === 'patternOpacity' ? '%' : ' px')
    const draft = cloneDocument(options.current()); apply(draft, input); options.preview(draft)
  })
  panel.addEventListener('change', (event) => { if (!closed) { options.edit((draft) => apply(draft, event.target as HTMLInputElement)); render() } })
  panel.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.dataset.action === 'close') { close(); return }
    if (button.dataset.action === 'undo') options.undo()
    else if (button.dataset.action === 'redo') options.redo()
    else options.edit((draft) => {
      const group = draft.groups.find((group) => group.id === options.groupId)
      if (!group) return
      if (button.dataset.move) moveSignalStackTrack(draft, group.id, button.dataset.move, Number(button.dataset.delta) as -1 | 1)
      if (button.dataset.preset) {
        const preset = button.dataset.preset
        group.signalStackRenderStyle = preset === 'outlines' ? 'line' : 'fill-line'; group.signalStackOpacity = 30
        Object.assign(group.signalStackAppearance ??= {}, { colorMode: preset === 'colored' ? 'distinct' : 'same', fillPatterns: preset === 'patterned' ? 'mixed' : 'none', outlinePatterns: preset === 'outlines', memberPatterns: {} })
      }
    })
    options.preview(options.current()); render()
  })
  panel.addEventListener('cancel', (event) => { event.preventDefault(); close() })
  document.body.append(panel); panel.show(); render()
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard, true); window.addEventListener('resize', position)
  panel.querySelector<HTMLSelectElement>('select')?.focus()
}
