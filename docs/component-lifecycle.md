# Component lifecycle

Every runtime component has one declared strategy in [`runtime-components.json`](../runtime-components.json) or a platform-specific override.

## Strategy definitions

| Strategy | Use when | Required evidence |
| --- | --- | --- |
| `built` | Cowork owns or has reproducible build inputs and transforms them into runtime output. | Pinned sources, checksums, build command, deterministic output checks, license record. |
| `generated` | The output is small platform glue derived entirely from repository code or metadata. | Source-controlled generator and tests. |
| `copied` | The component is a supplied/private artifact or a temporary prebuilt dependency without a Cowork recipe. | Exact source version/path, provenance, integrity check, license review, replacement plan when appropriate. |

`copied` is not shorthand for “easier.” Use it only when rebuilding is unavailable, disproportionately risky, or intentionally delegated to an upstream release pipeline.

## Decision process

Ask in order:

1. Do we have legal and technical permission to redistribute it?
2. Is source or a supported package artifact available?
3. Can we pin every network input by version and SHA-256?
4. Can we build it reproducibly on each target platform?
5. Does rebuilding improve security, size, maintenance, or portability enough to justify ownership?
6. If not, what exact supplied artifact is the source of truth?

Record the answer in the platform recipe and component note.

## Move a copied component to built

1. Add a platform recipe containing source URLs, versions, and SHA-256 values.
2. Add lockfiles or hash-locked dependency inputs.
3. Implement a named builder in `stageRuntime()` or a dedicated module called by it.
4. Write output only inside the component's staging destination.
5. Validate expected executable/package paths before accepting output.
6. Change the component strategy from `copied` to `built`.
7. Add a fixture test for the builder and a native real-payload smoke test.
8. Compare old and new behavior, package versions, licenses, archive size, and representative artifact outputs.
9. Remove the old direct-copy source only after the built component ships successfully.

The archive and install contract must remain unchanged during this transition.

## Supplied/private components

Current supplied inputs include `@oai/artifact-tool` and Python `artifact_tool_v2`.

- Never place credentials, authenticated download URLs, or internal source paths in the release manifest.
- Accept supplied artifacts through a local staging input or protected CI artifact.
- Pin and verify a digest before assembly when a standalone artifact is available.
- Preserve embedded license and notice files.
- Record only non-sensitive provenance in `runtime.json`.

## Skills marketplace boundary

Skills and plugins are not runtime components. Their source of truth is the Cowork skills marketplace, and the application installs them independently into project or user plugin roots.

Do not copy, transform, or patch skill content during runtime staging. Marketplace helpers must consume the public runtime environment contract, including `COWORK_RUNTIME_NODE_MODULES`, rather than a Codex cache path.

LibreOffice is a checksum-pinned component input because the reference runtime does not contain it. Cowork copies the normalized official engine into the unified ZIP and builds the headless policy launcher itself. The private engine remains upstream-supplied; the public no-UI/no-print boundary is Cowork-owned.

## Native dependency policy

For Git, Poppler, libheif, jxrlib, and future native tools:

- prefer official reproducible releases with published hashes;
- otherwise build in native CI from a pinned source revision;
- record compiler/toolchain and minimum OS/ABI assumptions;
- inspect dynamic library dependencies;
- test after relocation and ZIP extraction;
- keep license notices inside the runtime.

## Dependency recipe hygiene

- Pin exact versions, not ranges.
- Commit lockfiles where redistribution rules allow it.
- Use hashes for Python wheels and downloaded archives before promoting a recipe to release-grade.
- Separate public package recipes from supplied/private inputs.
- Do not generate recipes by copying machine-specific `file://` references.
- Review package removals as carefully as additions; plugin scripts may rely on packages indirectly.

## Provenance expectations

Each component manifest entry should answer:

- What is it?
- Was it built, generated, or copied?
- Where is it in the runtime?
- What source input produced it?
- Why is this strategy currently appropriate?

The source runtime's original `runtime.json` is preserved under `provenance/`, but it never replaces Cowork's canonical manifest.
