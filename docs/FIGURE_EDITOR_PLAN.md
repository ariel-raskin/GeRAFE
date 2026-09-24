# Figure Editor plan

Status: the first usable FE workflow merged in PRs #170 and #171 under issue #164. Browser-based real-file export was checked for BigWig, BED, BEDPE, and BAM; native `.hic`, `.cool`, and `.mcool` sources passed real-file query tests, while FE matrix geometry has synthetic renderer tests. Matrix files require the desktop app, so an end-to-end automated FE matrix export remains future validation. The existing [shared track system direction](TRACK_SYSTEM_DIRECTION.md) is the architectural starting point.

## Goal

Move from a gene or locus being explored in the Genome Renderer (GeR) to an editable, publication-quality figure in one action. The Figure Editor (FE) starts with the same genomic data, tracks, order, groups, labels, colors, scales, reference, region, and relevant annotations. It changes the task from navigation to composition: the user controls the figure's physical dimensions, layout, typography, graph appearance, and export.

FE must render from the same source data and semantic track definitions as GeR. It must not treat a screenshot of the browser as the figure.

## Handoff and document behavior

1. **Create figure from current view** is available near the GeR view controls. It opens FE with the current reference, exact locus, every loaded track in GeR order (including lower-area tracks below upper-area tracks), display groups, signal stacks, scale bindings, colors, labels, and saved highlights/outlines relevant to the view. FE has one unified row area, not GeR's upper/lower split.
2. FE starts as an independent snapshot of the GeR document, retaining stable source and track identities. Figure-only edits do not silently change the GeR workspace. **Back to GeR** returns to the browser without losing the draft.
3. A later **New from view** action can start again from GeR. Automatic update/merge from GeR is deferred; it must preview conflicts with FE overrides before replacing them.
4. Save FE projects separately from ordinary GeR workspaces, with versioned schema migrations. Save the figure specification and source provenance, not copied genomics data or rasterized plots. Reopening must identify missing or changed files and offer relinking.
5. Exporting never overwrites the editable FE project. The exported image records enough metadata to reproduce its dimensions and source/region choices.

The first version supports one or two aligned columns. Each column has its own locus and ruler. Rows are figure track positions, and each column can assign a different loaded GeR track to a row (for example, dTAG versus AGB1 treatment at the same locus, or the same tracks at two distant regions). Adding a second column initially duplicates the first column's assignments. Cross-window interactions are clipped to each window; a discontinuous arc must not be drawn across the gap. Beyond two columns and arbitrary panel layouts are later work.

## Interface

- A clear GeR/FE mode switch or **Create figure** action opens an FE workspace, rather than placing figure controls into GeR's navigation menus.
- The center is a page preview with physical page bounds, safe margins, rulers/guides, zoom-to-fit, and export-area indication. Preview zoom does not change exported dimensions.
- A compact layer list shows page, genomic ruler, groups, tracks, and annotations in figure order. Selecting a layer reveals only its relevant controls in a contextual inspector.
- Direct manipulation covers track height, gaps, label placement, and boundaries; the inspector provides exact numeric values. Multi-selection supports bulk styling, alignment, and spacing.
- A wider context preview shows the current crop with draggable left and right boundaries. Coordinates, gene names, and saved regions are alternate precise inputs. Columns can have independent regions or linked edits. Signal scales are shared across columns by default, with independent and fixed options.
- Undo/redo spans figure edits. Reset-to-GeR/default controls make experimentation reversible.

The inspector should make every visible text, label, axis, outline, line, fill, and spacing element adjustable, without displaying every option at once. Controls are organized by page, group, track, axis/ruler, and annotation. Values shared across many tracks can be changed in bulk; a selected element can override them locally.

## Rendering and export

GeR and FE share normalized feature queries, source caches, scale-domain calculations, and track drawing rules. FE has a separate layout engine that works in physical units (such as millimeters or points) instead of screen pixels. Drawing primitives should be independent of browser DOM size and device-pixel ratio.

FE preview and export must agree on genomic positions, signs, ranges, ordering, colors, clipping, and annotation geometry. They need not be pixel-identical at different preview zoom levels. Export rerenders at the chosen output dimensions; it never enlarges the on-screen canvas. Text, ruler ticks, outlines, and ordinary graph geometry should be vector-capable. Dense contact maps may be embedded as appropriately resolved raster layers while retaining vector text and marks.

First export targets: SVG and PNG, with explicit physical width/height and PNG resolution (for example 300 or 600 DPI). PDF can follow once fonts and vector/raster fidelity are validated. Export waits for required source queries, reports missing or incomplete tracks, and offers a deliberate choice to cancel or export with clearly listed omissions. It does not silently export a loading placeholder.

## Initial controls

- **Page:** width, height, orientation, margins, background/transparent background, padding, and optional title/caption.
- **Track and group:** order, inclusion, physical height, spacing, panel boundary, fill/line color and thickness, graph style, scale display, and label placement.
- **Typography:** editable text, font family, size, weight, color, alignment, rotation where useful, and collision/overflow feedback.
- **Genomics:** reference, region, coordinate ruler/tick density, orientation where supported, visible annotations, and per-track rendering controls already available in GeR.
- **Quantitative integrity:** fixed/linked/automatic domains are visible in the inspector and export manifest. Changing figure width or region must not silently change a locked scale.

FE should inherit sensible GeR defaults, so the first preview is already close to a useful figure. Fine control is optional, not required to get an export.

## Implementation sequence

1. **Source-driven figure foundation:** a separate versioned figure document retains GeR track/source identities; FE queries the same source objects at its own resolution and lays them out in physical units. Test genomic coordinate mapping, ordering, source identity, and scale behavior. Reusing GeR's exact canvas drawing primitives remains a later rendering-fidelity improvement.
2. **First usable FE:** one-click handoff of all loaded tracks, independent draft, one/two-column preview, per-column assignments/regions, region crop, layer selection, physical track sizes/gaps, typography and graph controls, save/reopen/relink, undo/redo, and high-resolution PNG/SVG export.
3. **Publication polish:** legends, titles/captions, alignment guides, editable callouts, export preflight/provenance, consistent font handling, and PDF.
4. **Advanced figures:** more than two columns/arbitrary panels, reusable templates, explicit refresh from GeR with conflict handling, and more specialized track presentations.

Each phase should include real-file smoke tests for representative signal, interval/gene, BEDPE, BAM, and matrix tracks as they become exportable, plus checks at different page sizes and output resolutions. A track kind is not considered FE-ready merely because its browser canvas can be captured.

## Open design choices

- Exact placement and naming of the GeR-to-FE action and whether FE is a tab, full-window mode, or separate window. Prefer a full-window mode initially so the page and inspector have room without duplicating data sources.
- Whether figure-specific overrides are stored as a generic style tree or typed properties per track/element. Prefer typed properties with explicit migration and validation.
- Font embedding/substitution policy for portable SVG/PDF, and the default output page size.
- How an explicit **Update from GeR** merges later track additions, removals, and style changes without losing FE composition.

None of these choices requires more GeR feature development before FE begins. The necessary first work is extracting a reusable rendering path, not adding more browser controls.
