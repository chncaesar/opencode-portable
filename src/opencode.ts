import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./common.js";

export interface SessionInfo {
  id: string;
  projectID: string;
  parentID?: string | null;
  title?: string;
  time: { created: number; updated: number };
  location?: { directory?: string };
  [k: string]: unknown;
}

export interface ProjectInfo {
  id: string;
  canonical?: string;
  [k: string]: unknown;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  missing: boolean;
  message: string;
}

export function opencodeBin(): string {
  return process.env.OPENCODE_BIN || "opencode";
}

/** Quote one argument for cmd.exe. Used only for .cmd/.bat launchers on Windows. */
export function winCmdQuote(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * How to start the program. Node refuses to start .cmd/.bat files without a shell on Windows
 * (npm installs OpenCode as opencode.cmd), so those get a shell and quoted arguments.
 */
export function spawnSpec(bin: string, args: string[], platform: string = process.platform): SpawnSpec {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return { command: winCmdQuote(bin), args: args.map(winCmdQuote), shell: true };
  }
  return { command: bin, args, shell: false };
}

/** Run the opencode binary. Never throws; inspect the result. */
export function runOpencode(args: string[], timeoutMs = 120_000): Promise<RunResult> {
  // OpenCode v2.2.5 cuts its stdout short (at a multiple of 64 KiB) when it is a pipe and the output is large.
  // Writing to a regular file is complete, so stdout is redirected to a temp file and read back afterwards.
  const dir = mkdtempSync(join(tmpdir(), "ocm-run-"));
  const outPath = join(dir, "stdout.txt");
  const outFd = openSync(outPath, "w", 0o600);
  const cleanup = (): string => {
    try {
      closeSync(outFd);
    } catch {
      /* already closed */
    }
    let text = "";
    try {
      text = readFileSync(outPath, "utf8");
    } catch {
      /* no output */
    }
    rmSync(dir, { recursive: true, force: true });
    return text;
  };
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const done = (r: Omit<RunResult, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout: cleanup(), stderr });
    };
    let child;
    try {
      const spec = spawnSpec(opencodeBin(), args);
      child = spawn(spec.command, spec.args, { stdio: ["ignore", outFd, "pipe"], shell: spec.shell, windowsHide: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      return done({ code: null, timedOut: false, missing: err.code === "ENOENT", message: err.message });
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, timedOut: true, missing: false, message: "timed out" });
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 1_000_000) stderr += d.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      done({ code: null, timedOut: false, missing: err.code === "ENOENT", message: err.message });
    });
    child.on("close", (code) => {
      done({ code, timedOut: false, missing: false, message: code === 0 ? "" : `exit code ${code}` });
    });
  });
}

const UNREACHABLE =
  "Could not get session data from OpenCode. Make sure OpenCode is installed (or set OPENCODE_BIN) and its background service is running, then try again.";

function explain(r: RunResult, what: string): UserError {
  if (r.missing) return new UserError(`The "${opencodeBin()}" program was not found. Install OpenCode or set OPENCODE_BIN to its path.`);
  if (r.timedOut) return new UserError(`OpenCode did not answer in time while ${what}.`);
  return new UserError(`${UNREACHABLE} (Problem while ${what}.)`);
}

async function apiGet<T>(path: string, what: string): Promise<T> {
  const r = await runOpencode(["api", "GET", path], 120_000);
  if (r.code !== 0 || r.missing || r.timedOut) throw Object.assign(explain(r, what), { raw: r.stderr || r.message });
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new UserError(`OpenCode returned an unexpected answer while ${what}.`);
  }
}

/** All sessions the service lists. Follows cursor pagination until a page adds nothing new. */
export async function listSessions(): Promise<SessionInfo[]> {
  const seen = new Map<string, SessionInfo>();
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page++) {
    const q = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await apiGet<{ data?: SessionInfo[]; cursor?: { next?: string | null } }>(`/api/session?${q}`, "listing sessions");
    const items = Array.isArray(res?.data) ? res.data : [];
    let added = 0;
    for (const s of items) {
      if (s && typeof s.id === "string" && !seen.has(s.id)) {
        seen.set(s.id, s);
        added++;
      }
    }
    const next = res?.cursor?.next;
    if (added === 0 || !next || next === cursor) break;
    cursor = next;
  }
  return [...seen.values()];
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const res = await apiGet<ProjectInfo[] | { data?: ProjectInfo[] }>("/api/project", "listing projects");
  const arr = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
  return arr.filter((p) => p && typeof p.id === "string");
}

export async function exportSession(id: string, sanitize: boolean): Promise<string> {
  const args = ["session", "export", ...(sanitize ? ["--sanitize"] : []), id];
  const r = await runOpencode(args, 300_000);
  if (r.code !== 0) throw Object.assign(explain(r, `exporting session ${id}`), { raw: r.stderr || r.message });
  try {
    JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new UserError(`OpenCode returned an incomplete transcript for session ${id}.`), { raw: `invalid JSON, ${r.stdout.length} chars` });
  }
  return r.stdout;
}
