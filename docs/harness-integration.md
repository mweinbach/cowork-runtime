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
tool context
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
4. Verify schema 2, its Ed25519 signature, and the complete exact tree before activation; schema 1 is diagnostics-only.
5. Build a scoped environment for shell/tool subprocesses.
6. Independently ensure marketplace plugins through the normal user/project plugin installer.
7. Keep the installed runtime read-only; artifact outputs and temporary profiles belong in normal writable workspace/scratch roots.
8. Expose status, diagnostics, install, and activation over JSON-RPC.
9. Log versions and verification results without logging credentials or signed URLs.
10. Verify direct entrypoint closures on every use and invalidate cached component trust when the recursive runtime watcher observes a mutation or overflows.

The desktop UI should not download archives, mutate `current.json`, select binaries, or implement fallback logic.

## Per-turn environment

Call `buildRuntimeEnv()` using the active runtime and the tool's base environment. Pass the result into shell/tool processes and provider-owned execution processes that need the runtime.

Avoid assigning the full result into global `process.env`. Runtime `PATH` and `NODE_OPTIONS` can affect the server itself, package managers, Electron, and provider subprocesses unexpectedly.

Sandboxed commands should receive:

- the runtime entrypoint directories on `PATH`;
- Cowork runtime path variables;
- `NODE_OPTIONS` and resolver variables;
- no unrelated provider keys or server secrets.

## Skills and plugin discovery

The unified runtime contains no skills or plugins. Marketplace-installed project and user plugins are the authoritative skill content and stay in the normal `.cowork/plugins` roots.

Runtime setup and marketplace setup are independent startup operations. A runtime failure must not make the harness treat runtime files as skills, and a marketplace update must not mutate runtime binaries. Plugin enable/disable state remains user configuration under `~/.cowork`.

## Migration from the split runtime

When agent-coworker adopts this package:

1. Prefer an active `~/.cowork/runtime/<date>` when present.
2. Install the unified release if no active runtime exists.
3. Map tool environments to the unified manifest while leaving plugin discovery on marketplace/user/project roots.
4. Run provider, sandbox, document, presentation, spreadsheet, and packaged-desktop tests.
5. Remove the old split bootstrap code, state files, and bundle flags after the unified path verifies.
6. Remove the legacy standalone LibreOffice downloader/cache. Resolve only the `soffice` launcher supplied by the active unified runtime.

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
- separately installed marketplace plugin state;
- available update date;
- last install/download error;
- whether the host is using emulation.
- managed headless LibreOffice version and real conversion health, reported as part of runtime integrity.

Keep download and activation separate controls so a runtime can be preloaded, verified, and then promoted deliberately.
