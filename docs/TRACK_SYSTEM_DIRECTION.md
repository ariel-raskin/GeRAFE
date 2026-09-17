# Shared track system direction

This note records what GeRAFE should carry forward from two predecessor figure-rendering prototypes. It is a design constraint for both major product goals:

- **Goal A:** a fast, fully functional genome browser;
- **Goal B:** publication-quality figure creation directly from the region and tracks being browsed.

The central rule is that browsing and figure creation must use one semantic track document. Figure creation is a different layout/rendering view of the same tracks, not an export format that tries to reconstruct their meaning later.

## What the existing projects teach us

### Manifest-driven prototype

- Its manifest is effective provenance: each source row records `group`, `label`, `path`, `color`, `kind`, `pair_id`, `strand`, and optional height/range overrides.
- A stranded display is assembled from explicit plus/minus roles and a `pair_id`. Filename inference is useful for proposing a pair, but ambiguous or incomplete pairs are skipped.
- Plus and minus limits can be calculated independently across a group and manually overridden with `plus_ymax` and `minus_ymax`. This is important for transcription data whose two strands have genuinely different observed magnitudes.
- Groups control order, spacing, labels, rules, bulk color changes, and currently autoscaling. The interface demonstrates why bulk operations on a selected set of tracks are valuable.
- It has richer annotation and figure concepts than the current browser: representative transcript selection, exon/CDS/UTR geometry, strand-separated genes, collision-aware labels, guides/highlights, interaction outlines, BED/BEDPE, and multiple Hi-C presentation modes.
- Its generated layout metadata is valuable: rendered groups and tracks retain physical bounds and source identity, enabling selection and editing after preview.

### Project-document prototype

- Its versioned project object is a better foundation than loose renderer arguments. Tracks have stable IDs, kinds, labels, sources, colors, enabled state, scale mode, fixed limits, and height.
- `signal`, `stranded`, and `genes` are distinct track kinds with type-aware editors and validation.
- `group`, `track`, and `fixed` scaling is understandable to users. Shared group scales make condition-to-condition comparison honest.
- Its stranded implementation uses one paired track with explicit plus/minus sources and colors. It supports a symmetric magnitude when comparison requires equal visual weight above and below zero.
- Track order, group membership, enablement, and render provenance survive save/load and remain editable.
- The preview/final distinction is correct: rendering quality changes, but the scientific track state does not.

### Limitation shared by both

Both projects use the same `group` field for two separate questions:

1. Which tracks belong together visually?
2. Which tracks share a numeric scale?

Those relationships often coincide, but not always. GeRAFE must represent them independently. A user may want four PRO-seq conditions inside one labeled visual group while linking scales only within two experimental comparisons, or may want visually separate tracks to retain a shared scale.

## Proposed semantic model

The persistent document should contain data sources, tracks, visual groups, and scale bindings as separate objects with stable IDs.

```ts
interface TrackDocument {
  referenceId: string
  region: Region
  sources: TrackSource[]
  tracks: TrackSpec[]
  groups: DisplayGroup[]
  scales: ScaleBinding[]
  annotations: AnnotationObject[]
}

interface TrackSource {
  id: string
  path: string
  format: 'bigwig' | 'bedgraph' | 'bam' | 'bed' | 'bedpe' | 'genes' | 'hic'
  role: 'signal' | 'plus' | 'minus' | 'intervals' | 'interactions' | 'matrix'
  valueTransform: 'as-is' | 'absolute' | 'negate'
  provenance?: { size: number; modifiedUtc: string }
}

interface TrackSpec {
  id: string
  kind: 'signal' | 'stranded' | 'alignment' | 'interval' | 'interaction' | 'genes' | 'matrix'
  label: string
  sourceIds: string[]
  displayGroupId?: string
  scaleBindingId?: string
  enabled: boolean
  style: TrackStyle
  heightWeight: number
  stranded?: StrandedDisplay
}
```

The stored scientific/display state should use relative height weights rather than pixels or inches. Browser layout converts weights to pixels; figure layout converts them to physical dimensions. File handles, decoded features, caches, request state, and Canvas objects remain runtime-only and never enter this document.

## Stranded tracks

Pair inference should be offered when filenames contain plus/minus tokens, but the result must be visible and manually correctable. Pairing is a relationship between source channels, not visual grouping and not scale linkage.

Every stranded track needs independent choices for:

- **Pairing:** paired plus/minus, plus only, minus only, or two ordinary unpaired tracks.
- **Input sign:** use values as stored, take absolute magnitude, or negate. Minus-strand files are not universally encoded the same way.
- **Presentation:** a diverging plot around one zero baseline, two tightly stacked halves, or two fully separate tracks.
- **Strand magnitude:** symmetric (`+/-` use the same absolute maximum) or independent (each side has its own maximum).
- **Cross-track linkage:** unlinked, linked to other tracks by a scale binding, or fixed.
- **Appearance:** separate plus/minus colors, fill/line mode, baseline visibility, gap, and strand labels.

This covers both patterns demonstrated by the predecessor prototypes: symmetric comparisons and asymmetric transcription displays. The default for recognizable PRO-seq/GRO-seq pairs should be diverging, plus above and minus below, with explicit minus-value normalization. The user must be able to switch symmetry and unlink either strand without reopening files.

## Scaling

Scale computation should be a shared engine that returns numeric domains; Canvas and figure renderers should never calculate their own ranges.

```ts
interface ScaleBinding {
  id: string
  memberTrackIds: string[]
  mode: 'auto-visible' | 'auto-region' | 'fixed'
  limits?: { min: number; max: number }
  includeZero: boolean
  strandedMagnitude: 'symmetric' | 'independent'
}
```

- `auto-visible` follows the live viewport and is useful for exploration.
- `auto-region` computes once for the selected figure region and is reproducible while styling a figure.
- `fixed` stores exact limits.
- Sharing is expressed by multiple track IDs referencing one binding, independently of their visual groups.
- Scale bindings should only compare compatible channels. Ordinary signal, plus magnitude, minus magnitude, and matrices require distinct calculations.
- The UI should expose observed maxima even when fixed or shared limits are used.
- Changing regions should not make axes flicker during every pointer event. Interactive autoscaling can retain the current domain during a drag and settle after data for the new viewport arrives.

Percentile/clipped scaling and whole-file scaling may be added later without changing track identity.

## Visual grouping and ordering

A display group should own only presentation concerns: label, order, collapsed state, gap before/after, group rule, and optional style defaults. Moving a track between groups must not silently change its scale binding. A separate action can deliberately “link scales in this group.”

Track order remains authoritative within two named browser panes. Groups reference contiguous runs rather than duplicating tracks, and drag operations move a group as an indivisible block. Gene annotations are ordinary ordered tracks that initially open in the lower pane, not a pinned or special canvas afterthought. Any track or complete group can move between panes, while both panes continue to share the same locus and semantic document order used by a figure.

Bulk actions learned from `gene_tracks_organic` should remain available: group/ungroup selected tracks, link/unlink selected scales, recolor all/plus/minus channels, enable/disable, duplicate, and set heights.

### Current browser layout conventions

- A horizontal boundary belongs to the track immediately above it. Dragging that boundary changes only that track's height and does not require preselection; the top edge of the track below is not a separate resize target.
- Signal plots keep a small symmetric inset while using the rest of the track height. Numeric scale labels are centered on their horizontal tick marks in the label card.
- Collapsed gene mode is a single structural and label lane. When gene structures would overlap in screen space, the first visible structure is retained and later overlapping structures are omitted; labels that cannot remain near their structure are also omitted. Expanded and squished modes retain their multi-transcript layouts.
- Ruler annotations occupy distinct vertical bands: cytoband labels remain adjacent to the ideogram, the genomic-span indicator sits below them, and genomic-coordinate ticks occupy the bottom of the ruler.

## Agreement between browser and figure mode

The following must remain identical when moving from browsing to figure composition:

- reference and locus;
- data source identity and strand roles;
- track and group order;
- labels, colors, visibility, and baseline behavior;
- pair/link state and numeric scale domains;
- annotation source and selected transcript policy;
- guides, highlights, and named regions.

Only composition-specific properties should be layered on in figure mode: page size, margins, physical track heights/gaps, typography, legends, title/caption, panel outlines, DPI, and output format. Figure styling can either update the shared track style or create an explicit figure-only override; it must never diverge silently.

The interactive browser can continue using Canvas for speed. Publication export should eventually use a vector-capable renderer (SVG first, with PNG/PDF output) driven by the same normalized features, scale domains, and layout primitives. Pixel-for-pixel identity is unnecessary, but geometry, signs, ranges, colors, and ordering must agree.

## Annotation and provenance consequences

- **Core implemented:** the compact RefSeq source now combines a whole-genome search index with chromosome-lazy transcript, exon, CDS/UTR, strand, and TSS geometry. Continue by adding transcript metadata beyond the current RefSeq identifiers.
- **Initial policy implemented:** gene tracks offer collapsed representative-transcript, expanded all-isoform, and squished all-isoform modes. Add canonical/longest-CDS and user-selected transcript policies next.
- Store source path, format, file size, modification time, and role. A saved session can then detect moved or changed inputs and a figure export can write a reproducible source manifest.
- Guides/highlights should be named model objects that may originate from a gene, promoter, or manual interval; interaction outlines should reference those objects rather than copy coordinates.

## Implementation sequence

1. **Implemented:** introduce the versioned `TrackDocument`, stable IDs, source provenance, display groups, and scale bindings beneath the existing browser.
2. **Implemented for signal and gene tracks:** add direct label-gutter selection and context menus, animated drag ordering across two independently scrollable panes, within-group ordering, grouping, labels, colors, duplication/relinking, fixed or viewport-auto domains, independent scale linking, editable 1–100 relative heights, fit-to-pane layout, persistence, JSON workspace interchange, and undo/redo. Group blocks cannot be split, and dynamic centered label wrapping follows track height.
3. **Core implemented:** explicit plus/minus source roles, filename inference, automatic and manually correctable pairing, sign normalization, one-track diverging presentation, separate strand colors, and independent strand scale channels. Add stacked/separate presentations, input-sign overrides, and optional symmetric magnitudes next.
4. **Core implemented:** signal domain calculation now lives in a renderer-independent scale engine; stranded channels remain separate during selected-track and group autoscaling. Extend it with drag-stable domains, auto-region, and percentiles.
5. **Implemented:** upgrade gene annotations to exon-aware models and add BED/BEDPE tracks.
6. Add figure composition as another view of the same document, then SVG/PNG/PDF export and render provenance.
7. **Core implemented ahead of figure composition:** add indexed `.hic`, `.cool`, and `.mcool` cis matrix tracks, zoom-aware/manual resolutions, source normalizations, and a persisted triangular heatmap presentation. Extend this to interchromosomal two-axis views, expected/observed transforms, and richer matrix-derived annotations later.

This ordering keeps Goal A moving while preventing browser-only decisions from becoming migration problems for Goal B.
