# GeRAFE release notes

## 0.2.0 beta — 2026-09-23

This release expands the Genome Renderer substantially beyond the v0.1.3
contact-matrix beta. It is the GeR milestone before work begins on the
Figure Editor; figure composition and high-resolution figure export are
**planned, not included** in this release.

### Genomic tracks and analysis

- Added BAM inspection, read sorting/grouping, read-detail and mate navigation,
  filtering, mismatch controls, downsampling feedback, and a minimum
  coverage alternate-allele-frequency threshold.
- Added signal drawing and scale controls, including linked and fixed domains,
  and reversible signal-track stacks with shared scaling, member legends,
  per-track colors/patterns, visibility, and order.
- Added gene, BED, and BEDPE presentation and filtering controls.
- Expanded contact maps with observed/expected and log2 O/E views, native
  matrix difference/ratio comparisons, independent vertical-locus navigation
  for rectangular and trans views, and bounded tiled rendering for dense maps.
- Added BEDPE-on-matrix contact outlines and focus filtering, plus manually
  drawn matrix outlines that can be shared across compatible tracks.

### Browser and workspace workflow

- Added saved, editable region highlights and comparison dividers with
  configurable colors, line styles, fill, snap-to-bin selection, and
  independent signal scaling across divider sections.
- Added explicit workspace Save As, flexible pasted genomic-coordinate input,
  improved track fitting, and more compact browser layout and help controls.
- Added an in-app Windows track picker with folder shortcuts, cloud
  availability and in-workspace badges. Cloud-backed tracks reserve their
  normal row and show loading state while files are prepared; saved sources
  restore independently.
- Added IGV Desktop XML session import with a preview of supported formats,
  installed references, available paths and BAM indexes, individual relinking,
  and a clear report of unsupported or IGV-only items.

### Current limitations

- The Figure Editor is not yet implemented. See
  [the Figure Editor plan](docs/FIGURE_EDITOR_PLAN.md).
- Cloud-provider network download percentages are not available to GeRAFE;
  online-only files may show an indeterminate wait until the provider supplies
  the data.
- IGV import is desktop-only and does not recreate remote resources or
  IGV-specific panel and subtrack presentation.
- The installer is Windows x64 only and is signed for GeRAFE's updater but
  is not Windows Authenticode-signed; SmartScreen may warn on installation.

## 0.1.3 beta — 2026-09-17

This is the contact-matrix update. It adds local `.hic`, `.cool`, and `.mcool`
tracks alongside a substantial round of interaction-track, layout, and browser
control improvements.

### Contact matrices

- Open local `.hic`, `.cool`, and `.mcool` files as triangular cis contact maps.
- Choose compatible source resolutions and normalizations, flip matrices above
  or below their baseline, resize or lock their height, and apply shared actions
  to matrix selections and matrix-only groups.
- Scale by the visible maximum, a robust percentile, or a fixed z-min/z-max;
  exclude near-diagonal cells from automatic scaling without hiding them.
- Limit genomic depth automatically, to the full visual span, or to a fixed
  distance independent of track height.
- Use linear or logarithmic intensity, reverse score direction, and choose warm,
  blue-to-black, monochrome, or two-to-eight-color custom palettes.
- Inspect contacts with a crosshair and a configurable floating card. Zero,
  missing/NaN, and normalization-masked cells have distinct display controls.
- Show per-track gradient legends and share automatic matrix scales within
  linked visual groups.

The matrix renderer retains the direct sparse drawing path restored after dense
background filling and height-dependent queries caused panning regressions.

### Other data and track improvements

- Added BEDPE interaction-arc tracks with orientation controls and gene-based or
  visible-gene filtering.
- Added a native local index/cache for large `.bedGraph.gz` files and improved
  compressed bedGraph preparation speed.
- Added content-aware track fitting, locked heights, bottom-edge resizing,
  cross-pane movement, and more consistent group and multi-track actions.
- Refined signal baselines and scaling, compact BED tracks, collapsed gene
  layout, track-card labels, genomic rulers, cursors, and the chromosome picker.
- Reorganized context menus and global track behavior settings, with clearer
  terminology and confirmation for destructive workspace actions.

### Current limitations

- Contact matrices currently use one genomic locus as a triangular cis view.
  Interchromosomal/two-axis navigation, expected/observed transforms, comparison
  matrices, and matrix-derived annotation tracks are not yet implemented.
- Very deep, high-resolution views can contain enough cells to slow panning;
  bounded depth and coarser resolutions remain available for those cases.
- Explicit normalization masks are shown only when the active reader exposes
  them. The current `.hic` reader does not expose a standalone mask vector.
- The release installer is Windows x64 only and is not yet Authenticode-signed,
  so Windows SmartScreen may warn on first installation.

## 0.1.2 beta — 2026-09-16

- Added Track behavior options for automatic stranded-pair linking, shared group
  autoscaling, linked red/blue strand colors, and TSS-indicator visibility.
- Linked positive/negative signal tracks now render and autoscale independently
  as a visual pair.
- Added compressed `.bedGraph.gz` support for safely sized, unindexed files.
- Improved BED labels, compact automatic heights, fitting, group controls,
  genomic ticks, zoom controls, side-scroll panning, signal stability, and gene
  chevrons.
- Added a per-track option to suppress negative signal values.
