import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { sha256, UserError, type Tier } from "./common.js";
import type { McpLayout, Redaction } from "./mcp.js";

export const FORMAT_VERSION = 1;

export interface ManifestFile {
  path: string; // path inside the archive, e.g. config/AGENTS.md
  tier: Tier;
  sha256: string;
  size: number;
}

export interface Manifest {
  formatVersion: number;
  toolVersion: string;
  createdAt: string;
  sourceOs: string;
  sourceHome: string;
  sourceOpencodeVersion: string | null;
  tiers: Tier[];
  files: ManifestFile[];
  /** Directories that were symlinks on the source; their target content is archived as regular files. */
  links: { path: string; target: string }[];
  /** Layout of the mcp block on the source machine. Missing in older archives means legacy. */
  mcpLayout?: McpLayout;
  sessions?: { count: number; sanitized: boolean };
  /** Present when secrets.enc is in the archive. Contents (labels, counts) are only visible after decrypting. */
  credentials?: { bundle: string; kdf: string };
  mcp?: {
    servers: { name: string; type: string }[];
    redactions: Redaction[];
  };
}

export interface ArchiveEntry {
  path: string;
  tier: Tier;
  data: Buffer;
}

export async function writeArchive(out: string, manifest: Manifest, entries: ArchiveEntry[]): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), "ocm-stage-"));
  try {
    const names: string[] = ["manifest.json"];
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    for (const e of entries) {
      const p = join(stage, e.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.data);
      names.push(e.path);
    }
    mkdirSync(dirname(out), { recursive: true });
    await tar.c({ file: out, gzip: true, cwd: stage, portable: true, noPax: true }, names);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Stages files on disk one at a time so large session exports never sit in memory together. */
export class ArchiveBuilder {
  readonly stage = mkdtempSync(join(tmpdir(), "ocm-stage-"));
  readonly files: ManifestFile[] = [];

  get totalBytes(): number {
    return this.files.reduce((n, f) => n + f.size, 0);
  }

  add(path: string, tier: Tier, data: Buffer | string): void {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const p = join(this.stage, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    this.files.push({ path, tier, sha256: sha256(buf), size: buf.length });
  }

  async finish(out: string, base: Omit<Manifest, "files">): Promise<Manifest> {
    const manifest = { ...base, files: this.files } as Manifest;
    writeFileSync(join(this.stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    mkdirSync(dirname(out), { recursive: true });
    await tar.c({ file: out, gzip: true, cwd: this.stage, portable: true, noPax: true }, ["manifest.json", ...this.files.map((f) => f.path)]);
    return manifest;
  }

  dispose(): void {
    rmSync(this.stage, { recursive: true, force: true });
  }
}

export interface LoadedArchive {
  manifest: Manifest;
  /** Small files, held in memory. */
  files: Map<string, Buffer>;
  /** Session transcripts written to disk (only when extractDir was given): archive path -> absolute path. */
  extracted: Map<string, string>;
}

function safeRel(p: string): boolean {
  return !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === ".." || s === "");
}

const SESSION_FILE_RE = /^sessions\/[A-Za-z0-9_.-]+\.json$/;
const isSessionBody = (p: string): boolean => SESSION_FILE_RE.test(p) && p !== "sessions/index.json";

/**
 * Read an archive and verify every checksum listed in the manifest.
 * Session transcripts are hashed while streaming and, if extractDir is given, written there instead of kept in memory.
 */
export async function readArchive(file: string, opts: { extractDir?: string } = {}): Promise<LoadedArchive> {
  const files = new Map<string, Buffer>();
  const hashes = new Map<string, string>();
  const extracted = new Map<string, string>();
  const writes: Promise<void>[] = [];
  try {
    await tar.t({
      file,
      onReadEntry: (entry) => {
        if (entry.type !== "File") {
          entry.resume();
          return;
        }
        if (isSessionBody(entry.path)) {
          const h = createHash("sha256");
          let ws: ReturnType<typeof createWriteStream> | undefined;
          if (opts.extractDir) {
            const dest = join(opts.extractDir, entry.path);
            mkdirSync(dirname(dest), { recursive: true });
            const stream = createWriteStream(dest);
            ws = stream;
            writes.push(new Promise((res, rej) => stream.on("finish", () => res()).on("error", rej)));
            extracted.set(entry.path, dest);
          }
          // Hash and write from one data handler. Piping while also listening for data lost the contents of every
          // file after the first one.
          entry.on("data", (c: Buffer) => {
            h.update(c);
            ws?.write(c);
          });
          entry.on("end", () => {
            hashes.set(entry.path, h.digest("hex"));
            ws?.end();
          });
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => files.set(entry.path, Buffer.concat(chunks)));
      },
    });
    await Promise.all(writes);
  } catch {
    throw new UserError(`"${file}" is not a readable .ocm archive.`);
  }
  const raw = files.get("manifest.json");
  if (!raw) throw new UserError(`"${file}" has no manifest.json, so it is not a valid .ocm archive.`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8")) as Manifest;
  } catch {
    throw new UserError("The archive manifest is damaged and cannot be read.");
  }
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new UserError(
      `This archive uses format version ${manifest.formatVersion}; this tool understands version ${FORMAT_VERSION}. Update opencode-portable.`,
    );
  }
  for (const f of manifest.files) {
    if (!safeRel(f.path)) throw new UserError(`The archive lists an unsafe path "${f.path}". Refusing to continue.`);
    const data = files.get(f.path);
    const actual = hashes.get(f.path) ?? (data ? sha256(data) : undefined);
    if (actual === undefined) throw new UserError(`The archive is incomplete: ${f.path} is missing.`);
    if (actual !== f.sha256) throw new UserError(`Checksum mismatch for ${f.path}. The archive is corrupted; export it again.`);
  }
  return { manifest, files, extracted };
}
