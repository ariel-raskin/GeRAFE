# Figure Editor plan

Status: design plan, not implemented. The existing [shared track system direction](TRACK_SYSTEM_DIRECTION.md) is the architectural starting point.

## Goal

Move from a gene or locus being explored in the Genome Renderer (GeR) to an editable, publication-quality figure in one action. The Figure Editor (FE) starts with the same genomic data, tracks, order, groups, labels, colors, scales, reference, region, and relevant annotations. It changes the task from navigation to composition: the user controls the figure's physical dimensions, layout, typography, graph appearance, and export.

FE must render from the same source data and semantic track definitions as GeR. It must not treat a screenshot of the browser as the figure.

## Handoff and document behavior

1. **Create figure from current view** is available near the GeR view controls. It opens FE with the current reference, exact locus, visible tracks and their ordering, display groups, signal stacks, scale bindings, colors, labels, and saved highlights/outlines relevant to the view.
2. FE starts as an independent snapshot of the GeR document, retaining stable source and track identities. Figure-only edits do not silently change the GeR workspace. **Back to GeR** returns to the browser without losing the draft.
3. An explicit **Update from GeR** action can refresh source/track content later. It must preview conflicts with FE overrides before replacing them. A new figure can also be made from a later GeR view.
4. Save FE projects separately from ordinary GeR workspaces, with versioned schema migrations. Save the figure specification and source provenance, not copied genomics data or rasterized plots. Reopening must identify missing or changed files and offer relinking.
5. Exporting never overwrites the editable FE project. The exported image records enough metadata to reproduce its dimensions and source/region choices.

The first version is one genomic panel. It preserves GeR's visual track order and initial upper/lower arrangement, but FE owns the final spacing and layout. Multiple aligned loci/panels are a later phase, not a prerequisite for a useful first figure.

## Interface

- A clear GeR/FE mode switch or **Create figure** action opens an FE workspace, rather than placing figure controls into GeR's navigation menus.
- The center is a page preview with physical page bounds, safe margins, rulers/guides, zoom-to-fit, and export-area indication. Preview zoom does not change exported dimensions.
- A compact layer list shows page, genomic ruler, groups, tracks, and annotations in figure order. Selecting a layer reveals only its relevant controls in a contextual inspector.
- Direct manipulation covers track height, gaps, label placement, and boundaries; the inspector provides exact numeric values. Multi-selection supports bulk styling, alignment, and spacing.
- Coordinates use the same reference and flexible locus input as GeR. Editing the region updates all aligned tracks together. An explicit scale lock prevents accidental changes in quantitative interpretation.
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

1. **Shared-render foundation:** separate data querying and domain computation from GeR's screen-size-dependent canvas layout. Define a stable render scene and figure document with tests for genomic coordinate mapping, ordering, source identity, and scale agreement.
2. **First usable FE:** one-click handoff, independent draft, page preview, region editing, layer selection, physical track sizes/gaps, typography and label controls, save/reopen, undo/redo, and high-resolution PNG/SVG export.
3. **Publication polish:** legends, titles/captions, alignment guides, editable callouts, export preflight/provenance, consistent font handling, and PDF.
4. **Advanced figures:** multiple aligned panels or loci, reusable templates, explicit refresh from GeR with conflict handling, and more specialized track presentations.

Each phase should include real-file smoke tests for representative signal, interval/gene, BEDPE, BAM, and matrix tracks as they become exportable, plus checks at different page sizes and output resolutions. A track kind is not considered FE-ready merely because its browser canvas can be captured.

## Open design choices

- Exact placement and naming of the GeR-to-FE action and whether FE is a tab, full-window mode, or separate window. Prefer a full-window mode initially so the page and inspector have room without duplicating data sources.
- Whether figure-specific overrides are stored as a generic style tree or typed properties per track/element. Prefer typed properties with explicit migration and validation.
- Font embedding/substitution policy for portable SVG/PDF, and the default output page size.
- How an explicit **Update from GeR** merges later track additions, removals, and style changes without losing FE composition.

None of these choices requires more GeR feature development before FE begins. The necessary first work is extracting a reusable rendering path, not adding more browser controls.
