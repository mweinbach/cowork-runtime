# Update an existing runtime

Use this process when refreshing an already-supported asset such as `win-x86`.

## 1. Choose a new date version

Use the release date in `YYYY-MM-DD` form. Never rebuild a consumed release under the same date and silently replace its bytes.

For examples below:

```powershell
$Version = "2026-07-01"
$Asset = "win-x86"
$Source = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime"
```

## 2. Inspect the new source before staging

Check the source manifest and top-level layout:

```powershell
Get-Content "$Source\runtime.json"
Get-ChildItem "$Source\dependencies"
Get-ChildItem "$Source\plugins\openai-primary-runtime\plugins"
```

Compare at least:

- source bundle version, target platform, and target architecture;
- Node, Python, and pnpm versions;
- top-level Node packages and private supplied packages;
- Python package versions;
- native tools and their versions;
- plugin list and plugin manifest versions;
- new or removed license files;
- changes to expected entrypoint paths.

Do not patch the source cache in place. Treat it as an immutable input.

Compare `runtime-overlays/plugins/` against the refreshed upstream plugin tree before staging. Review every same-path difference as an intentional Cowork override, retain useful upstream-only files, and remove obsolete Cowork overlays instead of letting them drift silently.

## 3. Refresh component recipes

Update the matching directory under `recipes/<asset>/`.

For Windows Python inventory:

```powershell
& "$Source\dependencies\python\python.exe" -m pip freeze --all
```

Remove machine-local direct references from the public requirements recipe and keep supplied/private packages documented separately.

For Node, inspect the source pnpm lock and update the resolved top-level public versions in `node-packages.json`:

```text
dependencies/node/node_modules/.pnpm/lock.yaml
```

If a component moved, appeared, or disappeared, update [`runtime-components.json`](../runtime-components.json) or create a platform-specific component plan.

## 4. Stage from scratch

```powershell
bun run stage -- `
  --source $Source `
  --asset $Asset `
  --version $Version `
  --force
```

For a platform-specific component plan:

```powershell
bun run stage -- `
  --source $Source `
  --asset $Asset `
  --version $Version `
  --component-plan "recipes\$Asset\runtime-components.json" `
  --force
```

Review the staged `payloads/<asset>/runtime.json`. Confirm that every component strategy and source is truthful.

## 5. Verify the staged payload

```powershell
bun run verify -- --runtime "payloads\$Asset" --deep --execute
```

Additionally run entrypoints that are meaningful for the update:

```powershell
& "payloads\win-x86\dependencies\bin\pnpm.cmd" --version
& "payloads\win-x86\dependencies\bin\pdfinfo.cmd" -v
& "payloads\win-x86\dependencies\bin\pdftoppm.cmd" -v
```

For plugin updates, verify each plugin's declared skill files and run a representative artifact task. A documents update should create a DOCX and exercise the render path when LibreOffice is available; presentations and spreadsheets should exercise `@oai/artifact-tool` output.

## 6. Build the release asset

```powershell
bun run build -- --runtime "payloads\$Asset" --asset $Asset
```

Record the size and SHA-256 from the command output. Unexpected large changes usually mean a dependency tree or native bundle changed and deserve inspection.

## 7. Test a clean install

Never verify only the staging directory. Extract through the same installer users will run:

```powershell
$SmokeHome = Join-Path $env:TEMP "cowork-runtime-$Version"

bun src/cli.ts install `
  --archive "dist\cowork-runtime-$Asset.zip" `
  --checksum "dist\cowork-runtime-$Asset.zip.sha256" `
  --home $SmokeHome

bun src/cli.ts verify `
  --runtime "$SmokeHome\.cowork\runtime\$Version" `
  --deep `
  --execute
```

This catches archive modes, symlink behavior, path relocation, long-path issues, and missing files that staging verification cannot.

## 8. Review and publish

Run `bun run check`, review `git status`, then follow [Release and rollback](releasing-and-rollback.md).

## Update checklist

- [ ] New date version selected.
- [ ] Source manifest and component versions reviewed.
- [ ] Public dependency recipes refreshed.
- [ ] Private/direct-copy inputs explicitly recorded.
- [ ] License inventory reviewed.
- [ ] Staged runtime passes deep and executable verification.
- [ ] Generated launchers execute from the relocated payload.
- [ ] Clean installer extraction passes.
- [ ] Representative document/PDF/presentation/spreadsheet flows pass.
- [ ] ZIP and SHA-256 sidecar are attached to the matching release tag.
