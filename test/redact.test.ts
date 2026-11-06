import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readArchive } from "../src/archive.js";
import { main } from "../src/cli.js";
import { runExport } from "../src/export.js";
import { applyPlan, formatPlan, planImport } from "../src/import.js";
import { inspectArchive } from "../src/inspect.js";
import { parseJsonc } from "../src/mcp.js";
import { decryptBundle } from "../src/secrets.js";
import { redactJsonc, restoreConfigMarkers } from "../src/redact.js";
import { FakeOpencode } from "./fake.js";
import { makePassphraseProvider } from "../src/passphrase.js";
import { IS_WIN, privateTmpEnv, tmp, write } from "./helpers.js";

const PASS = "correct horse battery";
const staticPass = () => makePassphraseProvider({ env: { OPENCODE_PORTABLE_PASSPHRASE: PASS }, isTTY: false });

const K1 = "sk-ant-77char-000000000000000000000000000000000000000000000000000000000000000000";
const K2 = "sk-openai-35char-000000000000000000000000000000000";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";

const CONFIG = `{
  // top comment
  "provider": {
    "x": {
      "options": {
        "apiKey": "${K1}",
        "baseURL": "https://x.example",
      },
    },
    "y": { "options": { "apiKey": "${K2}" } }, /* inline */
  },
  "notes": "the token is ${TOKEN} and that is fine",
  "fromEnv": { "apiKey": "{env:ALREADY}", "secret": "{file:~/.tok}" },
  "normal": { "enabled": true, "count": 42 },
  "keybinds": { "session_pass": "ctrl+p" },
}
`;

const CONFIG_SECRETS = [K1, K2, TOKEN];

function target(home = "/home/zjc") {
  const root = tmp();
  return { configDir: join(root, "c"), stateDir: join(root, "s"), home, root };
}

function setup() {
  const root = tmp();
  const cfg = join(root, "c", "opencode.jsonc");
  write(cfg, CONFIG);
  return { root, configDir: join(root, "c"), stateDir: join(root, "s"), cfg };
}

function scanBytes(out: string, secrets: string[]) {
  const raw = readFileSync(out);
  const dec = gunzipSync(raw);
  for (const s of secrets) {
    expect(raw.includes(Buffer.from(s)), `raw contains ${s}`).toBe(false);
    expect(dec.includes(Buffer.from(s)), `gunzipped contains ${s}`).toBe(false);
  }
}

let fake: FakeOpencode;
let restoreTmp: () => void;
beforeEach(() => { restoreTmp = privateTmpEnv(tmp("ocm-privtmp-")); fake = new FakeOpencode(); });
afterEach(() => { fake.restore(); restoreTmp(); });

describe("redactJsonc", () => {
  it("redacts values, preserves comments and unrelated keys, derives marker names", () => {
    const { text, records } = redactJsonc("config/opencode.jsonc", Buffer.from(CONFIG), new Set());
    expect(text).toContain("// top comment");
    expect(text).toContain("/* inline */");
    const parsed = parseJsonc(text, "redacted");
    expect(parsed.provider.x.options.apiKey).toBe("{env:PROVIDER_X_OPTIONS_APIKEY}");
    expect(parsed.provider.y.options.apiKey).toBe("{env:PROVIDER_Y_OPTIONS_APIKEY}");
    expect(parsed.notes).toBe(`the token is {env:NOTES} and that is fine`);
    expect(parsed.fromEnv.apiKey).toBe("{env:ALREADY}");
    expect(parsed.normal.enabled).toBe(true);
    expect(parsed.normal.count).toBe(42);
    expect(parsed.keybinds.session_pass).toBe("ctrl+p");
    expect(records.map((r) => r.name)).toContain("PROVIDER_X_OPTIONS_APIKEY");
    // records intentionally carry the value in memory for the bundle; the redacted text must not contain it
    for (const s of [K1, K2, TOKEN]) expect(text).not.toContain(s);
    expect(JSON.stringify(records.map(({ value: _v, ...rest }) => rest))).not.toContain(K1);
  });

  it("restores markers and reports missing ones", () => {
    const { text } = redactJsonc("config/opencode.jsonc", Buffer.from(CONFIG), new Set());
    const r = restoreConfigMarkers(text, ["PROVIDER_X_OPTIONS_APIKEY", "NOPE"], { PROVIDER_X_OPTIONS_APIKEY: K1 });
    expect(parseJsonc(r.text, "r").provider.x.options.apiKey).toBe(K1);
    expect(r.missing).toEqual(["NOPE"]);
  });
});

describe("export redacts config secrets by default", () => {
  it("strips all secrets from the archive, source untouched, manifest lists them", async () => {
    const { root, configDir, stateDir, cfg } = setup();
    const before = readFileSync(cfg, "utf8");
    const out = join(root, "a.ocm");
    const logs: string[] = [];
    const res = await runExport({ configDir, stateDir, tiers: ["config"], out, opencodeBin: null, log: (s) => logs.push(s) });
    scanBytes(out, CONFIG_SECRETS);
    expect(readFileSync(cfg, "utf8")).toBe(before);
    const { manifest, files } = await readArchive(out);
    const text = files.get("config/opencode.jsonc")!.toString();
    expect(text).toContain("// top comment");
    expect(text).toContain("{env:PROVIDER_X_OPTIONS_APIKEY}");
    const p = parseJsonc(text, "archived");
    expect(p.provider.x.options.apiKey).toMatch(/^\{env:/);
    expect(p.provider.x.options.baseURL).toBe("https://x.example");
    expect(p.notes).toBe(`the token is {env:NOTES} and that is fine`);
    expect(manifest.configRedactions!.length).toBe(3);
    expect(manifest.configRedactions!.some((r) => r.name === "PROVIDER_X_OPTIONS_APIKEY")).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(K1);
    expect(logs.join("\n")).toContain("replaced with {env:NAME} markers");
    expect(logs.join("\n")).not.toContain(K1);
  });

  it("marker names are unique across MCP and config in one export", async () => {
    const root = tmp();
    const cfg = join(root, "c", "opencode.jsonc");
    write(cfg, `{
      "provider": { "x": { "options": { "apiKey": "${K1}" } } },
      "mcp": { "gh": { "type": "local", "command": ["x"], "environment": { "GITHUB_TOKEN": "ghp-tok-unique-1" } } }
    }`);
    fake.use({ sessions: [], auth: [] });
    const out = join(root, "a.ocm");
    const res = await runExport({ configDir: join(root, "c"), stateDir: join(root, "s"), tiers: ["config", "mcp", "credentials"], out, opencodeBin: null, keepSecrets: true, passphrase: PASS });
    const names = [...(res.manifest.configRedactions ?? []).map((r) => r.name), ...(res.manifest.mcp?.redactions ?? []).map((r) => r.name)];
    expect(new Set(names).size).toBe(names.length);
    const { files } = await readArchive(out);
    const payload = await decryptBundle(files.get("secrets.enc")!, PASS);
    const all = { ...(payload.mcpSecrets ?? {}), ...(payload.configSecrets ?? {}) };
    expect(Object.keys(all)).toHaveLength(names.length);
    expect(Object.values(all)).toContain(K1);
    expect(Object.values(all)).toContain("ghp-tok-unique-1");
    scanBytes(out, [K1, "ghp-tok-unique-1"]);
  });

  it("inspect shows the redactions, never values", async () => {
    const { root, configDir, stateDir } = setup();
    const out = join(root, "a.ocm");
    await runExport({ configDir, stateDir, tiers: ["config"], out, opencodeBin: null });
    const text = await inspectArchive(out);
    expect(text).toContain("Inline config secrets replaced with {env:NAME} markers (3)");
    expect(text).toContain("provider.x.options.apiKey");
    for (const s of CONFIG_SECRETS) expect(text).not.toContain(s);
  });
});

describe("round trip with --keep-secrets and --restore-secrets", () => {
  async function exportWithCreds() {
    const root = tmp();
    const cfg = join(root, "c", "opencode.jsonc");
    write(cfg, `{
      // keep me
      "provider": { "x": { "options": { "apiKey": "${K1}" } } },
      "mcp": { "gh": { "type": "local", "command": ["x"], "environment": { "GITHUB_TOKEN": "ghp-tok-rt-1" } } }
    }`);
    fake.use({ sessions: [], auth: [] });
    const out = join(root, "a.ocm");
    const res = await runExport({ configDir: join(root, "c"), stateDir: join(root, "s"), tiers: ["config", "mcp", "credentials"], out, opencodeBin: null, keepSecrets: true, passphrase: PASS });
    return { root, cfg, out, res };
  }

  it("restores both config and MCP values into the written files, names them, sets 0600", async () => {
    const { out } = await exportWithCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    const tgt = target();
    process.env.OPENCODE_PORTABLE_PASSPHRASE = PASS;
    const outLines: string[] = [];
    const code2 = await main(["import", out, "--apply", "--restore-secrets", "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir], (s) => outLines.push(s));
    delete process.env.OPENCODE_PORTABLE_PASSPHRASE;
    expect(code2).toBe(0);
    const text = readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8");
    expect(text).toContain("// keep me");
    expect(text).toContain(K1);
    expect(text).toContain("ghp-tok-rt-1");
    expect(text).not.toContain("{env:PROVIDER_X_OPTIONS_APIKEY}");
    expect(text).not.toContain("{env:GITHUB_TOKEN}");
    const joined = outLines.join("\n");
    expect(joined).toMatch(/Real secret values were written into these files: config\/opencode\.jsonc/);
    expect(joined).toMatch(/Real secret values were written into opencode\.jsonc for MCP servers: gh/);
    if (!IS_WIN) {
      const mode = (await import("node:fs")).statSync(join(tgt.configDir, "opencode.jsonc")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("restores into a .incoming file when the target differs", async () => {
    const { out } = await exportWithCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    const tgt = target();
    write(join(tgt.configDir, "opencode.jsonc"), '{ "different": true }');
    const plan = await planImport({ archive: out, ...tgt, apply: true, restoreSecrets: true, passphrase: staticPass() });
    applyPlan(plan);
    const incoming = readFileSync(join(tgt.configDir, "opencode.jsonc.incoming"), "utf8");
    expect(incoming).toContain(K1);
    expect(incoming).not.toContain("{env:PROVIDER_X_OPTIONS_APIKEY}");
    // the config tier wrote .incoming; the MCP tier still merges into the real file (pre-existing behaviour)
    expect(readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8")).toContain("different");
    expect(plan.restoredConfigFiles).toContain("config/opencode.jsonc");
  });

  it("without --restore-secrets the markers stay", async () => {
    const { out } = await exportWithCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    const tgt = target();
    const plan = await planImport({ archive: out, ...tgt, apply: true, passphrase: staticPass() });
    applyPlan(plan);
    const text = readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8");
    expect(text).toContain("{env:PROVIDER_X_OPTIONS_APIKEY}");
    expect(text).not.toContain(K1);
    const msg = formatPlan(plan, { written: [], backups: [] });
    expect(msg).toMatch(/\{env:PROVIDER_X_OPTIONS_APIKEY\}  used by config\/opencode\.jsonc/);
  });

  it("--restore-mcp-secrets alias still restores MCP only", async () => {
    const { out } = await exportWithCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    const tgt = target();
    const plan = await planImport({ archive: out, ...tgt, apply: true, restoreMcpSecrets: true, passphrase: staticPass() });
    applyPlan(plan);
    const text = readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8");
    expect(text).toContain("ghp-tok-rt-1"); // MCP restored
    expect(text).toContain("{env:PROVIDER_X_OPTIONS_APIKEY}"); // config NOT restored
    expect(text).not.toContain(K1);
  });

  it("an old bundle without configSecrets still decrypts and imports", async () => {
    const { out } = await exportWithCreds();
    // Strip configSecrets from the bundle to simulate an archive written before this feature.
    const root = tmp();
    const { files, manifest } = await readArchive(out);
    const old = await decryptBundle(files.get("secrets.enc")!, PASS);
    const { configSecrets, ...rest } = old;
    const { encryptBundle } = await import("../src/secrets.js");
    const { ArchiveBuilder } = await import("../src/archive.js");
    const b = new ArchiveBuilder();
    for (const f of manifest.files) {
      const data = f.path === "secrets.enc" ? await encryptBundle(rest, PASS) : files.get(f.path)!;
      b.add(f.path, f.tier, data);
    }
    const out2 = join(root, "old.ocm");
    const { files: _files, ...base } = manifest;
    await b.finish(out2, base);
    b.dispose();
    const plan = await planImport({ archive: out2, ...target(), apply: true, restoreSecrets: true, passphrase: staticPass() });
    expect(plan.credentials!.payload!.configSecrets).toBeUndefined();
  });
});

describe("--fail-on-secrets", () => {
  it("passes when everything is redactable, fails for a plugin script secret", async () => {
    const root = tmp();
    const cfg = join(root, "c", "opencode.jsonc");
    write(cfg, `{ "provider": { "x": { "options": { "apiKey": "${K1}" } } } }`);
    const out = join(root, "a.ocm");
    const ok = await main(["export", "--tiers", "config", "--fail-on-secrets", "--config-dir", join(root, "c"), "--state-dir", join(root, "s"), "--out", out], () => {});
    expect(ok).toBe(0);
    expect(existsSync(out)).toBe(true);

    write(join(root, "c", "plugins", "p.js"), `export default { token: "${K1}" };`);
    const out2 = join(root, "b.ocm");
    const lines: string[] = [];
    const code = await main(["export", "--tiers", "config", "--fail-on-secrets", "--config-dir", join(root, "c"), "--state-dir", join(root, "s"), "--out", out2], (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/could not be redacted/);
    expect(lines.join("\n")).not.toContain(K1);
    expect(existsSync(out2)).toBe(false);
  });
});

describe("large payload", () => {
  it("redacts 2000 secrets in a ~3MB config in one pass, leaving the rest untouched", async () => {
    const n = 2000;
    const parts: string[] = ["{ // header"];
    const secrets: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = `sk-large-${i}-${"x".repeat(1500)}`;
      secrets.push(v);
      parts.push(`  "k${i}": { "apiKey": "${v}", "keep": ${i} },`);
    }
    parts.push('  "tail": {"a":1}');
    parts.push("}");
    const src = parts.join("\n");
    const { text, records } = redactJsonc("config/opencode.jsonc", Buffer.from(src), new Set());
    expect(records).toHaveLength(n);
    const parsed = parseJsonc(text, "big");
    expect(parsed.tail.a).toBe(1);
    expect(parsed.k0.keep).toBe(0);
    expect(parsed.k0.apiKey).toBe("{env:K0_APIKEY}");
    expect(parsed.k1999.keep).toBe(1999);
    expect(text).toContain("// header");
    for (const s of secrets) expect(text).not.toContain(s);
    // uniqueness held
    expect(new Set(records.map((r) => r.name)).size).toBe(n);
  }, 60_000);
});
