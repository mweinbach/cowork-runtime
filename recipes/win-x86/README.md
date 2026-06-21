# Windows x86-64 component recipe

This recipe captures the buildable portion of OpenAI runtime `26.619.11828` used to bootstrap Cowork Runtime `2026-06-21`.

The release asset remains named `win-x86` by product convention, but the binary payload targets Windows x64. Windows ARM64 uses x64 emulation.

## Can be assembled by Cowork

- Official Node `24.14.0` x64 distribution.
- Public Node packages pinned in `node-packages.json` with pnpm `11.5.3`.
- Portable Python `3.12.13` plus the public packages pinned in `python-requirements.lock`.
- Relocatable launchers under `dependencies/bin`.
- Cowork's ESM package resolver.
- Release manifest, checksum, extraction, activation, and verification logic.

Before switching the release builder from exact-copy to assembly, add upstream URL and SHA-256 pins for Node and the portable Python distribution, generate a pnpm lockfile from the public package recipe, and generate a hash-locked Python requirements file for Windows wheels.

## Supplied/direct-copy inputs

- `@oai/artifact-tool` and its bundled private/native dependencies.
- Python `artifact_tool_v2`.
- Curated Documents, PDF, Presentations, and Spreadsheets plugin directories.

## Native inputs awaiting dedicated recipes

- Portable Git.
- Poppler.
- libheif.
- jxrlib.

These are redistributable platform payloads, but should move to Cowork-owned fetch-or-build recipes with pinned upstream URLs, checksums, versions, and license inventory before exact-copy is removed.

