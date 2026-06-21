import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertHostCompatible,
  assertRuntimeVersion,
  compatibleHostsForAsset,
  expectedSourceTarget,
  runtimeAssetFileName,
} from "./platform";
import {
  assertSafeRelativePath,
  RUNTIME_MANIFEST_FILE,
  readRuntimeManifest,
  writeRuntimeManifest,
} from "./manifest";
import type {
  CoworkRuntimeManifest,
  RuntimeAssetId,
  RuntimeHost,
  RuntimeVerification,
} from "./types";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORT_DIR = path.join(PROJECT_ROOT, "runtime-support");
const COMPONENT_PLAN_FILE = path.join(PROJECT_ROOT, "runtime-components.json");

type ComponentPlanEntry = {
  id: string;
  strategy: "built" | "generated" | "copied";
  sourceBase?: "reference-runtime" | "component-input";
  source?: string;
  destination: string;
  note?: string;
};

type ComponentPlan = {
  schemaVersion: 1;
  components: ComponentPlanEntry[];
};

type SourceRuntimeManifest = {
  bundleVersion: string;
  nodeVersion?: string;
  pythonVersion?: string;
  pnpmVersion?: string;
  targetPlatform: string;
  targetArch: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSourceRuntimeManifest(value: unknown): SourceRuntimeManifest {
  if (!isRecord(value)) throw new Error("Source runtime.json must contain an object.");
  for (const key of ["bundleVersion", "targetPlatform", "targetArch"] as const) {
    if (typeof value[key] !== "string" || !value[key]) {
      throw new Error(`Source runtime.json is missing ${key}.`);
    }
  }
  return value as SourceRuntimeManifest;
}

function parseComponentPlan(value: unknown): ComponentPlan {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.components)) {
    throw new Error("Runtime component plan must use schemaVersion 1 and contain components.");
  }
  const components = value.components.map((candidate, index): ComponentPlanEntry => {
    if (!isRecord(candidate)) throw new Error(`Component plan entry ${index} must be an object.`);
    const { id, strategy, sourceBase, source, destination, note } = candidate;
    if (typeof id !== "string" || !id) throw new Error(`Component plan entry ${index} needs an id.`);
    if (strategy !== "built" && strategy !== "generated" && strategy !== "copied") {
      throw new Error(`Component ${id} has an unsupported strategy.`);
    }
    if (typeof destination !== "string") throw new Error(`Component ${id} needs a destination.`);
    assertSafeRelativePath(destination, `component ${id} destination`);
    if (source !== undefined) {
      if (typeof source !== "string") throw new Error(`Component ${id} source must be a string.`);
      assertSafeRelativePath(source, `component ${id} source`);
    }
    if (
      sourceBase !== undefined &&
      sourceBase !== "reference-runtime" &&
      sourceBase !== "component-input"
    ) {
      throw new Error(`Component ${id} has an unsupported sourceBase.`);
    }
    if (note !== undefined && typeof note !== "string") {
      throw new Error(`Component ${id} note must be a string.`);
    }
    return {
      id,
      strategy,
      destination,
      ...(sourceBase ? { sourceBase } : {}),
      ...(source ? { source } : {}),
      ...(note ? { note } : {}),
    };
  });
  return { schemaVersion: 1, components };
}

async function readComponentPlan(componentPlanPath: string): Promise<ComponentPlan> {
  const raw = await fs.readFile(componentPlanPath, "utf8");
  return parseComponentPlan(JSON.parse(raw) as unknown);
}

function pathKeyForEnv(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function dedupePathEntries(entries: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry) return false;
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appendNodeOption(existing: string | undefined, option: string): string {
  const current = existing?.trim();
  if (!current) return option;
  return current.includes(option) ? current : `${option} ${current}`;
}

function toManifestPath(runtimeDir: string, absolutePath: string): string {
  const relative = path.relative(runtimeDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Runtime path must be inside the payload: ${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

export function resolveManifestPath(runtimeDir: string, relativePath: string): string {
  return path.join(runtimeDir, ...relativePath.split("/"));
}

async function firstExisting(runtimeDir: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const absolute = resolveManifestPath(runtimeDir, candidate);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat?.isFile() || stat?.isDirectory()) return absolute;
  }
  return null;
}

async function requireExisting(
  runtimeDir: string,
  candidates: string[],
  label: string,
): Promise<string> {
  const found = await firstExisting(runtimeDir, candidates);
  if (!found) throw new Error(`Source runtime does not contain ${label}.`);
  return found;
}

async function payloadStats(runtimeDir: string): Promise<{ fileCount: number; unpackedBytes: number }> {
  let fileCount = 0;
  let unpackedBytes = 0;
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (dir === runtimeDir && entry.name === RUNTIME_MANIFEST_FILE) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fs.lstat(absolute);
        fileCount += 1;
        unpackedBytes += entry.isSymbolicLink()
          ? Buffer.byteLength(await fs.readlink(absolute), "utf8")
          : stat.size;
      }
    }
  };
  await visit(runtimeDir);
  return { fileCount, unpackedBytes };
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o755 });
  if (process.platform !== "win32") await fs.chmod(filePath, 0o755);
}

async function buildWindowsSofficeShim(opts: {
  destination: string;
  supportDir: string;
  rustcPath?: string;
  prebuiltPath?: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(opts.destination), { recursive: true });
  if (opts.prebuiltPath) {
    await fs.copyFile(path.resolve(opts.prebuiltPath), opts.destination);
    return;
  }
  const source = path.join(opts.supportDir, "headless-soffice", "shim.rs");
  await execFileAsync(opts.rustcPath ?? "rustc", [
    source,
    "--edition=2021",
    "--target",
    "x86_64-pc-windows-msvc",
    "-C",
    "opt-level=z",
    "-C",
    "strip=symbols",
    "-o",
    opts.destination,
  ], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function generateRuntimeLaunchers(
  runtimeDir: string,
  asset: RuntimeAssetId,
  opts: {
    supportDir: string;
    rustcPath?: string;
    windowsSofficeShimPath?: string;
  },
): Promise<void> {
  const binDir = path.join(runtimeDir, "dependencies", "bin");
  await fs.mkdir(binDir, { recursive: true });
  const windows = asset === "win-x86";
  if (windows) {
    const cmd = (command: string): string => `@echo off\r\nsetlocal\r\n${command}\r\nexit /b %ERRORLEVEL%\r\n`;
    await writeExecutable(
      path.join(binDir, "pnpm.cmd"),
      cmd('"%~dp0..\\node\\bin\\node.exe" "%~dp0..\\node\\node_modules\\pnpm\\bin\\pnpm.mjs" %*'),
    );
    const nativeLaunchers: Array<[string, string]> = [
      ["pdfinfo.cmd", '"%~dp0..\\native\\poppler\\Library\\bin\\pdfinfo.exe" %*'],
      ["pdftoppm.cmd", '"%~dp0..\\native\\poppler\\Library\\bin\\pdftoppm.exe" %*'],
      ["heif-convert.cmd", '"%~dp0..\\native\\libheif\\libheif\\bin\\heif-convert.exe" %*'],
      ["JxrDecApp.cmd", '"%~dp0..\\native\\jxrlib\\jxrlib\\bin\\JxrDecApp.exe" %*'],
    ];
    for (const [name, command] of nativeLaunchers) {
      const target = command.match(/\.\.\\native\\([^\"]+)/)?.[1];
      if (target && !(await fs.stat(path.join(runtimeDir, "dependencies", "native", target)).catch(() => null))) {
        continue;
      }
      await writeExecutable(path.join(binDir, name), cmd(command));
    }
    await buildWindowsSofficeShim({
      destination: path.join(binDir, "soffice.exe"),
      supportDir: opts.supportDir,
      ...(opts.rustcPath ? { rustcPath: opts.rustcPath } : {}),
      ...(opts.windowsSofficeShimPath
        ? { prebuiltPath: opts.windowsSofficeShimPath }
        : {}),
    });
    return;
  }

  const shellLauncher = (target: string, prefix = ""): string =>
    `#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$SCRIPT_DIR/${target}" ${prefix}"$@"\n`;
  await writeExecutable(
    path.join(binDir, "pnpm"),
    shellLauncher("../node/bin/node", '"$SCRIPT_DIR/../node/node_modules/pnpm/bin/pnpm.mjs" '),
  );
  for (const [name, candidates] of [
    ["pdfinfo", ["../native/poppler/bin/pdfinfo", "../native/poppler/Library/bin/pdfinfo"]],
    ["pdftoppm", ["../native/poppler/bin/pdftoppm", "../native/poppler/Library/bin/pdftoppm"]],
    ["heif-convert", ["../native/libheif/bin/heif-convert"]],
    ["JxrDecApp", ["../native/jxrlib/bin/JxrDecApp"]],
  ] as const) {
    const target = await (async () => {
      for (const candidate of candidates) {
        const absolute = path.resolve(binDir, candidate);
        if (await fs.stat(absolute).catch(() => null)) return candidate;
      }
      return null;
    })();
  if (target) await writeExecutable(path.join(binDir, name), shellLauncher(target));
  }
  await writeExecutable(
    path.join(binDir, "soffice"),
    shellLauncher(
      "../node/bin/node",
      '"$SCRIPT_DIR/../../cowork/headless-soffice/launcher.mjs" ',
    ),
  );
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function stageRuntime(opts: {
  sourceDir: string;
  destinationDir: string;
  asset: RuntimeAssetId;
  version: string;
  force?: boolean;
  createdAt?: string;
  supportDir?: string;
  componentInputDir?: string;
  componentPlanPath?: string;
  rustcPath?: string;
  windowsSofficeShimPath?: string;
  log?: (line: string) => void;
}): Promise<CoworkRuntimeManifest> {
  assertRuntimeVersion(opts.version);
  const sourceDir = path.resolve(opts.sourceDir);
  const destinationDir = path.resolve(opts.destinationDir);
  const supportDir = path.resolve(opts.supportDir ?? SUPPORT_DIR);
  const componentInputDir = path.resolve(
    opts.componentInputDir ?? path.join(PROJECT_ROOT, "runtime-inputs", opts.asset),
  );
  if (isPathInside(sourceDir, destinationDir) || isPathInside(destinationDir, sourceDir)) {
    throw new Error("Source and destination runtime directories must not contain one another.");
  }

  const sourceRaw = await fs.readFile(path.join(sourceDir, "runtime.json"), "utf8");
  const source = parseSourceRuntimeManifest(JSON.parse(sourceRaw) as unknown);
  const componentPlan = await readComponentPlan(
    path.resolve(opts.componentPlanPath ?? COMPONENT_PLAN_FILE),
  );
  const expected = expectedSourceTarget(opts.asset);
  if (source.targetPlatform !== expected.targetPlatform || source.targetArch !== expected.targetArch) {
    throw new Error(
      `Source runtime targets ${source.targetPlatform}-${source.targetArch}, but ${opts.asset} expects ${expected.targetPlatform}-${expected.targetArch}.`,
    );
  }

  const destinationStat = await fs.stat(destinationDir).catch(() => null);
  if (destinationStat && !opts.force) {
    throw new Error(`Destination already exists: ${destinationDir}. Pass force to replace it.`);
  }
  if (destinationStat) await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destinationDir), { recursive: true });

  opts.log?.(`Assembling runtime payload from ${sourceDir}`);
  try {
    await fs.mkdir(destinationDir, { recursive: true });
    for (const component of componentPlan.components) {
      const destination = resolveManifestPath(destinationDir, component.destination);
      if (component.strategy === "copied") {
        if (!component.source) throw new Error(`Copied component ${component.id} needs a source.`);
        const sourceRoot =
          component.sourceBase === "component-input" ? componentInputDir : sourceDir;
        const sourcePath = resolveManifestPath(sourceRoot, component.source);
        const stat = await fs.stat(sourcePath).catch(() => null);
        if (!stat) {
          const hint =
            component.sourceBase === "component-input"
              ? ` Run prepare-libreoffice for ${opts.asset} first.`
              : "";
          throw new Error(`Component source is missing: ${sourcePath}.${hint}`);
        }
        opts.log?.(`Copying component ${component.id}`);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(sourcePath, destination, {
          recursive: stat.isDirectory(),
          force: true,
          dereference: false,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      } else if (component.id === "node-module-resolver") {
        const resolverSource = path.join(supportDir, "node-resolver");
        opts.log?.("Building Cowork Node module resolver");
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(resolverSource, destination, {
          recursive: true,
          force: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      } else if (component.id === "headless-soffice-launcher") {
        const launcherSource = path.join(supportDir, "headless-soffice");
        opts.log?.("Building Cowork headless soffice support layer");
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(launcherSource, destination, {
          recursive: true,
          force: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      } else if (component.id === "runtime-launchers") {
        opts.log?.("Generating relocatable runtime launchers");
        await generateRuntimeLaunchers(destinationDir, opts.asset, {
          supportDir,
          ...(opts.rustcPath ? { rustcPath: opts.rustcPath } : {}),
          ...(opts.windowsSofficeShimPath
            ? { windowsSofficeShimPath: opts.windowsSofficeShimPath }
            : {}),
        });
      } else if (component.id === "source-provenance") {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, `${JSON.stringify(source, null, 2)}\n`, "utf8");
      } else {
        throw new Error(`No builder is registered for component ${component.id}.`);
      }
    }

    const bin = await requireExisting(destinationDir, ["dependencies/bin"], "dependencies/bin");
    const node = await requireExisting(
      destinationDir,
      ["dependencies/node/bin/node.exe", "dependencies/node/bin/node"],
      "bundled Node",
    );
    const python = await requireExisting(
      destinationDir,
      [
        "dependencies/python/python.exe",
        "dependencies/python/bin/python3",
        "dependencies/python/bin/python",
      ],
      "bundled Python",
    );
    const nodeModules = await requireExisting(
      destinationDir,
      ["dependencies/node/node_modules"],
      "Node package directory",
    );
    const resolver = await requireExisting(
      destinationDir,
      ["cowork/node-resolver/register.mjs"],
      "Cowork Node resolver",
    );
    const artifactToolPackage = await requireExisting(
      destinationDir,
      ["dependencies/node/node_modules/@oai/artifact-tool"],
      "@oai/artifact-tool",
    );
    const pnpm = await firstExisting(destinationDir, ["dependencies/bin/pnpm.cmd", "dependencies/bin/pnpm"]);
    const git = await firstExisting(destinationDir, [
      "dependencies/native/git/cmd/git.exe",
      "dependencies/native/git/bin/git",
    ]);
    const pdfinfo = await firstExisting(destinationDir, [
      "dependencies/bin/pdfinfo.cmd",
      "dependencies/bin/pdfinfo",
    ]);
    const pdftoppm = await firstExisting(destinationDir, [
      "dependencies/bin/pdftoppm.cmd",
      "dependencies/bin/pdftoppm",
    ]);
    const popplerBin = await firstExisting(destinationDir, [
      "dependencies/native/poppler/Library/bin",
      "dependencies/native/poppler/bin",
    ]);
    const libreOffice = await requireExisting(
      destinationDir,
      ["dependencies/libreoffice"],
      "managed LibreOffice payload",
    );
    const libreOfficeBinary = await requireExisting(
      destinationDir,
      [
        "dependencies/libreoffice/program/soffice.com",
        "dependencies/libreoffice/program/soffice",
        "dependencies/libreoffice/LibreOffice.app/Contents/MacOS/soffice",
      ],
      "private LibreOffice executable",
    );
    const soffice = await requireExisting(
      destinationDir,
      ["dependencies/bin/soffice.exe", "dependencies/bin/soffice"],
      "Cowork headless soffice launcher",
    );
    const libreOfficeProvenance = JSON.parse(
      await fs.readFile(path.join(libreOffice, "cowork-libreoffice.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof libreOfficeProvenance.version !== "string" || !libreOfficeProvenance.version) {
      throw new Error("Prepared LibreOffice provenance is missing its version.");
    }
    const stats = await payloadStats(destinationDir);
    const manifest: CoworkRuntimeManifest = {
      schemaVersion: 1,
      version: opts.version,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      asset: opts.asset,
      assetFileName: runtimeAssetFileName(opts.asset),
      compatibleHosts: compatibleHostsForAsset(opts.asset),
      source: {
        kind: "codex-primary-runtime",
        bundleVersion: source.bundleVersion,
        targetPlatform: source.targetPlatform,
        targetArch: source.targetArch,
      },
      components: componentPlan.components.map((component) => ({
        id: component.id,
        strategy: component.strategy,
        path: component.destination,
        ...(component.source
          ? {
              source:
                component.sourceBase === "component-input"
                  ? `component-input:${component.source}`
                  : component.source,
            }
          : {}),
        ...(component.note ? { note: component.note } : {}),
      })),
      versions: {
        ...(source.nodeVersion ? { node: source.nodeVersion } : {}),
        ...(source.pythonVersion ? { python: source.pythonVersion } : {}),
        ...(source.pnpmVersion ? { pnpm: source.pnpmVersion } : {}),
        libreOffice: libreOfficeProvenance.version,
      },
      paths: {
        bin: toManifestPath(destinationDir, bin),
        node: toManifestPath(destinationDir, node),
        python: toManifestPath(destinationDir, python),
        nodeModules: toManifestPath(destinationDir, nodeModules),
        nodeResolver: toManifestPath(destinationDir, resolver),
        artifactToolPackage: toManifestPath(destinationDir, artifactToolPackage),
        ...(pnpm ? { pnpm: toManifestPath(destinationDir, pnpm) } : {}),
        ...(git ? { git: toManifestPath(destinationDir, git) } : {}),
        ...(pdfinfo ? { pdfinfo: toManifestPath(destinationDir, pdfinfo) } : {}),
        ...(pdftoppm ? { pdftoppm: toManifestPath(destinationDir, pdftoppm) } : {}),
        ...(popplerBin ? { popplerBin: toManifestPath(destinationDir, popplerBin) } : {}),
        soffice: toManifestPath(destinationDir, soffice),
        libreOffice: toManifestPath(destinationDir, libreOffice),
        libreOfficeBinary: toManifestPath(destinationDir, libreOfficeBinary),
      },
      payload: stats,
    };
    await writeRuntimeManifest(destinationDir, manifest);
    opts.log?.(`Staged ${stats.fileCount} files (${stats.unpackedBytes} bytes).`);
    return manifest;
  } catch (error) {
    await fs.rm(destinationDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function buildRuntimeEnv(
  runtimeDir: string,
  baseEnv: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, string>> {
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const manifest = await readRuntimeManifest(resolvedRuntimeDir);
  const absolute = (relative: string): string => resolveManifestPath(resolvedRuntimeDir, relative);
  const pathKey = pathKeyForEnv(baseEnv);
  const pythonDir = path.dirname(absolute(manifest.paths.python));
  const pathDirs = [
    absolute(manifest.paths.bin),
    path.dirname(absolute(manifest.paths.node)),
    pythonDir,
    path.join(pythonDir, "Scripts"),
    ...(manifest.paths.git ? [path.dirname(absolute(manifest.paths.git))] : []),
    ...(manifest.paths.popplerBin ? [absolute(manifest.paths.popplerBin)] : []),
  ];
  const nodeModules = absolute(manifest.paths.nodeModules);
  const resolverOption = `--import=${pathToFileURL(absolute(manifest.paths.nodeResolver)).href}`;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") result[key] = value;
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const currentPath = baseEnv[pathKey]?.split(delimiter) ?? [];
  const currentNodePath = baseEnv.NODE_PATH?.split(delimiter) ?? [];
  result[pathKey] = dedupePathEntries([...pathDirs, ...currentPath], platform).join(delimiter);
  result.NODE_PATH = dedupePathEntries([nodeModules, ...currentNodePath], platform).join(delimiter);
  result.NODE_OPTIONS = appendNodeOption(baseEnv.NODE_OPTIONS, resolverOption);
  result.PYTHONDONTWRITEBYTECODE = "1";
  result.COWORK_RUNTIME_DIR = resolvedRuntimeDir;
  result.COWORK_RUNTIME_VERSION = manifest.version;
  result.COWORK_RUNTIME_ASSET = manifest.asset;
  result.COWORK_RUNTIME_BIN = absolute(manifest.paths.bin);
  result.COWORK_RUNTIME_NODE = absolute(manifest.paths.node);
  result.COWORK_RUNTIME_PYTHON = absolute(manifest.paths.python);
  result.COWORK_RUNTIME_NODE_MODULES = nodeModules;
  result.COWORK_RUNTIME_NODE_RESOLVER = absolute(manifest.paths.nodeResolver);
  if (manifest.paths.popplerBin) {
    result.COWORK_RUNTIME_POPPLER_BIN = absolute(manifest.paths.popplerBin);
  }
  if (manifest.paths.soffice) result.COWORK_RUNTIME_SOFFICE = absolute(manifest.paths.soffice);
  if (manifest.paths.libreOffice) {
    result.COWORK_RUNTIME_LIBREOFFICE_DIR = absolute(manifest.paths.libreOffice);
  }
  if (manifest.paths.libreOfficeBinary) {
    result.COWORK_RUNTIME_LIBREOFFICE_BINARY = absolute(manifest.paths.libreOfficeBinary);
  }
  result.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION = "1";
  return result;
}

async function commandVersion(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    env,
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0] ?? "ok";
}

async function verifySofficeConversion(
  executable: string,
  env: Record<string, string>,
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-soffice-"));
  try {
    const input = path.join(tempDir, "cowork-soffice-smoke.html");
    const output = path.join(tempDir, "cowork-soffice-smoke.pdf");
    await fs.writeFile(
      input,
      "<!doctype html><title>Cowork Runtime</title><p>Managed headless LibreOffice smoke test.</p>\n",
      "utf8",
    );
    await execFileAsync(executable, ["--convert-to", "pdf", "--outdir", tempDir, input], {
      env,
      cwd: tempDir,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stat = await fs.stat(output).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error("Managed headless soffice did not produce a non-empty PDF.");
    }
    return `${stat.size} byte PDF`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function verifyRuntime(opts: {
  runtimeDir: string;
  deep?: boolean;
  execute?: boolean;
  host?: RuntimeHost;
}): Promise<RuntimeVerification> {
  const runtimeDir = path.resolve(opts.runtimeDir);
  const errors: string[] = [];
  const checks: Record<string, string> = {};
  let manifest: CoworkRuntimeManifest | undefined;
  try {
    manifest = await readRuntimeManifest(runtimeDir);
    checks.manifest = `${manifest.asset} ${manifest.version}`;
  } catch (error) {
    return {
      ok: false,
      runtimeDir,
      errors: [error instanceof Error ? error.message : String(error)],
      checks,
    };
  }

  for (const [name, relative] of Object.entries(manifest.paths)) {
    const absolute = resolveManifestPath(runtimeDir, relative);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) errors.push(`Missing runtime path ${name}: ${relative}`);
    else checks[name] = relative;
  }
  for (const key of ["soffice", "libreOffice", "libreOfficeBinary"] as const) {
    if (!manifest.paths[key]) errors.push(`Runtime is missing required managed LibreOffice path: ${key}.`);
  }
  if (opts.deep) {
    const stats = await payloadStats(runtimeDir);
    checks.payload = `${stats.fileCount} files, ${stats.unpackedBytes} bytes`;
    if (stats.fileCount !== manifest.payload.fileCount) {
      errors.push(
        `Payload file count mismatch: manifest=${manifest.payload.fileCount}, actual=${stats.fileCount}.`,
      );
    }
    if (stats.unpackedBytes !== manifest.payload.unpackedBytes) {
      errors.push(
        `Payload size mismatch: manifest=${manifest.payload.unpackedBytes}, actual=${stats.unpackedBytes}.`,
      );
    }
  }

  if (opts.execute && errors.length === 0) {
    try {
      assertHostCompatible(manifest.asset, opts.host ?? process);
      const env = await buildRuntimeEnv(runtimeDir);
      const node = resolveManifestPath(runtimeDir, manifest.paths.node);
      const python = resolveManifestPath(runtimeDir, manifest.paths.python);
      checks.nodeVersion = await commandVersion(node, ["--version"], env);
      checks.pythonVersion = await commandVersion(python, ["--version"], env);
      checks.pythonLibraries = await commandVersion(
        python,
        [
          "-c",
          "import docx,lxml,PIL,pandas,numpy,pypdf,pdfplumber,reportlab,pdf2image; print('ok')",
        ],
        env,
      );
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-verify-"));
      try {
        const probe = path.join(tempDir, "probe.mjs");
        await fs.writeFile(
          probe,
          "const m = await import('@oai/artifact-tool'); console.log(Object.keys(m).length > 0 ? 'ok' : 'empty');\n",
          "utf8",
        );
        checks.artifactToolImport = await commandVersion(node, [probe], env, tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      if (manifest.paths.git) {
        checks.gitVersion = await commandVersion(
          resolveManifestPath(runtimeDir, manifest.paths.git),
          ["--version"],
          env,
        );
      }
      if (manifest.paths.soffice) {
        const soffice = resolveManifestPath(runtimeDir, manifest.paths.soffice);
        checks.libreOfficeVersion = await commandVersion(soffice, ["--version"], env);
        checks.libreOfficeConversion = await verifySofficeConversion(soffice, env);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (opts.deep && opts.execute && errors.length === 0) {
    const stats = await payloadStats(runtimeDir);
    checks.payloadAfterExecute = `${stats.fileCount} files, ${stats.unpackedBytes} bytes`;
    if (stats.fileCount !== manifest.payload.fileCount) {
      errors.push(
        `Payload file count changed during executable verification: manifest=${manifest.payload.fileCount}, actual=${stats.fileCount}.`,
      );
    }
    if (stats.unpackedBytes !== manifest.payload.unpackedBytes) {
      errors.push(
        `Payload size changed during executable verification: manifest=${manifest.payload.unpackedBytes}, actual=${stats.unpackedBytes}.`,
      );
    }
  }

  return { ok: errors.length === 0, runtimeDir, manifest, errors, checks };
}
