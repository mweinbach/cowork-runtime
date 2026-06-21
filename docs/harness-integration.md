# Harness integration

The harness owns runtime lifecycle and tool behavior. Desktop and mobile clients should only display status and invoke typed server controls.

## Recommended startup flow

```text
resolve configured/recommended date
        │
        ▼
resolveCurrentRuntime()
        │ missing/outdated
        ▼
downloadAndInstallRuntime()
        │
        ▼
verifyRuntime()
        │
        ▼
buildRuntimeEnv()
        │
        ▼
tool context + plugin discovery
```

Reusable exports are available from [`src/index.ts`](../src/index.ts):

- `downloadAndInstallRuntime()`
- `installRuntimeArchive()`
- `resolveCurrentRuntime()`
- `activateInstalledRuntime()`
- `listInstalledRuntimes()`
- `readRuntimeManifest()`
- `verifyRuntime()`
- `buildRuntimeEnv()`
- `resolveRuntimeAssetForHost()`

## Server responsibilities

The server should:

1. Resolve the Cowork auth home and runtime root.
2. Select the correct release asset for the host.
3. Download/install outside an active model turn when possible.
4. Verify before activation.
5. Build a scoped environment for shell/tool subprocesses.
6. Discover plugins from `manifest.paths.plugins`.
7. Add runtime cache roots to sandbox policy only where writes are genuinely required.
8. Expose status, diagnostics, install, and activation over JSON-RPC.
9. Log versions and verification results without logging credentials or signed URLs.

The desktop UI should not download archives, mutate `current.json`, select binaries, or implement fallback logic.

## Per-turn environment

Call `buildRuntimeEnv()` using the active runtime and the tool's base environment. Pass the result into shell/tool processes and provider-owned execution processes that need the runtime.

Avoid assigning the full result into global `process.env`. Runtime `PATH` and `NODE_OPTIONS` can affect the server itself, package managers, Electron, and provider subprocesses unexpectedly.

Sandboxed commands should receive:

- the runtime entrypoint directories on `PATH`;
- Cowork runtime path variables;
- `NODE_OPTIONS` and resolver variables;
- no unrelated provider keys or server secrets.

## Plugin discovery

The unified runtime contains the curated plugin tree. Consumers should read the active manifest and discover from its declared plugin root rather than hardcoding an old Codex cache location.

Plugin enable/disable state remains user configuration under `~/.cowork`; upgrading the runtime must not silently re-enable a plugin the user disabled.

Runtime plugin files are immutable release content. User and workspace overrides stay outside the runtime directory.

## Migration from the split runtime

When agent-coworker adopts this package:

1. Add the unified resolver alongside the existing artifact/Codex/LibreOffice code.
2. Prefer an active `~/.cowork/runtime/<date>` when present.
3. Install the unified release if no active runtime exists.
4. Map tools and plugin discovery to the unified manifest.
5. Run provider, sandbox, document, presentation, spreadsheet, and packaged-desktop tests.
6. Remove the old split bootstrap code, state files, and bundle flags in one focused cleanup after the unified path is proven.

Do not permanently probe both old and new cache trees on every turn. If legacy migration is needed, make it an explicit one-time migration with recorded state.

## Packaged desktop

Two supported approaches are possible:

- Download the release on first use and share the same installer as server/CLI deployments.
- Bundle a verified release ZIP as an app resource, then install it through `installRuntimeArchive()` on first use.

Do not unpack a second ad hoc runtime into Electron resources and bypass activation/verification. The same manifest and install path should remain authoritative.

## Diagnostics to expose

A runtime status response should include:

- active version and asset;
- resolved install path;
- source bundle version;
- shallow/deep/executable verification state;
- Node and Python versions;
- included plugins;
- available update date;
- last install/download error;
- whether the host is using emulation.

Keep download and activation separate controls so a runtime can be preloaded, verified, and then promoted deliberately.

