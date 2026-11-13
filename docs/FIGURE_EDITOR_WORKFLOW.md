# Manuscript track figures

The Figure Editor composes genomic data into physical pages. Its settings belong to the figure; editing a figure does not change the genome viewer workspace.

## Start a comparison

1. Load the tracks and annotation source in GeR, navigate to the locus, then choose **Create figure**.
2. Choose **Set up 3 comparison columns**. Rename the column headings for your conditions. **Add column** supports up to eight columns. Column properties include relative width, left/right ordering, and genomic crop. Linked region edits are optional.
3. Choose **Compact manuscript layout** for a 145-mm-wide starting point: narrow gaps, small physical row heights, endpoint rulers with scale bars, compact gene models, and a linear white/yellow/orange/red matrix palette. This changes figure styles, including the matrix transform. It leaves data normalization, track assignments, and genomic windows unchanged. Undo restores the previous settings.
4. Select one row per assay and assign each condition's loaded track to its corresponding column. **Hide separate rows for these assigned tracks** removes redundant source rows from the composition; their data stays available. Use ×/+ to exclude/restore rows. Move arrows reorder included rows past excluded source rows.
5. Select a row or click a plotted cell to adjust its appearance. Settings are grouped in expandable inspector sections. **Apply appearance to all columns** copies that cell's appearance and scale limits, retaining assignments. **Reset appearance** restores source/default cell styles.

The preset is a starting point for the compact multi-condition heatmap/interaction/gene/strand/signal layout. It does not guess condition-to-source assignments or experimental scale caps.

## Available controls

| Element | Controls |
| --- | --- |
| Page | Width/height in mm (0 height fits content), margins, label area, column/row gaps, background, title, font family and default size |
| Headings | Font size, weight and color; title and column-heading areas |
| Ruler | Tick or endpoint style, visibility, chromosome visibility/size, coordinate size/units/decimal precision, scale-bar length/size, background/shading, line width/color, gap below |
| Rows | Physical height, extra gap, label and shared assay/group label, label font/color/weight/orientation/offset, group bracket position/width/font/color, plot background/padding, frame color/width (0 hides) |
| Axes | Label font/color/inset/precision and optional opaque background, zero-line color/width, separate section scaling, annotation visibility by type |
| Signal | Color, opacity, fill or line graph, line width, inherited/shared/independent/fixed limits |
| Paired strands | Positive and negative colors, independent positive/negative limits, relative height of the two halves, fill/line graph |
| Gene models | Annotation-source assignment, gene-name/ID filter, collapsed/expanded/squished models, canonical/all transcripts, label visibility/size/color/italics/above-or-below position, exon/CDS height, intron width, arrow size, transcript spacing, top offset, label gap, opacity |
| Interactions | Color/opacity, line width, height multiplier, direction, line or anchor-width ribbon, gene-focus filter, maximum distance/count |
| Contact matrices | Source or custom palette, palette direction, linear/log1p transform, resolution, normalization, triangle direction/depth, scale limits, inline or vertical color bar, last-column-only legend, legend width/gap/font |
| Annotations | Saved-region bounds/shading/boundaries and divider position, color/style/width; matrix outline visibility/color/width. Add/remove figure-only dividers from Page properties. Rows can hide guides while retaining section scaling. |

Sizes are physical units, independent of preview zoom. Font family names use fonts available on the rendering computer. Font embedding and PDF export remain future work.

## Quantitative comparisons

**Source limits / pooled data** retains fixed source caps when available. **Shared observed limits** pools visible values from the tracks assigned to that assay row across conditions; **Independent** uses each cell's values. **Fixed limits** takes explicit minimum/maximum values. Matrix automatic limits use the source's maximum/percentile policy, with fixed caps overridden when observed scaling is selected.

With **Scale each divider section separately**, each section gets its own domain. Paired strands have independent positive and negative maxima within each section. Fixed section limits appear as genomic ranges in the inspector. A negative minimum and positive maximum are required for paired strands. Section limits are keyed to their genomic start; moving a divider changes that key and uses the cell's general fixed limits until the new section is edited. Shared scaling pools corresponding sections in column order; use the same locus/dividers for directly comparable treatment panels.

Figure BigWig queries request full-resolution values so automatic scales do not change with export DPI. Matrix resolution and normalization remain explicit source/query choices; FE does not add smoothing or an extra normalization step. Choose a resolution/normalization supported by the matrix file. Matrix files require the desktop app.

## Save and reproduce

**Save project** writes version-2 `.gerafe-figure.json`, containing editable settings and source provenance, including local file locations when available. Version-1 projects open automatically. Data records are not copied into project files. Keep the project and original sources for continued editing.

**Export SVG** writes vector geometry with the complete figure recipe in its metadata. Native file paths are removed from that recipe. **Open project** can also open these SVGs and recover their settings; relink source files if they are unavailable in the current session. Import reads metadata and re-renders from sources rather than executing or displaying imported SVG content. SVGs exported before recipes were included cannot be reopened this way.

**Export PNG** renders at 300 or 600 DPI and records physical output resolution. Preview zoom never affects export dimensions. Missing sources and over-dense matrices are reported before export. A matrix exceeding 80,000 returned cells requires a coarser resolution or smaller region.

## Validation and remaining work

The synthetic manuscript fixture exercises three conditions, matrix + BEDPE + genes + paired strands + two signal assays. Tests cover pooled section domains, fixed overrides, unequal column widths, project migration, query settings, and recipe metadata. The browser smoke test edits controls, checks undo, reopens JSON and exported SVG, and exports a print-resolution PNG for visual review. Run `node scripts/run-smoke.mjs --figure` for this check.

Exact parity with every predecessor renderer is not established. End-to-end native matrix figure export with manuscript data, arbitrary multi-panel canvases, multi-selection, direct row/column resizing, reusable custom style libraries, callouts, embedded fonts, PDF, and merging later GeR edits remain follow-up work.
