# Troubleshooting

## Checksum mismatch

Symptoms: installation stops before extraction.

Checks:

- Confirm the ZIP and `.sha256` came from the same release tag.
- Confirm a proxy or download cache did not return an HTML error page.
- Recompute with `Get-FileHash -Algorithm SHA256` on Windows or `sha256sum` on macOS/Linux.
- Never bypass verification to make the install proceed.

## Archive rejected during extraction

The extractor rejects traversal, absolute paths, backslashes in ZIP names, duplicates, unsafe symlinks, special files, excessive entry counts, and excessive unpacked size.

If a legitimate platform payload uses symlinks, ensure they are relative and remain inside the runtime root. Fix the archive builder; do not relax containment.

## Deep verification mismatch

Symptoms: file count or unpacked bytes differ from `runtime.json`.

Likely causes:

- the staged payload changed after its manifest was written;
- antivirus quarantined a binary;
- extraction skipped a file or link;
- the archive was built from the wrong directory;
- a developer edited the ignored payload manually.

Restage from immutable inputs, rebuild, and test a clean install.

## `@oai/artifact-tool` import fails

Check:

- `COWORK_RUNTIME_NODE_MODULES` points at the active runtime;
- `COWORK_RUNTIME_NODE_RESOLVER` exists;
- `NODE_OPTIONS` contains the resolver `--import` URL;
- the builder uses the bundled Node executable;
- the runtime asset matches the host architecture;
- the artifact package's native dependencies are present.

Run `verify --execute`; it includes a scratch-directory bare-import probe.

## Python package import fails

Confirm the bundled Python executable is used, not system Python:

```powershell
& "$Runtime\dependencies\python\python.exe" --version
& "$Runtime\dependencies\python\python.exe" -c "import docx,lxml,PIL,pandas,numpy,pypdf,pdfplumber,reportlab,pdf2image; print('ok')"
```

Do not repair an installed runtime with `pip install`. Update the recipe and publish a new immutable runtime.

## `soffice` is unavailable

The runtime is incomplete or damaged. Do not fall back to a host LibreOffice installation.

- Check that `COWORK_RUNTIME_SOFFICE` points to `dependencies/bin/soffice` (or `soffice.exe`) inside the active version.
- Run `cowork-runtime verify --deep --execute`; it performs a real PDF conversion.
- Reinstall the release if a manifest path or payload count is wrong.
- Activate the retained fallback version if the latest release fails.
- If building locally, rerun `prepare-libreoffice`, then stage and rebuild the full ZIP.

The raw `dependencies/libreoffice/program` directory must remain off `PATH`. Never invoke it directly to bypass the headless policy launcher.

## Native command fails after relocation

Run the generated launcher from the installed directory. Check quoting, relative paths, dynamic libraries, and architecture.

Windows: inspect missing DLLs and x64 emulation behavior. macOS: inspect architecture, signing, and quarantine. Linux: inspect `ldd`, glibc baseline, and RPATH.

## Installation cannot replace an existing version

An active process may hold Node, Python, or native DLLs open on Windows. Prefer installing a new date version. `--force` is for controlled local replacement before publication, not routine updates.

## `current.json` points nowhere

Use `bun src/cli.ts list`, then activate an installed version explicitly. If no versions are installed, download or install a release. Do not hand-edit absolute paths into `current.json`.

## Release download returns 404

Confirm:

- repository uses `owner/name` syntax;
- tag is `runtime-YYYY-MM-DD`;
- asset name exactly matches the host mapping;
- the ZIP and checksum are both attached;
- the release is visible to the credentials/network context used by the harness.
