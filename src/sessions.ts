import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArchiveBuilder } from "./archive.js";
import { logError, UserError } from "./common.js";
import {
  exportSession,
  listProjects,
  listSessions,
  opencodeBin,
  runOpencode,
  type ProjectInfo,
  type SessionInfo,
} from "./opencode.js";
import { applyRules, isUnder, type PathRule } from "./paths.js";

export interface SessionIndexEntry {
  id: string;
  title: string;
  time: { created: number; updated: number };
  projectID: string;
  sourceDirectory?: string;
  projectCanonical?: string;
  parentID?: string;
  size: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------- export

export function parseSince(text: string, now = Date.now()): number {
  const m = /^(\d+)d$/.exec(text.trim());
  if (m) return now - Number(m[1]) * 86_400_000;
  if (/^\d{4}-\d{2}-\d{2}/.test(text.trim())) {
    const t = Date.parse(text.trim());
    if (!Number.isNaN(t)) return t;
  }
  throw new UserError(`Invalid --since value "${text}". Use a number of days like 30d, or a date like 2026-01-01.`);
}

export interface SessionExportOptions {
  since?: string;
  projects?: string[];
  maxSessions?: number;
  sanitize?: boolean;
  log?: (s: string) => void;
  stateDir?: string;
}

export function selectSessions(
  all: SessionInfo[],
  projects: ProjectInfo[],
  opts: Pick<SessionExportOptions, "since" | "projects" | "maxSessions">,
  warnings: string[],
): SessionInfo[] {
  const canonical = new Map(projects.map((p) => [p.id, p.canonical]));
  let sel = all.filter((s) => s.time && typeof s.time.updated === "number");

  if (opts.since) {
    const cutoff = parseSince(opts.since);
    sel = sel.filter((s) => s.time.updated >= cutoff);
  }
  if (opts.projects && opts.projects.length > 0) {
    const matchers = opts.projects.map((v) => {
      const abs = resolve(v);
      const f = (s: SessionInfo): boolean => {
        if (s.projectID === v) return true;
        const dir = s.location?.directory;
        const canon = canonical.get(s.projectID);
        return (!!dir && isUnder(dir, abs)) || (!!canon && isUnder(canon, abs));
      };
      if (!sel.some(f)) warnings.push(`--project ${v}: no sessions matched (use a project ID or a directory path).`);
      return f;
    });
    sel = sel.filter((s) => matchers.some((m) => m(s)));
  }
  if (opts.maxSessions !== undefined) {
    sel = [...sel].sort((a, b) => b.time.updated - a.time.updated).slice(0, opts.maxSessions);
  }
  // Keep sub-agent sessions of anything selected.
  const ids = new Set(sel.map((s) => s.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of all) {
      if (!ids.has(s.id) && s.parentID && ids.has(s.parentID)) {
        ids.add(s.id);
        sel.push(s);
        grew = true;
      }
    }
  }
  return sel;
}

export async function exportSessionsInto(builder: ArchiveBuilder, opts: SessionExportOptions): Promise<{ count: number; warnings: string[] }> {
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  let all: SessionInfo[];
  let projects: ProjectInfo[] = [];
  try {
    all = await listSessions();
  } catch (e) {
    logError(opts.stateDir, (e as { raw?: string }).raw ?? e);
    throw e;
  }
  try {
    projects = await listProjects();
  } catch (e) {
    logError(opts.stateDir, (e as { raw?: string }).raw ?? e);
    warnings.push("Could not read the project list, so project root paths are missing from the archive.");
  }
  const canonical = new Map(projects.map((p) => [p.id, p.canonical]));
  const selected = selectSessions(all, projects, opts, warnings);
  const nProjects = new Set(selected.map((s) => s.projectID)).size;
  log(`Selected ${selected.length} of ${all.length} session(s) in ${nProjects} project(s).`);
  if (selected.length === 0) warnings.push("No sessions matched, so the sessions tier is empty.");

  const index: SessionIndexEntry[] = [];
  let done = 0;
  for (const s of selected) {
    done++;
    if (!SAFE_ID.test(s.id)) {
      warnings.push(`Skipped a session with an unusual ID (${JSON.stringify(s.id)}).`);
      continue;
    }
    try {
      const raw = await exportSession(s.id, !!opts.sanitize);
      JSON.parse(raw);
      builder.add(`sessions/${s.id}.json`, "sessions", raw);
      index.push({
        id: s.id,
        title: s.title ?? "",
        time: { created: s.time.created, updated: s.time.updated },
        projectID: s.projectID,
        ...(s.location?.directory ? { sourceDirectory: s.location.directory } : {}),
        ...(canonical.get(s.projectID) ? { projectCanonical: canonical.get(s.projectID) } : {}),
        ...(s.parentID ? { parentID: s.parentID } : {}),
        size: Buffer.byteLength(raw),
      });
    } catch (e) {
      logError(opts.stateDir, `session ${s.id}: ${(e as { raw?: string }).raw ?? e}`);
      if (e instanceof UserError && /was not found/.test(e.message)) throw e;
      warnings.push(`Could not export session "${s.title ?? ""}" (${s.id}); it was left out.`);
    }
    if (done % 25 === 0) log(`  exported ${done}/${selected.length}`);
  }
  if (selected.length > 0 && index.length === 0) {
    throw new UserError("None of the selected sessions could be exported. Check that OpenCode is running, then try again.");
  }
  builder.add("sessions/index.json", "sessions", JSON.stringify({ version: 1, sessions: index }, null, 2));
  log(`Session data staged: ${index.length} session(s), ${(index.reduce((n, e) => n + e.size, 0) / 1048576).toFixed(1)} MB before compression.`);
  return { count: index.length, warnings };
}

export function parseIndex(raw: Buffer | undefined): SessionIndexEntry[] {
  if (!raw) throw new UserError("The archive says it contains sessions but sessions/index.json is missing.");
  try {
    const j = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(j.sessions)) throw new Error("bad");
    return j.sessions as SessionIndexEntry[];
  } catch {
    throw new UserError("The session index in the archive is damaged.");
  }
}

// ---------------------------------------------------------------- repo scan

const SKIP_DIRS = new Set(["node_modules", "Library", "AppData", "Applications", "vendor", "__pycache__", "venv", "target", "dist"]);

export function defaultScanRoots(home: string, exists: (p: string) => boolean = existsSync): string[] {
  const cand = [home, "/work", join(home, "code"), join(home, "Projects"), join(home, "src")];
  return [...new Set(cand)].filter((p) => exists(p));
}

function gitRootCommit(dir: string): Promise<string | null> {
  return new Promise((res) => {
    execFile("git", ["-C", dir, "rev-list", "--max-parents=0", "HEAD"], { timeout: 15_000, encoding: "utf8" }, (err, out) => {
      if (err) return res(null);
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean).sort();
      res(lines[0] ?? null);
    });
  });
}

export interface RepoIndex {
  /** root commit -> repo directories, best candidate first */
  byRoot: Map<string, string[]>;
  scanned: number;
}

export async function scanRepos(roots: string[], maxDepth = 4): Promise<RepoIndex> {
  const repos: { dir: string; gitDir: boolean }[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitDir = false;
      try {
        gitDir = statSync(dotGit).isDirectory();
      } catch {
        /* ignore */
      }
      repos.push({ dir, gitDir });
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      if (d.name.startsWith(".") || SKIP_DIRS.has(d.name)) continue;
      walk(join(dir, d.name), depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);

  const byRoot = new Map<string, { dir: string; gitDir: boolean }[]>();
  for (const r of repos) {
    const c = await gitRootCommit(r.dir);
    if (!c) continue;
    byRoot.set(c, [...(byRoot.get(c) ?? []), r]);
  }
  const out = new Map<string, string[]>();
  for (const [c, list] of byRoot) {
    list.sort((a, b) => Number(b.gitDir) - Number(a.gitDir) || a.dir.length - b.dir.length || a.dir.localeCompare(b.dir));
    out.set(c, list.map((x) => x.dir));
  }
  return { byRoot: out, scanned: repos.length };
}

// ---------------------------------------------------------------- planning

export type Method = "rule" | "mapping" | "repo" | "home" | "original" | "detached-to" | "detached";
export type SessionKind = "add" | "skip" | "conflict" | "detached";

export interface SessionPlan {
  entry: SessionIndexEntry;
  kind: SessionKind;
  reason: string;
  targetDir?: string;
}

export interface ProjectPlan {
  projectID: string;
  sourceRoot: string;
  targetRoot?: string;
  method: Method;
  notes: string[];
  sessions: SessionPlan[];
}

export interface MappingFile {
  version: 1;
  projects: Record<string, { source: string; target: string; method: string }>;
}

export interface SessionPlanContext {
  explicitRules: PathRule[];
  homeRule?: PathRule;
  mapping: MappingFile["projects"];
  scanRoots: string[];
  detachedTo?: string;
  exists?: (p: string) => boolean;
  /** Sessions already on the target. null when the target could not be read. */
  targetSessions: Map<string, SessionInfo> | null;
}

const HEX_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

export interface SessionsPlan {
  projects: ProjectPlan[];
  targetListed: boolean;
  repoScan?: { scanned: number; roots: string[] };
  warnings: string[];
}

export async function planSessions(index: SessionIndexEntry[], ctx: SessionPlanContext): Promise<SessionsPlan> {
  const exists = ctx.exists ?? existsSync;
  const warnings: string[] = [];
  const byProject = new Map<string, SessionIndexEntry[]>();
  for (const e of index) byProject.set(e.projectID, [...(byProject.get(e.projectID) ?? []), e]);

  let repos: RepoIndex | undefined;
  if ([...byProject.keys()].some((id) => HEX_ID.test(id))) repos = await scanRepos(ctx.scanRoots);

  if (ctx.detachedTo && !exists(ctx.detachedTo)) throw new UserError(`--import-detached-to directory does not exist: ${ctx.detachedTo}`);

  const resolveDir = (src: string, notes: string[]): { dir: string; method: Method } | null => {
    if (ctx.explicitRules.length) {
      const r = applyRules(src, ctx.explicitRules);
      if (r !== src) {
        if (exists(r)) return { dir: r, method: "rule" };
        notes.push(`A --map rule gives ${r}, which does not exist here.`);
      }
    }
    if (ctx.homeRule) {
      const r = applyRules(src, [ctx.homeRule]);
      if (r !== src && exists(r)) return { dir: r, method: "home" };
    }
    if (exists(src)) return { dir: src, method: "original" };
    return null;
  };

  const projects: ProjectPlan[] = [];
  for (const [projectID, entries] of byProject) {
    const dirs = entries.map((e) => e.sourceDirectory).filter((d): d is string => !!d);
    const sourceRoot = entries.find((e) => e.projectCanonical)?.projectCanonical ?? [...dirs].sort((a, b) => a.length - b.length)[0] ?? "";
    const notes: string[] = [];
    let method: Method = "detached";
    let targetRoot: string | undefined;

    // 1. explicit --map rule
    if (sourceRoot && ctx.explicitRules.length) {
      const r = applyRules(sourceRoot, ctx.explicitRules);
      if (r !== sourceRoot) {
        if (exists(r)) {
          targetRoot = r;
          method = "rule";
        } else notes.push(`A --map rule gives ${r}, which does not exist here.`);
      }
    }
    // 2. mapping file from an earlier import
    if (!targetRoot && ctx.mapping[projectID]) {
      const t = ctx.mapping[projectID].target;
      if (exists(t)) {
        targetRoot = t;
        method = "mapping";
      } else notes.push(`The saved mapping points to ${t}, which no longer exists.`);
    }
    // 3. repo scan by root commit
    if (!targetRoot && repos && HEX_ID.test(projectID)) {
      const hits = repos.byRoot.get(projectID.toLowerCase()) ?? repos.byRoot.get(projectID);
      if (hits?.length) {
        targetRoot = hits[0];
        method = "repo";
        if (hits.length > 1) notes.push(`${hits.length - 1} other clone(s) with the same history were ignored.`);
      }
    }
    // 4. home swap, 5. original path
    if (!targetRoot && sourceRoot) {
      const r = resolveDir(sourceRoot, notes);
      if (r) {
        targetRoot = r.dir;
        method = r.method;
      }
    }
    // 6. detached
    if (!targetRoot && ctx.detachedTo) {
      targetRoot = ctx.detachedTo;
      method = "detached-to";
    }

    const sessions: SessionPlan[] = [];
    const depth = new Map<string, number>();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const depthOf = (e: SessionIndexEntry): number => {
      if (depth.has(e.id)) return depth.get(e.id)!;
      depth.set(e.id, 0);
      const d = e.parentID && byId.has(e.parentID) ? depthOf(byId.get(e.parentID)!) + 1 : 0;
      depth.set(e.id, d);
      return d;
    };
    const ordered = [...entries].sort((a, b) => depthOf(a) - depthOf(b) || a.time.created - b.time.created);

    for (const e of ordered) {
      let dir: string | undefined;
      if (targetRoot) {
        if (e.sourceDirectory && sourceRoot && method !== "detached-to" && isUnder(e.sourceDirectory, sourceRoot)) {
          const cand = applyRules(e.sourceDirectory, [{ src: sourceRoot, dst: targetRoot }]);
          dir = exists(cand) ? cand : targetRoot;
        } else if (e.sourceDirectory && sourceRoot && method !== "detached-to") {
          dir = resolveDir(e.sourceDirectory, [])?.dir ?? targetRoot;
        } else dir = targetRoot;
      }
      const existing = ctx.targetSessions?.get(e.id);
      let plan: SessionPlan;
      if (existing) {
        const tu = existing.time?.updated ?? 0;
        // OpenCode resets a session's update time when it is imported, so an imported copy always looks newer than the
        // source. Treat "target updated >= source updated" as already present.
        if (tu >= e.time.updated) plan = { entry: e, kind: "skip", reason: "already on this machine (same or newer copy)", targetDir: dir };
        else plan = { entry: e, kind: "conflict", reason: "the archive copy is newer, but updating existing sessions is not supported; kept as is", targetDir: dir };
      } else if (!dir) {
        plan = { entry: e, kind: "detached", reason: "no matching directory on this machine" };
      } else plan = { entry: e, kind: "add", reason: "new", targetDir: dir };
      sessions.push(plan);
    }
    projects.push({ projectID, sourceRoot, targetRoot, method: targetRoot ? method : "detached", notes, sessions });
  }
  projects.sort((a, b) => a.sourceRoot.localeCompare(b.sourceRoot) || a.projectID.localeCompare(b.projectID));
  if (!ctx.targetSessions) warnings.push("Could not read the sessions already on this machine, so existing sessions are not detected. Start OpenCode before using --apply.");
  return {
    projects,
    targetListed: !!ctx.targetSessions,
    ...(repos ? { repoScan: { scanned: repos.scanned, roots: ctx.scanRoots } } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------- apply

export interface SessionApplyResult {
  imported: string[];
  skipped: number;
  failed: { id: string; title: string; reason: string }[];
}

export async function applySessions(
  plan: SessionsPlan,
  extracted: Map<string, string>,
  opts: { timeoutSec: number; stateDir?: string; log?: (s: string) => void },
): Promise<SessionApplyResult> {
  const res: SessionApplyResult = { imported: [], skipped: 0, failed: [] };
  const todo = plan.projects.flatMap((p) => p.sessions);
  for (const s of todo) {
    if (s.kind !== "add" || !s.targetDir) {
      res.skipped++;
      continue;
    }
    const file = extracted.get(`sessions/${s.entry.id}.json`);
    if (!file) {
      res.failed.push({ id: s.entry.id, title: s.entry.title, reason: "the session file is missing from the archive" });
      continue;
    }
    const r = await runOpencode(["session", "import", "--directory", s.targetDir, file], opts.timeoutSec * 1000);
    if (r.code === 0) {
      res.imported.push(s.entry.id);
      opts.log?.(`  imported ${s.entry.id}  ${s.entry.title}`);
    } else {
      logError(opts.stateDir, `session import ${s.entry.id} -> ${s.targetDir}: ${r.stderr || r.stdout || r.message}`);
      const reason = r.missing
        ? `the "${opencodeBin()}" program was not found`
        : r.timedOut
          ? `OpenCode took longer than ${opts.timeoutSec} seconds`
          : "OpenCode refused to import it (details are in the log file)";
      res.failed.push({ id: s.entry.id, title: s.entry.title, reason });
      opts.log?.(`  FAILED   ${s.entry.id}  ${s.entry.title}: ${reason}`);
    }
  }
  return res;
}

// ---------------------------------------------------------------- mapping file

export function mappingPath(archive: string): string {
  return `${archive}.mapping.json`;
}

export function loadMapping(archive: string, warnings: string[]): MappingFile["projects"] {
  const p = mappingPath(archive);
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j && typeof j.projects === "object" && j.projects) return j.projects;
  } catch {
    /* fall through */
  }
  warnings.push(`Ignored ${p}: it could not be read.`);
  return {};
}

export function saveMapping(archive: string, plan: SessionsPlan, previous: MappingFile["projects"]): string | null {
  const projects = { ...previous };
  for (const p of plan.projects) {
    if (p.targetRoot) projects[p.projectID] = { source: p.sourceRoot, target: p.targetRoot, method: p.method };
  }
  const file = mappingPath(archive);
  try {
    writeFileSync(file, JSON.stringify({ version: 1, projects } satisfies MappingFile, null, 2));
    return file;
  } catch {
    return null;
  }
}
