import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildRuntimeArchive as buildRuntimeArchiveImpl } from "../src/archive";
import {
  installRuntimeArchive as installRuntimeArchiveImpl,
  listInstalledRuntimes,
  resolveCurrentRuntime,
} from "../src/install";
import { readRuntimeManifest } from "../src/manifest";
import { resealRuntime } from "../src/reseal";
import {
  buildRuntimeEnv as buildRuntimeEnvImpl,
  stageRuntime as stageRuntimeImpl,
  verifyRuntime as verifyRuntimeImpl,
} from "../src/runtime";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const TEST_KEY_ID = "runtime-pipeline-test";
const TEST_KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const signingKey = { keyId: TEST_KEY_ID, privateKey: TEST_KEY_PAIR.privateKey };
const trustedKeys = { [TEST_KEY_ID]: TEST_KEY_PAIR.publicKey };
const TARGET_KEY_ID = "runtime-pipeline-target";
const TARGET_KEY_PAIR = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const stageRuntime = (
  opts: Omit<Parameters<typeof stageRuntimeImpl>[0], "signingKey">,
) => stageRuntimeImpl({ ...opts, signingKey });
const buildRuntimeArchive = (
  opts: Omit<Parameters<typeof buildRuntimeArchiveImpl>[0], "signingKey">,
) => buildRuntimeArchiveImpl({ ...opts, signingKey });
const installRuntimeArchive = (
  opts: Omit<Parameters<typeof installRuntimeArchiveImpl>[0], "trustedKeys">,
) => installRuntimeArchiveImpl({ ...opts, trustedKeys });
const verifyRuntime = (
  opts: Omit<Parameters<typeof verifyRuntimeImpl>[0], "trustedKeys">,
) => verifyRuntimeImpl({ ...opts, trustedKeys });
const buildRuntimeEnv = (
  runtimeDir: string,
  baseEnv?: Record<string, string | undefined>,
  platform?: NodeJS.Platform,
) => buildRuntimeEnvImpl(runtimeDir, baseEnv, platform, trustedKeys);

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cowork-runtime-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function writeFile(root: string, relative: string, content = "fixture"): Promise<void> {
  const destination = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

async function writeExecutable(
  root: string,
  relative: string,
  content = "#!/bin/sh\nprintf 'fixture\\n'\n",
): Promise<void> {
  const destination = path.join(root, ...relative.split("/"));
  await writeFile(root, relative, content);
  await fs.chmod(destination, 0o755);
}

async function fakeSourceRuntime(root: string): Promise<void> {
  await writeFile(
    root,
    "runtime.json",
    `${JSON.stringify(
      {
        bundleFormatVersion: 2,
        bundleVersion: "fixture.1",
        nodeVersion: "v24.0.0",
        pythonVersion: "3.12.0",
        pnpmVersion: "11.0.0",
        targetPlatform: "win32",
        targetArch: "x64",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(root, "dependencies/node/bin/node.exe");
  await writeFile(root, "dependencies/node/node_modules/pnpm/bin/pnpm.mjs");
  await writeFile(
    root,
    "dependencies/node/node_modules/@oai/artifact-tool/package.json",
    '{"name":"@oai/artifact-tool","version":"2.8.13"}\n',
  );
  await writeFile(root, "dependencies/python/python.exe");
  await writeFile(root, "dependencies/native/git/cmd/git.exe");
  await writeFile(root, "dependencies/native/poppler/Library/bin/pdfinfo.exe");
  await writeFile(root, "dependencies/native/poppler/Library/bin/pdftoppm.exe");
  await writeFile(root, "dependencies/native/libheif/libheif/bin/heif-convert.exe");
  await writeFile(root, "dependencies/native/jxrlib/jxrlib/bin/JxrDecApp.exe");
}

async function fakeLibreOfficeInput(root: string): Promise<{
  componentInputDir: string;
  windowsSofficeShimPath: string;
}> {
  const componentInputDir = path.join(root, "component-input");
  await writeFile(componentInputDir, "libreoffice/program/soffice.com");
  await writeFile(
    componentInputDir,
    "libreoffice/cowork-libreoffice.json",
    '{"schemaVersion":1,"version":"26.2.3","asset":"win-x86"}\n',
  );
  const windowsSofficeShimPath = path.join(root, "soffice.exe");
  await fs.writeFile(windowsSofficeShimPath, "fixture shim");
  return { componentInputDir, windowsSofficeShimPath };
}

async function fakeMacSourceRuntime(root: string): Promise<void> {
  await writeFile(
    root,
    "runtime.json",
    `${JSON.stringify(
      {
        bundleFormatVersion: 2,
        bundleVersion: "fixture.macos-arm64.1",
        nodeVersion: "v24.14.0",
        pythonVersion: "3.12.13",
        pnpmVersion: "11.5.3",
        targetPlatform: "darwin",
        targetArch: "arm64",
      },
      null,
      2,
    )}\n`,
  );
  await writeExecutable(
    root,
    "dependencies/node/bin/node",
    "#!/bin/sh\nprintf 'node:%s\\n' \"$*\"\n",
  );
  await writeFile(root, "dependencies/node/node_modules/pnpm/bin/pnpm.mjs");
  await writeFile(
    root,
    "dependencies/node/node_modules/@oai/artifact-tool/package.json",
    '{"name":"@oai/artifact-tool","version":"2.8.13"}\n',
  );
  await writeExecutable(root, "dependencies/python/bin/python3");
  await writeFile(root, "dependencies/python/lib/pkgconfig/python-3.12.pc");
  await fs.symlink(
    "/private/build/python/lib/pkgconfig/python-3.12.pc",
    path.join(root, "dependencies", "python", "lib", "pkgconfig", "python3.pc"),
  );
  await writeExecutable(root, "dependencies/native/git/bin/git");
  await writeExecutable(
    root,
    "dependencies/native/poppler/bin/pdfinfo",
    "#!/bin/sh\nprintf 'pdfinfo:%s\\n' \"$*\"\n",
  );
  await writeExecutable(root, "dependencies/native/poppler/bin/pdftoppm");
  await writeExecutable(
    root,
    "dependencies/native/libheif/libheif/bin/heif-dec",
    "#!/bin/sh\nprintf 'heif:%s\\n' \"$*\"\n",
  );
  await fs.symlink(
    "heif-dec",
    path.join(root, "dependencies", "native", "libheif", "libheif", "bin", "heif-convert"),
  );
  await writeExecutable(
    root,
    "dependencies/native/jxrlib/jxrlib/bin/JxrDecApp",
    "#!/bin/sh\nprintf 'jxr:%s\\n' \"$*\"\n",
  );
  await writeFile(
    root,
    "dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/duplicate",
  );
}

async function fakeMacLibreOfficeInput(root: string): Promise<{ componentInputDir: string }> {
  const componentInputDir = path.join(root, "component-input");
  await writeExecutable(
    componentInputDir,
    "libreoffice/LibreOffice.app/Contents/MacOS/soffice",
  );
  await writeFile(
    componentInputDir,
    "libreoffice/cowork-libreoffice.json",
    '{"schemaVersion":1,"version":"26.2.3","asset":"macos-arm64"}\n',
  );
  return { componentInputDir };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("unified runtime pipeline", () => {
  test("re-seals only after the source signature and exact tree verify", async () => {
    const root = await tempRoot("reseal");
    const source = path.join(root, "source");
    const staged = path.join(root, "payload");
    await fakeSourceRuntime(source);
    const libreOffice = await fakeLibreOfficeInput(root);
    await stageRuntime({
      sourceDir: source,
      destinationDir: staged,
      asset: "win-x86",
      version: "2026-06-22",
      ...libreOffice,
    });

    await resealRuntime({
      runtimeDir: staged,
      sourceTrustedKeys: trustedKeys,
      signingKey: { keyId: TARGET_KEY_ID, privateKey: TARGET_KEY_PAIR.privateKey },
      expectedVersion: "2026-06-22",
      expectedAsset: "win-x86",
      execute: false,
    });

    const verification = await verifyRuntimeImpl({
      runtimeDir: staged,
      deep: true,
      trustedKeys: { [TARGET_KEY_ID]: TARGET_KEY_PAIR.publicKey },
    });
    expect(verification.errors).toEqual([]);
    expect(verification.checks.integrity).toContain(TARGET_KEY_ID);
    await expect(
      verifyRuntimeImpl({ runtimeDir: staged, trustedKeys }),
    ).resolves.toMatchObject({ ok: false });

    await fs.writeFile(path.join(staged, "dependencies", "node", "bin", "node.exe"), "hacked!");
    await expect(
      buildRuntimeArchiveImpl({
        runtimeDir: staged,
        outputFile: path.join(root, "must-not-build.zip"),
        signingKey: { keyId: TARGET_KEY_ID, privateKey: TARGET_KEY_PAIR.privateKey },
      }),
    ).rejects.toThrow("SHA-256 mismatch");
    await expect(
      resealRuntime({
        runtimeDir: staged,
        sourceTrustedKeys: { [TARGET_KEY_ID]: TARGET_KEY_PAIR.publicKey },
        signingKey,
        execute: false,
      }),
    ).rejects.toThrow("Refusing to re-seal an unverified runtime");
  });

  test("round-trips relocatable macOS ARM64 launchers and symlinks", async () => {
    if (process.platform === "win32") return;

    const root = await tempRoot("macos-arm64");
    const source = path.join(root, "source");
    const staged = path.join(root, "payloads", "macos-arm64");
    const archive = path.join(root, "dist", "cowork-runtime-macos-arm64.zip");
    const home = path.join(root, "home");
    await fakeMacSourceRuntime(source);
    const libreOffice = await fakeMacLibreOfficeInput(root);

    const manifest = await stageRuntime({
      sourceDir: source,
      destinationDir: staged,
      asset: "macos-arm64",
      version: "2026-06-21",
      createdAt: "2026-06-21T00:00:00.000Z",
      componentPlanPath: path.resolve("recipes/macos-arm64/runtime-components.json"),
      ...libreOffice,
    });
    expect(manifest.paths).toMatchObject({
      node: "dependencies/node/bin/node",
      python: "dependencies/python/bin/python3",
      pnpm: "dependencies/bin/pnpm",
      git: "dependencies/native/git/bin/git",
      pdfinfo: "dependencies/bin/pdfinfo",
      pdftoppm: "dependencies/bin/pdftoppm",
      heifConvert: "dependencies/bin/heif-convert",
      jxrDecApp: "dependencies/bin/JxrDecApp",
      popplerBin: "dependencies/native/poppler/bin",
      soffice: "dependencies/bin/soffice",
      libreOfficeBinary: "dependencies/libreoffice/LibreOffice.app/Contents/MacOS/soffice",
    });
    expect(manifest.components.map((component) => component.id)).not.toContain(
      "source-libreoffice-headless",
    );
    await expect(
      fs.stat(path.join(staged, "dependencies", "native", "libreoffice-headless")),
    ).rejects.toThrow();
    for (const launcher of [
      "pnpm",
      "pdfinfo",
      "pdftoppm",
      "heif-convert",
      "JxrDecApp",
      "soffice",
    ]) {
      const stat = await fs.stat(path.join(staged, "dependencies", "bin", launcher));
      expect(stat.mode & 0o111).not.toBe(0);
    }
    expect(await fs.readFile(path.join(staged, "dependencies", "bin", "heif-convert"), "utf8"))
      .toContain("../native/libheif/libheif/bin/heif-convert");
    expect(await fs.readFile(path.join(staged, "dependencies", "bin", "JxrDecApp"), "utf8"))
      .toContain("../native/jxrlib/jxrlib/bin/JxrDecApp");
    expect(
      await fs.readlink(
        path.join(staged, "dependencies", "python", "lib", "pkgconfig", "python3.pc"),
      ),
    ).toBe("python-3.12.pc");

    const built = await buildRuntimeArchive({ runtimeDir: staged, outputFile: archive });
    const installed = await installRuntimeArchive({
      archivePath: built.archivePath,
      expectedSha256: built.sha256,
      home,
      host: { platform: "darwin", arch: "arm64" },
    });
    const convertedLink = path.join(
      installed.runtimeDir,
      "dependencies",
      "native",
      "libheif",
      "libheif",
      "bin",
      "heif-convert",
    );
    expect((await fs.lstat(convertedLink)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(convertedLink)).toBe("heif-dec");

    const bin = path.join(installed.runtimeDir, "dependencies", "bin");
    expect(await fs.readFile(path.join(bin, "pnpm"), "utf8")).toContain("NODE_OPTIONS= exec");
    expect((await execFileAsync(path.join(bin, "pdfinfo"), ["--version"])).stdout.trim()).toBe(
      "pdfinfo:--version",
    );
    expect((await execFileAsync(path.join(bin, "heif-convert"), ["input.heic"])).stdout.trim())
      .toBe("heif:input.heic");
    expect((await execFileAsync(path.join(bin, "JxrDecApp"), ["input.jxr"])).stdout.trim()).toBe(
      "jxr:input.jxr",
    );
    expect((await execFileAsync(path.join(bin, "pnpm"), ["--version"])).stdout.trim()).toContain(
      "pnpm.mjs --version",
    );
    expect(await fs.readFile(path.join(installed.runtimeDir, "cowork", "node-resolver", "hooks.mjs"), "utf8"))
      .toContain("runtimeParentURLs.length === 0");
  });

  test("stages components, builds a release, and installs by date", async () => {
    const root = await tempRoot("pipeline");
    const source = path.join(root, "source");
    const staged = path.join(root, "payloads", "win-x86");
    const archive = path.join(root, "dist", "cowork-runtime-win-x86.zip");
    const home = path.join(root, "home");
    await fakeSourceRuntime(source);
    const libreOffice = await fakeLibreOfficeInput(root);

    const stagedManifest = await stageRuntime({
      sourceDir: source,
      destinationDir: staged,
      asset: "win-x86",
      version: "2026-06-21",
      createdAt: "2026-06-21T00:00:00.000Z",
      ...libreOffice,
    });
    expect(stagedManifest.components.find((entry) => entry.id === "runtime-launchers")?.strategy).toBe(
      "generated",
    );
    expect(stagedManifest.components.some((entry) => entry.id === "productivity-plugins")).toBe(false);
    expect(stagedManifest.paths).not.toHaveProperty("plugins");
    expect(stagedManifest.paths.soffice).toBe("dependencies/bin/soffice.exe");
    expect(stagedManifest.paths.heifConvert).toBe("dependencies/bin/heif-convert.cmd");
    expect(stagedManifest.paths.jxrDecApp).toBe("dependencies/bin/JxrDecApp.cmd");
    expect(stagedManifest.versions.libreOffice).toBe("26.2.3");
    await expect(fs.stat(path.join(staged, "plugins"))).rejects.toThrow();
    expect(await fs.readFile(path.join(staged, "provenance", "codex-primary-runtime.json"), "utf8"))
      .toContain("fixture.1");
    expect(await fs.readFile(path.join(staged, "dependencies", "bin", "pnpm.cmd"), "utf8"))
      .toContain("node.exe");
    expect(await fs.readFile(path.join(staged, "dependencies", "bin", "pnpm.cmd"), "utf8"))
      .toContain('set "NODE_OPTIONS="');

    const verification = await verifyRuntime({ runtimeDir: staged, deep: true });
    expect(verification.errors).toEqual([]);
    const built = await buildRuntimeArchive({ runtimeDir: staged, outputFile: archive });
    expect(built.sha256).toHaveLength(64);

    const installed = await installRuntimeArchive({
      archivePath: built.archivePath,
      expectedSha256: built.sha256,
      home,
      host: { platform: "win32", arch: "arm64" },
    });
    expect(installed.runtimeDir).toBe(path.join(home, ".cowork", "runtime", "2026-06-21"));
    expect(await resolveCurrentRuntime(home)).toBe(installed.runtimeDir);
    expect(await readRuntimeManifest(installed.runtimeDir)).toMatchObject({
      version: "2026-06-21",
      asset: "win-x86",
    });
    expect(await listInstalledRuntimes(home)).toEqual([
      { version: "2026-06-21", path: installed.runtimeDir, current: true },
    ]);
  });

  test("exports one runtime environment and refuses bad checksums", async () => {
    const root = await tempRoot("env");
    const source = path.join(root, "source");
    const staged = path.join(root, "payload");
    await fakeSourceRuntime(source);
    const libreOffice = await fakeLibreOfficeInput(root);
    await stageRuntime({
      sourceDir: source,
      destinationDir: staged,
      asset: "win-x86",
      version: "2026-06-21",
      ...libreOffice,
    });
    const env = await buildRuntimeEnv(
      staged,
      { PATH: "C:\\Windows\\System32", PYTHONDONTWRITEBYTECODE: "0" },
      "win32",
    );
    expect(env.COWORK_RUNTIME_DIR).toBe(staged);
    expect(env.COWORK_RUNTIME_NODE_MODULES).toContain(path.join("dependencies", "node", "node_modules"));
    expect(env.NODE_PATH).toContain(path.join("node_modules", ".pnpm", "node_modules"));
    expect(env.COWORK_RUNTIME_SOFFICE).toBe(path.join(staged, "dependencies", "bin", "soffice.exe"));
    expect(env.COWORK_RUNTIME_POPPLER_BIN).toBe(
      path.join(staged, "dependencies", "native", "poppler", "Library", "bin"),
    );
    expect(env.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION).toBe("1");
    expect(env.PATH).not.toContain(path.join("dependencies", "libreoffice", "program"));
    expect(env).not.toHaveProperty("COWORK_RUNTIME_PLUGINS_DIR");
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(env.NODE_OPTIONS).toContain("register.mjs");

    const built = await buildRuntimeArchive({
      runtimeDir: staged,
      outputFile: path.join(root, "runtime.zip"),
    });
    await expect(
      installRuntimeArchive({
        archivePath: built.archivePath,
        expectedSha256: "0".repeat(64),
        home: path.join(root, "home"),
      }),
    ).rejects.toThrow("checksum mismatch");
  });

  test("keeps the current runtime and one fallback after a third install", async () => {
    const root = await tempRoot("retention");
    const source = path.join(root, "source");
    const home = path.join(root, "home");
    await fakeSourceRuntime(source);
    const libreOffice = await fakeLibreOfficeInput(root);

    for (const version of ["2026-06-19", "2026-06-20", "2026-06-21"]) {
      const staged = path.join(root, "payloads", version);
      const archive = path.join(root, "dist", `${version}.zip`);
      await stageRuntime({
        sourceDir: source,
        destinationDir: staged,
        asset: "win-x86",
        version,
        ...libreOffice,
      });
      const built = await buildRuntimeArchive({ runtimeDir: staged, outputFile: archive });
      await installRuntimeArchive({
        archivePath: built.archivePath,
        expectedSha256: built.sha256,
        home,
        host: { platform: "win32", arch: "x64" },
      });
    }

    expect(await listInstalledRuntimes(home)).toEqual([
      {
        version: "2026-06-21",
        path: path.join(home, ".cowork", "runtime", "2026-06-21"),
        current: true,
      },
      {
        version: "2026-06-20",
        path: path.join(home, ".cowork", "runtime", "2026-06-20"),
        current: false,
      },
    ]);
    await expect(fs.stat(path.join(home, ".cowork", "runtime", "2026-06-19"))).rejects.toThrow();
  });
});
