import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { RuntimeAssetId } from "./types";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCES_FILE = path.join(PROJECT_ROOT, "libreoffice-sources.json");

const INTERACTIVE_WINDOWS_LAUNCHERS = [
  "soffice.exe",
  "swriter.exe",
  "swriter.com",
  "scalc.exe",
  "scalc.com",
  "simpress.exe",
  "simpress.com",
  "sdraw.exe",
  "sdraw.com",
  "sbase.exe",
  "sbase.com",
  "smath.exe",
  "smath.com",
  "sweb.exe",
  "sweb.com",
  "quickstart.exe",
  "soffice_safe.exe",
  "gengal.exe",
  "minidump_upload.exe",
  "odbcconfig.exe",
  "senddoc.exe",
  "spsupp_helper.exe",
  "twain32shim.exe",
  "update_service.exe",
  "updater.exe",
  "mar.exe",
] as const;

type ArchiveType = "msi" | "dmg" | "deb-tar";

export type LibreOfficeSource = {
  version: string;
  asset: RuntimeAssetId;
  archiveType: ArchiveType;
  url: string;
  sha256: string;
};

type LibreOfficeSources = {
  schemaVersion: 1;
  version: string;
  assets: Record<RuntimeAssetId, Omit<LibreOfficeSource, "version" | "asset">>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function parseSources(value: unknown): LibreOfficeSources {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== "string") {
    throw new Error("LibreOffice source metadata must use schemaVersion 1 and include a version.");
  }
  if (!isRecord(value.assets)) throw new Error("LibreOffice source metadata needs an assets object.");
  for (const [asset, candidate] of Object.entries(value.assets)) {
    if (!isRecord(candidate)) throw new Error(`LibreOffice source ${asset} must be an object.`);
    if (!(candidate.archiveType === "msi" || candidate.archiveType === "dmg" || candidate.archiveType === "deb-tar")) {
      throw new Error(`LibreOffice source ${asset} has an unsupported archiveType.`);
    }
    if (typeof candidate.url !== "string" || !candidate.url.startsWith("https://")) {
      throw new Error(`LibreOffice source ${asset} must use an HTTPS URL.`);
    }
    assertSha256(candidate.sha256, `LibreOffice source ${asset} sha256`);
  }
  return value as LibreOfficeSources;
}

export async function readLibreOfficeSource(
  asset: RuntimeAssetId,
  sourcesFile = DEFAULT_SOURCES_FILE,
): Promise<LibreOfficeSource> {
  const raw = await fs.readFile(path.resolve(sourcesFile), "utf8");
  const sources = parseSources(JSON.parse(raw) as unknown);
  const source = sources.assets[asset];
  if (!source) throw new Error(`No LibreOffice source is configured for ${asset}.`);
  return { version: sources.version, asset, ...source };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fsSync.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function archiveName(source: LibreOfficeSource): string {
  const parsed = new URL(source.url);
  const name = path.posix.basename(parsed.pathname);
  if (!name) throw new Error(`LibreOffice source URL has no archive name: ${source.url}`);
  return name;
}

function assertBuildHost(asset: RuntimeAssetId, platform: NodeJS.Platform): void {
  const expected = asset === "win-x86" ? "win32" : asset.startsWith("macos-") ? "darwin" : "linux";
  if (platform !== expected) {
    throw new Error(`LibreOffice input ${asset} must be prepared on ${expected}, not ${platform}.`);
  }
}

function preparedOfficeEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PYTHONDONTWRITEBYTECODE: "1",
    SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION: "1",
  };
}

function codeSignatureVerification(
  officeRoot: string,
  asset: RuntimeAssetId,
): { command: string; args: string[] } | null {
  if (!asset.startsWith("macos-")) return null;
  return {
    command: "codesign",
    args: ["--verify", "--deep", "--strict", path.join(officeRoot, "LibreOffice.app")],
  };
}

async function downloadArchive(
  source: LibreOfficeSource,
  destination: string,
  fetchImpl: typeof fetch,
  log?: (line: string) => void,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const existing = await fs.stat(destination).catch(() => null);
  if (existing?.isFile()) {
    const digest = await sha256File(destination);
    if (digest === source.sha256) {
      log?.(`Using cached LibreOffice archive ${destination}`);
      return;
    }
    await fs.rm(destination, { force: true });
  }

  const partial = `${destination}.partial`;
  await fs.rm(partial, { force: true });
  log?.(`Downloading LibreOffice ${source.version} from ${source.url}`);
  const response = await fetchImpl(source.url);
  if (!response.ok || !response.body) {
    throw new Error(`GET ${source.url} failed with status ${response.status}.`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body as never), fsSync.createWriteStream(partial));
    const digest = await sha256File(partial);
    if (digest !== source.sha256) {
      throw new Error(
        `LibreOffice archive checksum mismatch: expected ${source.sha256}, received ${digest}.`,
      );
    }
    await fs.rename(partial, destination);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

async function run(
  command: string,
  args: string[],
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await execFileAsync(command, args, {
    env,
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function findFiles(root: string, predicate: (candidate: string) => boolean): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && predicate(candidate)) matches.push(candidate);
    }
  };
  await visit(root);
  return matches;
}

async function findOfficeRoot(extractedRoot: string, executableName: string): Promise<string> {
  const candidates = await findFiles(
    extractedRoot,
    (candidate) =>
      path.basename(candidate).toLowerCase() === executableName.toLowerCase() &&
      path.basename(path.dirname(candidate)).toLowerCase() === "program",
  );
  const executable = candidates.at(0);
  if (!executable) throw new Error(`Extracted LibreOffice archive did not contain program/${executableName}.`);
  return path.dirname(path.dirname(executable));
}

async function extractWindows(archive: string, extractedRoot: string): Promise<string> {
  await fs.mkdir(extractedRoot, { recursive: true });
  await run("msiexec.exe", ["/a", archive, "/qn", `TARGETDIR=${extractedRoot}`], 15 * 60_000);
  return await findOfficeRoot(extractedRoot, "soffice.com");
}

async function extractLinux(archive: string, extractedRoot: string, scratchRoot: string): Promise<string> {
  const unpacked = path.join(scratchRoot, "deb-archives");
  await fs.mkdir(unpacked, { recursive: true });
  await fs.mkdir(extractedRoot, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", unpacked], 10 * 60_000);
  const packages = await findFiles(unpacked, (candidate) => candidate.toLowerCase().endsWith(".deb"));
  if (packages.length === 0) throw new Error("LibreOffice tarball did not contain Debian packages.");
  for (const packagePath of packages) {
    await run("dpkg-deb", ["-x", packagePath, extractedRoot], 5 * 60_000);
  }
  return await findOfficeRoot(extractedRoot, "soffice");
}

async function extractMac(archive: string, extractedRoot: string, scratchRoot: string): Promise<string> {
  const mount = path.join(scratchRoot, "mount");
  await fs.mkdir(mount, { recursive: true });
  let attached = false;
  try {
    await run("hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-mountpoint", mount], 5 * 60_000);
    attached = true;
    const entries = await fs.readdir(mount, { withFileTypes: true });
    const app = entries.find((entry) => entry.isDirectory() && entry.name === "LibreOffice.app");
    if (!app) throw new Error("LibreOffice DMG did not contain LibreOffice.app.");
    const target = path.join(extractedRoot, "LibreOffice.app");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.cp(path.join(mount, app.name), target, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    return extractedRoot;
  } finally {
    if (attached) await run("hdiutil", ["detach", mount], 2 * 60_000).catch(() => {});
  }
}

async function stripInteractiveWindowsLaunchers(officeRoot: string): Promise<void> {
  const program = path.join(officeRoot, "program");
  for (const name of INTERACTIVE_WINDOWS_LAUNCHERS) {
    await fs.rm(path.join(program, name), { force: true });
  }
}

async function pruneNonRuntimeAssets(officeRoot: string, asset: RuntimeAssetId): Promise<void> {
  if (asset.startsWith("macos-")) return;
  for (const relative of [
    "help",
    "readmes",
    "share/extensions",
    "share/gallery",
    "share/template",
    "share/tipoftheday",
    "share/toolbarmode",
    "share/theme_definitions",
    "share/themes",
    "share/wizards",
  ]) {
    await fs.rm(path.join(officeRoot, ...relative.split("/")), { recursive: true, force: true });
  }
  const configDir = path.join(officeRoot, "share", "config");
  const iconArchives = await findFiles(
    configDir,
    (candidate) => /^images_.*\.zip$/i.test(path.basename(candidate)),
  ).catch(() => []);
  await Promise.all(iconArchives.map((candidate) => fs.rm(candidate, { force: true })));
  const rootEntries = await fs.readdir(officeRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (
      entry.isFile() &&
      (/^LibreOffice_.*\.(?:msi|deb|rpm)$/i.test(entry.name) || entry.name === "CREDITS.fodt")
    ) {
      await fs.rm(path.join(officeRoot, entry.name), { force: true });
    }
  }
}

export function rawSofficePath(officeRoot: string, asset: RuntimeAssetId): string {
  if (asset === "win-x86") return path.join(officeRoot, "program", "soffice.com");
  if (asset.startsWith("macos-")) {
    return path.join(officeRoot, "LibreOffice.app", "Contents", "MacOS", "soffice");
  }
  return path.join(officeRoot, "program", "soffice");
}

async function verifyPreparedOffice(officeRoot: string, source: LibreOfficeSource): Promise<void> {
  const executable = rawSofficePath(officeRoot, source.asset);
  const stat = await fs.stat(executable).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Prepared LibreOffice is missing ${executable}.`);
  const verificationEnv = preparedOfficeEnvironment(process.env);
  await run(
    executable,
    ["--headless", "--invisible", "--nologo", "--version"],
    60_000,
    verificationEnv,
  );
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-libreoffice-verify-"));
  try {
    const profile = path.join(scratch, "profile");
    const input = path.join(scratch, "input.html");
    const output = path.join(scratch, "input.pdf");
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(input, "<!doctype html><p>Cowork headless conversion check.</p>\n", "utf8");
    await run(
      executable,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--invisible",
        "--nologo",
        "--nodefault",
        "--nofirststartwizard",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        scratch,
        input,
      ],
      180_000,
      verificationEnv,
    );
    const outputStat = await fs.stat(output).catch(() => null);
    if (!outputStat?.isFile() || outputStat.size === 0) {
      throw new Error("Prepared LibreOffice did not complete its headless PDF conversion check.");
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  const signatureVerification = codeSignatureVerification(officeRoot, source.asset);
  if (signatureVerification) {
    await run(
      signatureVerification.command,
      signatureVerification.args,
      5 * 60_000,
    );
  }
}

export async function prepareLibreOfficeInput(opts: {
  asset: RuntimeAssetId;
  outputDir?: string;
  cacheDir?: string;
  sourcesFile?: string;
  force?: boolean;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<{ outputDir: string; source: LibreOfficeSource; archivePath: string }> {
  const platform = opts.platform ?? process.platform;
  assertBuildHost(opts.asset, platform);
  const source = await readLibreOfficeSource(opts.asset, opts.sourcesFile);
  const outputDir = path.resolve(
    opts.outputDir ?? path.join(PROJECT_ROOT, "runtime-inputs", opts.asset, "libreoffice"),
  );
  const cacheDir = path.resolve(opts.cacheDir ?? path.join(PROJECT_ROOT, ".cache", "libreoffice"));
  const archivePath = path.join(cacheDir, archiveName(source));
  const existing = await fs.stat(outputDir).catch(() => null);
  if (existing && !opts.force) {
    throw new Error(`LibreOffice input already exists: ${outputDir}. Pass force to replace it.`);
  }
  await downloadArchive(source, archivePath, opts.fetchImpl ?? fetch, opts.log);

  const parent = path.dirname(outputDir);
  await fs.mkdir(parent, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-libreoffice-prepare-"));
  const staged = `${outputDir}.staging-${path.basename(scratch)}`;
  try {
    await fs.rm(staged, { recursive: true, force: true });
    const extracted = path.join(scratch, "extracted");
    let officeSource: string;
    if (source.archiveType === "msi") officeSource = await extractWindows(archivePath, extracted);
    else if (source.archiveType === "deb-tar") officeSource = await extractLinux(archivePath, extracted, scratch);
    else officeSource = await extractMac(archivePath, extracted, scratch);

    await fs.cp(officeSource, staged, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    if (source.asset === "win-x86") await stripInteractiveWindowsLaunchers(staged);
    await pruneNonRuntimeAssets(staged, source.asset);
    await fs.writeFile(
      path.join(staged, "cowork-libreoffice.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version: source.version,
          asset: source.asset,
          sourceUrl: source.url,
          sourceSha256: source.sha256,
          packaging: "official-binary-with-cowork-headless-launcher",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await verifyPreparedOffice(staged, source);
    if (existing) await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rename(staged, outputDir);
    opts.log?.(`Prepared LibreOffice ${source.version} at ${outputDir}`);
    return { outputDir, source, archivePath };
  } finally {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export const __libreOfficeInternal = {
  assertBuildHost,
  codeSignatureVerification,
  parseSources,
  preparedOfficeEnvironment,
};
