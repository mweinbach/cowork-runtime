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
| `macos-arm64` | `darwin-arm64` | Reserved for platform bring-up. |
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
  node/
  python/
  native/
plugins/
  openai-primary-runtime/
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
| `plugins` | Plugin directories included in the payload. |
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
COWORK_RUNTIME_PLUGINS_DIR
```

The result also prepends runtime entrypoints to `PATH`, prepends the package tree to `NODE_PATH`, and adds the Cowork resolver through `NODE_OPTIONS=--import=...`.

Do not mutate global `process.env` as the integration mechanism. Construct a per-turn or per-child-process environment so unrelated server and provider processes do not inherit the artifact toolchain accidentally.

## Verification levels

- Shallow verification checks the manifest and required paths.
- Deep verification recomputes payload file count and unpacked bytes.
- Executable verification launches Node and Python, imports the Python document stack, imports `@oai/artifact-tool` through the resolver, and checks Git.

A release requires all three on the target host.

