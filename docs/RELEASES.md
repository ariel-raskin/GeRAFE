# Releasing and updating GeRAFE

GeRAFE uses signed Tauri update artifacts attached to GitHub Releases. The
initial Windows installer and all later in-app updates are built by GitHub
Actions from a version tag; release executables are never committed to the
repository.

## Release security

Tauri updater signatures authenticate the packages accepted by installed copies
of GeRAFE. They are separate from Windows Authenticode signing.

- The updater public key is intentionally stored in `src-tauri/tauri.conf.json`.
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are
  encrypted GitHub Actions repository secrets.
- A machine-local backup currently exists under
  `%LOCALAPPDATA%\GeRAFE\release-signing`. It is restricted to the current
  Windows user and is not part of the repository.
- The `.dpapi` password backup is tied to this Windows account and computer. Keep
  an additional offline backup of the original private key and its password in
  separate secure locations. Losing either one prevents existing installations
  from accepting later updates.

Never print the private key in a workflow, add it to a repository file, attach
it to a release, or send it through an issue or pull request.

## Create a beta release

1. Start an ordinary release branch from current `main`.
2. Choose the next semantic version and synchronize every version-bearing file:

   ```powershell
   npm run version:set -- 0.1.2
   npm run version:check
   ```

3. Update user-facing release notes or documentation as needed, then run:

   ```powershell
   npm test
   npm run build
   cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

4. Commit the version bump, open a pull request, allow CI to pass, and merge it.
5. From updated `main`, create and push the matching tag:

   ```powershell
   git tag v0.1.2
   git push origin v0.1.2
   ```

6. The **Release Windows beta** workflow verifies that the tag matches the
   application version, repeats the test suite, builds the Windows NSIS
   installer, signs its updater artifact, creates `latest.json`, and opens a
   draft GitHub Release.
7. Download and install the draft asset on a Windows test account. Verify the
   app version, Start Menu entry, workspace restoration, file reopening, and
   **Help → Check for updates**.
8. Publish the draft only after that smoke test. Published releases become
   visible to existing applications through the static `latest.json` endpoint.

Do not move or reuse a version tag after publishing it. If a release is bad,
restore the desired code in a new, higher patch version; the updater deliberately
does not accept downgrades.

## Tester installation and updates

An invited tester installs the current `GeRAFE_*_x64-setup.exe` from the latest
GitHub Release once. The NSIS installer is per-user and does not require
administrator privileges. Because the beta does not yet use an Authenticode
certificate, Windows SmartScreen may require the tester to confirm the initial
download.

The app checks for a newer signed release shortly after startup. It never
installs silently: the tester chooses **Update and restart**, and GeRAFE saves
the current workspace before downloading. A manual check is available under
**Help → Check for updates**.

The application identifier remains `org.arielraskin.gerafe`, so WebView storage
and automatic workspace state remain in place across installer updates. During
the first transition only, the installer refreshes an existing executable at
the old `%LOCALAPPDATA%\Programs\GeRAFE` development-install path so an existing
taskbar pin continues to launch the current version.

GitHub Release downloads are publicly reachable because the repository is
public. Permission to use prerelease builds remains limited by
`BETA_TESTING.md`.
