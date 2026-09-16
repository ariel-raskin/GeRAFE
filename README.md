<h1 align="center">
  <img src="static/gerafe-icon.png" alt="GeRAFE icon" width="170" align="middle">
  &nbsp;GeRAFE
</h1>

<p align="center"><strong>Genomic Renderer and Figure Editor</strong></p>

<p align="center">
  A fast, local-first desktop genome browser being built toward publication-quality genomic figure composition.
</p>

<p align="center">
  <a href="https://github.com/ariel-raskin/GeRAFE/actions/workflows/ci.yml"><img src="https://github.com/ariel-raskin/GeRAFE/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

GeRAFE explores genomic signal, alignment, interval, and gene-annotation tracks directly from files on your computer. It provides responsive chromosome navigation, flexible track organization, and persistent workspaces without uploading genomic data.

GeRAFE is currently developed and tested as a Windows desktop application.

![GeRAFE showing synthetic stranded PRO-seq, H3K27ac, BED intervals, and built-in RefSeq genes](screenshots/gerafe-browser.png)

> [!IMPORTANT]
> GeRAFE is early research software. Validate displays against established tools before relying on them for analysis, and do not use the application for clinical decisions.

> [!NOTE]
> GeRAFE is not currently open-source software. Installation and use are limited
> to specifically invited beta testers under the
> [prerelease evaluation terms](BETA_TESTING.md).

## Features

- Smooth drag-to-pan and cursor-centered zooming across genomic coordinates.
- Search by hg38 gene symbol or enter chromosome coordinates directly.
- Built-in hg38 chromosome sizes, cytobands, and RefSeq gene/transcript annotations.
- Import custom reference assemblies from `.fai`, `.genome`, `.chrom.sizes`, and other two-column chromosome-size files.
- Two independently scrollable and resizable track panes with a fixed coordinate header.
- Reorder tracks by dragging and organize related tracks into visual groups.
- Select one or multiple tracks and edit their colors, heights, height locks, grouping, and shared type-specific display settings.
- Automatic visible-window scaling, fixed scales, linked scales, and optional zero-flooring for quantitative tracks.
- Automatic positive/negative signal pairing from common filename markers such as `plus`/`minus` and `pos`/`neg`, with one shared zero axis, red/blue strand colors, and independently scaled strand magnitudes.
- Stranded pairs remain compatible with visual groups; grouped autoscaling and color controls keep ordinary, positive, and negative channels separate.
- Collapsed, expanded, and squished layouts for interval and gene tracks.
- Arc-style BEDPE interaction tracks with endpoint anchors, score-weighted emphasis, optional item colors, interchromosomal markers, top/bottom arc orientation, and annotation-aware gene filters.
- Indexed cis contact-map tracks from `.hic`, `.cool`, and multiresolution `.mcool` files, with zoom-aware resolution selection and triangular heatmap rendering.
- Persistent light and dark themes.
- Automatic restoration of local desktop tracks between launches, with relinking when a source has moved or changed.
- Versioned `.gerafe.json` workspace files with track layout, source provenance, and display settings, plus 100-step undo/redo while editing. Legacy `.locus.json` workspaces remain supported.

## Supported files

| Format | Extensions | Current display |
| --- | --- | --- |
| BigWig | `.bw`, `.bigWig` | Indexed quantitative signal with zoom summaries |
| bedGraph | `.bedGraph`, `.bedGraph.gz` | Quantitative signal; the desktop app creates and reuses an indexed local cache for compressed or large files |
| TDF | `.tdf` | Indexed IGV signal tiles, including compressed and uncompressed fixed-step, variable-step, BED, and BED-with-name tiles |
| BAM | `.bam` with `.bai` or `.csi` | Coverage and packed read alignments with CIGAR geometry, pairing, mismatches, indels, and splice gaps |
| BED | `.bed` | BED3–BED12 intervals, blocks, thick regions, strand, labels, scores, and item colors |
| BEDPE | `.bedpe` | Paired genomic interactions as arcs and anchor blocks; interchromosomal contacts use labeled markers |
| Hi-C | `.hic` | Indexed sparse cis contact matrices with source resolutions and KR/VC-family normalizations when present |
| Cooler | `.cool` | Indexed sparse cis contact matrices with raw counts and discovered balancing columns |
| Multires Cooler | `.mcool` | Zoom-aware sparse cis contact matrices across the file's available resolutions |

On desktop, GeRAFE automatically looks beside a BAM for conventional `sample.bam.bai`, `sample.bai`, `sample.bam.csi`, and `sample.csi` index names. When using the browser development build, select the BAM and its index together.

Large and gzip-compressed bedGraph sources are streamed into a private multiresolution BigWig cache under the operating system's GeRAFE cache directory. GeRAFE normally uses the active reference's chromosome sizes to build the cache in one pass, falling back to an additional discovery pass for chromosomes absent from the reference. The first open can take time because ordinary gzip files cannot be randomly accessed; later opens, workspace restoration, panning, and zooming reuse the indexed cache. Changing the source file invalidates and rebuilds its cache. GeRAFE does not place sidecar files beside the original data.

## Installation

Invited beta testers can install the current Windows build from the
[latest GeRAFE release](https://github.com/ariel-raskin/GeRAFE/releases/latest).
Download `GeRAFE_*_x64-setup.exe` and run it. The installer is per-user and does
not require administrator privileges.

GeRAFE's update packages are cryptographically signed and verified by the app.
The beta installer does not yet have a Windows Authenticode certificate, so
Microsoft SmartScreen may show a warning after a browser download.

### Requirements

- Windows 10 or 11.
- Microsoft Edge WebView2 Runtime. It is normally already installed on current Windows systems.

The following additional tools are needed only to build GeRAFE from source:

- [Node.js](https://nodejs.org/) 22.12 or newer and npm.
- Stable [Rust](https://www.rust-lang.org/tools/install) with the MSVC toolchain.
- Microsoft C++ Build Tools with **Desktop development with C++** enabled.

The native requirements are described in the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Clone and run for development

```powershell
git clone https://github.com/ariel-raskin/GeRAFE.git
cd GeRAFE
npm ci
npm run desktop:dev
```

This compiles the Rust shell, starts the frontend development server, and opens the desktop application.

### Install a development build locally

```powershell
npm ci
npm run desktop:install-local
```

This builds the release application in a machine-local cache outside the source checkout, installs it at `%LOCALAPPDATA%\Programs\GeRAFE\gerafe.exe`, and creates a **GeRAFE** Start Menu shortcut that launches the application directly without a terminal window. Open GeRAFE from Start, then right-click its taskbar icon and choose **Pin to taskbar**.

After pulling future source changes, close GeRAFE and run
`npm run desktop:install-local` again. This source-install command remains for
development; invited testers should normally use the release installer and
in-app updater.

For a first installation or routine update from an existing Windows checkout, you
can instead double-click **Install or Update GeRAFE.cmd**. See the
[multi-computer setup guide](docs/MULTI_COMPUTER_SETUP.md) for a GitHub-based
workflow and details about workspace and local-data behavior across computers.

### Build without installing

```powershell
npm ci
npm run desktop:build
```

The executable is written to:

```text
src-tauri/target/release/gerafe.exe
```

From an existing checkout, `Launch GeRAFE.cmd` opens the locally installed application after `npm run desktop:install-local` has been run.

### Updates

The installed desktop app checks for signed beta updates shortly after launch.
When one is available, review its notes and choose **Update and restart**. GeRAFE
saves the current workspace before downloading and never installs an update
silently. Use **Help → Check for updates** to check manually or **Help → About
GeRAFE** to see the installed version.

## Using the browser

### Open and navigate

- Open files with **File → Open tracks…**, `Ctrl+O`, or drag and drop.
- Search for a gene such as `RUNX1`, or enter a locus such as `chr8:127,700,001-127,900,000`.
- Drag horizontally over the track data to pan.
- Hold `Ctrl` while using the mouse wheel to zoom around the pointer.
- Double-click the data area or use the toolbar `+` and `−` buttons to zoom.
- Drag the slider between the zoom buttons for direct chromosome-scale zoom control; its left edge shows the full chromosome and its right edge reaches base-level detail.
- Use the normal mouse wheel to scroll through tracks or an overflowing gene track.

### Manage tracks

- Click a track label to select it.
- Use `Ctrl`-click to toggle selection, `Shift`-click to select a range, or `Ctrl+A` outside a text field to select all visible tracks.
- Right-click a track label for display, color, height, scale, grouping, duplication, relinking, and removal options. Ordinary signal tracks can also suppress negative values when those values are not meaningful.
- Recognizable complementary BigWig, bedGraph, and TDF signal files link automatically. Right-click the combined track to set strand colors, relink either source, or separate the sources again. Under **Settings → Track options**, choose whether to show TSS elbows, auto-link strands, apply red/blue strand colors, and autoscale new visual groups.
- Drag selected tracks to reorder them or move them between the upper and lower panes. Hold the primary mouse button over a track body to select it without returning to its label. Hover either outer boundary of a selected track—or of a consecutive selected run—and drag vertically to resize every selected track by the same pixel amount.
- Click a group card to select the entire group; right-click it for group-wide options.
- Use **Fit tracks** to fit the visible upper tracks exactly into the available pane height. Long names retain enough height for two centered lines. **Lock track height** in a track's context menu reserves its current height and excludes it from manual and automatic fitting. The separate indicator on the right side of the button enables persistent automatic fitting as tracks or pane dimensions change. Each channel of a linked positive/negative pair receives the same height as a regular signal track.
- The lower gene track sizes itself to the visible layout; its small reference provenance label is informational and does not reserve additional layout space. Collapsed mode overlays representative gene structures on one baseline and uses two collision-aware name lanes, keeping its height bounded at wide genomic spans. Expanded and squished modes retain transcript stacking.

### BAM display controls

BAM track menus provide:

- coverage plus alignments, coverage-only, or alignments-only views;
- expanded, collapsed, and squished read packing;
- paired-read display and mismatch visibility;
- coloring by track, strand, pair orientation, or mapping quality;
- minimum MAPQ and duplicate, secondary, or supplementary-alignment filters.

### Contact-matrix display controls

Right-click one or several selected `.hic`, `.cool`, or `.mcool` tracks to open hover fly-out menus for their shared resolution, normalization, intensity, and color-scale controls. Resolution can follow the visible span automatically or use a value supported by every selected source. New tracks start with unnormalized values (`NONE` for `.hic`, raw counts for Cooler) and a publication-oriented yellow → red → black scale. A dark-canvas warm → red → white adaptation and a single-color scale are also available. Intensity can use an off-diagonal automatic z-maximum or a fixed z-max with either log or linear transformation. The triangular matrix can be flipped above or below its baseline and re-queries its visible contact distance when its height changes.

GeRAFE reads genomic coordinates from each Cooler's stored bin table and canonicalizes the triangle orientation of both Cooler and `.hic` cells before drawing. Matrix readers and their indexes are reused across queries, pans use an overscanned window, and contacts too distant to be visible within the track height are omitted from the render payload to keep navigation responsive. Sparse bins without a returned contact are painted with the selected scale's zero-value color rather than interpolated; the current sparse payload does not distinguish a true zero from a masked or unavailable bin.

### Workspaces and persistence

Desktop-opened source paths are retained locally and reopened on the same computer when GeRAFE starts again. If a file is missing or has changed, its track remains in the workspace and can be relinked.

Use **File → Save workspace…** to export a `.gerafe.json` document and **Open workspace…** to restore it. GeRAFE also opens legacy `.locus.json` workspaces. Workspace files contain layout, settings, paths, and provenance—not copies of genomic data. A workspace moved to another computer therefore requires access to, or relinking of, its source files.

## Current limitations

- The desktop application and release installer are currently built and tested on Windows x64 only.
- Release updates have a required Tauri updater signature but not yet a Windows Authenticode certificate, so SmartScreen may warn on the first installer download.
- The supported track formats are limited to those listed above.
- BEDPE is currently an in-memory arc track for files up to 50 MB, with at most 2,000 highest-scoring interactions drawn per visible window.
- Contact-matrix tracks currently show one-dimensional cis windows as triangular heatmaps. Interchromosomal maps, two-axis navigation, expected/observed transforms, and matrix-derived annotations are not yet available.
- Custom references provide coordinate navigation but do not automatically include gene annotations or cytobands.
- Individual BAM reads are drawn below a 250 kb visible span; BAM requests are limited to 2 Mb to avoid unbounded pileups.
- Mismatches can be read from BAM MD tags. Reconstructing mismatches for BAMs without MD tags is unavailable because reference-sequence bases are not currently loaded.
- Browser-only development sessions cannot retain JavaScript `File` objects across a page reload; native desktop sessions can retain file paths.
- Stranded signals currently use the shared-baseline diverging presentation with independent positive and negative magnitude scales. Symmetric, stacked, and fully separate paired presentations are planned but not yet available.

## Development

Install dependencies and run the automated checks:

```powershell
npm ci
npm test
npm run build
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the frontend in a browser |
| `npm run desktop:dev` | Run the Tauri desktop application in development mode using a machine-local Cargo target outside synced folders |
| `npm run desktop:build` | Build the production desktop executable |
| `npm run desktop:bundle` | Build the signed-update-compatible Windows NSIS installer (requires the private signing environment) |
| `npm run desktop:check-setup` | Check Windows desktop build prerequisites without installing |
| `npm run desktop:install-local` | Build and install the Windows app at its stable local path and create its Start Menu shortcut |
| `npm run version:check` | Verify package, Tauri, Cargo, and lockfile versions match |
| `npm run version:set -- 0.1.2` | Set all application version fields together |
| `npm test` | Run the Vitest unit suite |
| `npm run build` | Type-check and build the production frontend |
| `npm run smoke` | Run the general browser smoke test against a running development server |
| `npm run benchmark:data -- "C:\path\to\signal.bw"` | Benchmark indexed BigWig reads |

Parser and renderer changes should also be checked with the relevant scripts under `scripts/` using real local files. Genomic test data and generated executables must not be committed.

## Privacy

GeRAFE reads genomic files locally. It does not upload tracks, workspaces, loci, or usage data, and it currently contains no telemetry. A saved workspace may contain absolute source paths, so inspect it before sharing it publicly.

## Beta testing and feedback

GeRAFE is currently being tested by specifically invited beta testers. Testers
may send feedback directly to the maintainer through the communication channel
arranged with them; a GitHub account is not required. External code
contributions are not currently being accepted. Please do not send private,
controlled-access, or unpublished genomic data with feedback. See
[BETA_TESTING.md](BETA_TESTING.md) for the limited evaluation permission and
[SECURITY.md](SECURITY.md) for security reports.

## License status

GeRAFE does not currently have an open-source license. Default copyright rules
therefore apply: the public repository may be viewed and forked under GitHub's
terms, but no general permission to modify, redistribute, or commercially use
GeRAFE has been granted. Specifically invited beta testers have only the limited
evaluation permission described in [BETA_TESTING.md](BETA_TESTING.md). A formal
software license may be selected later.

## Documentation

- [Contributing workflow](CONTRIBUTING.md)
- [Prerelease beta-testing terms](BETA_TESTING.md)
- [Development history before Git](docs/DEVELOPMENT_HISTORY.md)
- [Feasibility and performance notes](docs/FEASIBILITY.md)
- [Multi-computer Windows setup](docs/MULTI_COMPUTER_SETUP.md)
- [Release and in-app update workflow](docs/RELEASES.md)
- [Related genome browsers and visualization tools](docs/RELATED_TOOLS.md)
- [Semantic track system and browser/figure compatibility design](docs/TRACK_SYSTEM_DIRECTION.md)
- [Bundled reference-data sources](docs/THIRD_PARTY_DATA.md)
