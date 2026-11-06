import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers.js";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_OC_STATE;
const logPath = process.env.FAKE_OC_LOG;
let stdoutMode = null;
try { stdoutMode = fs.fstatSync(1).mode & 0o777; } catch {}
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ args, stdoutMode }) + "\\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (msg, code = 1) => { process.stderr.write(msg + "\\n"); process.exit(code); };

if (args[0] === "--version") { console.log("opencode v9.9.9"); process.exit(0); }

if (args[0] === "api" && args[1] === "GET") {
  const u = new URL(args[2], "http://x");
  if (u.pathname === "/api/project") { console.log(JSON.stringify(state.projects || [])); process.exit(0); }
  if (u.pathname === "/api/session") {
    const cap = state.pageSize || 50;
    const limit = Math.min(Number(u.searchParams.get("limit") || 50), cap);
    const cur = u.searchParams.get("cursor");
    const offset = cur ? Number(Buffer.from(cur, "base64").toString()) : 0;
    const data = state.sessions.slice(offset, offset + limit);
    const next = Buffer.from(String(offset + data.length)).toString("base64");
    console.log(JSON.stringify({ data, cursor: { previous: "p", next } }));
    process.exit(0);
  }
  fail("404");
}

if (args[0] === "auth" && args[1] === "export") {
  process.stdout.write(JSON.stringify(state.auth || []));
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "import") {
  const file = args[2];
  const mode = fs.statSync(file).mode & 0o777;
  const content = fs.readFileSync(file, "utf8");
  state.authImports = (state.authImports || []).concat([{ file, mode, content }]);
  if (state.failAuthImport) { save(); fail("auth import exploded: " + state.failAuthImport); }
  const list = JSON.parse(content);
  state.auth = state.auth || [];
  let imported = 0, skipped = 0;
  for (const c of list) {
    if (state.auth.some((x) => x.id === c.id)) skipped++;
    else { state.auth.push(c); imported++; }
  }
  save();
  console.error("Imported " + imported + " credential" + (imported === 1 ? "" : "s") + (skipped ? ", skipped " + skipped + " already present" : ""));
  process.exit(0);
}

if (args[0] === "session" && args[1] === "export") {
  const rest = args.slice(2);
  const id = rest[rest.length - 1];
  const s = state.sessions.find((x) => x.id === id);
  if (!s || (state.failExport || []).includes(id)) fail("Session not found: " + id);
  const body = (state.exports || {})[id] || { info: { id, title: s.title, time: s.time }, messages: [{ role: "user", text: "hello " + id }] };
  if (rest.includes("--sanitize")) body.sanitized = true;
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

if (args[0] === "session" && args[1] === "import") {
  const di = args.indexOf("--directory");
  const dir = args[di + 1];
  const file = args[args.length - 1];
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  const id = body.info.id;
  if ((state.failImport || []).includes(id)) fail("boom: internal detail secret-stderr");
  state.sessions.push({ id, projectID: "derived:" + dir, title: body.info.title, time: body.info.time, location: { directory: dir }, _raw: fs.readFileSync(file, "utf8") });
  save();
  console.log("Imported session: " + id);
  process.exit(0);
}
fail("unsupported: " + args.join(" "), 2);
`;

export interface FakeSession {
  id: string;
  projectID: string;
  title: string;
  time: { created: number; updated: number };
  location?: { directory: string };
  parentID?: string;
  _raw?: string;
}

export interface FakeState {
  sessions: FakeSession[];
  projects?: { id: string; canonical: string }[];
  failImport?: string[];
  failExport?: string[];
  pageSize?: number;
  exports?: Record<string, unknown>;
  auth?: any[];
  failAuthImport?: string;
  authImports?: { file: string; mode: number; content: string }[];
}

export class FakeOpencode {
  readonly dir = tmp("ocm-fake-");
  readonly bin = join(this.dir, "opencode");
  readonly log = join(this.dir, "calls.log");
  private saved: Record<string, string | undefined> = {};

  constructor() {
    writeFileSync(this.bin, SCRIPT);
    chmodSync(this.bin, 0o755);
  }

  /** Point the tool at a fake machine described by `state`. Returns the state file path. */
  use(state: FakeState, name = "state"): string {
    const p = join(this.dir, `${name}.json`);
    writeFileSync(p, JSON.stringify(state));
    for (const k of ["OPENCODE_BIN", "FAKE_OC_STATE", "FAKE_OC_LOG"]) if (!(k in this.saved)) this.saved[k] = process.env[k];
    process.env.OPENCODE_BIN = this.bin;
    process.env.FAKE_OC_STATE = p;
    process.env.FAKE_OC_LOG = this.log;
    return p;
  }

  state(path = process.env.FAKE_OC_STATE!): FakeState {
    return JSON.parse(readFileSync(path, "utf8"));
  }

  /** Calls with the mode of the stdout file the tool gave to the program. */
  callModes(): { args: string[]; stdoutMode: number | null }[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  calls(): string[][] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).args);
  }

  importCalls(): { dir: string; file: string }[] {
    return this.calls()
      .filter((a) => a[0] === "session" && a[1] === "import")
      .map((a) => ({ dir: a[a.indexOf("--directory") + 1], file: a[a.length - 1] }));
  }

  clearLog(): void {
    writeFileSync(this.log, "");
  }

  restore(): void {
    for (const [k, v] of Object.entries(this.saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    this.saved = {};
  }
}
