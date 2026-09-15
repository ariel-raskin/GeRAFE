# Using GeRAFE on more than one Windows computer

Use a separate GitHub clone on each computer. GitHub remains the source of truth
for source code and version history, while the installed application, Start Menu
shortcut, taskbar pin, dependency folders, and automatic workspace state remain
local to each Windows account.

Invited beta testers should normally install a published Windows release and use
GeRAFE's in-app updater. A source checkout and development toolchain are needed
only on computers used to change or test the source code.

## Beta tester setup

1. Open the [latest GeRAFE release](https://github.com/ariel-raskin/GeRAFE/releases/latest).
2. Download and run `GeRAFE_*_x64-setup.exe`. Windows SmartScreen may request
   confirmation because beta installers do not yet have an Authenticode
   certificate.
3. Open **GeRAFE** from Start and optionally pin the running app to the taskbar.
4. GeRAFE checks for signed updates after launch. Use **Help → Check for
   updates** at any time to check manually.

## Development setup on an additional computer

1. Install the development prerequisites:

   - [Git for Windows](https://git-scm.com/download/win);
   - [Node.js 22.12 or newer](https://nodejs.org/);
   - [Rust through rustup](https://rustup.rs/);
   - [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), selecting **Desktop development with C++** and a Windows 10 or 11 SDK; and
   - Microsoft Edge WebView2 Runtime, which is normally already present on current Windows systems.

2. Clone the repository into a normal local development folder:

   ```powershell
   git clone https://github.com/ariel-raskin/GeRAFE.git
   cd GeRAFE
   ```

3. Double-click **Install or Update GeRAFE.cmd**, or run:

   ```powershell
   npm run desktop:install-local
   ```

4. The setup checks the toolchain, installs exact npm dependencies, builds
   GeRAFE, installs it at `%LOCALAPPDATA%\Programs\GeRAFE\gerafe.exe`, and
   creates the **GeRAFE** Start Menu shortcut.
5. Open **GeRAFE** from Start. Right-click its running taskbar icon and select
   **Pin to taskbar**.

Normal launches from Start or the taskbar open only GeRAFE; no terminal or
development-server window is involved. A setup window is needed only while
installing or updating the local executable.

## Installing later updates

Release installations update from inside GeRAFE. Review the release notes in
the update dialog, choose **Update and restart**, and allow the passive installer
to finish. The application saves its current automatic workspace before it
restarts.

For a development installation built from a clone, close GeRAFE, open PowerShell
in the repository, and run:

```powershell
git switch main
git pull --ff-only
npm run desktop:install-local
```

The installer replaces the executable at the same stable path and retains the
same Windows application identity. The existing Start shortcut and taskbar pin
should continue to launch the updated build.

Pulling source code alone does **not** update the installed application. A new
native executable must be built and installed after the source changes.

## Source code and synced data

- Use GitHub—not a file-sync service—to move source-code changes between
  computers. Commit work on a branch, open a pull request, and pull the merged
  `main` branch on each test computer.
- Keep large genomics files outside the Git repository. Dropbox or another
  approved storage system can still synchronize data and deliberately saved
  `.gerafe.json` workspaces.
- `node_modules`, frontend output, Rust build output, and installed executables
  are machine-generated and ignored by Git.
- Avoid sharing the `.git` directory through a file-sync service; concurrent
  writers and conflicted copies can corrupt or confuse repository state.

## State and local genomics files

GeRAFE's automatic “last opened” workspace and native source paths are stored per
Windows account. They do not automatically follow the source checkout to another
computer.

To move a deliberate browser setup between computers:

1. Save a `.gerafe.json` workspace in an approved shared location.
2. Make the referenced genomics files and indexes available on the other
   computer.
3. Open the workspace there and relink sources whose absolute paths differ.

The workspace stores paths, provenance, layout, groups, scales, colors, and
display settings; it does not embed copies of the genomic data. Inspect a
workspace before sharing it publicly because absolute paths can reveal local
usernames, folders, or project names.

## Troubleshooting

- **A required tool is missing:** the setup window names it and provides the
  relevant installation page. After installation, close and reopen the setup.
- **GeRAFE is running:** close the app before updating so Windows can replace the
  installed executable.
- **The taskbar icon points to an old or missing app:** unpin it, run setup once,
  open GeRAFE from the newly created Start shortcut, and pin that running icon.
- **A track says its source needs reopening:** make the data file available
  locally and relink it. Paths and local file access can differ between computers
  even when the workspace itself is synchronized.
