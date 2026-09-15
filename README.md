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
- Select one or multiple tracks and edit their colors, heights, grouping, and type-specific display settings.
- Automatic visible-window scaling, fixed scales, and linked scales for quantitative tracks.
- Automatic positive/negative signal pairing from common filename markers such as `plus`/`minus` and `pos`/`neg`, with one shared zero axis and independently scaled strand magnitudes.
- Stranded pairs remain compatible with visual groups; grouped autoscaling and color controls keep ordinary, positive, and negative channels separate.
- Collapsed, expanded, and squished layouts for interval and gene tracks.
- Persistent light and dark themes.
- Automatic restoration of local desktop tracks between launches, with relinking when a source has moved or changed.
- Versioned `.gerafe.json` workspace files with track layout, source provenance, and display settings, plus 100-step undo/redo while editing. Legacy `.locus.json` workspaces remain supported.

## Supported files

| Format | Extensions | Current display |
| --- | --- | --- |
| BigWig | `.bw`, `.bigWig` | Indexed quantitative signal with zoom summaries |
| bedGraph | `.bedGraph` | Quantitative signal for smaller text-based datasets |
| TDF | `.tdf` | Indexed IGV signal tiles, including compressed and uncompressed fixed-step, variable-step, BED, and BED-with-name tiles |
| BAM | `.bam` with `.bai` or `.csi` | Coverage and packed read alignments with CIGAR geometry, pairing, mismatches, indels, and splice gaps |
| BED | `.bed` | BED3–BED12 intervals, blocks, thick regions, strand, labels, scores, and item colors |

On desktop, GeRAFE automatically looks beside a BAM for conventional `sample.bam.bai`, `sample.bai`, `sample.bam.csi`, and `sample.csi` index names. When using the browser development build, select the BAM and its index together.

## Installation

GeRAFE does not yet publish a signed installer or prebuilt GitHub release. Build it from source with the steps below.

### Requirements

- Windows 10 or 11.
- [Node.js](https://nodejs.org/) 22.12 or newer and npm.
- Stable [Rust](https://www.rust-lang.org/tools/install) with the MSVC toolchain.
- Microsoft C++ Build Tools with **Desktop development with C++** enabled.
- Microsoft Edge WebView2 Runtime. It is normally already installed on current Windows systems.

The native requirements are described in the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Clone and run for development

```powershell
git clone https://github.com/ariel-raskin/GeRAFE.git
cd GeRAFE
npm ci
npm run desktop:dev
```

This compiles the Rust shell, starts the frontend development server, and opens the desktop application.

### Install locally for everyday use

```powershell
npm ci
npm run desktop:install-local
```

This builds the release application in a machine-local cache outside the source checkout, installs it at `%LOCALAPPDATA%\Programs\GeRAFE\gerafe.exe`, and creates a **GeRAFE** Start Menu shortcut that launches the application directly without a terminal window. Open GeRAFE from Start, then right-click its taskbar icon and choose **Pin to taskbar**.

After pulling future changes, close GeRAFE and run `npm run desktop:install-local` again. The command replaces the executable at the same location, so the Start Menu shortcut and taskbar pin continue to launch the updated application.

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

## Using the browser

### Open and navigate

- Open files with **File → Open tracks…**, `Ctrl+O`, or drag and drop.
- Search for a gene such as `RUNX1`, or enter a locus such as `chr8:127,700,001-127,900,000`.
- Drag horizontally over the track data to pan.
- Hold `Ctrl` while using the mouse wheel to zoom around the pointer.
- Double-click the data area or use the toolbar `+` and `−` buttons to zoom.
- The percentage between the zoom buttons is chromosome-relative: **100%** shows the full chromosome.
- Use the normal mouse wheel to scroll through tracks or an overflowing gene track.

### Manage tracks

- Click a track label to select it.
- Use `Ctrl`-click to toggle selection, `Shift`-click to select a range, or `Ctrl+A` outside a text field to select all visible tracks.
- Right-click a track label for display, color, height, scale, grouping, duplication, relinking, and removal options.
- Recognizable complementary BigWig, bedGraph, and TDF signal files link automatically. Right-click the combined track to set strand colors, relink either source, or separate the sources again. Automatic linking can be toggled under **Settings**.
- Drag selected tracks to reorder them or move them between the upper and lower panes.
- Click a group card to select the entire group; right-click it for group-wide options.
- Use **Fit tracks** to fit the visible upper tracks into the available pane height. Each channel of a linked positive/negative pair receives the same height as a regular signal track.

### BAM display controls

BAM track menus provide:

- coverage plus alignments, coverage-only, or alignments-only views;
- expanded, collapsed, and squished read packing;
- paired-read display and mismatch visibility;
- coloring by track, strand, pair orientation, or mapping quality;
- minimum MAPQ and duplicate, secondary, or supplementary-alignment filters.

### Workspaces and persistence

Desktop-opened source paths are retained locally and reopened on the same computer when GeRAFE starts again. If a file is missing or has changed, its track remains in the workspace and can be relinked.

Use **File → Save workspace…** to export a `.gerafe.json` document and **Open workspace…** to restore it. GeRAFE also opens legacy `.locus.json` workspaces. Workspace files contain layout, settings, paths, and provenance—not copies of genomic data. A workspace moved to another computer therefore requires access to, or relinking of, its source files.

## Current limitations

- The desktop application is currently built and tested on Windows; packaged installers and signed releases are not provided yet.
- There is not yet an in-app updater. Updating a source installation requires pulling the latest code and running the local installer again.
- The supported track formats are limited to those listed above.
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
| `npm run desktop:dev` | Run the Tauri desktop application in development mode |
| `npm run desktop:build` | Build the production desktop executable |
| `npm run desktop:check-setup` | Check Windows desktop build prerequisites without installing |
| `npm run desktop:install-local` | Build and install the Windows app at its stable local path and create its Start Menu shortcut |
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
- [Related genome browsers and visualization tools](docs/RELATED_TOOLS.md)
- [Semantic track system and browser/figure compatibility design](docs/TRACK_SYSTEM_DIRECTION.md)
- [Bundled reference-data sources](docs/THIRD_PARTY_DATA.md)
