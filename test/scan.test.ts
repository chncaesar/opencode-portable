import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runExport } from "../src/export.js";
import { inspectArchive } from "../src/inspect.js";
import { scanFile } from "../src/scan.js";
import { tmp, write } from "./helpers.js";

const S = {
  apiKey: "plainvalue-key-0001",
  sk: "sk-abcdefghijklmnopqrstuvwx",
  ghp: "ghp_abcdefghijklmnopqrstuvwxyz0123",
  pat: "github_pat_abcdefghijklmnopqrstuv",
  xox: "xoxb-1234567890-abcdefghij",
  aws: "AKIAABCDEFGHIJKLMNOP",
  bearer: "Bearer abcdefghijklmnopqrstuvwxyz012345",
  pass: "hunter2-hunter2",
};
const ALL = Object.values(S);

const CONFIG = `{
  // inline secrets
  "provider": { "x": { "options": { "apiKey": "${S.apiKey}", "baseURL": "https://x.example" } } },
  "note": "token is ${S.sk}",
  "other": [ "${S.ghp}", "${S.pat}", "${S.xox}", "${S.aws}", "${S.bearer}" ],
  "db": { "password": "${S.pass}" },
  "fromEnv": { "apiKey": "{env:MY_KEY}", "token": "{file:~/.tok}", "secret": "Bearer {env:T}" },
  "keybinds": { "leader": "ctrl+x", "session_pass": "ctrl+p" },
  "mcp": { "gh": { "type": "local", "command": ["x"], "environment": { "GITHUB_TOKEN": "mcp-handled-elsewhere-1" } } }
}`;

describe("inline secret scanner", () => {
  const found = scanFile("config/opencode.jsonc", Buffer.from(CONFIG));
  const wheres = found.map((f) => f.where);

  it("flags secret-named keys and every known token shape", () => {
    expect(wheres).toContain("provider.x.options.apiKey");
    expect(wheres).toContain("note");
    expect(wheres).toContain("db.password");
    for (const i of [0, 1, 2, 3, 4]) expect(wheres).toContain(`other[${i}]`);
  });

  it("does not flag env/file references, keybinds, or harmless keys", () => {
    expect(wheres.some((w) => w.startsWith("fromEnv"))).toBe(false);
    expect(wheres.some((w) => w.startsWith("keybinds"))).toBe(false);
    expect(wheres).not.toContain("provider.x.options.baseURL");
  });

  it("findings never contain the secret text", () => {
    const text = JSON.stringify(found);
    for (const s of ALL) expect(text).not.toContain(s);
  });

  it("scans tui.json and plugin scripts, but not prose or other files", () => {
    expect(scanFile("config/tui.json", Buffer.from(`{"token":"${S.pass}"}`))).toHaveLength(1);
    const js = `const a = { apiKey: "${S.apiKey}" };\nconst b = process.env.TOKEN;\nfetch("x", { headers: { Authorization: "${S.bearer}" } });\nconst c = "${S.aws}";`;
    const f = scanFile("config/plugins/p.js", Buffer.from(js));
    expect(f.map((x) => x.where)).toEqual(["line 1", "line 3", "line 4"]);
    expect(JSON.stringify(f)).not.toContain(S.apiKey);
    expect(scanFile("config/command/a.md", Buffer.from(`token: "${S.pass}" ${S.sk}`))).toEqual([]);
    expect(scanFile("config/skills/s/SKILL.md", Buffer.from(S.sk))).toEqual([]);
    expect(scanFile("config/plugins/readme.md", Buffer.from(S.sk))).toEqual([]);
    expect(scanFile("config/opencode.jsonc", Buffer.from("{ not json"))).toEqual([]);
  });

  it("a value that is only a reference is never flagged", () => {
    const f = scanFile("config/opencode.jsonc", Buffer.from(`{"apiKey":"{env:A}","password":"$PASS","secret":"\${X}"}`));
    expect(f).toEqual([]);
  });
});

describe("export integration", () => {
  function setup() {
    const root = tmp();
    write(join(root, "c", "opencode.jsonc"), CONFIG);
    return { root, dirs: { configDir: join(root, "c"), stateDir: join(root, "s") } };
  }

  it("warns with locations only, records them in the manifest, shows them in inspect", async () => {
    const { root, dirs } = setup();
    const out = join(root, "a.ocm");
    const res = await runExport({ ...dirs, tiers: ["config"], out, opencodeBin: null });
    const warn = res.warnings.filter((w) => w.startsWith("Possible inline secret"));
    expect(warn.length).toBeGreaterThanOrEqual(8);
    expect(warn.join("\n")).toContain("{env:NAME}");
    for (const s of ALL) expect(warn.join("\n") + JSON.stringify(res.manifest)).not.toContain(s);
    const text = await inspectArchive(out);
    expect(text).toContain("Possible inline secrets in config files");
    expect(text).toContain("provider.x.options.apiKey");
    for (const s of ALL) expect(text).not.toContain(s);
  });

  it("mcp-only export does not scan the config tier", async () => {
    const { root, dirs } = setup();
    const res = await runExport({ ...dirs, tiers: ["mcp"], out: join(root, "a.ocm"), opencodeBin: null });
    expect(res.warnings.some((w) => w.startsWith("Possible inline secret"))).toBe(false);
  });

  it("--fail-on-secrets exits 1 without writing an archive; clean configs pass", async () => {
    const { root, dirs } = setup();
    const out = join(root, "a.ocm");
    const lines: string[] = [];
    const code = await main(["export", "--tiers", "config", "--fail-on-secrets", "--config-dir", dirs.configDir, "--state-dir", dirs.stateDir, "--out", out], (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/possible inline secret/);
    for (const s of ALL) expect(lines.join("\n")).not.toContain(s);
    const { existsSync } = await import("node:fs");
    expect(existsSync(out)).toBe(false);

    const clean = tmp();
    write(join(clean, "c", "opencode.jsonc"), '{ "model": "a/b", "provider": { "x": { "options": { "apiKey": "{env:K}" } } } }');
    const ok = await main(["export", "--tiers", "config", "--fail-on-secrets", "--config-dir", join(clean, "c"), "--state-dir", join(clean, "s"), "--out", join(clean, "a.ocm")], () => {});
    expect(ok).toBe(0);
  });
});
