# Add a platform

Platform support is complete only when selection, assembly, archive preservation, installation, and executable verification all work on the target operating system.

Do not publish a placeholder ZIP or relabel a binary built for another ABI. The only intentional exception is Windows ARM64 selecting the `win-x86` x64 payload through emulation.

## 1. Select the asset ID

Existing reserved IDs are:

- `win-x86`
- `macos-x86`
- `macos-arm64`
- `linux-x86`
- `linux-arm64`

If the new platform needs a different ID, update all of the following:

1. `RUNTIME_ASSET_IDS` in [`src/types.ts`](../src/types.ts).
2. `compatibleHostsForAsset()` in [`src/platform.ts`](../src/platform.ts).
3. `expectedSourceTarget()` in `src/platform.ts`.
4. Platform tests in [`test/platform.test.ts`](../test/platform.test.ts).
5. The tables in this guide and [Runtime contract](runtime-contract.md).

Keep asset names stable after first publication.

## 2. Acquire or assemble a native source payload

The source must contain a `runtime.json` with `bundleVersion`, `targetPlatform`, and `targetArch`. The current assembler expects these logical components:

```text
dependencies/node/
dependencies/python/
dependencies/native/
runtime-inputs/<asset>/libreoffice/
```

The exact executable candidates are resolved in [`src/runtime.ts`](../src/runtime.ts). Add candidates rather than scattering platform checks through consumers.

Build or acquire the payload on the target OS. A source tree copied from another platform can contain valid-looking paths while still carrying unusable native modules.

Run `bun src/cli.ts prepare-libreoffice --asset <asset>` on that target OS. The command downloads the pinned official archive from `libreoffice-sources.json`, verifies SHA-256 before extraction, normalizes the engine into `runtime-inputs/<asset>/libreoffice`, and records provenance. Add or update the asset metadata before staging a new platform.

## 3. Create the platform recipe

Create:

```text
recipes/<asset>/README.md
recipes/<asset>/node-packages.json
recipes/<asset>/python-requirements.lock
```

If the shared [`runtime-components.json`](../runtime-components.json) is accurate, reuse it. If source paths or strategies differ, create:

```text
recipes/<asset>/runtime-components.json
```

Pass it during staging:

```bash
bun run stage -- \
  --source /path/to/source-runtime \
  --asset <asset> \
  --version YYYY-MM-DD \
  --component-plan recipes/<asset>/runtime-components.json \
  --force
```

The plan may use:

- `built` for Cowork-owned source transformed into runtime output;
- `generated` for platform launchers, manifests, and provenance;
- `copied` for supplied or prebuilt input trees.

Set `sourceBase` to `component-input` when a copied component comes from `runtime-inputs/<asset>` rather than the OAI reference payload.

See [Component lifecycle](component-lifecycle.md) before classifying a new dependency.

## 4. Add runtime entrypoint candidates

Update [`src/runtime.ts`](../src/runtime.ts) for the platform's actual layout:

- Node executable;
- Python executable and scripts directory;
- Node modules directory;
- pnpm launcher;
- Git executable;
- Poppler entrypoints;
- `@oai/artifact-tool` package root.
- managed `soffice` launcher and private LibreOffice console binary.

Keep manifest paths POSIX-style even on Windows. Convert them to native paths only at runtime.

## 5. Generate relocatable launchers

Extend `generateRuntimeLaunchers()` in `src/runtime.ts`.

Requirements:

- derive paths from the launcher's own directory;
- quote paths containing spaces;
- forward all arguments without evaluation;
- preserve the child exit code;
- avoid host-specific absolute paths;
- mark POSIX launchers executable;
- skip optional utilities only when their component is genuinely absent.

Add a test that executes each launcher after archive extraction, not only in staging.

## 6. Preserve platform filesystem semantics

The ZIP builder and extractor support executable modes and contained relative symlinks. Platform bring-up must test them explicitly.

### macOS

- Build separately for x64 and ARM64; do not infer compatibility from JavaScript-only tests.
- Verify native Node modules, Python wheels, Poppler, and other Mach-O binaries with the intended architecture.
- Decide whether downloaded binaries require signing or notarization before product distribution.
- Check quarantine behavior on a clean machine.
- Keep symlinks inside the runtime root and verify executable modes after extraction.

### Linux

- Define the supported glibc baseline and record it in the platform recipe.
- Treat glibc and musl as different runtime targets if both are needed.
- Inspect `ldd` output for Node, Python, native Python modules, and native Node modules.
- Avoid accidental dependencies on build-machine-only shared libraries or absolute RPATH entries.
- Preserve executable modes and internal symlinks.

### Windows

- Test long paths and paths containing spaces.
- Ensure runtime DLL lookup succeeds after relocation.
- Test generated `.cmd` launchers through both PowerShell and `cmd.exe`.
- For ARM64, test from an ARM64 machine even though `win-x86` runs under x64 emulation.

### Managed LibreOffice component

LibreOffice must be prepared from the pinned platform archive and included in the ZIP. Keep its private program directory off `PATH`; only generate the Cowork policy launcher in `dependencies/bin`. Platform validation must prove that the launcher blocks printing/UI options and completes a real document-to-PDF conversion without opening a window. Preserve macOS application signing by leaving the signed app payload intact and enforcing the boundary at the launcher.

## 7. Add tests and CI coverage

At minimum add:

- host-to-asset mapping tests;
- source target mismatch tests;
- staging tests for the platform's executable layout;
- launcher tests;
- archive mode/symlink tests on POSIX;
- clean install plus `verify --deep --execute` on native CI;
- one representative artifact workflow.

CI without the large payload should continue using fixture runtimes. Release validation should run in a separate native job with the real payload.

## 8. Publish with the other platform assets

All platform assets for a date share one release tag. Build each asset on its native runner, then attach the ZIP and checksum pair. Do not block an already-supported platform on an unfinished new platform; publish only verified assets and document availability.

## Platform completion checklist

- [ ] Asset ID and compatible hosts defined.
- [ ] Native source payload and provenance recorded.
- [ ] Component recipe committed.
- [ ] Entry points and launchers implemented.
- [ ] Native modules and shared libraries inspected.
- [ ] Modes and symlinks survive ZIP round-trip.
- [ ] Deep and executable verification pass after clean extraction.
- [ ] Representative artifact workflow passes.
- [ ] Managed headless `soffice` rejects UI/printing modes and passes a real conversion.
- [ ] Release asset and SHA-256 sidecar published.
- [ ] Harness selection test added.
