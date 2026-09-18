# GeRAFE release notes

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
