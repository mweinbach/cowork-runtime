# Release and rollback

## Release policy

- One tag per ISO date: `runtime-YYYY-MM-DD`.
- Stable asset names within that tag.
- One `.sha256` sidecar per ZIP.
- One application-pinned Ed25519 signing identity; the private key is supplied only by the protected release environment.
- Only verified platform assets are published.
- Published bytes are immutable.

`gh release upload --clobber` is acceptable only while preparing an unpublished/internal release that no consumer can have installed. Once distributed, correct the issue in a new date-versioned release.

## Pre-release gate

GitHub release jobs receive the signing identity through the encrypted
`COWORK_RUNTIME_SIGNING_PRIVATE_KEY` repository secret and the non-secret
`COWORK_RUNTIME_SIGNING_KEY_ID` repository variable. Run the **Runtime Release
Signing Preflight** workflow before a release build. It maps the secret into the
job environment, materializes `COWORK_RUNTIME_SIGNING_KEY_FILE` under
`RUNNER_TEMP` with mode `0600`, verifies that it derives the public key committed
under `keys/`, and deletes the temporary file even on failure. Build/signing
steps must consume `COWORK_RUNTIME_SIGNING_KEY_FILE`; they must never echo or
persist the multiline private-key environment value.

For every platform asset:

1. `bun run check` passes.
2. `COWORK_RUNTIME_SIGNING_KEY_FILE` is present, private, and matches the repository public key.
3. Staged schema-2 payload passes signature, exact-tree, `verify --deep --execute` checks on the target OS.
4. ZIP build completes and produces a checksum.
5. Clean installer extraction repeats signature, exact-tree, and executable verification.
6. Generated launchers execute from the installed path.
7. Representative artifact workflows pass.
8. Component provenance and dependency recipes are current.
9. License and notice files have been reviewed.

## Publish

Example for Windows:

```powershell
$Version = "2026-07-01"
$Tag = "runtime-$Version"

gh release create $Tag `
  dist/cowork-runtime-win-x86.zip `
  dist/cowork-runtime-win-x86.zip.sha256 `
  --title "Cowork Runtime $Version" `
  --notes "Windows x86-64 runtime. Windows ARM64 uses x64 emulation."
```

For a multi-platform release, attach every verified ZIP/checksum pair to the same tag.

## Verify the published release

Download into a clean directory instead of trusting the upload response:

```powershell
gh release download runtime-2026-07-01 --dir release-smoke
```

Compare the downloaded checksum sidecar, then install from the downloaded archive into a temporary home and repeat signature, exact-tree, and deep executable verification using the pinned public key.

Also exercise the GitHub download path used by consumers:

```powershell
bun src/cli.ts download `
  --repo owner/cowork-runtime `
  --version 2026-07-01 `
  --home "$env:TEMP\cowork-runtime-release-smoke"
```

## Roll back locally

The active runtime and one fallback remain side by side. Activate the fallback without downloading it again:

```powershell
bun src/cli.ts list
bun src/cli.ts activate --version 2026-06-21
```

The next harness process should resolve `current.json` and use the selected directory. Do not mutate the contents of either installed version.

Retention runs only after a new archive passes checksum, extraction, compatibility, manifest, and deep runtime verification. A successful third install removes the oldest inactive version. If an older version is manually reactivated, pruning preserves that active version plus the newest available fallback.

## Roll back a product default

If agent-coworker pins or recommends a runtime version:

1. Change the default/recommended date back to a known-good release.
2. Keep already-installed versions intact.
3. Restart or refresh the harness runtime resolver.
4. Verify the active manifest and executable checks.
5. Publish a follow-up runtime rather than overwriting the bad release.

## Broken or compromised release

1. Stop advertising the tag immediately.
2. Remove or mark the GitHub release as unavailable if continued downloads are unsafe.
3. Record the affected SHA-256 and component provenance.
4. Publish a new date version with corrected inputs.
5. Update the harness recommendation or minimum-safe version.
6. Add a regression test for the failure.

Deleting a release does not remove already-installed copies. Consumers need an explicit minimum-safe-version or denylist mechanism before automatic remediation can be guaranteed.
