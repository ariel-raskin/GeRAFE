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

Matrix presentation settings deliberately do not change the genomic query or the number of fetched cells. Genomic depth and contact-value mode are query-affecting settings in the matrix dialog. Resolution and normalization also remain query-affecting controls in the track context menu.

Observed/expected queries use the selected normalization. The `.hic` reader obtains its chromosome-specific expected vector from the file. For `.cool` and `.mcool`, GeRAFE scans all cis pixels on the active chromosome and computes one mean per distance from all valid bin pairs, including omitted sparse zeros. Invalid normalization weights exclude their bins from both sums and denominators. The resulting vector is cached by file stamp, chromosome, resolution, normalization, and queried depth. The computation is capped at 2,000 distance bins; choosing a shorter depth or coarser resolution makes wider views available. A positive contact at a distance with no valid expectation is marked missing. Sparse zero contacts stay zero; log2(0) is not materialized.

Log2(O/E) uses a symmetric automatic magnitude based on absolute values or a fixed positive/negative magnitude. It has a fixed blue–white–red diverging palette centered on O/E = 1. The ordinary z-min, linear/log intensity, and sequential palette settings do not apply in that mode. Linked matrix groups share a scale only among tracks using the same contact-value mode.

The matrix settings dialog supports three intensity-range modes:

- **Automatic maximum** uses the largest eligible visible contact value.
- **Robust percentile** uses a configurable percentile and defaults to the 99th percentile.
- **Fixed range** uses explicit z-min and z-max values.

Automatic modes can exclude a configurable number of diagonals, including the main diagonal, from scale calculation. This prevents the strong contact diagonal from flattening weaker off-diagonal structure without hiding those cells from the plot. The default of three preserves the earlier exclusion of the main and first two adjacent diagonals. A manual z-min applies to all three modes. Linear and log intensity, score-direction reversal, and preset or custom color stops remain presentation-only. Custom palettes support two to eight ordered colors.

Palette stops are evenly spaced across the resolved intensity range. The warm preset follows the earlier figure-rendering workflow with light, yellow, orange, red, and deep-red stops. Robust percentile or fixed-range scaling now provides the explicit control for preventing a small number of outliers from flattening visible contact differences; the earlier high-color-threshold palette warp has been retired.

Matrix tracks in a linked visual group share the largest automatic or fixed z-max calculated for the matrix members of the same contact-value mode. Independent groups retain a separate z-max for every matrix. Applying matrix settings to a matrix-only group also applies z-min and automatic-scale parameters consistently to every member. This is intentionally separate from the matrix normalization stored for each source. Mixed groups may contain other track kinds, but linked matrix scaling is calculated only from their matrix members.

The renderer clips every contact diamond to the inside of its track and redraws the lower track boundary after the matrix. Palette, legend, group scaling, intensity scaling, and track-height changes must remain presentation-only so they cannot reintroduce the height-dependent query expansion described above. `matrixDepthMode` and `matrixMaxDistance` are the sole persisted controls for off-diagonal query reach.

## Inspection and empty-cell states

Matrix hover inspection is presentation-only. The browser converts the pointer from the rotated triangular canvas coordinates back into the two source bins, then uses cached sparse lookups to classify the cell and report its value, genomic separation, resolution, normalization, and transform. The crosshair and hover card do not trigger source queries. Inspector visibility and content are global app preferences under **Settings → Track behavior → Matrix tracks**. The inspector defaults to on with only its value or cell-state line shown; interacting bins and the lower details line are independently optional. The same global section controls matrix color-scale legends and track-card metadata.

The renderer keeps three non-value states distinct:

- a sparse omitted pixel inside the queried domain is a zero;
- an explicit non-finite source pixel is missing / NaN;
- a bin with an invalid active Cooler normalization weight is masked, and all cells involving it are masked.

Some readers do not expose a normalization mask. GeRAFE does not infer masked bins from absent contacts in that case. Zero cells can retain the track background, use the palette's low-score color, or use a chosen color. Missing pixels can use the track background or a chosen color. Masked bins can use a muted hatch, the track background, or a chosen color.

Zero-color display must remain a single clipped triangular/trapezoidal fill beneath the sparse contacts. It must not enumerate or materialize absent matrix cells. Missing pixels remain sparse coordinates and masked bins remain a short bin list. This preserves the direct renderer's feature-count guardrail.
