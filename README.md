# Cowork Runtime

Cowork Runtime packages the platform-specific tools and productivity plugins used by the Cowork harness into one versioned release artifact.

The application itself still runs on Bun. This runtime is the managed execution layer for artifact work: Node, Python, public package dependencies, native utilities, and the document/PDF/presentation/spreadsheet plugins.

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
| Productivity plugins | Direct copy | Remain supplied release inputs |

Every installed `runtime.json` records the strategy, path, and provenance of each component. Replacing a copied component with a reproducible builder does not change archive names or the harness integration contract.

The first extracted public dependency recipes live under [`recipes/win-x86`](recipes/win-x86/README.md). They deliberately keep `@oai/artifact-tool`, `artifact_tool_v2`, and curated plugins outside the public build recipe as supplied inputs.

Large payloads are intentionally ignored by Git. `payloads/` is local staging and `dist/` contains release assets.

## Build the Windows payload

Install the small builder dependencies:

```powershell
bun install
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
COWORK_RUNTIME_PLUGINS_DIR
```

It also prepares `PATH`, `NODE_PATH`, and a Node `--import` resolver hook so builders in writable scratch directories can directly import managed packages such as `@oai/artifact-tool`.

## Safety properties

- SHA-256 is verified before extraction.
- ZIP entries are bounded by count and unpacked size.
- Absolute paths, traversal paths, duplicate paths, unsafe links, and special filesystem entries are rejected.
- Installation uses a staging directory and atomic promotion.
- The source payload is never modified.
- Runtime binaries and release ZIPs are not committed to Git.

Run `bun run check` for the typecheck and deterministic test suite.
