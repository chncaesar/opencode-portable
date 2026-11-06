import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./paths.js";

export { UserError };

export type Tier = "config" | "mcp" | "state" | "sessions" | "credentials";
export const ALL_TIERS: Tier[] = ["config", "mcp", "state", "sessions", "credentials"];

export interface DirOptions {
  configDir?: string;
  stateDir?: string;
  home?: string;
}

export interface Dirs {
  home: string;
  configDir: string;
  stateDir: string;
}

export function resolveDirs(opts: DirOptions = {}, env: NodeJS.ProcessEnv = process.env): Dirs {
  const home = opts.home ?? homedir();
  const configDir =
    opts.configDir ?? (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(home, ".config", "opencode"));
  const stateDir =
    opts.stateDir ??
    (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "opencode") : join(home, ".local", "state", "opencode"));
  return { home, configDir, stateDir };
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function toolVersion(): string {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(p, "utf8")).version as string;
  } catch {
    return "unknown";
  }
}

export function parseTiers(text: string | undefined, fallback: Tier[]): Tier[] {
  if (!text) return fallback;
  const out: Tier[] = [];
  for (const t of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!ALL_TIERS.includes(t as Tier)) throw new UserError(`Unknown tier "${t}". Valid tiers: ${ALL_TIERS.join(", ")}.`);
    if (!out.includes(t as Tier)) out.push(t as Tier);
  }
  if (out.length === 0) throw new UserError("No tiers selected.");
  return out;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Append exception details to a log file. Never throws. Returns the log path. */
export function logError(stateDir: string | undefined, err: unknown): string {
  const dirs = [stateDir, tmpdir()].filter(Boolean) as string[];
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true });
      const file = join(d, "opencode-portable.log");
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`);
      return file;
    } catch {
      /* try next */
    }
  }
  return "(log file could not be written)";
}
