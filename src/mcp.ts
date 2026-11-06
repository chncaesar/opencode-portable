import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";
import { UserError } from "./common.js";
import { isAbsolutePathLike, rewriteArg, type PathRule } from "./paths.js";

export type McpServer = Record<string, unknown>;

export interface Redaction {
  server: string;
  location: string;
  name: string;
}

const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|PASS/i;
const HEADER_SECRET_RE = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|COOKIE/i;
const URL_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^@/\s]+)(@)/i;
const REF_RE = /^\s*(Bearer\s+|Basic\s+|Token\s+)?(\$\{[^}]*\}|\{env:[^}]*\}|\{file:[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s*$/i;

export const placeholder = (name: string): string => "{env:" + name + "}";
const PLACEHOLDER_RE = /\{env:([A-Za-z0-9_]+)\}/;

function isRef(v: string): boolean {
  return REF_RE.test(v);
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "VALUE";
}

export function parseJsonc(text: string, label: string): any {
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new UserError(`${label} is not valid JSON/JSONC (syntax problem near character ${errors[0].offset}).`);
  }
  return v;
}

interface Hit {
  location: string;
  base: string;
  value: string;
  replace: (name: string) => void;
}

/** Locate secret values in one server definition. */
function findHits(serverName: string, server: McpServer): Hit[] {
  const hits: Hit[] = [];
  const s = sanitizeName(serverName);

  const env = server.environment;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const e = env as Record<string, unknown>;
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === "string" && v !== "" && SECRET_KEY_RE.test(k) && !isRef(v)) {
        hits.push({ location: `environment.${k}`, base: sanitizeName(k), value: v, replace: (n) => (e[k] = placeholder(n)) });
      } else if (typeof v === "string") {
        // Key name looks harmless (e.g. DATABASE_URL) but the value may embed user:password@.
        const um = URL_PASSWORD_RE.exec(v);
        if (um && !isRef(um[2]) && !PLACEHOLDER_RE.test(um[2])) {
          hits.push({
            location: `environment.${k}`,
            base: `${sanitizeName(k)}_PASSWORD`,
            value: um[2],
            replace: (n) => (e[k] = (e[k] as string).replace(URL_PASSWORD_RE, `$1${placeholder(n)}$3`)),
          });
        }
      }
    }
  }

  const headers = server.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const h = headers as Record<string, unknown>;
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === "string" && v !== "" && HEADER_SECRET_RE.test(k) && !isRef(v)) {
        const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(v);
        const prefix = m ? m[1] + " " : "";
        const secret = m ? m[2] : v;
        hits.push({
          location: `headers.${k}`,
          base: `${s}_${sanitizeName(k)}`,
          value: secret,
          replace: (n) => (h[k] = prefix + placeholder(n)),
        });
      }
    }
  }

  if (typeof server.url === "string") {
    const m = URL_PASSWORD_RE.exec(server.url);
    if (m && !isRef(m[2]) && !PLACEHOLDER_RE.test(m[2])) {
      hits.push({
        location: "url",
        base: `${s}_URL_PASSWORD`,
        value: m[2],
        replace: (n) => (server.url = (server.url as string).replace(URL_PASSWORD_RE, `$1${placeholder(n)}$3`)),
      });
    }
  }

  const cmd = server.command;
  if (Array.isArray(cmd)) {
    const c = cmd as unknown[];
    c.forEach((arg, i) => {
      if (typeof arg !== "string") return;
      const um = URL_PASSWORD_RE.exec(arg);
      if (um && !PLACEHOLDER_RE.test(um[2])) {
        hits.push({
          location: `command[${i}]`,
          base: `${s}_ARG${i}_PASSWORD`,
          value: um[2],
          replace: (n) => (c[i] = (c[i] as string).replace(URL_PASSWORD_RE, `$1${placeholder(n)}$3`)),
        });
        return;
      }
      const eq = /^(-{0,2}[A-Za-z0-9_.-]+)=(.+)$/s.exec(arg);
      if (eq && SECRET_KEY_RE.test(eq[1]) && !isRef(eq[2]) && !PLACEHOLDER_RE.test(eq[2])) {
        hits.push({
          location: `command[${i}]`,
          base: sanitizeName(eq[1]),
          value: eq[2],
          replace: (n) => (c[i] = `${eq[1]}=${placeholder(n)}`),
        });
        return;
      }
      if (/^-{1,2}[A-Za-z0-9_-]+$/.test(arg) && SECRET_KEY_RE.test(arg)) {
        const next = c[i + 1];
        if (typeof next === "string" && next !== "" && !next.startsWith("-") && !isRef(next) && !PLACEHOLDER_RE.test(next)) {
          hits.push({
            location: `command[${i + 1}]`,
            base: `${s}_${sanitizeName(arg)}`,
            value: next,
            replace: (n) => (c[i + 1] = placeholder(n)),
          });
        }
      }
    });
  }
  return hits;
}

/** Locations (e.g. "environment.DB_PASSWORD") that hold secrets in a server. */
export function secretLocations(serverName: string, server: McpServer): Set<string> {
  return new Set(findHits(serverName, server).map((h) => h.location));
}

/** Replace secret values with {env:NAME} markers. Input is not modified. */
export function redactMcp(mcp: Record<string, McpServer>): {
  mcp: Record<string, McpServer>;
  redactions: Redaction[];
  /** Marker name -> the real value. For the encrypted bundle only; never write it anywhere else. */
  secrets: Record<string, string>;
} {
  const out = structuredClone(mcp);
  const redactions: Redaction[] = [];
  const used = new Map<string, string>(); // placeholder name -> original value
  for (const [name, server] of Object.entries(out)) {
    if (!server || typeof server !== "object") continue;
    for (const hit of findHits(name, server)) {
      let n = hit.base;
      let attempt = 1;
      while (used.has(n) && used.get(n) !== hit.value) {
        attempt++;
        n = attempt === 2 ? `${sanitizeName(name)}_${hit.base}` : `${sanitizeName(name)}_${hit.base}_${attempt}`;
      }
      used.set(n, hit.value);
      hit.replace(n);
      redactions.push({ server: name, location: hit.location, name: n });
    }
  }
  return { mcp: out, redactions, secrets: Object.fromEntries(used) };
}

/** Replace {env:NAME} markers inside every string of a server with the real values. */
export function restoreMarkers(server: McpServer, secrets: Record<string, string>): { server: McpServer; missing: string[] } {
  const missing: string[] = [];
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\{env:([A-Za-z0-9_]+)\}/g, (m, n: string) => {
        if (Object.prototype.hasOwnProperty.call(secrets, n)) return secrets[n];
        missing.push(n);
        return m;
      });
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return { server: sub(server) as McpServer, missing };
}

// ---------- path rewriting ----------

export function rewriteServerPaths(server: McpServer, rules: PathRule[]): McpServer {
  const out = structuredClone(server);
  if (Array.isArray(out.command)) {
    out.command = (out.command as unknown[]).map((a) => (typeof a === "string" ? rewriteArg(a, rules) : a));
  }
  return out;
}

// ---------- diff ----------

function flatten(v: unknown, prefix: string, out: Map<string, string>): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
    if (v.length === 0) out.set(prefix, "[]");
  } else if (v && typeof v === "object") {
    const entries = Object.entries(v);
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out);
    if (entries.length === 0) out.set(prefix, "{}");
  } else {
    out.set(prefix, JSON.stringify(v));
  }
}

export interface FieldDiff {
  field: string;
  from: string;
  to: string;
}

/** Field-level difference between an existing and an incoming server. Secret values are hidden. */
export function diffServers(name: string, existing: McpServer, incoming: McpServer): FieldDiff[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(existing, "", a);
  flatten(incoming, "", b);
  const secrets = new Set([...secretLocations(name, existing), ...secretLocations(name, incoming)]);
  const show = (field: string, v: string | undefined): string => {
    if (v === undefined) return "(not set)";
    if (secrets.has(field)) return "(secret value hidden)";
    return v;
  };
  const diffs: FieldDiff[] = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])]) {
    if (a.get(k) !== b.get(k)) diffs.push({ field: k, from: show(k, a.get(k)), to: show(k, b.get(k)) });
  }
  return diffs;
}

// ---------- readiness ----------

export type Readiness = "ready" | "needs install" | "needs path fix" | "remote";

export interface ReadinessReport {
  status: Readiness;
  notes: string[];
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, cmd + ext), constants.X_OK);
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

export function checkReadiness(server: McpServer, env: NodeJS.ProcessEnv = process.env): ReadinessReport {
  const notes: string[] = [];
  const cmd = server.command;
  if (!Array.isArray(cmd) || typeof cmd[0] !== "string") {
    if (typeof server.url === "string") {
      notes.push("Remote server. If it uses OAuth, run `opencode mcp auth <name>` on this machine.");
      return { status: "remote", notes };
    }
    return { status: "needs path fix", notes: ["No command or URL found in this server definition."] };
  }
  const exe = cmd[0] as string;
  let status: Readiness = "ready";
  if (/\.(cmd|exe|bat)$/i.test(exe) && process.platform !== "win32") {
    notes.push(`"${exe}" looks like a Windows program and this is not Windows.`);
    status = "needs path fix";
  } else if (isAbsolutePathLike(exe) || exe.includes("/") || exe.includes("\\")) {
    if (!existsSync(isAbsolute(exe) ? exe : resolve(exe))) {
      notes.push(`Program not found: ${exe}`);
      status = "needs path fix";
    }
  } else if (!onPath(exe, env)) {
    notes.push(`"${exe}" is not on PATH. Install it first.`);
    status = "needs install";
  }
  for (const a of cmd.slice(1)) {
    if (typeof a === "string" && a.startsWith("/") && !existsSync(a)) {
      notes.push(`Path not found: ${a}`);
      if (status === "ready") status = "needs path fix";
    }
  }
  return { status, notes };
}

// ---------- merge into jsonc ----------

export type McpLayout = "legacy" | "v2";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isServerDef(v: unknown): boolean {
  return isPlainObject(v) && (v.type === "local" || v.type === "remote");
}

/**
 * Detect which MCP layout a parsed config uses.
 * v2: mcp.servers is a container whose values are all server definitions.
 * legacy: mcp.<name> entries are server definitions (a server may even be named "servers").
 * null: no mcp block, or nothing recognisable in it.
 */
export function detectMcpLayout(cfg: any): McpLayout | null {
  const mcp = cfg?.mcp;
  if (!isPlainObject(mcp)) return null;
  const sv = mcp.servers;
  if (isPlainObject(sv) && Object.values(sv).every(isServerDef)) return "v2";
  if (Object.values(mcp).some(isServerDef)) return "legacy";
  return null;
}

/** Convert a layout-specific server definition to the internal canonical form (absent enabled = enabled). */
export function toCanonical(server: McpServer, layout: McpLayout): McpServer {
  const out = structuredClone(server);
  if (layout === "v2") {
    if (out.disabled === true) out.enabled = false;
    delete out.disabled;
  }
  if (out.enabled === true) delete out.enabled;
  return out;
}

export function fromCanonical(server: McpServer, layout: McpLayout): McpServer {
  const out = structuredClone(server);
  if (layout === "v2") {
    if (out.enabled === false) out.disabled = true;
    delete out.enabled;
  } else if (out.enabled === true) delete out.enabled;
  return out;
}

/** Servers of a parsed config, in canonical form. */
export function extractServers(cfg: any): { layout: McpLayout | null; servers: Record<string, McpServer> } {
  const layout = detectMcpLayout(cfg);
  const servers: Record<string, McpServer> = {};
  if (!layout) return { layout, servers };
  const src = layout === "v2" ? cfg.mcp.servers : cfg.mcp;
  for (const [name, def] of Object.entries(src as Record<string, unknown>)) {
    if (isServerDef(def)) servers[name] = toCanonical(def as McpServer, layout);
  }
  return { layout, servers };
}

export function formattingFor(text: string): FormattingOptions {
  return /^\t/m.test(text) ? { insertSpaces: false, tabSize: 1, eol: "\n" } : { insertSpaces: true, tabSize: 2, eol: "\n" };
}

/** Write one canonical server into the text using the given layout. Comments elsewhere survive. */
export function setMcpServer(text: string, name: string, server: McpServer, layout: McpLayout = "legacy"): string {
  const path = layout === "v2" ? ["mcp", "servers", name] : ["mcp", name];
  return applyEdits(text, modify(text, path, fromCanonical(server, layout), { formattingOptions: formattingFor(text) }));
}

/** Remove the server definitions from a config text, keeping unrelated mcp settings such as mcp.timeout. */
export function stripMcpBlock(text: string): string {
  const cfg = parse(text, [], { allowTrailingComma: true });
  const layout = detectMcpLayout(cfg);
  const fo = { formattingOptions: formattingFor(text) };
  if (layout === "v2") {
    let t = applyEdits(text, modify(text, ["mcp", "servers"], undefined, fo));
    const left = parse(t, [], { allowTrailingComma: true })?.mcp;
    if (isPlainObject(left) && Object.keys(left).length === 0) t = applyEdits(t, modify(t, ["mcp"], undefined, fo));
    return t;
  }
  return applyEdits(text, modify(text, ["mcp"], undefined, fo));
}
