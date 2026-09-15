# Repository workflow for coding agents

- GitHub repository: `ariel-raskin/GeRAFE`. Treat it as the source of truth.
- Do not make feature or fix commits directly on `main` unless the user explicitly requests that workflow.
- Before implementation, update local `main`, create a focused branch, and inspect existing related issues and pull requests.
- For substantial work, create or reference a GitHub issue with acceptance criteria. Use a pull request for every completed branch and include tests and known limitations.
- Keep commits small enough to review and use descriptive conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, `chore:`).
- Preserve user files and unrelated working-tree changes. Never commit local genomics data, secrets, build outputs, dependency directories, or executables.
- Run `npm test` and `npm run build` for normal changes. Add relevant real-file smoke tests for file-format work and build the desktop app for native changes.
- Update documentation and workspace-schema migrations whenever user-visible behavior or persisted state changes.
- GeRAFE (Genomic Renderer and Figure Editor) is the project and application name. Use `GeRAFE` in user-facing text and `gerafe` for package and executable identifiers.
