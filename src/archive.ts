import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { ZipArchive } from "archiver";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { readRuntimeManifest } from "./manifest";
import type { RuntimeKeyMaterial } from "./integrity";
import { verifyRuntime } from "./runtime";

const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_ARCHIVE_UNPACKED_BYTES = 8 * 1024 * 1024 * 1024;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_SYMLINK = 0o120000;

export function normalizeZipEntryName(name: string): string {
  if (!name || name.includes("\0") || name.includes("\\")) {
    throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}`);
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`ZIP entry must be relative: ${name}`);
  }
  const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  const normalized = path.posix.normalize(withoutTrailingSlash);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== withoutTrailingSlash
  ) {
    throw new Error(`ZIP entry escapes or is not normalized: ${name}`);
  }
  return normalized;
}

function assertSymlinkTarget(entryName: string, target: string): void {
  if (!target || target.includes("\0") || target.includes("\\") || path.posix.isAbsolute(target)) {
    throw new Error(`Unsafe symlink target for ${entryName}: ${target}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryName), target));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error(`Symlink ${entryName} escapes the runtime: ${target}`);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

type ArchiveEntry = {
  absolutePath: string;
  archivePath: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  symlinkTarget?: string;
};

async function collectArchiveEntries(runtimeDir: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const archivePath = path.relative(runtimeDir, absolutePath).split(path.sep).join("/");
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        const symlinkTarget = await fs.readlink(absolutePath);
        assertSymlinkTarget(archivePath, symlinkTarget.split(path.sep).join("/"));
        entries.push({
          absolutePath,
          archivePath,
          kind: "symlink",
          mode: stat.mode,
          symlinkTarget,
        });
      } else if (stat.isDirectory()) {
        entries.push({ absolutePath, archivePath, kind: "directory", mode: stat.mode });
        await visit(absolutePath);
      } else if (stat.isFile()) {
        entries.push({ absolutePath, archivePath, kind: "file", mode: stat.mode });
      } else {
        throw new Error(`Runtime contains unsupported filesystem entry: ${absolutePath}`);
      }
    }
  };
  await visit(runtimeDir);
  return entries;
}

export async function buildRuntimeArchive(opts: {
  runtimeDir: string;
  outputFile?: string;
  compressionLevel?: number;
  signingKey: { keyId: string; privateKey: RuntimeKeyMaterial };
  log?: (line: string) => void;
}): Promise<{ archivePath: string; checksumPath: string; sha256: string; bytes: number }> {
  const runtimeDir = path.resolve(opts.runtimeDir);
  const manifest = await readRuntimeManifest(runtimeDir);
  if (manifest.schemaVersion !== 2 || manifest.integrity?.keyId !== opts.signingKey.keyId) {
    throw new Error("Runtime signing key does not match the schema-2 runtime manifest.");
  }
  const publicKey = createPublicKey(opts.signingKey.privateKey).export({
    format: "pem",
    type: "spki",
  });
  const verification = await verifyRuntime({
    runtimeDir,
    deep: true,
    trustedKeys: { [opts.signingKey.keyId]: publicKey },
  });
  if (!verification.ok) {
    throw new Error(`Runtime verification failed:\n${verification.errors.join("\n")}`);
  }
  const outputFile = path.resolve(opts.outputFile ?? path.join("dist", manifest.assetFileName));
  if (outputFile === runtimeDir || outputFile.startsWith(`${runtimeDir}${path.sep}`)) {
    throw new Error("Runtime archive output must be outside the runtime directory.");
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const temporaryFile = `${outputFile}.tmp-${randomUUID()}`;
  const archiveEntries = await collectArchiveEntries(runtimeDir);
  const timestamp = new Date(manifest.createdAt);
  const output = createWriteStream(temporaryFile, { flags: "wx" });
  const zip = new ZipArchive({
    forceZip64: true,
    zlib: { level: opts.compressionLevel ?? 6 },
  });
  const completed = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    zip.once("error", reject);
    zip.once("warning", (error: Error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(error);
    });
  });
  zip.pipe(output);
  opts.log?.(`Creating ${outputFile} from ${archiveEntries.length} entries.`);
  try {
    for (const entry of archiveEntries) {
      if (entry.kind === "directory") {
        zip.append("", {
          name: `${entry.archivePath}/`,
          type: "directory",
          date: timestamp,
          mode: entry.mode,
        });
      } else if (entry.kind === "symlink") {
        zip.symlink(entry.archivePath, entry.symlinkTarget ?? "", entry.mode);
      } else {
        zip.file(entry.absolutePath, {
          name: entry.archivePath,
          date: timestamp,
          mode: entry.mode,
        });
      }
    }
    await zip.finalize();
    await completed;
    await fs.rm(outputFile, { force: true });
    await fs.rename(temporaryFile, outputFile);
  } catch (error) {
    zip.abort();
    output.destroy();
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }

  const sha256 = await sha256File(outputFile);
  const checksumPath = `${outputFile}.sha256`;
  await fs.writeFile(checksumPath, `${sha256}  ${path.basename(outputFile)}\n`, "utf8");
  const stat = await fs.stat(outputFile);
  opts.log?.(`Created ${outputFile} (${stat.size} bytes, sha256 ${sha256}).`);
  return { archivePath: outputFile, checksumPath, sha256, bytes: stat.size };
}

function entryUnixMode(entry: Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: true },
      (error, zipFile) => {
        if (error) reject(error);
        else if (!zipFile) reject(new Error(`Could not open ZIP archive: ${archivePath}`));
        else resolve(zipFile);
      },
    );
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else if (!stream) reject(new Error(`Could not read ZIP entry: ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

async function readSmallStream(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("ZIP symlink target is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function extractEntry(opts: {
  zip: ZipFile;
  entry: Entry;
  destinationDir: string;
  seen: Set<string>;
}): Promise<void> {
  const normalized = normalizeZipEntryName(opts.entry.fileName);
  const seenKey = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  if (opts.seen.has(seenKey)) throw new Error(`Duplicate ZIP entry: ${normalized}`);
  opts.seen.add(seenKey);

  const destination = path.join(opts.destinationDir, ...normalized.split("/"));
  const relative = path.relative(opts.destinationDir, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`ZIP entry escapes destination: ${opts.entry.fileName}`);
  }

  const mode = entryUnixMode(opts.entry);
  const fileType = mode & UNIX_FILE_TYPE_MASK;
  const directory = opts.entry.fileName.endsWith("/") || fileType === UNIX_DIRECTORY;
  const symlink = fileType === UNIX_SYMLINK;
  if (fileType !== 0 && fileType !== UNIX_DIRECTORY && fileType !== UNIX_REGULAR_FILE && !symlink) {
    throw new Error(`Unsupported ZIP entry type: ${opts.entry.fileName}`);
  }

  if (directory) {
    await fs.mkdir(destination, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const stream = await openEntryStream(opts.zip, opts.entry);
  if (symlink) {
    const target = (await readSmallStream(stream, 64 * 1024)).toString("utf8");
    assertSymlinkTarget(normalized, target);
    await fs.symlink(target, destination);
    return;
  }
  const fileMode = mode & 0o777;
  await pipeline(
    stream,
    createWriteStream(destination, {
      flags: "wx",
      ...(fileMode ? { mode: fileMode } : {}),
    }),
  );
  if (process.platform !== "win32" && fileMode) await fs.chmod(destination, fileMode);
}

export async function extractRuntimeArchive(opts: {
  archivePath: string;
  destinationDir: string;
  maxEntries?: number;
  maxUnpackedBytes?: number;
}): Promise<void> {
  const destinationDir = path.resolve(opts.destinationDir);
  const existing = await fs.stat(destinationDir).catch(() => null);
  if (existing) throw new Error(`Extraction destination already exists: ${destinationDir}`);
  await fs.mkdir(destinationDir, { recursive: false });
  const zip = await openZip(path.resolve(opts.archivePath));
  const seen = new Set<string>();
  let entryCount = 0;
  let unpackedBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry) => {
        entryCount += 1;
        unpackedBytes += entry.uncompressedSize;
        if (entryCount > (opts.maxEntries ?? MAX_ARCHIVE_ENTRIES)) {
          fail(new Error(`ZIP archive exceeds the entry limit (${entryCount}).`));
          return;
        }
        if (unpackedBytes > (opts.maxUnpackedBytes ?? MAX_ARCHIVE_UNPACKED_BYTES)) {
          fail(new Error(`ZIP archive exceeds the unpacked size limit (${unpackedBytes} bytes).`));
          return;
        }
        void extractEntry({ zip, entry, destinationDir, seen })
          .then(() => zip.readEntry())
          .catch(fail);
      });
      zip.readEntry();
    });
  } catch (error) {
    await fs.rm(destinationDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
