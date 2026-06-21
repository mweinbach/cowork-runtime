# Cowork Runtime maintainer guides

These guides describe how to evolve the runtime without changing its consumer contract accidentally.

## Start here

- [Runtime contract](runtime-contract.md) — archive layout, manifest, install paths, environment, and compatibility promises.
- [Update an existing runtime](updating-a-runtime.md) — refresh Windows or another existing platform from a newer source payload.
- [Add a platform](adding-a-platform.md) — bring up macOS or Linux and add host selection safely.
- [Component lifecycle](component-lifecycle.md) — decide whether a component is built, generated, or copied, then migrate it over time.
- [Release and rollback](releasing-and-rollback.md) — produce, publish, verify, activate, and roll back date-versioned releases.
- [Harness integration](harness-integration.md) — consume the unified runtime from agent-coworker without moving business logic into the desktop UI.
- [Troubleshooting](troubleshooting.md) — common packaging, extraction, native dependency, and runtime-resolution failures.

## The pipeline

```text
component inputs
      │
      ▼
stageRuntime() + runtime-components.json
      │
      ▼
payloads/<asset>/runtime.json
      │
      ├── verify --deep --execute
      ▼
buildRuntimeArchive()
      │
      ▼
cowork-runtime-<asset>.zip + .sha256
      │
      ▼
installRuntimeArchive()
      │
      ▼
~/.cowork/runtime/YYYY-MM-DD + current.json
```

## Invariants

1. The ZIP root contains the runtime directly; it is not wrapped in another directory.
2. `runtime.json` is Cowork-owned and is the canonical manifest.
3. The source runtime manifest is provenance only and lives under `provenance/`.
4. Published assets are immutable. A changed payload receives a new date-versioned release.
5. Native payloads are built and execution-tested on their target operating system.
6. Every ZIP is accompanied by a SHA-256 sidecar.
7. A release is not complete until a clean archive extraction passes deep and executable verification.

