# Cowork Runtime

Cowork Runtime packages the platform-specific tools and libraries used by the Cowork harness into one versioned release artifact.

The application itself still runs on Bun. This runtime is the managed execution layer for artifact work: Node, Python, package dependencies, and native utilities. Skills and plugins are separate application downloads from the Cowork skills marketplace and are never bundled into this archive.

## Maintainer guides

The [maintainer guide index](docs/README.md) covers:

- [updating an existing platform runtime](docs/updating-a-runtime.md);
- [adding macOS, Linux, or another platform](docs/adding-a-platform.md);
- [deciding which components to build, generate, or copy](docs/component-lifecycle.md);
- [the archive/install/environment contract](docs/runtime-contract.md);
- [publishing and rolling back releases](docs/releasing-and-rollback.md);
- [agent-coworker integration](docs/harness-integration.md);
- [runtime troubleshooting](docs/troubleshooting.md).

## Release contract

Each release uses an ISO-date version and a stable asset name:

| Host | Release asset | Notes |
| --- | --- | --- |
| Windows x64 | `cowork-runtime-win-x86.zip` | The `x86` asset label means the x86-64 compatibility payload. |
| Windows ARM64 | `cowork-runtime-win-x86.zip` | Runs through Windows x64 emulation for now. |
| macOS x64 | `cowork-runtime-macos-x86.zip` | Payload to be assembled later. |
| macOS ARM64 | `cowork-runtime-macos-arm64.zip` | Payload to be assembled later. |
| Linux x64 | `cowork-runtime-linux-x86.zip` | Payload to be assembled later. |
| Linux ARM64 | `cowork-runtime-linux-arm64.zip` | Payload to be assembled later. |

For version `2026-06-21`, the expected release tag is `runtime-2026-06-21`. Every ZIP has a sibling `.sha256` asset.

Installation is checksum-verified, extracted into a temporary directory, validated, then atomically promoted to:

```text
~/.cowork/runtime/2026-06-21/
```

`~/.cowork/runtime/current.json` selects the active version. There is no mutable `current/` directory or platform-dependent symlink.

## Component policy

The runtime is assembled from components rather than blindly cloning an upstream directory. [`runtime-components.json`](runtime-components.json) is the source of truth.

Current Windows bootstrap:

| Component | Current strategy | Intended direction |
| --- | --- | --- |
| Cowork manifest, checksums, installer | Generated/built here | Cowork-owned |
| Node ESM resolver | Built here | Cowork-owned |
| Relocatable launchers | Generated here | Cowork-owned |
| Node executable and package tree | Copied from the pinned reference payload | Assemble from official Node, a lockfile, and a supplied private artifact package |
| Python executable and packages | Copied from the pinned reference payload | Assemble from portable Python and a hashed requirements lock |
| Git, Poppler, libheif, jxrlib | Copied from the pinned reference payload | Fetch or compile from pinned upstream releases per platform |
| `@oai/artifact-tool` | Direct copy | Remains a supplied release input unless build inputs become available |
| LibreOffice conversion engine | Official binary, checksum-pinned and normalized here | Keep full filter/render compatibility while exposing no interactive launcher |
| Headless `soffice` policy launcher | Built here; Windows uses a tiny Rust shim | Cowork-owned |

Every installed `runtime.json` records the strategy, path, and provenance of each component. Replacing a copied component with a reproducible builder does not change archive names or the harness integration contract.

The first extracted public dependency recipes live under [`recipes/win-x86`](recipes/win-x86/README.md). They deliberately keep `@oai/artifact-tool` and `artifact_tool_v2` outside the public build recipe as supplied inputs.

Large payloads are intentionally ignored by Git. `payloads/` is local staging and `dist/` contains release assets.

## Build the Windows payload

Install the small builder dependencies:

```powershell
bun install
```

Prepare the checksum-pinned LibreOffice component on the target operating system. Windows release builders also need a Rust toolchain for the small native `soffice.exe` forwarding shim:

```powershell
bun run prepare:libreoffice -- --asset win-x86 --force
```

Assemble from the current OpenAI reference runtime:

```powershell
bun run stage -- `
  --source "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime" `
  --asset win-x86 `
  --version 2026-06-21 `
  --force
```

This copies only the components marked `copied`, builds the Cowork-owned support layer, generates launchers, preserves the original source manifest under `provenance/`, and writes the canonical Cowork `runtime.json`.

No source skill or plugin tree is copied. Marketplace skills consume this runtime through the environment contract below; the marketplace owns their instructions and helper scripts.

Build and verify the release:

```powershell
bun run build -- --runtime payloads/win-x86 --asset win-x86
bun run verify -- --runtime payloads/win-x86 --deep --execute
```

The build creates:

```text
dist/cowork-runtime-win-x86.zip
dist/cowork-runtime-win-x86.zip.sha256
```

## Test the installer locally

Use a temporary home first:

```powershell
bun src/cli.ts install `
  --archive dist/cowork-runtime-win-x86.zip `
  --checksum dist/cowork-runtime-win-x86.zip.sha256 `
  --home "$env:TEMP\cowork-runtime-smoke"

bun src/cli.ts verify `
  --runtime "$env:TEMP\cowork-runtime-smoke\.cowork\runtime\2026-06-21" `
  --deep `
  --execute
```

Install to the real Cowork home by omitting `--home`.

## Publish a GitHub release

Once this repository has a GitHub remote and the ZIP has passed the local install smoke test:

```powershell
gh release create runtime-2026-06-21 `
  dist/cowork-runtime-win-x86.zip `
  dist/cowork-runtime-win-x86.zip.sha256 `
  --title "Cowork Runtime 2026-06-21" `
  --notes "Windows x86-64 runtime; Windows ARM64 uses x64 emulation."
```

During private release preparation only, before any consumer can have installed the asset, a corrected upload can be replaced with:

```powershell
gh release upload runtime-2026-06-21 `
  dist/cowork-runtime-win-x86.zip `
  dist/cowork-runtime-win-x86.zip.sha256 `
  --clobber
```

After distribution, never clobber published bytes. Publish a new date version instead. See [Release and rollback](docs/releasing-and-rollback.md).

## Download from the harness or CLI

The reusable library exports release selection, download, safe extraction, verification, activation, and environment construction. The standalone CLI uses the same code:

```powershell
bun src/cli.ts download `
  --repo owner/cowork-runtime `
  --version 2026-06-21
```

The runtime environment exposes a single namespace:

```text
COWORK_RUNTIME_DIR
COWORK_RUNTIME_VERSION
COWORK_RUNTIME_ASSET
COWORK_RUNTIME_BIN
COWORK_RUNTIME_NODE
COWORK_RUNTIME_PYTHON
COWORK_RUNTIME_NODE_MODULES
COWORK_RUNTIME_NODE_RESOLVER
COWORK_RUNTIME_POPPLER_BIN
COWORK_RUNTIME_SOFFICE
COWORK_RUNTIME_LIBREOFFICE_DIR
COWORK_RUNTIME_LIBREOFFICE_BINARY
```

It also prepares `PATH`, `NODE_PATH`, and a Node `--import` resolver hook so marketplace skill builders in writable scratch directories can directly import managed packages such as `@oai/artifact-tool`.

## Skills marketplace boundary

The runtime and skills have independent release lifecycles:

- the app downloads this platform runtime into `~/.cowork/runtime/<date>`;
- the app downloads authoritative plugins and skills from the Cowork skills marketplace into the normal project or user plugin roots;
- plugin discovery never scans the runtime directory;
- updating the runtime cannot replace skill content, and updating a skill cannot replace runtime binaries.

Marketplace helpers that need package locations use `COWORK_RUNTIME_NODE_MODULES`; they must not reach into a Codex cache or assume a mutable compatibility directory.

## LibreOffice and `soffice`

The OAI reference payload does not carry LibreOffice, so Cowork adds it as a separate, checksum-pinned component input while still publishing one unified runtime ZIP. [`libreoffice-sources.json`](libreoffice-sources.json) pins the official platform archives and hashes.

Only Cowork's launcher under `dependencies/bin` is placed on `PATH`. The private LibreOffice program directory is never exposed. The launcher:

- rejects UI, quick-start, view, and printer command-line modes;
- always forces headless, invisible, no-logo, no-default, no-restore operation;
- creates and removes an isolated profile for every invocation;
- disables synchronous printer detection and profile printer loading;
- disables document macro execution and system file dialogs;
- forwards only conversion, text-output, version, and help operations.

On Windows, interactive module launchers such as `soffice.exe`, `swriter.exe`, and `scalc.exe` are removed from the packaged engine. `soffice.com` and `soffice.bin` remain private because they are required for the conversion engine. Rebuilding a custom LibreOffice fork is deliberately avoided: the official filter/render binaries are the compatibility boundary, while the Cowork launcher provides the no-UI/no-print boundary.

## Safety properties

- SHA-256 is verified before extraction.
- ZIP entries are bounded by count and unpacked size.
- Absolute paths, traversal paths, duplicate paths, unsafe links, and special filesystem entries are rejected.
- Installation uses a staging directory and atomic promotion.
- The source payload is never modified.
- Runtime binaries and release ZIPs are not committed to Git.

Run `bun run check` for the typecheck and deterministic test suite.
