# Related genome browsers and visualization tools

This note records the external tools considered while defining GeRAFE. It is a
dated research and product-decision record, not an exhaustive ranking. Features,
packaging, and project activity can change, so recheck the linked primary sources
before making an architectural or licensing decision.

**Last reviewed:** September 15, 2026

## Decision

GeRAFE will continue as its own focused genome browser and will develop its own
integrated figure editor.

The central opportunity is not to reproduce every feature of a general-purpose
browser. It is to make the common local functional-genomics workflow unusually
direct: open files from disk, navigate smoothly, organize and compare tracks, and
turn the same scientifically meaningful track document into an editable,
publication-quality figure.

JBrowse 2 was the strongest candidate for use as an existing browser foundation.
It is capable, extensible, and broad, but its breadth also produces considerably
more interface and product complexity than GeRAFE needs. During a September 2026
hands-on evaluation, its desktop application felt like a desktop container around
the web application, some interactions did not fit the desired workflow, and an
operation failed early in testing. That experience is a project-specific field
note, not a claim that JBrowse is generally unreliable. It changed the decision
from “build a figure editor around JBrowse” to “continue GeRAFE, while treating
JBrowse as an important reference implementation.”

Gosling Designer is the closest project found to the broad idea of interactively
constructing custom genomic visualizations. In the same evaluation, it did not
feel operational or finished enough for the intended day-to-day figure workflow.
The underlying Gosling grammar remains valuable design inspiration, but GeRAFE
should not depend on Designer becoming its figure editor.

No evaluated project combined all of the following in the way GeRAFE intends:

- a focused, native-feeling local desktop workflow;
- responsive browsing of common functional-genomics files, including IGV TDF;
- low-friction organization of many experimental tracks, groups, scales, and
  positive/negative strand pairs;
- persistent scientific and display state; and
- a direct transition from the live browser into a graphical figure editor using
  the same semantic tracks rather than a flattened screenshot.

## Comparison at a glance

The entries are grouped by their primary role. A specialized viewer or scripted
figure package is not a deficient general browser; it is solving a different
problem.

| Project | Primary role | What makes it relevant to GeRAFE | Current conclusion |
| --- | --- | --- | --- |
| [IGV Desktop](https://igv.org/doc/desktop/) | Local general-purpose genome browser | The practical baseline for file compatibility, alignment display, sessions, and established genomics conventions | Compatibility and behavior reference, not a modern UI or figure-editor foundation |
| [igv.js](https://igv.org/doc/igvjs/) | Embeddable web genome viewer | Mature browser logic, wide file support, SVG export, events, and an MIT-licensed implementation | Revisit individual parsing and display problems; do not replace GeRAFE wholesale |
| [JBrowse 2](https://www.jbrowse.org/jb2/features/) | Extensible web, desktop, and embeddable genome-browser platform | The strongest modern full-browser comparison: plugins, sessions, local files, SVG/PNG export, synteny, structural variation, and 1D/2D views | Primary product and architecture reference; not GeRAFE's base at present |
| [JBR Genome Browser](https://github.com/JetBrains-Research/jbr) | Java desktop browser with integrated peak analysis | TDF, IGV-session import, group scaling, multiple loci, compact mode, and SVG/PNG/headless export | Worth a targeted hands-on comparison, especially for PRO-seq TDF; too small and specialized to use as the foundation |
| [Integrated Genome Browser](https://bioviz.org/) | Extensible Java desktop genome browser | Fast animated navigation, local and remote sources, plugins, and a long-running desktop-first design | Useful historical desktop UX reference; not an obvious foundation for a new TypeScript/Tauri application |
| [UCSC Genome Browser](https://genome.ucsc.edu/) | Hosted reference-data browser and analysis portal | Enormous annotation ecosystem, custom tracks, composite tracks, track hubs, and stable URLs | Reference for annotation discovery, hubs, and dense configuration rather than local desktop interaction |
| [WashU Epigenome Browser](https://genomebrowser.wustl.edu/) | Hosted epigenome, interaction, and comparative-genomics browser | Rich epigenomic tracks, long-range interactions, `.cool`/Hi-C, custom genome hubs, multiple regions, and SVG screenshots | Important reference when GeRAFE reaches interactions, matrices, comparative views, or sharing |
| [HiGlass](https://docs.higlass.io/) | Multiscale tiled 1D/2D data browser | Map-like continuous navigation, synchronized views, GPU rendering, and large Hi-C matrices | Strong technical reference for future matrix tracks; its tile-server workflow is more infrastructure than current 1D local-file needs require |
| [Gosling](https://gosling-lang.org/) | Declarative grammar for interactive genomic visualization | Composable marks, tracks, views, layouts, scales, and interactions provide a useful vocabulary for figure composition | Study the grammar and composition model; keep GeRAFE's end-user editor task-oriented |
| [Gosling Designer](https://pmc.ncbi.nlm.nih.gov/articles/PMC12636756/) | Visual authoring environment built around Gosling | The closest conceptual neighbor to a genomic visualization builder, including templates and access to the underlying grammar | Research prototype/inspiration, not a sufficiently dependable figure workflow for this project today |
| [GenomeSpy](https://genomespy.app/docs/) | GPU-powered genomic visualization grammar and application framework | Vega-Lite-like marks, transforms, composed views, linked interactions, lazy data, and semantic zoom | Revisit for grammar, scale resolution, and extensible mark ideas rather than ordinary file-browser UX |
| [pyGenomeTracks](https://pygenometracks.readthedocs.io/) | Scripted static genomic-track figures | Broad publication-oriented track set, explicit dimensions, labels, highlights, links, matrices, and reproducible configuration | Strong output and configuration reference; not an interactive graphical editor |
| [CoolBox](https://gangcaolab.github.io/CoolBox/) | Python API and browser for composed genomic figures | One composition model can drive both browser exploration and SVG figure output, including Hi-C | Particularly relevant precedent for GeRAFE's shared browser/figure document |
| [Sushi](https://bioconductor.org/packages/Sushi/) | R package for genomic figures | Flexible, scriptable publication-quality multi-panel plots | Reference for useful figure primitives and layouts, not an interactive application model |

## General-purpose browser references

### IGV Desktop and igv.js

IGV remains the behavioral baseline for local genomics inspection. It has mature
handling for alignments and variants, a large set of track types, local and remote
data, and an established session model. The desktop application is Java, while
[igv.js is a separate embeddable JavaScript implementation](https://github.com/igvteam/igv.js/)
from the same team. The web component exposes browser configuration, track APIs,
events, multiple loci, regions of interest, and SVG export.

Useful ideas to revisit:

- rendering conventions and menus for BAM, CRAM, VCF, junctions, and complex
  genomic formats;
- expected file/index discovery and chromosome-name alias behavior;
- sessions and reproducible locus/track state;
- how an embeddable viewer exposes navigation and track events to a host app.

GeRAFE should seek compatibility with users' expectations without inheriting every
IGV menu, mode, or visual convention. Its simpler organization, stranded-track
model, and direct figure workflow are intentional differentiators.

### JBrowse 2

JBrowse 2 is the broadest modern alternative found. Its official feature overview
describes a pluggable, GPU-accelerated, fully client-side core that is delivered as
a web application, Electron desktop application, and embeddable React components.
It supports a wide range of common and comparative-genomics formats, shareable
sessions, plugins, multiple view types, and SVG/high-resolution PNG output. Its
[download page](https://www.jbrowse.org/jb2/download/) also exposes command-line
image generation and framework integrations.

Useful ideas to revisit:

- separating data adapters, track models, and displays so one source can have more
  than one visualization;
- plugin boundaries and extension points;
- session portability and rendering from saved state;
- multiple synchronized loci, synteny, structural variation, and circular views;
- WebGL/WebGPU rendering and fallback strategies if Canvas becomes limiting.

The breadth is valuable across the scientific community, but it is beyond the
scope any one GeRAFE workflow needs. Adopting the entire platform would also mean
accepting its information architecture and interaction model. GeRAFE will instead
stay deliberately narrower and consult JBrowse when implementing specific hard
features. JBrowse's maintained `@gmod` parser ecosystem may be evaluated
individually where its licensing and behavior fit.

### JBR Genome Browser

JBR and JBrowse are unrelated projects despite the similar names. JBR comes from
JetBrains Research BioLabs and grew alongside its peak-calling work. Its published
feature list includes BED, BigWig, Wig, BigBed, TDF, BAM/SAM/CRAM, and GTF; JBR,
IGV, and UCSC session formats; group-scale mode; multiple simultaneous locations;
integrated peak calling; and PNG/SVG screenshots.

The application is distributed from
[GitHub Releases](https://github.com/JetBrains-Research/jbr/releases) rather than
through a conventional Windows installer. The Windows archive is extracted and
`jbr.exe` is launched directly, which makes it less discoverable and polished as
an installed desktop product.

Useful ideas to revisit:

- direct TDF behavior and compatibility with IGV sessions;
- group-scale and compact multi-track presentation;
- integrated peak analysis and interval-overlap operations;
- headless reproducible SVG/PNG rendering.

JBR is valuable as a targeted benchmark, but its smaller ecosystem, specialized
analysis focus, packaging, and limited visible platform/source story make it a
weak base for GeRAFE.

### Integrated Genome Browser

Integrated Genome Browser (IGB) is a long-running Java desktop browser emphasizing
fast animated zooming, extensibility, and data from local files or distributed
sources. It is worth revisiting for desktop interaction patterns and plugin UX.
Its architecture and technology are sufficiently different from GeRAFE that reuse
is less attractive than observation.

### UCSC Genome Browser

UCSC is principally a hosted data and analysis ecosystem, not a direct replacement
for GeRAFE's local desktop workflow. Its strengths include curated reference
annotations, custom tracks, composite/super-tracks, Table Browser operations, and
[track hubs](https://genome.ucsc.edu/goldenPath/help/hgTrackHubHelp.html) for
publishing collections of remotely indexed data.

Useful ideas to revisit include importing track hubs, discovering public
annotations, organizing large collections of subtracks, and generating stable
shareable references. GeRAFE should avoid reproducing UCSC's administrative and
portal-scale complexity unless a concrete workflow requires it.

## Specialized interactive systems

### WashU Epigenome Browser

WashU is especially strong for epigenomic integration, long-range interactions,
Hi-C/`.cool`, multiple regions, comparative genomics, public data hubs, and
shareable sessions. Its documentation also describes SVG screenshot generation.
The project's
[current documentation](https://epgg.github.io/) was refreshed for a 2025
generation of the browser.

It should be the first external reference when GeRAFE adds interaction arcs,
matrices, cross-species alignment, or collaborative web sharing. Those specialized
capabilities do not make it a simpler local IGV replacement.

### HiGlass

HiGlass applies the “slippy map” model to massive multiscale datasets. Its client
uses a tiled server/data pipeline, synchronized views, and GPU-backed rendering;
it is particularly established for 2D Hi-C contact matrices alongside 1D tracks.

Useful ideas to revisit:

- multiresolution tile contracts and request scheduling;
- synchronized overview/detail and multi-panel navigation;
- matrix rendering, GPU scene organization, and graceful level-of-detail changes;
- declarative saved view configurations.

For current BigWig/TDF/BAM/BED work, GeRAFE's direct indexed local reads are
simpler for the user than ingesting data into a tile server. Matrix support may
justify a different storage/rendering path later.

## Figure and visualization-system references

### Gosling and Gosling Designer

Gosling is a declarative grammar rather than a conventional file-first browser.
It composes genomic visualizations from data, marks, channels, transforms, tracks,
views, and layouts. This offers more expressive designs than a fixed menu of track
renderers. Gosling Designer adds visual authoring, templates, data management, and
an integrated grammar editor.

The important lesson is to keep a clean, serializable figure description beneath
the graphical editor. The user should normally manipulate meaningful objects—such
as a signal track, gene model, genomic highlight, scale link, or panel—without
needing to author a general visualization grammar. Advanced declarative access can
remain a later possibility.

### GenomeSpy

GenomeSpy takes another grammar-based approach, influenced by Vega-Lite. Its
building blocks include marks, encodings, transformations, composed views, scale
and axis resolution, lazy data, and zoom-dependent visibility. The latter is a
particularly useful model for semantic zoom.

GenomeSpy reinforces the value of keeping data transformation, scale resolution,
layout, and graphical marks explicit and separable. GeRAFE can adopt those ideas
inside a domain-specific UI without exposing a grammar as its primary workflow.

### pyGenomeTracks, CoolBox, and Sushi

These code/configuration-driven tools demonstrate many of the output controls a
serious figure editor needs: physical sizing, predictable track heights, aligned
axes, highlights and guides, gene models, links/arcs, matrices, typography, and
vector output. They also show the importance of reproducibility.

CoolBox is particularly relevant because it describes data and figure together in
one Python composition and can use that object in an interactive browser or render
it as a figure. That is close to GeRAFE's architectural rule: browser mode and
figure mode should be two presentations of one semantic track document.

The limitation for GeRAFE's target workflow is that these tools primarily require
code or configuration. They are references for rendering semantics and export,
not substitutes for a discoverable direct-manipulation editor.

## What GeRAFE should borrow—and what it should protect

Borrow or study:

- proven indexed-format behavior from IGV/igv.js and JBrowse parser packages;
- adapter/display separation and extension boundaries from JBrowse;
- TDF, group scaling, and headless/vector export behavior from JBR;
- hubs and public annotation discovery from UCSC and WashU;
- tiled matrix architecture from HiGlass;
- explicit marks, transformations, scales, and compositions from Gosling and
  GenomeSpy;
- physical layout, reusable configuration, and publication output from
  pyGenomeTracks, CoolBox, and Sushi.

Protect as GeRAFE's product identity:

- a focused interface built around frequently used local functional-genomics
  workflows rather than a catalogue of every available analysis;
- native-feeling file opening, persistence, and track manipulation;
- visual grouping independent of scale binding and stranded-source pairing;
- fast, stable navigation where track decoration does not shift during panning;
- one semantic document shared by exploration and figure composition;
- a graphical figure editor that preserves editable genomic meaning and
  provenance instead of merely decorating an exported screenshot.

## How to use this reference

When a difficult feature is planned, first identify the closest reference above
and inspect its current documentation, behavior, file conventions, and—where
available—implementation. Record the resulting design choice in the relevant
GeRAFE issue. Reuse code only after checking the exact package license and fit;
similar behavior is inspiration, not permission to copy an implementation.

Reassess the build-versus-adopt decision if an external tool later provides all
three of these without forcing GeRAFE into an unsuitable interaction model:

1. an embeddable, dependable local-file browser with the formats GeRAFE needs;
2. a practical direct-manipulation genomic figure editor; and
3. a stable semantic interchange layer that preserves tracks, groups, strand
   roles, scales, annotations, and provenance between them.
