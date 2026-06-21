import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRuntimeArchive } from "../src/archive";
import {
  installRuntimeArchive,
  listInstalledRuntimes,
  resolveCurrentRuntime,
} from "../src/install";
import { readRuntimeManifest } from "../src/manifest";
import { buildRuntimeEnv, stageRuntime, verifyRuntime } from "../src/runtime";

const temporaryRoots: string[] = [];

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

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("unified runtime pipeline", () => {
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
    expect(stagedManifest.versions.libreOffice).toBe("26.2.3");
    await expect(fs.stat(path.join(staged, "plugins"))).rejects.toThrow();
    expect(await fs.readFile(path.join(staged, "provenance", "codex-primary-runtime.json"), "utf8"))
      .toContain("fixture.1");
    expect(await fs.readFile(path.join(staged, "dependencies", "bin", "pnpm.cmd"), "utf8"))
      .toContain("node.exe");

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
