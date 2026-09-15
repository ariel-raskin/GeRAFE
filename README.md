# GeRAF

**GeRAF — Genomic Renderer and Figures** is a local desktop application for fast genome browsing and, in later phases, publication-quality genomic figure building from the same semantic track document. The current prototype is still packaged internally as **Locus Glide**; executable names, application identifiers, and icons will be migrated separately.

It currently renders **BigWig**, **TDF**, smaller **bedGraph**, indexed **BAM alignments and coverage**, and **BED intervals** directly from disk.

Development before the GitHub migration is summarized in [`docs/DEVELOPMENT_HISTORY.md`](docs/DEVELOPMENT_HISTORY.md). New work follows the issue/branch/pull-request process in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Run it

```powershell
npm install
npm run desktop:dev
```

This opens a normal desktop window. The production executable is built with:

```powershell
npm run desktop:build
```

After building, double-click **Launch Locus Glide.cmd** in this top-level folder. The executable itself is written to `src-tauri/target/release/locus-glide.exe`. Production embeds the interface and starts no web server. Use **File → Open tracks…**, press `Ctrl+O`, or drop files onto the viewer. Supported extensions are `.bw`, `.bigWig`, `.bedGraph`, `.tdf`, `.bam` plus `.bai`/`.csi`, and `.bed`. The desktop app automatically finds a conventionally named BAM index beside the BAM; in a web browser, select the data file and index together. Files can live anywhere and are never uploaded.

Controls:

- drag horizontally to pan;
- use the mouse wheel to move vertically through a long track stack or through an overflowing gene track under the pointer; hold `Ctrl` while scrolling, double-click, or use `+`/`−` to zoom;
- enter a gene symbol such as `RUNX1`, or conventional 1-based coordinates such as `chr8:127,700,001-127,900,000`;
- use the moon/sun toolbar button to switch theme; the desktop app remembers the selection.

Track management is incorporated into the left label gutter: right-click a track label for its type-specific options. Click selects one track, `Ctrl`-click toggles tracks, `Shift`-click selects a range, and `Ctrl+A` selects every visible track before applying shared color, visual-group, scale-linking, height, or removal actions. Clicking elsewhere clears track selection; `Ctrl+A` retains its normal text-selection behavior while typing in an input. Dragging shows a floating preview and insertion target. Ungrouped selections and complete groups move together; an individual grouped track can be reordered among its group members but cannot be dragged out of the group. A group is marked by a colored card-like label spanning its tracks. Click that card to select all group members; its selection ring and dot indicate that the complete group is selected. Right-click it to select its members, add selected or newly opened tracks, set group height or color, choose shared or independent autoscaling, fix a shared range, rename it, ungroup it, or remove all of its tracks. New members inherit explicit group color and scale behavior. Visual grouping and scale linkage remain independent unless the user deliberately chooses a group-scale action.

Track height is presented as a simple `1–100` value. Track names remain vertically centered and wrap to however many lines the chosen height permits. **Fit tracks** in the top toolbar assigns all visible upper-pane tracks a height that fits the currently available space.

The viewer has two independently scrollable track panes. RefSeq genes begin in the resizable lower pane, initially fitted exactly to the gene-track height, but they are an ordinary track: drag any track or complete group between the upper and lower panes. Drag the divider to resize the lower overlay; it expands over the upper pane rather than compressing upper tracks. The ideogram, span ruler, and coordinate ticks remain fixed above the scrolling upper tracks. Genomic panning and `Ctrl`+wheel zoom remain synchronized between both panes.

The browser and future figure maker use a versioned semantic track document. Layout state is saved automatically with 100-step undo/redo, and **File** can save or reopen a `.locus.json` workspace. In the desktop app, sources opened through the native picker retain their local paths and reopen automatically on the same computer; missing, moved, or changed files remain as relinkable offline tracks. Browser-development sessions cannot retain browser `File` objects and therefore still require relinking after reload. Workspace files store paths and provenance, not genomic bytes, so moving a workspace to another computer requires relinking its local sources.

**Edit → Undo track change / Redo track change** reverses document operations such as adding, removing, renaming, recoloring, reordering, grouping, or changing scale policy. It intentionally does not walk backward through every pan or zoom gesture; genome navigation updates the current workspace location without flooding the edit history.

Human hg38 is included as the initial reference, with indexes generated from the real local `hg38.ncbiRefSeq.gtf`. Its 58,523 gene spans power case-insensitive gene-symbol search, while chromosome-specific detail indexes provide 191,564 RefSeq transcript models without delaying startup. Gene tracks render each transcript structure in one solid track color, with thin UTR portions, taller CDS portions, regularly spaced strand arrows, and a compact elbow-style TSS indicator in collapsed view when the TSS is visible. Direction arrows switch to the theme background color where they cross an exon, keeping the otherwise single-color structure legible. The TSS indicators can be disabled under **Settings**. Their right-click menu switches among collapsed representative-transcript, expanded multi-transcript, and squished multi-transcript views; every mode retains a gene-symbol label above its transcript stack, and overflowing transcript stacks scroll within the track. The RefSeq track initially opens in the lower pane but can then be reordered or moved like any other track. The **Reference** selector remembers the default choice. Its `+` button imports another assembly from a `.fai`, `.genome`, `.chrom.sizes`, or other two-column chromosome-size file; only chromosome names and lengths are retained, so the source file does not need to remain connected. Custom assemblies currently have coordinate navigation but no bundled gene annotation.

The hg38 coordinate header also includes the real UCSC cytoband ideogram, a pinched centromere, a red marker for the current viewport, and a dimension line showing the visible genomic span. Custom references use a neutral whole-chromosome bar until a cytoband file is associated with them.

The desktop security policy explicitly permits the parser's inlined `data:application/wasm` decompressor while continuing to block remote connections. This is required for compressed BigWig and BAM blocks to decode without producing `Failed to fetch`.

## What this milestone proves

The high-frequency path—pointer input, coordinate transformation, and drawing—is synchronous and does no network or disk work. Each data request covers three viewport widths. While the current viewport remains inside that padded region, panning only redraws already-decoded values. BigWig resolution selection is driven by bases per pixel, so the parser reads summaries rather than base-resolution signal when zoomed out.

This is intentionally narrower than IGV. It proves the interaction and shared-document architecture before adding variants, general annotation import, reference sequence bases, or multi-locus views. BAM tracks now combine zoom-aware coverage with packed read alignments. Their context menu controls coverage/read visibility, expanded/collapsed/squished packing, pairing, mismatch display, coloring, MAPQ, and duplicate/secondary/supplementary filters. Mismatch recovery for BAMs without MD tags will arrive with reference FASTA/2bit support.

## Verification

```powershell
npm test
npm run build
npm run desktop:build
npm run benchmark:data -- "C:\path\to\signal.bw"
```

The viewer reports canvas draw time, approximate interactive FPS, and visible feature count in its footer. The Node benchmark measures indexed BigWig reads independently of rendering.

## Format strategy

| Data | First implementation | Reason |
| --- | --- | --- |
| BigWig | direct indexed reads | built-in zoom summaries and random access |
| TDF | direct indexed tile reads | compressed/uncompressed fixed-step, variable-step, BED, and BED-with-name tiles with zoom summaries |
| BAM | indexed coverage and read pileups | BAI/CSI, CIGAR geometry, pairing, mismatch/indel/splice marks, packing, color modes, and filters |
| BED | BED3–BED12 interval drawing | collapsed, expanded, and squished views; BED12 blocks/thick regions and item RGB |
| CRAM | indexed range reads in workers | reference-aware decoding and row packing are CPU-heavy |
| VCF | bgzip + Tabix/CSI | bounded reads per locus |
| GTF / GFF / BED | Tabix or convert to BigBed | raw genome-scale text cannot pan predictably |
| `.cool` / `.mcool` | multiresolution tiles | 2D matrices need a separate GPU track renderer |

The correct data root is `Stengel_Raskin/Data`. Its sequencing-relevant inventory includes about 1,232 BigWig files, 70 BAMs, 56 bedGraphs, 430 TDFs, thousands of BED/peak files, VCF/Tabix data, 48 `.cool/.mcool` files, and seven `.hic` files. Large `.fastq.gz` inputs are raw reads and are deliberately not browser tracks. Nothing from `Data` is copied or modified.

## Why this architecture

- [IGV.js](https://github.com/igvteam/igv.js) validates browser-side indexed genomics access and provides the compatibility baseline.
- [GMOD bbi-js](https://github.com/GMOD/bbi-js) supplies BigWig/BigBed index traversal and WebAssembly decompression; we use it as a parser, not as the viewer.
- [GMOD bam-js](https://github.com/GMOD/bam-js) supplies BAM/BAI/CSI range reads and WebAssembly BGZF decompression.
- [HiGlass](https://docs.higlass.io/) demonstrates that map-like multiresolution tiles are the right abstraction for large 1D and 2D genomics data.
- [Tauri](https://v2.tauri.app/) packages the static renderer as a native desktop executable using the operating system WebView. There is no production HTTP server.

The browser and future publication-figure workflow will share one semantic track document. The findings and proposed model derived from the local `gene_tracks_organic` and `plotanical` projects are recorded in [`docs/TRACK_SYSTEM_DIRECTION.md`](docs/TRACK_SYSTEM_DIRECTION.md).

## Next gate

Next, add indexed VCF/GTF plus indexed large-annotation support, then reference FASTA/2bit bases and `.cool/.mcool` in a separate matrix renderer. TDF remains a compatibility format; where the source BigWig exists, the open indexed standard is preferable. If rendering—not parsing—exceeds the frame budget with many simultaneous tracks, replace only the track renderer with WebGPU/WebGL while keeping the same source and viewport interfaces.
