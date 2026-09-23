# Development history before Git

GeRAFE began under the working name **Locus Glide** in a local folder that was not a Git repository. This document preserves the most reliable development history available before the project moved to GitHub on September 14, 2026.

## How this history was reconstructed

The chronology below was reconstructed from the local Codex session transcripts, user requests, project documentation, generated-file timestamps, and the final verified source tree. Raw session logs are deliberately not committed: they contain machine-specific paths, tool internals, large embedded data, and unrelated context. Because no source snapshots or Git objects existed, the entries below are milestones rather than fabricated commits or exact line-level diffs.

The Git history beginning with the import pull request is authoritative and reproducible. This document is the provenance record for everything earlier.

## September 23, 2026 — online-only file opening

- Detect Windows offline/recall attributes before opening desktop-native tracks and saved sources. A temporary named row reports indeterminate activity or prepared-byte percentage while a cloud provider supplies the file, including BAM indexes; it disappears on completion or error.
- Local files and browser sessions keep their existing open path. The percentage represents bytes GeRAFE has read, not a provider-reported network percentage.
- Replaced the desktop native track Open and relink dialogs with an in-app folder browser after the native dialog was observed to stall before returning an online-only path. Directory enumeration reads names and entry types only; file-content hydration remains under GeRAFE's progress UI.
- Polished the picker with breadcrumb navigation, persisted favorite-folder buttons, and a track-open folder history separate from workspace paths. Cloud opens now reserve the destination track row and render progress there; Windows Cloud Files on-disk bytes are preferred when available, with prepared-byte progress clearly labeled as the fallback.
- Follow-up: explicitly request full-file hydration for Cloud Files placeholders, surface provider errors and a stalled-provider hint, and restore saved native sources independently so a blocked cloud source does not starve other tracks after refresh.
- A controlled probe of the reported 289 MB Dropbox `.bw` showed a third-party reparse tag and an ordinary Windows `File::open` blocking before it returned a handle for 45 seconds. The standard Cloud Files API therefore does not address that particular placeholder; the in-row hint directs users to Dropbox's **Make available offline** action when its provider does not return bytes.
- The in-app desktop track picker now shows metadata-only Online-only/On this device badges for Windows files and can refresh the folder after a cloud sync-state change. This makes candidate files identifiable before selecting them without hydrating their contents.
- The picker also marks native files already referenced by tracks in the current workspace, including pending sources and supporting BAM indexes. Full-path matching avoids confusing same-named files in different folders; the indicator refreshes from current document state and is not persisted separately.

## September 23, 2026 — upper track fitting

- Removed the lower pane's padding spacer from the upper track scroller, so fitted tracks meet the lower pane without a scrollable blank gap; genuine track overflow remains scrollable.

## September 22, 2026 — signal stack presentation

- Added reversible collapsed presentation for ordinary signal-only groups, including automatic shared y-axis scales.
- Added stack-wide color/pattern differentiation, a synchronized compact legend, smooth equal-opacity curves, and stack-only member visibility and ordering.
- Migrated workspaces to schema version 32; v30 fill stacks become equal-weight patterned lines and v31 stacks gain stable per-member style assignments, while incompatible or incomplete stack state is expanded safely during normalization.
- Fixed plain group clicks so they replace unrelated selections, removed the redundant selected-group dot, and kept saved-region/matrix annotation geometry fixed in genomic coordinates while the viewport pans.
- Corrected cis-matrix outline clipping so upper edges remain visible and editable after an anchor interval pans beyond the base axis.
- Kept each signal stack member's color and line pattern when changing draw order or hiding other members.

## September 13, 2026 — feasibility and first browser

- Established the core goal: remake the useful genome-navigation parts of IGV with immediate-feeling pan and zoom, then connect browsing to a future figure-building workflow.
- Audited the local sequencing-data collection and researched indexed browser-side genomics readers and rendering architectures.
- Built the TypeScript/Vite canvas viewer and a Tauri Windows desktop shell.
- Implemented direct local BigWig and bedGraph loading, indexed reads with viewport overscan, pan/zoom navigation, and performance instrumentation.
- Added initial BAM/BAI coverage support to validate indexed alignment-file access.
- Fixed desktop-local compressed-data decoding and packaged a standalone executable with no production web server.
- Added persistent light/dark themes and began replacing the prototype landing page with a compact desktop genome-browser interface.

## September 13–14, 2026 — reference and semantic track system

- Added the built-in hg38 reference, chromosome navigation, gene-symbol search, RefSeq gene spans, detailed transcript structures, and the cytoband ideogram.
- Added custom reference import from chromosome-size/FAI-style files and persistent reference selection.
- Studied the local `gene_tracks_organic` and `plotanical` projects to define a shared semantic track model for both browser and future figure renderer.
- Introduced a versioned workspace document with stable source, track, visual-group, scale-binding, pane, and provenance records plus undo/redo and workspace save/load.
- Added independent and linked scales, fixed/visible autoscaling, track groups, multiselection, type-aware context menus, track heights, and drag reordering.
- Split the viewer into independently scrollable upper and lower track panes while keeping genome navigation synchronized.
- Made gene annotations ordinary movable tracks and added collapsed, expanded, and squished transcript views.

The long-term browser/figure agreement and phased direction from this work are recorded in [`TRACK_SYSTEM_DIRECTION.md`](TRACK_SYSTEM_DIRECTION.md).

## September 14, 2026 — interaction and rendering refinement

- Refined group labels into spanning cards with whole-group selection, inherited group styling/scaling, add/open/remove actions, and group-aware dragging.
- Added selection clearing, input-aware keyboard shortcuts, stable drag previews, placement indicators, track fitting, and intuitive `1–100` height controls.
- Refined signal axes and label-card layout, including responsive maximum-value lanes.
- Reworked gene rendering with stable phased direction arrows, coding/UTR exon heights, overlap-aware contrast, TSS elbows, internal transcript scrolling, and theme-aware colors.
- Added a top-level launcher and persistent native source paths so desktop tracks reopen after application restart.
- Added BED3–BED12 interval parsing and collapsed/expanded/squished interval rendering.

## September 14, 2026 — BAM and TDF compatibility milestone

- Added a direct indexed TDF reader supporting compressed and uncompressed fixed-step, variable-step, BED, and BED-with-name tiles with zoom summaries and chromosome aliases.
- Replaced BAM coverage-only tracks with compound coverage and read-alignment tracks.
- Added CIGAR-aware blocks, splice/deletion/insertion/mismatch marks, deterministic pileup packing/downsampling, paired-read connectors, MAPQ and flag filters, packing modes, and multiple color modes.
- Added BAI and CSI support plus automatic adjacent-index discovery in the desktop app.
- Migrated the workspace format to schema version 4 so BAM display/filter settings persist and older BAM coverage tracks upgrade automatically.
- Verified the implementation with 30 unit tests, a 489 MB BAM/BAI, a 155 MB TDF, browser smoke tests, a production build, and a standalone Windows launch test.

## GitHub migration baseline

The repository import intentionally preserves GitHub's original `Initial commit`, adds this provenance document, and imports the complete verified source tree as the first code snapshot. From this point forward, issues describe meaningful work, branches isolate changes, pull requests preserve reviewable diffs and verification, and releases/tags will identify distributable milestones.
