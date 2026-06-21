# Runtime contract

This is the compatibility boundary between the runtime repository and consumers such as agent-coworker.

## Release shape

One GitHub release represents one date version:

```text
tag: runtime-YYYY-MM-DD

cowork-runtime-win-x86.zip
cowork-runtime-win-x86.zip.sha256
cowork-runtime-macos-x86.zip
cowork-runtime-macos-x86.zip.sha256
cowork-runtime-macos-arm64.zip
cowork-runtime-macos-arm64.zip.sha256
cowork-runtime-linux-x86.zip
cowork-runtime-linux-x86.zip.sha256
cowork-runtime-linux-arm64.zip
cowork-runtime-linux-arm64.zip.sha256
```

Only assets that have actually been built and verified should be attached. Missing platform assets are preferable to placeholders.

Asset filenames remain stable across releases. The release tag supplies the version.

## Host mapping

| Runtime asset ID | Compatible hosts | Current state |
| --- | --- | --- |
| `win-x86` | `win32-x64`, `win32-arm64` | Implemented. ARM64 uses x64 emulation. |
| `macos-x86` | `darwin-x64` | Reserved for platform bring-up. |
| `macos-arm64` | `darwin-arm64` | Implemented as a native Apple Silicon payload. |
| `linux-x86` | `linux-x64` | Reserved for platform bring-up. |
| `linux-arm64` | `linux-arm64` | Reserved for platform bring-up. |

Despite its product-facing `x86` label, `win-x86` and the other `*-x86` assets are x86-64 payloads, not 32-bit binaries.

Host selection is implemented in [`src/platform.ts`](../src/platform.ts). Unsupported platform/architecture pairs fail closed.

## Archive layout

```text
runtime.json
provenance/
  codex-primary-runtime.json
cowork/
  node-resolver/
dependencies/
  bin/
  libreoffice/
  node/
  python/
  native/
```

The layout is relocatable. Launchers and resolver hooks derive paths from their own location or from manifest paths; they must not contain the staging machine's absolute paths.

## Manifest

`runtime.json` uses `schemaVersion: 1` and contains:

| Field | Meaning |
| --- | --- |
| `version` | ISO release date used as the install directory name. |
| `asset` | Runtime asset ID used for host compatibility. |
| `assetFileName` | Stable GitHub release filename. |
| `compatibleHosts` | Explicit `platform-arch` allowlist. |
| `source` | Source payload kind, version, platform, and architecture. |
| `components` | Strategy and provenance for each assembled component. |
| `versions` | Human-readable Node, Python, and package-manager versions. |
| `paths` | POSIX-style relative paths to runtime entrypoints. |
| `payload` | Expected file count and unpacked byte count for deep verification. |

All manifest paths are normalized relative paths. Absolute paths, backslashes, and traversal are rejected.

Changing field meaning or removing a required field requires a new manifest schema version and a coordinated consumer update. Adding an optional field does not.

## Installation and activation

An archive is installed as follows:

1. Hash the downloaded ZIP and compare it with the `.sha256` asset.
2. Extract into `~/.cowork/runtime/.staging-<uuid>` with containment and size limits.
3. Parse `runtime.json`, check host compatibility, and perform deep verification.
4. Atomically rename the staging directory to `~/.cowork/runtime/YYYY-MM-DD`.
5. Write `~/.cowork/runtime/current.json` to activate it.

Installed versions are immutable. Activation changes the pointer; it does not rewrite an installed runtime.

## Environment contract

Consumers call `buildRuntimeEnv()` and pass the returned environment only to tool processes that need runtime access.

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

The result also prepends runtime entrypoints to `PATH`, prepends the package tree to `NODE_PATH`, adds the Cowork resolver through `NODE_OPTIONS=--import=...`, forces `PYTHONDONTWRITEBYTECODE=1`, and disables synchronous LibreOffice printer detection. The private LibreOffice program directory is intentionally absent from `PATH`.

Marketplace skill helpers use `COWORK_RUNTIME_NODE_MODULES` to find supplied packages. The runtime does not contain or patch skill files, and consumers must never use the runtime as a plugin discovery root.

Do not mutate global `process.env` as the integration mechanism. Construct a per-turn or per-child-process environment so unrelated server and provider processes do not inherit the artifact toolchain accidentally.

## Verification levels

- Shallow verification checks the manifest and required paths.
- Deep verification recomputes payload file count and unpacked bytes before and after executable probes.
- Executable verification launches Node, Python, and pnpm; imports the Python document stack, `@oai/artifact-tool`, and the public managed Node packages; checks Git, Poppler, and libheif; and performs a real HTML-to-PDF conversion.
- macOS executable verification also confirms the required Mach-O architecture and validates LibreOffice's nested Developer ID signatures after relocation.

A release requires all three on the target host.

## Managed headless LibreOffice

Every complete runtime contains a private, platform-native LibreOffice conversion engine and a Cowork-owned headless policy launcher. Manifest paths identify the public launcher, private engine root, and private console executable. A missing path or failed conversion makes the runtime invalid.

Host LibreOffice installations are never searched. Consumers use `COWORK_RUNTIME_SOFFICE` or the bare `soffice` name resolved from the runtime `bin` directory. Direct invocation of the private engine bypasses policy and is unsupported.

The launcher rejects interactive, printing, macro, scripting, and server modes before starting LibreOffice; forces non-interactive flags; isolates configuration in a disposable profile; disables macro execution, system file dialogs, and printer detection; and accepts only conversion, text-output, version, and help operations. The raw engine remains private because LibreOffice's document filters and renderer still require its shared UI libraries even when no UI is displayed.
