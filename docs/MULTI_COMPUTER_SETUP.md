# Using GeRAFE on more than one Windows computer

GeRAFE can be developed on one computer and installed for testing on another.
Source files may arrive through the existing Dropbox-synced checkout, while GitHub
remains the authoritative project history. The compiled application, Start Menu
shortcut, taskbar pin, and automatic workspace state are local to each Windows
computer.

## One-time setup on an additional computer

1. Install the development prerequisites:

   - [Node.js 22.12 or newer](https://nodejs.org/);
   - [Rust through rustup](https://rustup.rs/);
   - [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), selecting **Desktop development with C++** and a Windows 10 or 11 SDK; and
   - Microsoft Edge WebView2 Runtime, which is normally already present on current Windows systems.

2. In Dropbox, make the GeRAFE repository folder **available offline** and wait
   until Dropbox reports that syncing is complete.
3. Double-click **Install or Update GeRAFE.cmd** in the repository root.
4. The setup window checks the toolchain, installs the exact npm dependencies,
   builds GeRAFE, installs it at
   `%LOCALAPPDATA%\Programs\GeRAFE\gerafe.exe`, and creates the **GeRAFE** Start
   Menu shortcut.
5. Open **GeRAFE** from Start. Right-click its running taskbar icon and select
   **Pin to taskbar**.

Normal launches from Start or the taskbar open only GeRAFE; no terminal or
development-server window is involved. The setup window is needed only while
installing or updating the local executable.

## Installing later updates

After a change has been merged and the coding computer's checkout is back on an
up-to-date `main` branch:

1. Close GeRAFE on the testing computer.
2. Wait for Dropbox to finish syncing the repository.
3. Double-click **Install or Update GeRAFE.cmd** again.

The installer replaces the executable at the same stable path and retains the same
Windows application identity. The existing Start shortcut and taskbar pin should
therefore launch the updated build; they do not need to be recreated for every
change.

Source synchronization alone does **not** update the installed application. A new
native executable must be built locally after the changed source arrives.

## Dropbox and GitHub responsibilities

- GitHub is the source of truth for commits, issues, pull requests, CI, and
  recoverable version history.
- Dropbox can transport the checked-out working files between these two computers,
  but it is not a replacement for committing and merging the changes on GitHub.
- Use only one computer for editing/Git operations at a time. Let Dropbox finish
  before using the checkout on the other computer; simultaneous changes can create
  conflicted copies inside both the source tree and `.git` metadata.
- Do not run a build while Dropbox is still applying a source update.
- `node_modules` and frontend build output are machine-generated. The setup command
  reconstructs them with `npm ci`; they are ignored by Git and must never be
  committed. The much larger Rust build cache and installed executable are already
  placed under `%LOCALAPPDATA%`, outside Dropbox.

If Dropbox conflicts ever become a recurring problem, the cleaner fallback is a
separate GitHub clone outside Dropbox on each computer, using `git pull` to obtain
merged changes. Genomics data and explicitly saved `.gerafe.json` workspaces can
remain in Dropbox.

## State and local genomics files

GeRAFE's automatic “last opened” workspace and native source paths are stored per
Windows account. They do not automatically follow the source checkout to another
computer.

To move a deliberate browser setup between computers:

1. Save a `.gerafe.json` workspace in a synced location.
2. Make the referenced genomics files and indexes available on the other computer.
3. Open the workspace there and relink sources whose absolute paths differ.

The workspace stores paths, provenance, layout, groups, scales, colors, and display
settings; it does not embed copies of the genomic data.

## Troubleshooting

- **A required tool is missing:** the setup window names it and provides the
  relevant installation page. After installation, close and reopen the setup.
- **GeRAFE is running:** close the app before updating so Windows can replace the
  installed executable.
- **The source appears half-updated:** wait for Dropbox to report **Up to date**, then
  rerun setup.
- **The taskbar icon points to an old or missing app:** unpin it, run setup once,
  open GeRAFE from the newly created Start shortcut, and pin that running icon.
- **A track says its source needs reopening:** make the data file available locally
  and relink it. Paths and local file access can differ between computers even when
  the workspace itself is synced.
