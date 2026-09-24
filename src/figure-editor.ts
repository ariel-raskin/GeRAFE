import { invoke } from '@tauri-apps/api/core'
import { pickNativeFilePaths } from './desktop-track-picker.ts'
import { addFigureColumn, FigureDocumentStore, normalizeFigureDocument, setFigureColumnRegion, type FigureCellStyle, type FigureDocument } from './figure-document.ts'
import { FigureRenderSession, figureSvgToPng } from './figure-render.ts'
import { formatLocus, parseLocus } from './genome.ts'
import { isDesktopApp, listNativeDirectory, readNativeTextFile, writeNativeTextFile } from './native-file.ts'
import { nativeFilePathKey } from './open-track-files.ts'
import { parentFolderOfFile } from './track-picker-state.ts'
import type { GeneSource } from './reference.ts'
import type { TrackSourceSpec } from './track-document.ts'
import type { Region, TrackSource } from './types.ts'

const FIGURE_FOLDER_KEY = 'gerafe:last-figure-folder'
type Selection = { kind: 'page' } | { kind: 'row'; rowId: string } | { kind: 'column'; columnId: string } | { kind: 'cell'; rowId: string; columnId: string }

export interface FigureEditorOptions {
  document: FigureDocument
  sources: ReadonlyMap<string, TrackSource>
  genes: () => GeneSource | undefined
  chromosomes: (referenceId: string) => ReadonlyMap<string, number> | undefined
  restoreSources: (document: FigureDocument) => Promise<ReadonlyMap<string, TrackSource>>
  relinkSource: (document: FigureDocument, sourceId: string) => Promise<{ source: TrackSource; sourceSpec: TrackSourceSpec } | undefined>
  onClose: () => void
}

export class FigureEditor {
  private store: FigureDocumentStore
  private sources: ReadonlyMap<string, TrackSource>
  private session = new FigureRenderSession()
  private root: HTMLElement
  private selection: Selection = { kind: 'page' }
  private renderVersion = 0
  private projectPath?: string
  private savedSnapshot: string
  private zoom = 1

  constructor(private readonly options: FigureEditorOptions) {
    this.store = new FigureDocumentStore(options.document)
    this.savedSnapshot = JSON.stringify(this.store.current)
    this.sources = options.sources
    this.root = document.createElement('section')
    this.root.className = 'figure-editor'
    this.root.setAttribute('aria-label', 'GeRAFE Figure Editor')
    this.root.hidden = true
    this.root.innerHTML = `
      <header class="fe-toolbar">
        <button type="button" data-action="back">← Back to GeR</button>
        <div class="fe-brand"><strong>Figure Editor</strong><small data-role="project-name"></small></div>
        <button type="button" data-action="undo" title="Undo figure edit">Undo</button>
        <button type="button" data-action="redo" title="Redo figure edit">Redo</button>
        <span class="fe-spacer"></span>
        <button type="button" data-action="open">Open project…</button>
        <button type="button" data-action="save">Save project</button>
        <button type="button" data-action="save-as">Save as…</button>
        <button type="button" data-action="export-svg">Export SVG…</button>
        <button type="button" data-action="export-png">Export PNG…</button>
      </header>
      <div class="fe-workspace">
        <aside class="fe-sidebar" aria-label="Figure layers"><div data-role="layers"></div></aside>
        <main class="fe-stage"><div class="fe-stage-tools"><span data-role="status">Preparing figure…</span><span class="fe-spacer"></span><button type="button" data-action="zoom-out">−</button><span data-role="zoom">100%</span><button type="button" data-action="zoom-in">+</button><button type="button" data-action="zoom-fit">Fit</button></div><div class="fe-scroll"><div class="fe-page" data-role="page-preview"></div></div></main>
        <aside class="fe-inspector" aria-label="Figure properties"><div data-role="inspector"></div></aside>
      </div>
      <div class="fe-toast" data-role="toast" role="status" hidden></div>`
    document.body.append(this.root)
    this.root.addEventListener('click', (event) => void this.onClick(event))
    this.root.addEventListener('change', (event) => void this.onChange(event))
  }

  get currentDocument(): FigureDocument { return this.store.current }
  show(): void { this.root.hidden = false; this.refresh() }
  hide(): void { this.root.hidden = true; this.options.onClose() }
  dispose(): void { this.root.remove() }

  private edit(change: (document: FigureDocument) => void): void {
    try { this.store.edit(change); this.refresh() }
    catch (error) { this.toast(error instanceof Error ? error.message : String(error), true) }
  }

  private refresh(): void {
    const document = this.store.current
    this.root.querySelector<HTMLElement>('[data-role="project-name"]')!.textContent = document.name
    this.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled = !this.store.canUndo
    this.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled = !this.store.canRedo
    this.root.querySelector<HTMLElement>('[data-role="zoom"]')!.textContent = `${Math.round(this.zoom * 100)}%`
    this.renderLayers()
    this.renderInspector()
    void this.renderPreview()
  }

  private renderLayers(): void {
    const document = this.store.current
    const layers = this.root.querySelector<HTMLElement>('[data-role="layers"]')!
    layers.innerHTML = `<div class="fe-sidebar-section"><h2>Figure</h2><button type="button" class="${this.selection.kind === 'page' ? 'is-selected' : ''}" data-select="page">Page · ${document.page.widthMm} mm</button></div>
      <div class="fe-sidebar-section"><h2>Columns</h2>${document.columns.map((column, index) => `<div class="fe-layer-line"><button type="button" class="${this.selection.kind === 'column' && this.selection.columnId === column.id ? 'is-selected' : ''}" data-select="column" data-column="${esc(column.id)}">${index + 1}. ${esc(column.title || formatLocus(column.region))}</button><button type="button" data-action="adjust-region" data-column="${esc(column.id)}" title="Adjust genomic region">↔</button></div>`).join('')}<button type="button" data-action="add-column" ${document.columns.length >= 2 ? 'disabled' : ''}>+ Add column</button></div>
      <div class="fe-sidebar-section"><h2>Track rows</h2>${document.rows.map((row, index) => `<div class="fe-layer-line ${row.included ? '' : 'is-excluded'}"><button type="button" class="${this.selection.kind === 'row' && this.selection.rowId === row.id ? 'is-selected' : ''}" data-select="row" data-row="${esc(row.id)}">${esc(row.label)}</button><button type="button" data-action="row-up" data-row="${esc(row.id)}" ${index === 0 ? 'disabled' : ''} title="Move row up">↑</button><button type="button" data-action="row-down" data-row="${esc(row.id)}" ${index === document.rows.length - 1 ? 'disabled' : ''} title="Move row down">↓</button><button type="button" data-action="row-toggle" data-row="${esc(row.id)}" title="${row.included ? 'Remove from figure' : 'Restore to figure'}">${row.included ? '×' : '+'}</button></div>`).join('')}</div>`
  }

  private renderInspector(): void {
    const doc = this.store.current
    const selection = this.selection
    const inspector = this.root.querySelector<HTMLElement>('[data-role="inspector"]')!
    const field = (label: string, name: string, value: string | number, type = 'text', attributes = '') => `<label class="fe-field"><span>${esc(label)}</span><input data-edit="${name}" type="${type}" value="${esc(String(value))}" ${attributes}/></label>`
    if (selection.kind === 'page') {
      const missing = doc.sourceDocument.sources.filter((source) => !this.sources.has(source.id) && doc.rows.some((row) => row.included && doc.columns.some((column) => (column.assignments[row.id] ?? []).some((trackId) => doc.sourceDocument.tracks.find((track) => track.id === trackId)?.sourceIds.includes(source.id)))))
      const annotationControls = [
        ...doc.sourceDocument.savedRegions.map((saved) => `<div class="fe-annotation"><strong>${esc(saved.label)}</strong><label><input data-edit="annotation-visible" data-annotation-kind="region" data-annotation="${esc(saved.id)}" type="checkbox" ${saved.highlighted ? 'checked' : ''}/> Show</label><input data-edit="annotation-color" data-annotation-kind="region" data-annotation="${esc(saved.id)}" type="color" value="${esc(saved.color)}" aria-label="${esc(saved.label)} color"/></div>`),
        ...doc.sourceDocument.comparisonDividers.map((divider, index) => `<div class="fe-annotation"><strong>Divider ${index + 1}</strong><input data-edit="annotation-color" data-annotation-kind="divider" data-annotation="${esc(divider.id)}" type="color" value="${esc(divider.color)}" aria-label="Divider ${index + 1} color"/></div>`),
        ...doc.sourceDocument.matrixOutlines.map((outline) => `<div class="fe-annotation"><strong>${esc(outline.label)}</strong><label><input data-edit="annotation-visible" data-annotation-kind="outline" data-annotation="${esc(outline.id)}" type="checkbox" ${outline.visible ? 'checked' : ''}/> Show</label><input data-edit="annotation-color" data-annotation-kind="outline" data-annotation="${esc(outline.id)}" type="color" value="${esc(outline.color)}" aria-label="${esc(outline.label)} color"/></div>`),
      ].join('')
      inspector.innerHTML = `<h2>Page</h2>${field('Figure name', 'figure-name', doc.name)}${field('Title', 'page-title', doc.page.title)}${field('Width (mm)', 'page-width', doc.page.widthMm, 'number', 'min="50" max="600" step="1"')}${field('Height (mm; 0 = fit)', 'page-height', doc.page.heightMm, 'number', 'min="0" max="600" step="1"')}${field('Margins (mm)', 'page-margin', doc.page.marginMm, 'number', 'min="0" max="100" step="0.5"')}${field('Label area (mm)', 'page-label-width', doc.page.labelWidthMm, 'number', 'min="0" max="120" step="0.5"')}${field('Column gap (mm)', 'page-column-gap', doc.page.columnGapMm, 'number', 'min="0" max="100" step="0.5"')}${field('Row gap (mm)', 'page-row-gap', doc.page.rowGapMm, 'number', 'min="0" max="50" step="0.5"')}${field('Ruler height (mm)', 'page-ruler-height', doc.page.rulerHeightMm, 'number', 'min="0" max="50" step="0.5"')}${field('Font family', 'page-font', doc.page.fontFamily)}${field('Font size (pt)', 'page-font-size', doc.page.fontSizePt, 'number', 'min="4" max="40" step="0.5"')}${field('Background', 'page-background', doc.page.background, 'color')}${annotationControls ? `<h3>Annotations</h3>${annotationControls}` : ''}${missing.length ? `<div class="fe-missing"><h3>Missing source files</h3><p>Reopen these files before export. Existing figure edits are preserved.</p>${missing.map((source) => `<div><span>${esc(source.name)}</span><button type="button" data-action="relink-source" data-source="${esc(source.id)}">Relink…</button></div>`).join('')}</div>` : ''}`
      return
    }
    if (selection.kind === 'column') {
      const column = doc.columns.find((item) => item.id === selection.columnId)
      if (!column) { this.selection = { kind: 'page' }; this.renderInspector(); return }
      inspector.innerHTML = `<h2>Column</h2>${field('Title', 'column-title', column.title)}<div class="fe-field"><span>Genomic region</span><strong>${esc(formatLocus(column.region))}</strong></div><button type="button" data-action="adjust-region" data-column="${esc(column.id)}">Adjust region…</button><label class="fe-checkbox"><input data-edit="linked-regions" type="checkbox" ${doc.linkedRegions ? 'checked' : ''}/> Link region edits across columns</label><p class="fe-help">Each column has its own ruler. Track rows stay aligned when regions differ.</p>${doc.columns.length > 1 ? `<button type="button" data-action="remove-column" data-column="${esc(column.id)}">Remove column</button>` : ''}`
      return
    }
    const row = doc.rows.find((item) => item.id === selection.rowId)
    if (!row) { this.selection = { kind: 'page' }; this.renderInspector(); return }
    const rowFields = `<h2>Track row</h2>${field('Figure label', 'row-label', row.label)}${field('Assay/group label', 'row-group-label', row.groupLabel ?? '')}${field('Height (mm)', 'row-height', row.heightMm, 'number', 'min="2" max="100" step="0.5"')}${field('Gap after (mm)', 'row-gap', row.gapAfterMm, 'number', 'min="0" max="100" step="0.5"')}${field('Label size (pt)', 'row-font-size', row.labelFontSizePt ?? doc.page.fontSizePt, 'number', 'min="4" max="40" step="0.5"')}${field('Label color', 'row-label-color', row.labelColor ?? '#111111', 'color')}${field('Frame color', 'row-frame-color', row.frameColor ?? '#444444', 'color')}${field('Frame width (pt)', 'row-frame-width', row.frameWidthPt ?? 0.5, 'number', 'min="0" max="8" step="0.1"')}`
    const assignments = doc.columns.map((column, index) => {
      const assigned = column.assignments[row.id] ?? []
      const options = doc.sourceDocument.tracks.map((track) => `<option value="${esc(track.id)}" ${assigned.length === 1 && assigned[0] === track.id ? 'selected' : ''}>${esc(track.label)}</option>`).join('')
      return `<label class="fe-field"><span>Column ${index + 1} track</span><select data-edit="cell-track" data-column="${esc(column.id)}"><option value="" ${!assigned.length ? 'selected' : ''}>No track</option>${assigned.length > 1 ? `<option value="__stack__" selected>${assigned.length} stacked tracks</option>` : ''}${options}</select></label>`
    }).join('')
    const styleControls = doc.columns.map((column, index) => {
      const style = column.styles?.[row.id] ?? {}
      const assignedId = column.assignments[row.id]?.[0]
      const spec = doc.sourceDocument.tracks.find((track) => track.id === assignedId)
      const signal = spec?.kind === 'signal' || spec?.kind === 'stranded'
      return `<div class="fe-cell-style"><h3>Column ${index + 1} appearance</h3>${field('Color', 'cell-color', style.color ?? spec?.color ?? '#245b9e', 'color', `data-column="${esc(column.id)}"`)}${spec?.kind === 'stranded' ? field('Negative color', 'cell-negative-color', style.negativeColor ?? spec.negativeColor ?? '#2878d4', 'color', `data-column="${esc(column.id)}"`) : ''}${field('Opacity (%)', 'cell-opacity', style.opacity ?? 100, 'number', `min="0" max="100" step="1" data-column="${esc(column.id)}"`)}${signal ? `<label class="fe-field"><span>Scale</span><select data-edit="cell-scale-mode" data-column="${esc(column.id)}"><option value="shared" ${!style.scaleMode || style.scaleMode === 'shared' ? 'selected' : ''}>Shared across columns</option><option value="independent" ${style.scaleMode === 'independent' ? 'selected' : ''}>Independent</option><option value="fixed" ${style.scaleMode === 'fixed' ? 'selected' : ''}>Fixed limits</option></select></label>${style.scaleMode === 'fixed' ? field('Minimum', 'cell-scale-min', style.scaleMin ?? 0, 'number', `step="any" data-column="${esc(column.id)}"`) + field('Maximum', 'cell-scale-max', style.scaleMax ?? 1, 'number', `step="any" data-column="${esc(column.id)}"`) : ''}<label class="fe-checkbox"><input type="checkbox" data-edit="cell-show-scale" data-column="${esc(column.id)}" ${style.showScale !== false ? 'checked' : ''}/> Show scale values</label>` : ''}${spec?.kind === 'signal' ? `<label class="fe-field"><span>Graph</span><select data-edit="cell-render-style" data-column="${esc(column.id)}"><option value="source" ${!style.renderStyle || style.renderStyle === 'source' ? 'selected' : ''}>Source setting</option><option value="fill" ${style.renderStyle === 'fill' ? 'selected' : ''}>Filled</option><option value="line" ${style.renderStyle === 'line' ? 'selected' : ''}>Line</option></select></label>` : ''}</div>`
    }).join('')
    inspector.innerHTML = rowFields + `<h3>Column assignments</h3>${assignments}<p class="fe-help">Click a rendered cell to select it. Figure styling does not alter the GeR workspace.</p>${styleControls}`
  }

  private async renderPreview(): Promise<void> {
    if (this.root.hidden) return
    const version = ++this.renderVersion
    const status = this.root.querySelector<HTMLElement>('[data-role="status"]')!
    status.textContent = 'Rendering figure from source data…'
    try {
      const result = await this.session.render(this.store.current, this.sources, this.options.genes())
      if (version !== this.renderVersion || this.root.hidden) return
      const preview = this.root.querySelector<HTMLElement>('[data-role="page-preview"]')!
      preview.innerHTML = result.svg
      const svg = preview.querySelector('svg')!
      svg.style.width = `${Math.round(result.widthMm * 96 / 25.4 * this.zoom)}px`
      svg.style.height = 'auto'
      status.textContent = result.issues.length ? `${result.issues.length} source issue${result.issues.length === 1 ? '' : 's'} · review before export` : `${this.store.current.rows.filter((row) => row.included).length} rows · ${this.store.current.columns.length} column${this.store.current.columns.length === 1 ? '' : 's'} · ${result.widthMm.toFixed(0)} × ${result.heightMm.toFixed(0)} mm`
      status.title = result.issues.join('\n')
    } catch (error) {
      if (version !== this.renderVersion) return
      status.textContent = error instanceof Error ? error.message : String(error)
      this.toast(status.textContent, true)
    }
  }

  private async onClick(event: MouseEvent): Promise<void> {
    const target = event.target as Element
    const select = target.closest<HTMLElement>('[data-select]')
    if (select) {
      this.selection = select.dataset.select === 'column' ? { kind: 'column', columnId: select.dataset.column! } : select.dataset.select === 'row' ? { kind: 'row', rowId: select.dataset.row! } : { kind: 'page' }
      this.renderLayers(); this.renderInspector(); return
    }
    const cell = target.closest<HTMLElement>('[data-fe-row][data-fe-column]')
    if (cell) { this.selection = { kind: 'cell', rowId: cell.dataset.feRow!, columnId: cell.dataset.feColumn! }; this.renderLayers(); this.renderInspector(); return }
    const action = target.closest<HTMLButtonElement>('[data-action]')
    if (!action) return
    const rowId = action.dataset.row
    const columnId = action.dataset.column
    switch (action.dataset.action) {
      case 'back': this.hide(); break
      case 'undo': this.store.undo(); this.refresh(); break
      case 'redo': this.store.redo(); this.refresh(); break
      case 'zoom-in': this.zoom = Math.min(3, this.zoom * 1.2); this.refresh(); break
      case 'zoom-out': this.zoom = Math.max(0.25, this.zoom / 1.2); this.refresh(); break
      case 'zoom-fit': this.zoom = Math.max(0.25, Math.min(1.5, (this.root.querySelector('.fe-scroll')!.clientWidth - 48) / (this.store.current.page.widthMm * 96 / 25.4))); this.refresh(); break
      case 'add-column': this.edit((draft) => addFigureColumn(draft)); break
      case 'remove-column': this.selection = { kind: 'page' }; this.edit((draft) => { draft.columns = draft.columns.filter((column) => column.id !== columnId); draft.linkedRegions = false }); break
      case 'row-up': case 'row-down': this.edit((draft) => { const index = draft.rows.findIndex((row) => row.id === rowId); const next = index + (action.dataset.action === 'row-up' ? -1 : 1); if (index >= 0 && next >= 0 && next < draft.rows.length) [draft.rows[index], draft.rows[next]] = [draft.rows[next], draft.rows[index]] }); break
      case 'row-toggle': this.edit((draft) => { const row = draft.rows.find((candidate) => candidate.id === rowId); if (row) row.included = !row.included }); break
      case 'adjust-region': if (columnId) void this.adjustRegion(columnId); break
      case 'save': void this.saveProject(false); break
      case 'save-as': void this.saveProject(true); break
      case 'open': void this.openProject(); break
      case 'relink-source': if (action.dataset.source) void this.relinkSource(action.dataset.source); break
      case 'export-svg': void this.exportFigure('svg'); break
      case 'export-png': void this.exportFigure('png'); break
    }
  }

  private onChange(event: Event): void {
    const input = event.target as HTMLInputElement | HTMLSelectElement
    const key = input.dataset.edit
    if (!key) return
    const number = Number(input.value)
    const selection = this.selection
    this.edit((draft) => {
      const page = draft.page
      if (key === 'figure-name') draft.name = input.value.trim() || 'Untitled figure'
      else if (key === 'page-title') page.title = input.value
      else if (key === 'page-width') page.widthMm = number
      else if (key === 'page-height') page.heightMm = number
      else if (key === 'page-margin') page.marginMm = number
      else if (key === 'page-label-width') page.labelWidthMm = number
      else if (key === 'page-column-gap') page.columnGapMm = number
      else if (key === 'page-row-gap') page.rowGapMm = number
      else if (key === 'page-ruler-height') page.rulerHeightMm = number
      else if (key === 'page-font') page.fontFamily = input.value.trim() || 'Arial, sans-serif'
      else if (key === 'page-font-size') page.fontSizePt = number
      else if (key === 'page-background') page.background = input.value
      else if (key === 'annotation-visible' || key === 'annotation-color') {
        const kind = input.dataset.annotationKind
        const id = input.dataset.annotation
        const annotation = kind === 'region' ? draft.sourceDocument.savedRegions.find((item) => item.id === id)
          : kind === 'divider' ? draft.sourceDocument.comparisonDividers.find((item) => item.id === id)
            : draft.sourceDocument.matrixOutlines.find((item) => item.id === id)
        if (annotation) {
          if (key === 'annotation-color') annotation.color = input.value
          else if ('highlighted' in annotation) annotation.highlighted = (input as HTMLInputElement).checked
          else if ('visible' in annotation) annotation.visible = (input as HTMLInputElement).checked
        }
      }
      else if (key === 'linked-regions') draft.linkedRegions = (input as HTMLInputElement).checked
      else if (key === 'column-title' && selection.kind === 'column') draft.columns.find((column) => column.id === selection.columnId)!.title = input.value
      else if (selection.kind === 'row' || selection.kind === 'cell') {
        const row = draft.rows.find((candidate) => candidate.id === selection.rowId)!
        if (key === 'row-label') row.label = input.value
        else if (key === 'row-group-label') row.groupLabel = input.value.trim() || undefined
        else if (key === 'row-height') row.heightMm = number
        else if (key === 'row-gap') row.gapAfterMm = number
        else if (key === 'row-font-size') row.labelFontSizePt = number
        else if (key === 'row-label-color') row.labelColor = input.value
        else if (key === 'row-frame-color') row.frameColor = input.value
        else if (key === 'row-frame-width') row.frameWidthPt = number
        else if (key === 'cell-track') {
          if (input.value === '__stack__') return
          draft.columns.find((column) => column.id === input.dataset.column)!.assignments[row.id] = input.value ? [input.value] : []
        } else if (key.startsWith('cell-')) {
          const column = draft.columns.find((item) => item.id === input.dataset.column)
          if (!column) return
          const styles = column.styles ??= {}
          const style: FigureCellStyle = styles[row.id] ??= {}
          if (key === 'cell-color') style.color = input.value
          else if (key === 'cell-negative-color') style.negativeColor = input.value
          else if (key === 'cell-opacity') style.opacity = number
          else if (key === 'cell-render-style') style.renderStyle = input.value as FigureCellStyle['renderStyle']
          else if (key === 'cell-scale-mode') { style.scaleMode = input.value as FigureCellStyle['scaleMode']; if (style.scaleMode === 'fixed') { style.scaleMin ??= 0; style.scaleMax ??= 1 } }
          else if (key === 'cell-scale-min') style.scaleMin = number
          else if (key === 'cell-scale-max') style.scaleMax = number
          else if (key === 'cell-show-scale') style.showScale = (input as HTMLInputElement).checked
        }
      }
    })
  }

  private async adjustRegion(columnId: string): Promise<void> {
    const doc = this.store.current
    const column = doc.columns.find((candidate) => candidate.id === columnId)
    if (!column) return
    const chromosomeLength = (chr: string, fallbackEnd: number) => this.options.chromosomes(doc.referenceId)?.get(chr) ?? Math.max(fallbackEnd * 2, fallbackEnd + 1_000_000)
    const initial = { ...column.region }
    const span = initial.end - initial.start
    let context: Region = { chr: initial.chr, start: Math.max(0, Math.floor(initial.start - span / 2)), end: Math.min(chromosomeLength(initial.chr, initial.end), Math.ceil(initial.end + span / 2)) }
    let selected = { ...initial }
    const plotStart = (doc.page.marginMm + doc.page.labelWidthMm) / 180
    const plotFraction = (180 - doc.page.marginMm * 2 - doc.page.labelWidthMm) / 180
    const dialog = document.createElement('dialog')
    dialog.className = 'fe-region-dialog'
    dialog.innerHTML = `<header><strong>Adjust figure region</strong><button type="button" data-crop="close" aria-label="Close">×</button></header><p>Drag the crop lines to extend or shrink the figure. Zoom out here for more context; the figure changes only when you apply.</p><div class="fe-crop-tools"><button type="button" data-crop="zoom-out">Wider context</button><input data-crop="locus" aria-label="Gene or genomic coordinates" placeholder="Gene or chr:start-end"/><button type="button" data-crop="go">Go</button><select data-crop="saved" aria-label="Saved region"><option value="">Saved regions…</option>${doc.sourceDocument.savedRegions.map((saved) => `<option value="${esc(saved.id)}">${esc(saved.label)}</option>`).join('')}</select></div><div class="fe-crop-view"><div class="fe-crop-preview"></div><div class="fe-crop-overlay"><div class="fe-crop-shade is-left"></div><div class="fe-crop-shade is-right"></div><button class="fe-crop-handle is-left" type="button" aria-label="Drag left figure boundary"></button><button class="fe-crop-handle is-right" type="button" aria-label="Drag right figure boundary"></button></div></div><div class="fe-crop-values"><label>Start <input data-crop="start" type="number" min="0" step="1"/></label><label>End <input data-crop="end" type="number" min="1" step="1"/></label><span data-crop="description"></span></div><footer><button type="button" data-crop="cancel">Cancel</button><button type="button" data-crop="apply">Apply region</button></footer>`
    this.root.append(dialog)
    dialog.showModal()
    let generation = 0
    const updateGuides = (): void => {
      const left = Math.max(0, Math.min(100, (plotStart + (selected.start - context.start) / (context.end - context.start) * plotFraction) * 100))
      const right = Math.max(0, Math.min(100, (plotStart + (selected.end - context.start) / (context.end - context.start) * plotFraction) * 100))
      dialog.querySelector<HTMLElement>('.fe-crop-handle.is-left')!.style.left = `${left}%`
      dialog.querySelector<HTMLElement>('.fe-crop-handle.is-right')!.style.left = `${right}%`
      dialog.querySelector<HTMLElement>('.fe-crop-shade.is-left')!.style.width = `${left}%`
      dialog.querySelector<HTMLElement>('.fe-crop-shade.is-right')!.style.left = `${right}%`
      dialog.querySelector<HTMLElement>('.fe-crop-shade.is-right')!.style.width = `${100 - right}%`
      dialog.querySelector<HTMLInputElement>('[data-crop="start"]')!.value = String(selected.start)
      dialog.querySelector<HTMLInputElement>('[data-crop="end"]')!.value = String(selected.end)
      dialog.querySelector<HTMLElement>('[data-crop="description"]')!.textContent = formatLocus(selected)
    }
    const drawContext = async (): Promise<void> => {
      const version = ++generation
      const temporary = structuredClone(doc)
      temporary.columns = [{ ...structuredClone(column), region: context }]
      temporary.page.widthMm = 180
      try {
        const result = await this.session.render(temporary, this.sources, this.options.genes())
        if (version !== generation || !dialog.isConnected) return
        const preview = dialog.querySelector<HTMLElement>('.fe-crop-preview')!
        preview.innerHTML = result.svg
        preview.querySelector('svg')!.style.width = '100%'
        updateGuides()
      } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true) }
    }
    const close = (): void => { generation++; dialog.close(); dialog.remove() }
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close() })
    dialog.addEventListener('click', (event) => {
      const action = (event.target as Element).closest<HTMLElement>('[data-crop]')?.dataset.crop
      if (action === 'close' || action === 'cancel') close()
      else if (action === 'apply') { this.edit((draft) => setFigureColumnRegion(draft, columnId, selected)); close() }
      else if (action === 'zoom-out') {
        const width = context.end - context.start
        context = { chr: context.chr, start: Math.max(0, Math.floor(context.start - width / 2)), end: Math.min(chromosomeLength(context.chr, context.end), Math.ceil(context.end + width / 2)) }
        void drawContext()
      } else if (action === 'go') {
        const value = dialog.querySelector<HTMLInputElement>('[data-crop="locus"]')!.value
        const region = parseLocus(value, this.options.chromosomes(doc.referenceId) ?? new Map())
        const gene = this.options.genes()?.find(value)
        const next = region || (gene ? { chr: gene.chr, start: Math.max(0, gene.start - Math.round((gene.end - gene.start) * 0.2)), end: gene.end + Math.round((gene.end - gene.start) * 0.2) } : undefined)
        if (!next) { this.toast('Enter a valid gene or genomic region.', true); return }
        selected = { ...next, end: Math.min(next.end, chromosomeLength(next.chr, next.end)) }
        context = { chr: next.chr, start: Math.max(0, next.start - (next.end - next.start) / 2), end: Math.min(chromosomeLength(next.chr, next.end), next.end + (next.end - next.start) / 2) }
        void drawContext()
      }
    })
    dialog.querySelector<HTMLSelectElement>('[data-crop="saved"]')!.addEventListener('change', (event) => {
      const saved = doc.sourceDocument.savedRegions.find((item) => item.id === (event.target as HTMLSelectElement).value)
      if (!saved) return
      selected = { ...saved.region }
      context = { chr: selected.chr, start: Math.max(0, selected.start - (selected.end - selected.start) / 2), end: Math.min(chromosomeLength(selected.chr, selected.end), selected.end + (selected.end - selected.start) / 2) }
      void drawContext()
    })
    for (const side of ['left', 'right'] as const) {
      const handle = dialog.querySelector<HTMLElement>(`.fe-crop-handle.is-${side}`)!
      handle.addEventListener('pointerdown', (event) => { handle.setPointerCapture(event.pointerId); event.preventDefault() })
      handle.addEventListener('pointermove', (event) => {
        if (!handle.hasPointerCapture(event.pointerId)) return
        const bounds = dialog.querySelector<HTMLElement>('.fe-crop-overlay')!.getBoundingClientRect()
        const fraction = ((event.clientX - bounds.left) / bounds.width - plotStart) / plotFraction
        const coordinate = Math.round(context.start + Math.max(0, Math.min(1, fraction)) * (context.end - context.start))
        if (side === 'left') selected.start = Math.min(coordinate, selected.end - 1)
        else selected.end = Math.max(coordinate, selected.start + 1)
        updateGuides()
      })
    }
    for (const side of ['start', 'end'] as const) dialog.querySelector<HTMLInputElement>(`[data-crop="${side}"]`)!.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLInputElement).value)
      if (!Number.isSafeInteger(value) || value < 0 || value > chromosomeLength(selected.chr, selected.end)) { this.toast('Coordinate is outside the chromosome.', true); return }
      selected[side] = value
      if (selected.end <= selected.start) selected.end = selected.start + 1
      if (selected.start < context.start || selected.end > context.end) {
        const width = selected.end - selected.start
        context = { chr: selected.chr, start: Math.max(0, selected.start - width / 2), end: Math.min(chromosomeLength(selected.chr, selected.end), selected.end + width / 2) }
        void drawContext()
      } else updateGuides()
    })
    updateGuides()
    void drawContext()
  }

  private async openProject(): Promise<void> {
    try {
      if (JSON.stringify(this.store.current) !== this.savedSnapshot && !await this.confirmDiscard()) return
      let contents: string
      let path: string | undefined
      if (isDesktopApp()) {
        path = (await pickNativeFilePaths({ title: 'Open GeRAFE figure project', category: 'FIGURE PROJECTS', fileMatches: (name) => /\.gerafe-figure\.json$/i.test(name), startFolder: localStorage.getItem(FIGURE_FOLDER_KEY) || undefined }))?.[0]
        if (!path) return
        contents = await readNativeTextFile(path)
      } else {
        const file = await chooseBrowserFile('.gerafe-figure.json,.json')
        if (!file) return
        contents = await file.text()
      }
      const next = normalizeFigureDocument(JSON.parse(contents))
      this.sources = await this.options.restoreSources(next)
      this.session = new FigureRenderSession()
      this.store = new FigureDocumentStore(next)
      this.savedSnapshot = JSON.stringify(this.store.current)
      this.projectPath = path
      this.selection = { kind: 'page' }
      if (path) rememberFigureFolder(path)
      this.refresh()
      this.toast(`Opened ${next.name}`)
    } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true) }
  }

  private async relinkSource(sourceId: string): Promise<void> {
    try {
      const reopened = await this.options.relinkSource(this.store.current, sourceId)
      if (!reopened) return
      const next = new Map(this.sources)
      next.set(sourceId, reopened.source)
      this.sources = next
      this.store.edit((draft) => {
        const index = draft.sourceDocument.sources.findIndex((item) => item.id === sourceId)
        if (index >= 0) draft.sourceDocument.sources[index] = { ...reopened.sourceSpec, id: sourceId }
      })
      this.session.clear()
      this.refresh()
      this.toast('Source reopened for this figure')
    } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true) }
  }

  private async saveProject(as: boolean): Promise<void> {
    try {
      const name = safeFileStem(this.store.current.name) + '.gerafe-figure.json'
      const path = isDesktopApp() ? as || !this.projectPath ? await this.pickSavePath(name, 'json') : this.projectPath : undefined
      if (isDesktopApp() && !path) return
      const contents = JSON.stringify(this.store.current, null, 2)
      if (path) { await writeNativeTextFile(path, contents); this.projectPath = path; rememberFigureFolder(path); this.toast(`Saved ${name}`) }
      else downloadBlob(new Blob([contents], { type: 'application/json' }), name)
      this.savedSnapshot = JSON.stringify(this.store.current)
    } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true) }
  }

  private async exportFigure(format: 'svg' | 'png'): Promise<void> {
    const status = this.root.querySelector<HTMLElement>('[data-role="status"]')!
    try {
      const dpi = format === 'png' ? Number((await this.askDpi()) ?? 0) : 600
      if (!dpi) return
      status.textContent = `Rendering ${format.toUpperCase()} from source data…`
      const result = await this.session.render(this.store.current, this.sources, this.options.genes(), dpi)
      if (result.issues.length && !await this.confirmIssues(result.issues)) { this.refresh(); return }
      const name = safeFileStem(this.store.current.name) + `.${format}`
      const path = isDesktopApp() ? await this.pickSavePath(name, format) : undefined
      if (isDesktopApp() && !path) { this.refresh(); return }
      if (format === 'svg') {
        if (path) await writeNativeTextFile(path, result.svg)
        else downloadBlob(new Blob([result.svg], { type: 'image/svg+xml' }), name)
      } else {
        const blob = await figureSvgToPng(result.svg, result.widthMm, result.heightMm, dpi)
        if (path) await writeNativeBlob(path, blob)
        else downloadBlob(blob, name)
      }
      if (path) rememberFigureFolder(path)
      this.toast(`Exported ${name}${format === 'png' ? ` at ${dpi} DPI` : ''}`)
      this.refresh()
    } catch (error) { this.toast(error instanceof Error ? error.message : String(error), true); this.refresh() }
  }

  private async pickSavePath(name: string, format: 'json' | 'svg' | 'png'): Promise<string | undefined> {
    const path = (await pickNativeFilePaths({ title: format === 'json' ? 'Save GeRAFE figure project' : `Export ${format.toUpperCase()} figure`, category: format === 'json' ? 'FIGURE PROJECTS' : 'FIGURE EXPORT', fileMatches: (value) => value.toLowerCase().endsWith(format === 'json' ? '.gerafe-figure.json' : `.${format}`), startFolder: localStorage.getItem(FIGURE_FOLDER_KEY) || undefined, saveFileName: name }))?.[0]
    if (!path) return undefined
    const folder = parentFolderOfFile(path)
    if (!folder) throw new Error('Choose a folder for the figure file.')
    const exists = (await listNativeDirectory(folder)).entries.some((entry) => !entry.isDirectory && nativeFilePathKey(entry.path) === nativeFilePathKey(path))
    if (exists && !await this.confirmIssues([`${path} already exists. Replace it?`], 'Replace file')) return undefined
    return path
  }

  private askDpi(): Promise<'300' | '600' | undefined> {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog')
      dialog.className = 'fe-confirm'
      dialog.innerHTML = '<h2>PNG resolution</h2><p>Choose export resolution. The genomic data will be queried again for the output size.</p><footer><button type="button" value="cancel">Cancel</button><button type="button" value="300">300 DPI</button><button type="button" value="600">600 DPI</button></footer>'
      this.root.append(dialog); dialog.showModal()
      const finish = (value?: '300' | '600') => { dialog.close(); dialog.remove(); resolve(value) }
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish() })
      dialog.addEventListener('click', (event) => { const value = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.value; if (value) finish(value === '300' || value === '600' ? value : undefined) })
    })
  }

  private confirmIssues(issues: string[], confirmLabel = 'Export with omissions'): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog')
      dialog.className = 'fe-confirm'
      dialog.innerHTML = `<h2>${confirmLabel === 'Replace file' ? 'Replace existing file?' : 'Figure export has missing data'}</h2><ul>${issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul><footer><button type="button" value="cancel">Cancel</button><button type="button" value="continue">${esc(confirmLabel)}</button></footer>`
      this.root.append(dialog); dialog.showModal()
      const finish = (accepted: boolean) => { dialog.close(); dialog.remove(); resolve(accepted) }
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false) })
      dialog.addEventListener('click', (event) => { const value = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.value; if (value) finish(value === 'continue') })
    })
  }

  private confirmDiscard(): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog')
      dialog.className = 'fe-confirm'
      dialog.innerHTML = '<h2>Open another figure?</h2><p>Unsaved changes in this figure will be lost. Save the project first if you want to keep them.</p><footer><button type="button" value="cancel">Keep editing</button><button type="button" value="continue">Open another project</button></footer>'
      this.root.append(dialog); dialog.showModal()
      const finish = (accepted: boolean) => { dialog.close(); dialog.remove(); resolve(accepted) }
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false) })
      dialog.addEventListener('click', (event) => { const value = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.value; if (value) finish(value === 'continue') })
    })
  }

  private toast(message: string, error = false): void {
    const node = this.root.querySelector<HTMLElement>('[data-role="toast"]')!
    node.hidden = false; node.textContent = message; node.classList.toggle('is-error', error)
    window.setTimeout(() => { if (node.textContent === message) node.hidden = true }, 5000)
  }
}

function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
function safeFileStem(value: string): string { return value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'figure' }
function rememberFigureFolder(path: string): void { const folder = parentFolderOfFile(path); if (folder) localStorage.setItem(FIGURE_FOLDER_KEY, folder) }
function downloadBlob(blob: Blob, name: string): void { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }
function chooseBrowserFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => { const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.addEventListener('change', () => resolve(input.files?.[0]), { once: true }); input.click() })
}
async function writeNativeBlob(path: string, blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 16_384) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 16_384)))
  await invoke('write_binary_file', { path, base64Contents: btoa(chunks.join('')) })
}
