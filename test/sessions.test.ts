import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readArchive } from "../src/archive.js";
import { main } from "../src/cli.js";
import { runExport } from "../src/export.js";
import { applyPlan, applySessionsPlan, planImport } from "../src/import.js";
import { inspectArchive } from "../src/inspect.js";
import { FakeOpencode, type FakeSession } from "./fake.js";
import { tmp, write } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.now();

function sess(id: string, projectID: string, dir: string, ageDays: number, extra: Partial<FakeSession> = {}): FakeSession {
  const t = NOW - ageDays * DAY;
  return { id, projectID, title: `title ${id}`, time: { created: t - 1000, updated: t }, location: { directory: dir }, ...extra };
}

function gitRepo(parent: string, name: string, msg = "init"): { dir: string; root: string } {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", msg);
  return { dir, root: git("rev-list", "--max-parents=0", "HEAD").trim().split("\n").sort()[0] };
}

let fake: FakeOpencode;
beforeEach(() => {
  fake = new FakeOpencode();
});
afterEach(() => fake.restore());

async function exportSessions(
  sessions: FakeSession[],
  projects: { id: string; canonical: string }[],
  extra: Record<string, unknown> = {},
  home = "/home/zjc",
) {
  fake.use({ sessions, projects, pageSize: 2 }, "source");
  const root = tmp();
  const logs: string[] = [];
  const res = await runExport({
    configDir: join(root, "c"), stateDir: join(root, "s"), home, tiers: ["sessions"], out: join(root, "a.ocm"),
    opencodeBin: null, log: (s) => logs.push(s), ...extra,
  });
  return { root, out: res.out, res, logs };
}

function target(home = tmp("ocm-home-")) {
  const root = tmp();
  return { configDir: join(root, "c"), stateDir: join(root, "s"), home, root };
}

describe("sessions export", () => {
  it("collects every session across pages, writes index and checksums, warns about secrets", async () => {
    const list = [1, 2, 3, 4, 5].map((i) => sess(`ses_${i}`, "p1", "/home/zjc/code/a", i));
    const { out, res, logs } = await exportSessions(list, [{ id: "p1", canonical: "/home/zjc/code/a" }]);
    expect(res.manifest.sessions).toEqual({ count: 5, sanitized: false });
    const { manifest, files } = await readArchive(out);
    expect(manifest.files.filter((f) => f.path.startsWith("sessions/ses_")).length).toBe(5);
    const idx = JSON.parse(files.get("sessions/index.json")!.toString()).sessions;
    expect(idx).toHaveLength(5);
    expect(idx[0]).toMatchObject({ projectID: "p1", sourceDirectory: "/home/zjc/code/a", projectCanonical: "/home/zjc/code/a" });
    expect(logs.join("\n")).toMatch(/may contain secrets/);
    expect(logs.join("\n")).toMatch(/Selected 5 of 5/);
    // export never uses --standalone and never passes --sanitize by default
    const exports = fake.calls().filter((a) => a[1] === "export");
    expect(exports.length).toBe(5);
    expect(exports.every((a) => !a.includes("--sanitize") && !a.includes("--standalone"))).toBe(true);
  });

  it("--sanitize-sessions passes --sanitize", async () => {
    await exportSessions([sess("ses_1", "p1", "/x", 1)], [], { sanitizeSessions: true });
    expect(fake.calls().find((a) => a[1] === "export")).toContain("--sanitize");
  });

  it("filters: since, project (id and path), max-sessions, and keeps children", async () => {
    const list = [
      sess("ses_new", "pA", "/w/a", 1),
      sess("ses_mid", "pA", "/w/a/sub", 20),
      sess("ses_old", "pA", "/w/a", 200),
      sess("ses_b", "pB", "/w/b", 2),
      sess("ses_kid", "pB", "/w/b", 300, { parentID: "ses_b" }),
    ];
    const projects = [{ id: "pA", canonical: "/w/a" }, { id: "pB", canonical: "/w/b" }];
    const ids = async (extra: Record<string, unknown>) => {
      const r = await exportSessions(list, projects, extra);
      return (await readArchive(r.out)).manifest.files.filter((f) => f.path !== "sessions/index.json" && f.tier === "sessions").map((f) => f.path.slice(9, -5)).sort();
    };
    expect(await ids({ since: "30d" })).toEqual(["ses_b", "ses_kid", "ses_mid", "ses_new"]);
    expect(await ids({ since: "2000-01-01" })).toHaveLength(5);
    expect(await ids({ projects: ["pB"] })).toEqual(["ses_b", "ses_kid"]);
    expect(await ids({ projects: ["/w/a"] })).toEqual(["ses_mid", "ses_new", "ses_old"]);
    expect(await ids({ projects: ["/w/a/sub"] })).toEqual(["ses_mid"]);
    expect(await ids({ maxSessions: 1 })).toEqual(["ses_new"]);
    expect(await ids({ maxSessions: 2, projects: ["pB"] })).toEqual(["ses_b", "ses_kid"]);
    await expect(ids({ since: "yesterday" })).rejects.toThrow(/Invalid --since/);
  });

  it("gives a plain error when opencode is missing", async () => {
    fake.use({ sessions: [] });
    process.env.OPENCODE_BIN = join(tmp(), "nope");
    const root = tmp();
    await expect(
      runExport({ configDir: root, stateDir: root, tiers: ["sessions"], out: join(root, "a.ocm"), opencodeBin: null }),
    ).rejects.toThrow(/was not found/);
  });

  it("one failing session export is skipped with a warning", async () => {
    fake.use({ sessions: [sess("ses_1", "p", "/x", 1), sess("ses_2", "p", "/x", 2)], failExport: ["ses_2"] });
    const root = tmp();
    const res = await runExport({ configDir: root, stateDir: root, tiers: ["sessions"], out: join(root, "a.ocm"), opencodeBin: null });
    expect(res.manifest.sessions!.count).toBe(1);
    expect(res.warnings.join(" ")).toMatch(/ses_2/);
  });

  it("inspect summarises sessions", async () => {
    const { out } = await exportSessions([sess("ses_1", "p1", "/home/zjc/a", 1), sess("ses_2", "p1", "/home/zjc/a", 3)], [{ id: "p1", canonical: "/home/zjc/a" }]);
    const text = await inspectArchive(out);
    expect(text).toContain("Sessions (2,");
    expect(text).toContain("Date range:");
    expect(text).toMatch(/2 session\(s\)\s+\/home\/zjc\/a/);
  });
});

describe("sessions import", () => {
  it("matches projects to local clones by root commit (repo scan)", async () => {
    const scan = tmp("ocm-scan-");
    const repo = gitRepo(join(scan, "deep", "er"), "myrepo");
    gitRepo(scan, "other", "different history");
    const { out } = await exportSessions(
      [sess("ses_1", repo.root, "/old/machine/myrepo", 1), sess("ses_2", repo.root, "/old/machine/myrepo/pkg", 2)],
      [{ id: repo.root, canonical: "/old/machine/myrepo" }],
    );
    mkdirSync(join(repo.dir, "pkg"));
    fake.use({ sessions: [] }, "target");
    const plan = await planImport({ archive: out, ...target(), scanRoots: [scan] });
    const p = plan.sessions!.projects[0];
    expect(p.method).toBe("repo");
    expect(p.targetRoot).toBe(repo.dir);
    expect(p.sessions.find((s) => s.entry.id === "ses_2")!.targetDir).toBe(join(repo.dir, "pkg"));
    expect(p.sessions.every((s) => s.kind === "add")).toBe(true);
  });

  it("explicit --map rule resolves a project", async () => {
    const local = tmp("ocm-local-");
    const { out } = await exportSessions([sess("ses_1", "proj", "/srv/app", 1)], [{ id: "proj", canonical: "/srv/app" }]);
    fake.use({ sessions: [] }, "target");
    const plan = await planImport({ archive: out, ...target(), scanRoots: [], maps: [`/srv/app=${local}`] });
    expect(plan.sessions!.projects[0]).toMatchObject({ method: "rule", targetRoot: local });
    // a rule pointing at a missing directory is not trusted
    const bad = await planImport({ archive: out, ...target(), scanRoots: [], maps: [`/srv/app=${join(local, "missing")}`] });
    expect(bad.sessions!.projects[0].method).toBe("detached");
    expect(bad.sessions!.projects[0].notes.join(" ")).toMatch(/does not exist/);
  });

  it("falls back to swapping the home directory when the directory exists", async () => {
    const tgt = target();
    mkdirSync(join(tgt.home, "code", "p"), { recursive: true });
    const { out } = await exportSessions([sess("ses_1", "proj", "/home/zjc/code/p", 1)], [{ id: "proj", canonical: "/home/zjc/code/p" }]);
    fake.use({ sessions: [] }, "target");
    const plan = await planImport({ archive: out, ...tgt, scanRoots: [] });
    expect(plan.sessions!.projects[0]).toMatchObject({ method: "home", targetRoot: join(tgt.home, "code", "p") });
  });

  it("uses the original path when it exists here", async () => {
    const same = tmp("ocm-same-");
    const { out } = await exportSessions([sess("ses_1", "proj", same, 1)], [{ id: "proj", canonical: same }]);
    fake.use({ sessions: [] }, "target");
    const plan = await planImport({ archive: out, ...target(), scanRoots: [] });
    expect(plan.sessions!.projects[0]).toMatchObject({ method: "original", targetRoot: same });
  });

  it("skips detached projects by default and honours --import-detached-to; dry run makes no import calls", async () => {
    const { out } = await exportSessions([sess("ses_1", "lost", "/nowhere/x", 1)], [{ id: "lost", canonical: "/nowhere/x" }]);
    fake.use({ sessions: [] }, "target");
    fake.clearLog();
    const tgt = target();
    const lines: string[] = [];
    const code = await main(["import", out, "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home, "--scan-root", tgt.home], (s) => lines.push(s));
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("detached");
    expect(text).toContain("--map /nowhere/x=LOCAL_PATH");
    expect(text).toContain("--import-detached-to");
    expect(text).toContain("Dry run only");
    expect(fake.importCalls()).toEqual([]);
    expect(existsSync(`${out}.mapping.json`)).toBe(false);
    expect(existsSync(tgt.configDir)).toBe(false);

    const plan = await planImport({ archive: out, ...tgt, apply: true, scanRoots: [] });
    const r = await applySessionsPlan(plan);
    expect(r!.result.imported).toEqual([]);
    expect(fake.importCalls()).toEqual([]);

    const dest = tmp("ocm-dest-");
    const plan2 = await planImport({ archive: out, ...tgt, apply: true, scanRoots: [], importDetachedTo: dest });
    expect(plan2.sessions!.projects[0].method).toBe("detached-to");
    await applySessionsPlan(plan2);
    expect(fake.importCalls().map((c) => c.dir)).toEqual([dest]);
    await expect(planImport({ archive: out, ...tgt, scanRoots: [], importDetachedTo: join(dest, "nope") })).rejects.toThrow(/does not exist/);
  });

  it("apply imports each session with the right --directory, parents first", async () => {
    const a = tmp("ocm-a-");
    const b = tmp("ocm-b-");
    const { out } = await exportSessions(
      [sess("ses_child", "pA", "/o/a", 3, { parentID: "ses_parent" }), sess("ses_parent", "pA", "/o/a", 2), sess("ses_b", "pB", "/o/b", 1)],
      [{ id: "pA", canonical: "/o/a" }, { id: "pB", canonical: "/o/b" }],
    );
    const tpath = fake.use({ sessions: [] }, "target");
    fake.clearLog();
    const tgt = target();
    const lines: string[] = [];
    const code = await main(["import", out, "--apply", "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home, "--scan-root", tgt.home, "--map", `/o/a=${a}`, "--map", `/o/b=${b}`], (s) => lines.push(s));
    expect(code).toBe(0);
    const calls = fake.importCalls();
    expect(calls).toHaveLength(3);
    const byFile = (id: string) => calls.find((c) => c.file.endsWith(`${id}.json`))!;
    expect(byFile("ses_parent").dir).toBe(a);
    expect(byFile("ses_child").dir).toBe(a);
    expect(byFile("ses_b").dir).toBe(b);
    expect(calls.findIndex((c) => c.file.endsWith("ses_parent.json"))).toBeLessThan(calls.findIndex((c) => c.file.endsWith("ses_child.json")));
    expect(fake.state(tpath).sessions.map((s) => s.id).sort()).toEqual(["ses_b", "ses_child", "ses_parent"]);
    expect(lines.join("\n")).toContain("Sessions imported: 3, skipped: 0, failed: 0");
    // temp extraction dir is gone
    expect(existsSync(calls[0].file)).toBe(false);
  });

  it("skips sessions that already exist and reports conflicts; nothing existing is re-imported", async () => {
    const dir = tmp("ocm-d-");
    const { out } = await exportSessions(
      [sess("ses_same", "p", "/o/x", 1), sess("ses_tnew", "p", "/o/x", 5), sess("ses_snew", "p", "/o/x", 1), sess("ses_add", "p", "/o/x", 2)],
      [{ id: "p", canonical: "/o/x" }],
    );
    const src = fake.state(process.env.FAKE_OC_STATE);
    const upd = (id: string) => src.sessions.find((s) => s.id === id)!.time.updated;
    fake.use({
      sessions: [
        { ...sess("ses_same", "t", dir, 0), time: { created: 1, updated: upd("ses_same") } },
        { ...sess("ses_tnew", "t", dir, 0), time: { created: 1, updated: upd("ses_tnew") + 5000 } },
        { ...sess("ses_snew", "t", dir, 0), time: { created: 1, updated: upd("ses_snew") - 5000 } },
      ],
    }, "target");
    fake.clearLog();
    const plan = await planImport({ archive: out, ...target(), apply: true, scanRoots: [], maps: [`/o/x=${dir}`] });
    const kinds = Object.fromEntries(plan.sessions!.projects[0].sessions.map((s) => [s.entry.id, s.kind]));
    // A copy that is the same age or newer on the target counts as present (import resets update times).
    expect(kinds).toEqual({ ses_same: "skip", ses_tnew: "skip", ses_snew: "conflict", ses_add: "add" });
    const r = await applySessionsPlan(plan);
    expect(r!.result.imported).toEqual(["ses_add"]);
    expect(fake.importCalls()).toHaveLength(1);
  });

  it("a failing session does not stop the others; stderr stays out of the output", async () => {
    const dir = tmp("ocm-d-");
    const { out } = await exportSessions([sess("ses_1", "p", "/o/x", 1), sess("ses_2", "p", "/o/x", 2), sess("ses_3", "p", "/o/x", 3)], [{ id: "p", canonical: "/o/x" }]);
    const tpath = fake.use({ sessions: [], failImport: ["ses_2"] }, "target");
    const tgt = target();
    const lines: string[] = [];
    const code = await main(["import", out, "--apply", "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home, "--scan-root", tgt.home, "--map", `/o/x=${dir}`], (s) => lines.push(s));
    const text = lines.join("\n");
    expect(code).toBe(1);
    expect(fake.state(tpath).sessions.map((s) => s.id).sort()).toEqual(["ses_1", "ses_3"]);
    expect(text).toContain("Sessions imported: 2, skipped: 0, failed: 1");
    expect(text).toContain("ses_2");
    expect(text).not.toContain("secret-stderr");
    expect(readFileSync(join(tgt.stateDir, "opencode-portable.log"), "utf8")).toContain("secret-stderr");
  });

  it("writes <archive>.mapping.json on apply and reuses it; explicit --map still wins", async () => {
    const dir1 = tmp("ocm-m1-");
    const dir2 = tmp("ocm-m2-");
    const { out } = await exportSessions([sess("ses_1", "proj", "/o/x", 1)], [{ id: "proj", canonical: "/o/x" }]);
    fake.use({ sessions: [] }, "target");
    const tgt = target();
    const plan = await planImport({ archive: out, ...tgt, apply: true, scanRoots: [], maps: [`/o/x=${dir1}`] });
    await applySessionsPlan(plan);
    const mapping = JSON.parse(readFileSync(`${out}.mapping.json`, "utf8"));
    expect(mapping.projects.proj).toMatchObject({ source: "/o/x", target: dir1 });

    fake.use({ sessions: [] }, "target2");
    const reused = await planImport({ archive: out, ...tgt, scanRoots: [] });
    expect(reused.sessions!.projects[0]).toMatchObject({ method: "mapping", targetRoot: dir1 });
    const override = await planImport({ archive: out, ...tgt, scanRoots: [], maps: [`/o/x=${dir2}`] });
    expect(override.sessions!.projects[0]).toMatchObject({ method: "rule", targetRoot: dir2 });
  });

  it("checksums cover session files: a tampered transcript is rejected", async () => {
    const { out, root } = await exportSessions([sess("ses_1", "p", "/o/x", 1)], [{ id: "p", canonical: "/o/x" }]);
    const x = mkdtempSync(join(root, "x-"));
    await tar.x({ file: out, cwd: x });
    writeFileSync(join(x, "sessions", "ses_1.json"), '{"info":{"id":"ses_1"},"messages":["tampered"]}');
    const bad = join(root, "bad.ocm");
    await tar.c({ file: bad, gzip: true, cwd: x }, ["manifest.json", ...readdirSync(join(x, "sessions")).map((f) => `sessions/${f}`)]);
    fake.use({ sessions: [] }, "target");
    await expect(planImport({ archive: bad, ...target(), scanRoots: [] })).rejects.toThrow(/Checksum mismatch for sessions\/ses_1\.json/);
    await expect(inspectArchive(bad)).rejects.toThrow(/Checksum mismatch/);
  });

  it("session text is never rewritten", async () => {
    const dir = tmp("ocm-d-");
    fake.use({ sessions: [sess("ses_1", "p", "/o/x", 1)], projects: [{ id: "p", canonical: "/o/x" }] }, "source");
    const st = fake.state();
    const body = { info: { id: "ses_1", title: "t", time: st.sessions[0].time }, messages: [{ text: "see /o/x/file and /home/zjc/x" }] };
    st.exports = { ses_1: body };
    const sp = fake.use(st, "source");
    const root = tmp();
    const res = await runExport({ configDir: join(root, "c"), stateDir: join(root, "s"), tiers: ["sessions"], out: join(root, "a.ocm"), opencodeBin: null });
    const tp = fake.use({ sessions: [] }, "target");
    const plan = await planImport({ archive: res.out, ...target(), apply: true, scanRoots: [], maps: [`/o/x=${dir}`] });
    await applySessionsPlan(plan);
    expect(fake.state(tp).sessions[0]._raw).toBe(JSON.stringify(body));
    expect(sp).toBeTruthy();
  });
});

describe("misc", () => {
  it("default scan roots are the home dir plus existing common code folders", async () => {
    const { defaultScanRoots } = await import("../src/sessions.js");
    const have = new Set(["/h", "/work", "/h/code", "/h/src"]);
    expect(defaultScanRoots("/h", (p) => have.has(p))).toEqual(["/h", "/work", "/h/code", "/h/src"]);
    expect(defaultScanRoots("/h", () => false)).toEqual([]);
  });

  it("dry run warns when the target service is unreachable; apply refuses", async () => {
    const dir = tmp("ocm-d-");
    const { out } = await exportSessions([sess("ses_1", "p", "/o/x", 1)], [{ id: "p", canonical: "/o/x" }]);
    process.env.OPENCODE_BIN = join(tmp(), "gone");
    const plan = await planImport({ archive: out, ...target(), scanRoots: [], maps: [`/o/x=${dir}`] });
    expect(plan.sessions!.targetListed).toBe(false);
    expect(plan.sessions!.warnings.join(" ")).toMatch(/Could not read the sessions already on this machine/);
    await expect(planImport({ archive: out, ...target(), scanRoots: [], apply: true, maps: [`/o/x=${dir}`] })).rejects.toThrow(/duplicates/);
  });

  it("session-only export options require the sessions tier", async () => {
    const root = tmp();
    const lines: string[] = [];
    const code = await main(["export", "--since", "30d", "--config-dir", root, "--state-dir", root], (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join(" ")).toMatch(/only apply when --tiers includes sessions/);
  });
});

describe("combined tiers", () => {
  it("export with all tiers then import into empty dirs", async () => {
    const root = tmp();
    write(join(root, "c", "opencode.jsonc"), '{ "mcp": {} }');
    write(join(root, "s", "kv.json"), "{}");
    fake.use({ sessions: [sess("ses_1", "p", "/o/x", 1)], projects: [{ id: "p", canonical: "/o/x" }] }, "source");
    const res = await runExport({ configDir: join(root, "c"), stateDir: join(root, "s"), home: "/home/zjc", tiers: ["config", "mcp", "state", "sessions"], out: join(root, "a.ocm"), opencodeBin: null });
    expect(res.manifest.tiers).toEqual(["config", "mcp", "state", "sessions"]);
    const dir = tmp();
    fake.use({ sessions: [] }, "target");
    const tgt = target();
    const plan = await planImport({ archive: res.out, ...tgt, apply: true, scanRoots: [], maps: [`/o/x=${dir}`] });
    applyPlan(plan);
    await applySessionsPlan(plan);
    expect(existsSync(join(tgt.stateDir, "kv.json"))).toBe(true);
    expect(fake.importCalls()).toHaveLength(1);
  });
});
