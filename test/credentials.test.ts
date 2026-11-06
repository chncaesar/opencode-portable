import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readArchive } from "../src/archive.js";
import { main } from "../src/cli.js";
import { parseTiers } from "../src/common.js";
import { runExport } from "../src/export.js";
import { applyCredentialsPlan, applyPlan, formatPlan, planImport } from "../src/import.js";
import { inspectArchive } from "../src/inspect.js";
import { parseJsonc } from "../src/mcp.js";
import { makePassphraseProvider } from "../src/passphrase.js";
import { BAD_BUNDLE, decryptBundle, encryptBundle, type BundlePayload } from "../src/secrets.js";
import { FakeOpencode } from "./fake.js";
import { IS_WIN, makeSource, privateTmpEnv, tmp, write } from "./helpers.js";

const PASS = "correct horse battery";
const KEY1 = "sk-ant-SECRET-111";
const KEY2 = "sk-openai-SECRET-222";
const MCP_VALUES = ["s3cr3t-pg-pass", "tok-abc-123-xyz", "envurl-pass-424", "hdr-secret-999"];
const AUTH = [
  { id: "cred_1", integrationID: "anthropic", label: "Work", active: true, value: { type: "api", key: KEY1 } },
  { id: "cred_2", integrationID: "openai", label: "Personal", active: false, value: { type: "api", key: KEY2 } },
];
const FAST = { logN: 12, r: 8, p: 1 };

const staticPass = (p = PASS) => makePassphraseProvider({ env: { OPENCODE_PORTABLE_PASSPHRASE: p }, isTTY: false });
const noPass = () => makePassphraseProvider({ env: {}, isTTY: false });

let fake: FakeOpencode;
let restoreTmp: () => void;
beforeEach(() => {
  // A private temp dir per test, so leftover checks are not disturbed by other test files running in parallel.
  restoreTmp = privateTmpEnv(tmp("ocm-privtmp-"));
  fake = new FakeOpencode();
});
afterEach(() => {
  fake.restore();
  restoreTmp();
});

const tmpLeftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("ocm-auth-") || n.startsWith("ocm-run-") || n.startsWith("ocm-sessions-") || n.startsWith("ocm-stage-")).sort();

async function exportCreds(extra: Record<string, unknown> = {}, auth: unknown[] = AUTH) {
  const src = makeSource();
  fake.use({ sessions: [], auth });
  const out = join(tmp(), "a.ocm");
  const logs: string[] = [];
  const res = await runExport({
    configDir: src.configDir, stateDir: src.stateDir, home: src.home, tiers: ["config", "mcp", "credentials"],
    out, opencodeBin: null, keepSecrets: true, passphrase: PASS, log: (s) => logs.push(s), ...extra,
  });
  return { src, out, res, logs };
}

function target(home = "/home/zjc") {
  const root = tmp();
  return { configDir: join(root, "c"), stateDir: join(root, "s"), home, root };
}

describe("encrypted bundle", () => {
  const payload: BundlePayload = { auth: AUTH, mcpSecrets: { GITHUB_TOKEN: "tok" } };

  it("round-trips with the default scrypt parameters and keeps parameters in the header", async () => {
    const enc = await encryptBundle(payload, PASS);
    expect(enc.subarray(0, 7).toString()).toBe("OCMSEC1");
    expect(enc[8]).toBe(17);
    expect(enc.readUInt32BE(9)).toBe(8);
    expect(await decryptBundle(enc, PASS)).toEqual(payload);
    const again = await encryptBundle(payload, PASS);
    expect(again.equals(enc)).toBe(false); // fresh salt and iv
  });

  it("wrong passphrase gives one plain error", async () => {
    const enc = await encryptBundle(payload, PASS, FAST);
    await expect(decryptBundle(enc, "another passphrase!")).rejects.toThrow(BAD_BUNDLE);
  });

  it("every flipped header byte, ciphertext byte, tag byte and truncation gives the same plain error", async () => {
    const enc = await encryptBundle(payload, PASS, FAST);
    const positions = [...Array(45).keys(), 45, 60, enc.length - 17, enc.length - 16, enc.length - 1];
    for (const pos of positions) {
      const bad = Buffer.from(enc);
      bad[pos] ^= 0x01;
      const err = await decryptBundle(bad, PASS).then(() => null, (e: Error) => e);
      expect(err, `byte ${pos}`).not.toBeNull();
      expect(err!.message).toBe(BAD_BUNDLE);
      expect(err!.stack ?? "").not.toMatch(/Unsupported state|auth/i);
    }
    for (const len of [0, 3, 7, 44, 45, 60, enc.length - 17, enc.length - 1]) {
      await expect(decryptBundle(enc.subarray(0, len), PASS), `len ${len}`).rejects.toThrow(BAD_BUNDLE);
    }
    await expect(decryptBundle(Buffer.concat([enc, Buffer.from("x")]), PASS)).rejects.toThrow(BAD_BUNDLE);
  });

  it("a header asking for huge memory is refused, not attempted", async () => {
    const enc = await encryptBundle(payload, PASS, FAST);
    enc[8] = 30;
    await expect(decryptBundle(enc, PASS)).rejects.toThrow(BAD_BUNDLE);
  });

  it("large payload (about 5 MB) round-trips byte for byte", async () => {
    const big = {
      auth: [{ id: "big", integrationID: "x", value: { type: "api", key: "k".repeat(2_500_000) + "é€😀" } }],
      mcpSecrets: { BIG: "v".repeat(2_500_000) + "\u0000end" },
    };
    const dec = await decryptBundle(await encryptBundle(big, PASS, FAST), PASS);
    expect(JSON.stringify(dec)).toBe(JSON.stringify(big));
  });
});

describe("passphrase handling", () => {
  it("export needs at least 12 characters, whatever the source", async () => {
    const p = makePassphraseProvider({ env: { OPENCODE_PORTABLE_PASSPHRASE: "short" }, isTTY: false });
    await expect(p.get({ minLength: 12 })).rejects.toThrow(/at least 12 characters/);
    await expect(p.get({})).resolves.toBe("short"); // import has no minimum
  });

  it.skipIf(IS_WIN)("reads --passphrase-file, strips the newline and warns about loose permissions", async () => {
    const f = join(tmp(), "pw");
    writeFileSync(f, `${PASS}\n`);
    chmodSync(f, 0o644);
    const warnings: string[] = [];
    const p = makePassphraseProvider({ file: f, env: { OPENCODE_PORTABLE_PASSPHRASE: "ignored ignored" }, isTTY: false, warn: (m) => warnings.push(m) });
    await expect(p.get({ minLength: 12 })).resolves.toBe(PASS);
    expect(warnings.join(" ")).toMatch(/can be read by other users/);
    chmodSync(f, 0o600);
    const w2: string[] = [];
    await makePassphraseProvider({ file: f, isTTY: false, warn: (m) => w2.push(m) }).get({});
    expect(w2).toEqual([]);
    await expect(makePassphraseProvider({ file: join(tmp(), "none"), isTTY: false }).get({})).rejects.toThrow(/could not be read/);
  });

  it("reads --passphrase-file on every OS (no permission check on Windows)", async () => {
    const f = join(tmp(), "pw2");
    writeFileSync(f, `${PASS}\r\n`);
    await expect(makePassphraseProvider({ file: f, isTTY: false }).get({ minLength: 12 })).resolves.toBe(PASS);
  });

  it("reads the environment variable", async () => {
    await expect(staticPass().get({ minLength: 12 })).resolves.toBe(PASS);
    expect(staticPass().hasStaticSource).toBe(true);
  });

  it("fails clearly with no source and no terminal", async () => {
    const p = noPass();
    expect(p.hasStaticSource).toBe(false);
    expect(p.canPrompt).toBe(false);
    await expect(p.get({})).rejects.toThrow(/No passphrase available.*--passphrase-file.*OPENCODE_PORTABLE_PASSPHRASE/);
  });

  it("asks twice on export and compares", async () => {
    const answers = ["first passphrase!", "different passphrase"];
    const asked: string[] = [];
    const p = makePassphraseProvider({ env: {}, isTTY: true, prompt: async (q) => (asked.push(q), answers.shift()!) });
    await expect(p.get({ confirm: true, minLength: 12 })).rejects.toThrow(/do not match/);
    expect(asked).toHaveLength(2);
    const same = ["same passphrase!!", "same passphrase!!"];
    const p2 = makePassphraseProvider({ env: {}, isTTY: true, prompt: async () => same.shift()! });
    await expect(p2.get({ confirm: true, minLength: 12 })).resolves.toBe("same passphrase!!");
    const once = ["only once please"];
    const asked2: string[] = [];
    const p3 = makePassphraseProvider({ env: {}, isTTY: true, prompt: async (q) => (asked2.push(q), once.shift()!) });
    await p3.get({});
    expect(asked2).toHaveLength(1);
  });

  it("the CLI rejects a --passphrase flag without echoing its value", async () => {
    const lines: string[] = [];
    const code = await main(["export", "--tiers", "credentials", "--passphrase", "hunter2hunter2"], (s) => lines.push(s));
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toMatch(/no --passphrase option/);
    expect(text).toMatch(/--passphrase-file/);
    expect(text).not.toContain("hunter2hunter2");
    const l2: string[] = [];
    expect(await main(["export", "--passphrase=hunter2hunter2"], (s) => l2.push(s))).toBe(1);
    expect(l2.join("")).not.toContain("hunter2hunter2");
  });

  it("credentials is opt-in: not in the default export tiers, but accepted when asked for", () => {
    expect(parseTiers(undefined, ["config", "mcp"])).toEqual(["config", "mcp"]);
    expect(parseTiers("config,credentials", [])).toEqual(["config", "credentials"]);
  });
});

describe("export with credentials", () => {
  it("keeps every secret out of the archive bytes, raw and gunzipped, and out of the logs", async () => {
    const before = tmpLeftovers();
    const { out, res, logs } = await exportCreds();
    const gz = readFileSync(out);
    const raw = gunzipSync(gz);
    for (const s of [KEY1, KEY2, ...MCP_VALUES, PASS]) {
      expect(gz.includes(Buffer.from(s)), s).toBe(false);
      expect(raw.includes(Buffer.from(s)), s).toBe(false);
    }
    const text = logs.join("\n") + JSON.stringify(res.manifest) + res.warnings.join("\n");
    for (const s of [KEY1, KEY2, ...MCP_VALUES]) expect(text).not.toContain(s);
    expect(logs.join("\n")).toContain("Work (anthropic)");
    expect(logs.join("\n")).toContain("Personal (openai)");
    expect(res.manifest.credentials).toMatchObject({ bundle: "secrets.enc" });
    const entry = res.manifest.files.find((f) => f.path === "secrets.enc")!;
    expect(entry.tier).toBe("credentials");
    expect(res.warnings.join(" ")).toMatch(/Remote MCP OAuth tokens are not transferred.*opencode mcp auth/);
    expect(tmpLeftovers()).toEqual(before);
    // the program was given a private stdout file
    const exp = fake.callModes().find((c) => c.args[0] === "auth" && c.args[1] === "export")!;
    if (!IS_WIN) expect(exp.stdoutMode).toBe(0o600); // POSIX file modes do not exist on Windows
    // the MCP config in the archive is still redacted
    const { files } = await readArchive(out);
    expect(files.get("mcp/mcp.json")!.toString()).toContain("{env:GITHUB_TOKEN}");
  });

  it("without --keep-secrets the bundle holds only the credentials", async () => {
    const { out } = await exportCreds({ keepSecrets: false });
    const { files } = await readArchive(out);
    const payload = await decryptBundle(files.get("secrets.enc")!, PASS);
    expect(payload.auth).toEqual(AUTH);
    expect(payload.mcpSecrets).toEqual({});
  });

  it("--keep-secrets stores the marker values under their marker names", async () => {
    const { out } = await exportCreds();
    const { files } = await readArchive(out);
    const payload = await decryptBundle(files.get("secrets.enc")!, PASS);
    expect(payload.mcpSecrets.GITHUB_TOKEN).toBe("tok-abc-123-xyz");
    expect(Object.values(payload.mcpSecrets).sort()).toEqual([...MCP_VALUES].sort());
  });

  it("--keep-secrets without the credentials tier tells the user what to add", async () => {
    const src = makeSource();
    fake.use({ sessions: [], auth: AUTH });
    const lines: string[] = [];
    const code = await main(["export", "--keep-secrets", "--config-dir", src.configDir, "--state-dir", src.stateDir, "--out", join(tmp(), "x.ocm")], (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/needs the credentials tier.*--tiers config,mcp,credentials/);
  });

  it("zero credentials: a note and no bundle", async () => {
    const { out, res } = await exportCreds({ keepSecrets: false }, []);
    expect(res.warnings.join(" ")).toMatch(/No stored credentials/);
    expect(res.manifest.files.some((f) => f.path === "secrets.enc")).toBe(false);
    expect(res.manifest.credentials).toBeUndefined();
    expect(existsSync(out)).toBe(true);
  });

  it("a broken auth export gives a plain error and leaks nothing", async () => {
    const src = makeSource();
    fake.use({ sessions: [], auth: { not: "an array", key: KEY1 } as never });
    await expect(
      runExport({ configDir: src.configDir, stateDir: src.stateDir, tiers: ["credentials"], out: join(tmp(), "a.ocm"), opencodeBin: null, passphrase: PASS }),
    ).rejects.toThrow(/unexpected format/);
  });

  it("inspect shows the bundle without decrypting and without labels", async () => {
    const { out } = await exportCreds();
    const text = await inspectArchive(out);
    expect(text).toMatch(/Credentials: encrypted bundle present \(\d+ bytes\)/);
    for (const s of [KEY1, "Work", "anthropic"]) expect(text).not.toContain(s);
  });
});

describe("import with credentials", () => {
  it("dry run without a passphrase only announces the bundle and calls nothing", async () => {
    const { out } = await exportCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    fake.clearLog();
    const plan = await planImport({ archive: out, ...target(), passphrase: noPass() });
    const text = formatPlan(plan);
    expect(text).toContain("encrypted credentials bundle");
    expect(text).toMatch(/passphrase is needed on --apply/);
    expect(text).not.toContain("Work");
    expect(fake.calls().filter((a) => a[0] === "auth")).toEqual([]);
  });

  it("dry run with a passphrase lists labels and secret names, never values, and writes nothing", async () => {
    const { out } = await exportCreds();
    const tp = fake.use({ sessions: [], auth: [] }, "target");
    fake.clearLog();
    const tgt = target();
    const plan = await planImport({ archive: out, ...tgt, passphrase: staticPass(), restoreMcpSecrets: true });
    const text = formatPlan(plan);
    expect(text).toContain("Work (anthropic)");
    expect(text).toContain("Personal (openai)");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toMatch(/--restore-mcp-secrets: real values will be written/);
    for (const s of [KEY1, KEY2, ...MCP_VALUES]) expect(text).not.toContain(s);
    expect(fake.calls().filter((a) => a[0] === "auth")).toEqual([]);
    expect(fake.state(tp).authImports).toBeUndefined();
    expect(existsSync(tgt.configDir)).toBe(false);
  });

  it("dry run does not decrypt when only a TTY is available and --tiers did not name credentials", async () => {
    const { out } = await exportCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    let asked = 0;
    const pp = makePassphraseProvider({ env: {}, isTTY: true, prompt: async () => (asked++, PASS) });
    const plan = await planImport({ archive: out, ...target(), passphrase: pp });
    expect(asked).toBe(0);
    expect(plan.credentials!.payload).toBeUndefined();
    const plan2 = await planImport({ archive: out, ...target(), passphrase: pp, tiers: ["credentials"] });
    expect(asked).toBe(1);
    expect(plan2.credentials!.labels).toHaveLength(2);
  });

  it("apply sends the exact auth array through a 0600 temp file that is always deleted; markers stay without restore", async () => {
    const { out } = await exportCreds();
    const tp = fake.use({ sessions: [], auth: [] }, "target");
    const before = tmpLeftovers();
    const tgt = target();
    const plan = await planImport({ archive: out, ...tgt, apply: true, passphrase: staticPass() });
    applyPlan(plan);
    const res = await applyCredentialsPlan(plan);
    expect(res).toEqual({ imported: 2, skipped: 0 });
    const st = fake.state(tp);
    expect(st.authImports).toHaveLength(1);
    expect(JSON.parse(st.authImports![0].content)).toEqual(AUTH);
    if (!IS_WIN) expect(st.authImports![0].mode).toBe(0o600);
    expect(existsSync(st.authImports![0].file)).toBe(false);
    expect(tmpLeftovers()).toEqual(before);
    const cfg = readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8");
    expect(cfg).toContain("{env:GITHUB_TOKEN}");
    for (const s of MCP_VALUES) expect(cfg).not.toContain(s);
  });

  it("--restore-mcp-secrets writes the real values for servers added in this run and names them", async () => {
    const { out } = await exportCreds();
    fake.use({ sessions: [], auth: [] }, "target");
    const tgt = target();
    const pre = join(tgt.configDir, "opencode.jsonc");
    write(pre, '{\n  // target\n  "mcp": { "github": { "type": "local", "command": ["mine"], "environment": { "GITHUB_TOKEN": "local-token-xyz" } } }\n}\n');
    const plan = await planImport({ archive: out, ...tgt, tiers: ["mcp", "credentials"], apply: true, passphrase: staticPass(), restoreMcpSecrets: true });
    applyPlan(plan);
    const text = readFileSync(pre, "utf8");
    const cfg = parseJsonc(text, "cfg");
    expect(text).toContain("// target");
    // github already existed, so it is a conflict: untouched, not restored
    expect(cfg.mcp.github.command).toEqual(["mine"]);
    expect(cfg.mcp.github.environment.GITHUB_TOKEN).toBe("local-token-xyz");
    expect(cfg.mcp.postgres.command[3]).toBe("postgresql://admin:s3cr3t-pg-pass@localhost:5432/db");
    expect(cfg.mcp.dburl.environment.DATABASE_URL).toBe("postgresql://apt:envurl-pass-424@127.0.0.1:5432/x");
    expect(cfg.mcp.remote1.headers.Authorization).toBe("Bearer hdr-secret-999");
    expect(plan.mcp.find((m) => m.name === "github")!.restored).toBeUndefined();
    const msg = formatPlan(plan, { written: [], backups: [] });
    expect(msg).toMatch(/Real secret values were written into opencode\.jsonc for: .*postgres/);
    expect(msg).not.toMatch(/written into opencode\.jsonc for: .*github/);
    for (const s of MCP_VALUES) expect(msg).not.toContain(s);
    // second run is idempotent for the restored servers
    const again = await planImport({ archive: out, ...tgt, tiers: ["mcp", "credentials"], apply: true, passphrase: staticPass(), restoreMcpSecrets: true });
    expect(again.mcp.filter((m) => m.name !== "github").every((m) => m.kind === "unchanged")).toBe(true);
  });

  it("--restore-mcp-secrets with no bundle is an error", async () => {
    const src = makeSource();
    const out = join(tmp(), "a.ocm");
    await runExport({ configDir: src.configDir, stateDir: src.stateDir, tiers: ["mcp"], out, opencodeBin: null });
    await expect(planImport({ archive: out, ...target(), apply: true, passphrase: staticPass(), restoreMcpSecrets: true })).rejects.toThrow(/needs a credentials bundle/);
  });

  it("an existing credential is left untouched and reported", async () => {
    const { out } = await exportCreds();
    const tp = fake.use({ sessions: [], auth: [{ id: "cred_1", integrationID: "anthropic", label: "Work", value: { type: "api", key: "local-key-keep" } }] }, "target");
    const lines: string[] = [];
    const tgt = target();
    const before = tmpLeftovers();
    process.env.OPENCODE_PORTABLE_PASSPHRASE = PASS;
    try {
      const code = await main(["import", out, "--apply", "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home], (s) => lines.push(s));
      expect(code).toBe(0);
      expect(tmpLeftovers()).toEqual(before);
    } finally {
      delete process.env.OPENCODE_PORTABLE_PASSPHRASE;
    }
    const text = lines.join("\n");
    expect(text).toContain("Credentials imported: 1, already present and left untouched: 1");
    const st = fake.state(tp);
    expect(st.auth!.find((a) => a.id === "cred_1").value.key).toBe("local-key-keep");
    expect(st.auth!.map((a) => a.id).sort()).toEqual(["cred_1", "cred_2"]);
    for (const s of [KEY1, KEY2]) expect(text).not.toContain(s);
  });

  it("wrong passphrase on apply: plain error, nothing written, nothing imported", async () => {
    const { out } = await exportCreds();
    const tp = fake.use({ sessions: [], auth: [] }, "target");
    const tgt = target();
    process.env.OPENCODE_PORTABLE_PASSPHRASE = "totally wrong passphrase";
    const lines: string[] = [];
    try {
      const code = await main(["import", out, "--apply", "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home], (s) => lines.push(s));
      expect(code).toBe(1);
    } finally {
      delete process.env.OPENCODE_PORTABLE_PASSPHRASE;
    }
    expect(lines.join("\n")).toBe(`Error: ${BAD_BUNDLE}`);
    expect(existsSync(tgt.configDir)).toBe(false);
    expect(fake.state(tp).authImports).toBeUndefined();
  });

  it("apply with no passphrase source and implicit tiers skips credentials with a clear note; explicit tiers fail", async () => {
    const { out } = await exportCreds();
    const tp = fake.use({ sessions: [], auth: [] }, "target");
    const plan = await planImport({ archive: out, ...target(), apply: true, passphrase: noPass() });
    expect(plan.credentials!.skippedReason).toMatch(/no passphrase available/);
    expect(await applyCredentialsPlan(plan)).toBeUndefined();
    expect(fake.state(tp).authImports).toBeUndefined();
    await expect(planImport({ archive: out, ...target(), apply: true, tiers: ["credentials"], passphrase: noPass() })).rejects.toThrow(/passphrase is needed/);
  });

  it("failed auth import: temp file still deleted, mode 0600, output and log contain no secret", async () => {
    const { out } = await exportCreds();
    const tp = fake.use({ sessions: [], auth: [], failAuthImport: `rejected ${KEY1} and ${KEY2}\nsecond line ${KEY1}` }, "target");
    const before = tmpLeftovers();
    const tgt = target();
    const lines: string[] = [];
    process.env.OPENCODE_PORTABLE_PASSPHRASE = PASS;
    try {
      const code = await main(["import", out, "--apply", "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home], (s) => lines.push(s));
      expect(code).toBe(1);
    } finally {
      delete process.env.OPENCODE_PORTABLE_PASSPHRASE;
    }
    const st = fake.state(tp);
    if (!IS_WIN) expect(st.authImports![0].mode).toBe(0o600);
    expect(existsSync(st.authImports![0].file)).toBe(false);
    expect(tmpLeftovers()).toEqual(before);
    const text = lines.join("\n");
    expect(text).toMatch(/Credentials NOT imported/);
    const log = readFileSync(join(tgt.stateDir, "opencode-portable.log"), "utf8");
    expect(log).toContain("exit code 1");
    expect(log).toContain("***");
    for (const s of [KEY1, KEY2, "second line"]) {
      expect(text).not.toContain(s);
      expect(log).not.toContain(s);
    }
  });

  it("large credentials (about 5 MB) reach opencode byte for byte through export, archive and import", async () => {
    const big = [
      { id: "cred_big", integrationID: "x", label: "Big", active: true, value: { type: "api", key: "K".repeat(2_600_000) + "é€😀" } },
      { id: "cred_big2", integrationID: "y", label: "Big2", active: true, value: { type: "api", key: "Z".repeat(2_600_000) } },
    ];
    const { out } = await exportCreds({ keepSecrets: false }, big);
    const tp = fake.use({ sessions: [], auth: [] }, "target");
    const plan = await planImport({ archive: out, ...target(), apply: true, passphrase: staticPass() });
    const res = await applyCredentialsPlan(plan);
    expect(res).toEqual({ imported: 2, skipped: 0 });
    const got = fake.state(tp).authImports![0].content;
    expect(got.length).toBe(JSON.stringify(big).length);
    expect(got).toBe(JSON.stringify(big));
  }, 60_000);
});
