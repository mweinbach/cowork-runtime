# macOS ARM64 component recipe

This recipe captures the buildable portion of OpenAI runtime `26.619.11828` used to bootstrap the native Apple Silicon Cowork Runtime `2026-06-21`.

## Can be assembled by Cowork

- Official Node `24.14.0` ARM64 distribution.
- Public Node packages pinned in `node-packages.json` with pnpm `11.5.3`.
- Native Python `3.12.13` plus the public packages pinned in `python-requirements.lock`.
- Official ARM64 LibreOffice `26.2.3`, pinned by URL and SHA-256 in `libreoffice-sources.json`.
- Relocatable POSIX launchers under `dependencies/bin`.
- Cowork's ESM package resolver and managed headless LibreOffice policy launcher.
- Release manifest, checksum, safe extraction, activation, and verification logic.

Before switching the release builder from exact-copy to assembly, add upstream URL and SHA-256 pins for Node and Python, generate a pnpm lockfile from the public package recipe, and generate a hash-locked requirements file for ARM64 Python wheels.

## Supplied/direct-copy inputs

- `@oai/artifact-tool` and its bundled private/native dependencies.
- Python `artifact_tool_v2`.

## Native inputs awaiting dedicated recipes

- Git.
- Poppler.
- libheif.
- jxrlib.

The platform component plan copies those four native trees individually. It deliberately excludes the reference runtime's `dependencies/native/libreoffice-headless` tree so the archive contains only the checksum-pinned official LibreOffice component managed by Cowork.

All Mach-O binaries, native Node modules, Python extension modules, executable modes, relative symlinks, and the signed LibreOffice app must be validated again after archive extraction on Apple Silicon before publication.
