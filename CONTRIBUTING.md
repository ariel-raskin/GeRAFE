# Contributing to GeRAFE

GeRAFE uses GitHub as the source of truth for code, decisions, and version history.

## Development workflow

1. Start from an up-to-date `main` branch.
2. Create a focused branch such as `feat/vcf-tracks`, `fix/bam-packing`, or `docs/figure-roadmap`.
3. Use a GitHub issue for work that benefits from requirements, design discussion, or follow-up tracking. Small self-contained fixes may begin directly on a branch.
4. Keep commits scoped and descriptive. Prefer prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, and `chore:`.
5. Run `npm test` and `npm run build` before opening a pull request. Run the relevant real-file smoke test for parser or renderer changes; run `npm run desktop:build` for Tauri/native changes.
6. Open a pull request that explains the user-visible result, important design choices, verification, and known boundaries.
7. Merge through GitHub after checks pass. Preserve meaningful commits; squash only noisy fixup history.

## Repository hygiene

- Do not commit genomic input data, local workspace state, secrets, dependency folders, build products, or compiled executables.
- Bundled reference indexes under `static/reference/` are intentional application assets and may be committed when reproducibly generated.
- Keep source-format support and empty-state extension lists synchronized through `src/supported-formats.ts`.
- Update `README.md`, relevant documents, and tests when behavior or supported formats change.
- Treat the semantic track document as the contract between the genome browser and future figure builder. Record intentional schema changes and provide migrations for saved workspaces.

## Product identity

The repository and application are named **GeRAFE — Genomic Renderer and Figure Editor**. Use `GeRAFE` for user-facing text and `gerafe` for package, executable, and storage identifiers. Compatibility code may retain earlier identifiers only when it is needed to migrate existing user data or workspaces.
