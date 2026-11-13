import { annotationFormat, readGeneAnnotation, type AnnotationFormat } from './gene-annotation.ts'
import { isDesktopApp, writeNativeBlob } from './native-file.ts'
import { pickNativeFilePaths } from './desktop-track-picker.ts'
import type { GeneSource, ReferenceGenome } from './reference.ts'

export interface AnnotationCatalogEntry { id: string; label: string; assembly: string; provider: string; format: AnnotationFormat; url: string; fileName: string; details: string }
export const ANNOTATION_CATALOG: readonly AnnotationCatalogEntry[] = [
  ...['hg38', 'hg19', 'mm39', 'mm10'].flatMap((assembly) => [
    { id: `${assembly}-ncbi-refseq`, label: 'NCBI RefSeq', assembly, provider: 'UCSC', format: 'genepred' as const, url: `https://hgdownload.soe.ucsc.edu/goldenPath/${assembly}/database/ncbiRefSeq.txt.gz`, fileName: `${assembly}.ncbiRefSeq.genepred.gz`, details: 'NCBI transcript placements. UCSC table snapshot at download time.' },
    { id: `${assembly}-refgene`, label: 'UCSC RefSeq', assembly, provider: 'UCSC', format: 'genepred' as const, url: `https://hgdownload.soe.ucsc.edu/goldenPath/${assembly}/database/refGene.txt.gz`, fileName: `${assembly}.refGene.genepred.gz`, details: 'RefSeq transcripts aligned by UCSC; may differ from NCBI placements.' },
  ]),
  { id: 'hg38-gencode49', label: 'GENCODE v49 · Basic', assembly: 'hg38', provider: 'GENCODE', format: 'gtf', url: 'https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_49/gencode.v49.basic.annotation.gtf.gz', fileName: 'gencode.v49.basic.annotation.gtf.gz', details: 'GRCh38.p14. Basic transcript subset; about 68 MB compressed.' },
  { id: 'hg38-ensembl115', label: 'Ensembl release 115', assembly: 'hg38', provider: 'Ensembl', format: 'gtf', url: 'https://ftp.ensembl.org/pub/release-115/gtf/homo_sapiens/Homo_sapiens.GRCh38.115.gtf.gz', fileName: 'Homo_sapiens.GRCh38.115.gtf.gz', details: 'GRCh38. Versioned release; about 104 MB compressed.' },
]

export function referenceAssembly(reference: ReferenceGenome): string | undefined {
  const chr1 = reference.chromosomes.get('chr1') ?? reference.chromosomes.get('1')
  return new Map([[248956422, 'hg38'], [249250621, 'hg19'], [195154279, 'mm39'], [195471971, 'mm10']]).get(chr1 ?? 0)
}

type CachedAnnotation = { blob: Blob; downloadedAt: string }
async function annotationCache<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('gerafe-public-annotations', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('files', mode)
      const request = work(transaction.objectStore('files'))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('Annotation cache transaction was aborted.'))
    })
  } finally { db.close() }
}

export async function cachedAnnotation(url: string): Promise<CachedAnnotation | undefined> {
  return annotationCache('readonly', (store) => store.get(url))
}
export async function restoreCachedAnnotation(url: string, format: AnnotationFormat, name: string, chromosomes: ReadonlyMap<string, number>): Promise<GeneSource> {
  const cached = await cachedAnnotation(url)
  if (!cached) throw new Error('Downloaded annotation is not cached on this computer. Download it again from Gene annotations, or relink a local copy.')
  return readGeneAnnotation(cached.blob.stream(), true, format, name, chromosomes)
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function openAnnotationLibrary(options: {
  anchor?: HTMLElement
  reference: ReferenceGenome
  add(source: GeneSource, entry: AnnotationCatalogEntry, size: number, downloadedAt: string): void
  importLocal(): void
  bundled(): void
}): void {
  const modal = document.createElement('dialog')
  modal.className = 'menu-popover annotation-library'
  modal.setAttribute('aria-label', 'Gene annotations')
  modal.setAttribute('aria-modal', 'false')
  const assembly = referenceAssembly(options.reference)
  modal.innerHTML = `<header><strong>Gene annotations</strong><button class="menu-item annotation-library-close" data-action="close" aria-label="Close gene annotations">×</button></header>
    <p>Add independent gene tracks from local files or download a public annotation. Active reference: <strong>${escape(options.reference.name)}</strong>.</p>
    <div class="annotation-library-tools"><button class="menu-item" data-action="import">Import local annotation…</button>${assembly === 'hg38' ? '<button class="menu-item" data-action="bundled">Show bundled RefSeq</button>' : ''}<label>Assembly <select data-role="assembly">${['hg38', 'hg19', 'mm39', 'mm10'].map((id) => `<option ${id === assembly ? 'selected' : ''}>${id}</option>`).join('')}</select></label></div>
    <p class="annotation-library-hint">Local files: GTF, GFF3, or genePred (including gzip). Files must match the active reference. UCSC genePred downloads use the .genepred.gz extension for importing later.</p>
    <div class="annotation-library-list"></div><p role="status" class="annotation-library-status"></p>`
  const list = modal.querySelector<HTMLElement>('.annotation-library-list')!
  const status = modal.querySelector<HTMLElement>('[role="status"]')!
  let controller: AbortController | undefined
  const close = () => {
    controller?.abort()
    document.removeEventListener('pointerdown', dismissOutside)
    document.removeEventListener('keydown', dismissWithEscape)
    window.removeEventListener('resize', position)
    modal.close(); modal.remove()
  }
  const dismissOutside = (event: PointerEvent) => {
    const target = event.target as Element
    if (!modal.contains(target) && !target.closest('.track-file-picker')) close()
  }
  const dismissWithEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.track-file-picker')) return
    close(); options.anchor?.focus()
  }
  const position = () => {
    const anchor = options.anchor?.getBoundingClientRect()
    const top = Math.max(8, Math.min(anchor?.bottom ?? 46, window.innerHeight - 100))
    modal.style.left = `${Math.max(8, Math.min(anchor?.left ?? 12, window.innerWidth - modal.offsetWidth - 8))}px`
    modal.style.top = `${top}px`
    modal.style.maxHeight = `${window.innerHeight - top - 8}px`
  }
  const render = () => {
    const selected = modal.querySelector<HTMLSelectElement>('select')!.value
    list.innerHTML = ANNOTATION_CATALOG.filter((entry) => entry.assembly === selected).map((entry) => `<article><div><strong>${escape(entry.label)}</strong><small>${escape(entry.provider)} · ${escape(entry.assembly)} · ${entry.format === 'genepred' ? 'genePred' : entry.format.toUpperCase()}</small><p>${escape(entry.details)}</p></div><div class="annotation-library-actions"><button class="menu-item" data-add="${entry.id}" ${entry.assembly !== assembly ? 'disabled title="Switch to this assembly before adding tracks"' : ''}>Download and add track</button><button class="menu-item" data-save="${entry.id}">Download file…</button><button class="menu-item" data-copy="${entry.id}">Copy download URL</button></div></article>`).join('')
  }
  modal.addEventListener('cancel', (event) => { event.preventDefault(); close() })
  modal.querySelector('select')!.addEventListener('change', render)
  modal.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.dataset.action === 'close') { close(); return }
    if (button.dataset.action === 'import') { close(); options.importLocal(); return }
    if (button.dataset.action === 'bundled') { options.bundled(); close(); return }
    const entry = ANNOTATION_CATALOG.find((item) => item.id === (button.dataset.add ?? button.dataset.save ?? button.dataset.copy))
    if (!entry || controller) return
    try {
      if (button.dataset.copy) { await navigator.clipboard.writeText(entry.url); status.textContent = 'Copied download URL.'; return }
      // Request the save location before downloading a potentially large file.
      const savePath = button.dataset.save && isDesktopApp()
        ? (await pickNativeFilePaths({ title: 'Download gene annotation', category: 'GENE ANNOTATION', fileMatches: (name) => Boolean(annotationFormat(name)), saveFileName: entry.fileName }))?.[0] : undefined
      if (button.dataset.save && isDesktopApp() && !savePath) return
      controller = new AbortController()
      modal.querySelectorAll<HTMLButtonElement>('[data-add], [data-save]').forEach((item) => { item.disabled = true })
      status.textContent = `Checking cached ${entry.label}…`
      let cached = await cachedAnnotation(entry.url).catch(() => undefined)
      let cacheSaved = Boolean(cached)
      if (!cached) {
        status.textContent = `Downloading ${entry.label}…`
        const response = await fetch(entry.url, { signal: controller.signal, credentials: 'omit' })
        if (!response.ok) throw new Error(`Download failed (${response.status}). Copy the URL to download in your browser, then import the file.`)
        const total = Number(response.headers.get('content-length'))
        const reader = response.body!.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []
        let received = 0
        while (true) {
          const part = await reader.read()
          if (part.done) break
          chunks.push(part.value); received += part.value.byteLength
          if (received > 256 * 1024 * 1024) { await reader.cancel(); throw new Error('Annotation download exceeds 256 MB compressed. Download and import it locally.') }
          status.textContent = `Downloading ${entry.label}: ${(received / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
        }
        cached = { blob: new Blob(chunks), downloadedAt: new Date().toISOString() }
        cacheSaved = await annotationCache('readwrite', (store) => store.put(cached, entry.url)).then(() => true).catch(() => false)
      }
      if (!modal.isConnected || controller.signal.aborted) return
      if (button.dataset.save) {
        if (savePath) await writeNativeBlob(savePath, cached.blob)
        else {
          const url = URL.createObjectURL(cached.blob), link = document.createElement('a')
          link.href = url; link.download = entry.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
        }
        status.textContent = `Downloaded ${entry.fileName}.`
      } else {
        status.textContent = `Reading ${entry.label}…`
        const source = await readGeneAnnotation(cached.blob.stream(), true, entry.format, entry.label, options.reference.chromosomes, (lines) => { status.textContent = `Reading ${entry.label}: ${lines.toLocaleString()} records…` }, controller.signal)
        if (!modal.isConnected || controller.signal.aborted) return
        options.add(source, entry, cached.blob.size, cached.downloadedAt)
        status.textContent = `Added ${entry.label}.${cacheSaved ? ' Download cached for reopening.' : ' Cache unavailable; save a local copy for reopening.'}`
      }
    } catch (error) { if (modal.isConnected) status.textContent = error instanceof Error ? error.message : String(error) }
    finally { controller = undefined; if (modal.isConnected) render() }
  })
  document.body.append(modal); render(); modal.show(); position()
  document.addEventListener('pointerdown', dismissOutside)
  document.addEventListener('keydown', dismissWithEscape)
  window.addEventListener('resize', position)
}
