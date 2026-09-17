# Contact-matrix rendering and performance notes

This document records the September 2026 `.hic`/`.cool`/`.mcool` rendering regression so future matrix work does not repeat it.

## What happened

The original contact-matrix implementation queried a bounded genomic window and drew the returned cells directly as canvas diamonds. Its responsiveness was acceptable for the initial files and views.

Later work attempted to make a resized matrix fill more vertical space and then to optimize the resulting renderer. The height-aware query expansion increased the off-diagonal genomic span when a track became taller. That increased the number of returned cells substantially even though the horizontal locus had not changed. Panning remained smooth below roughly 30,000 visible matrix features, slowed above that range, and stuttered badly around 100,000 features on the files used for testing.

Several follow-up experiments treated drawing as the primary bottleneck:

- Removing a sparse-background fill did not materially improve responsiveness.
- Caching the geometry in `Path2D` objects did not help enough because the canvas still had to traverse and paint the large geometry on every pan frame.
- Raster caching and downsampling did not resolve the reported lag and made the matrix look lower-resolution.

PR #61 restored the known-good renderer from before the height-aware query expansion and removed those unsuccessful optimizations. That restored the expected panning speed and visual resolution.

## Root cause

The dominant variable was the number of matrix cells fetched and painted, not the canvas background. A height-only UI change had been allowed to expand the data query, so ordinary resizing could multiply the per-frame feature load.

## Guardrails for future work

- Do not expand the matrix genomic query merely because track height changes.
- Preserve the direct, full-resolution cell renderer until a replacement is demonstrably faster at equal visual fidelity.
- Record visible feature count, render time, and pan frame rate when evaluating matrix changes.
- Test representative views below 30,000 cells and dense views near or above 100,000 cells.
- Treat lower apparent resolution as a regression unless an explicit user-selected level of detail requests it.
- Keep presentation-only features such as legends, label layout, and palettes independent of matrix fetching.
- For a future large performance improvement, prefer a deliberate tiled/level-of-detail or GPU-backed architecture with cache invalidation and fidelity tests. Avoid adding another full-frame cache without profiling it against real `.hic` and `.mcool` files.

## Current baseline

The current baseline uses the source-selected matrix resolution, a bounded overscan window, and direct per-cell canvas drawing. New tracks default to the full visible genomic span. The optional automatic-depth mode is fixed at 20% of the visible span, and fixed genomic-depth presets are also available. Every mode is independent of track height. Changes to this path should be compared against the post-PR-#61 behavior before merging.

## Scale and palette model

Matrix presentation settings deliberately do not change the genomic query or the number of fetched cells. The only query-affecting setting in the matrix dialog is explicit genomic depth. Resolution and normalization also remain query-affecting controls in the track context menu.

The matrix settings dialog supports three intensity-range modes:

- **Automatic maximum** uses the largest eligible visible contact value.
- **Robust percentile** uses a configurable percentile and defaults to the 99th percentile.
- **Fixed range** uses explicit z-min and z-max values.

Automatic modes can exclude a configurable number of diagonals, including the main diagonal, from scale calculation. This prevents the strong contact diagonal from flattening weaker off-diagonal structure without hiding those cells from the plot. The default of three preserves the earlier exclusion of the main and first two adjacent diagonals. A manual z-min applies to all three modes. Linear and log intensity, score-direction reversal, and preset or custom color stops remain presentation-only. Custom palettes support two to eight ordered colors.

Palette stops are evenly spaced across the resolved intensity range. The warm preset follows the earlier figure-rendering workflow with light, yellow, orange, red, and deep-red stops. Robust percentile or fixed-range scaling now provides the explicit control for preventing a small number of outliers from flattening visible contact differences; the earlier high-color-threshold palette warp has been retired.

Matrix tracks in a linked visual group share the largest automatic or fixed z-max calculated for the matrix members of that group. Independent groups retain a separate z-max for every matrix. Applying matrix settings to a matrix-only group also applies z-min and automatic-scale parameters consistently to every member. This is intentionally separate from the matrix normalization stored for each source. Mixed groups may contain other track kinds, but linked matrix scaling is calculated only from their matrix members.

The renderer clips every contact diamond to the inside of its track and redraws the lower track boundary after the matrix. Palette, legend, group scaling, intensity scaling, and track-height changes must remain presentation-only so they cannot reintroduce the height-dependent query expansion described above. `matrixDepthMode` and `matrixMaxDistance` are the sole persisted controls for off-diagonal query reach.
