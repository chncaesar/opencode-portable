import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readArchive } from "../src/archive.js";
import { runExport } from "../src/export.js";
import { applyPlan, planImport } from "../src/import.js";
import { detectMcpLayout, parseJsonc } from "../src/mcp.js";
import { tmp, write } from "./helpers.js";

const LEGACY = `{
  // legacy src
  "mcp": {
    // first server
    "alpha": { "type": "local", "command": ["node", "/home/zjc/a.js"], "environment": { "API_TOKEN": "tok-legacy-1" }, "enabled": false },
    "beta": { "type": "remote", "url": "https://x.example/mcp", "enabled": true }
  }
}
`;
const V2 = `{
  // v2 src
  "mcp": {
    "timeout": { "startup": 5000 },
    "servers": {
      // first server
      "alpha": { "type": "local", "command": ["node", "/home/zjc/a.js"], "environment": { "API_TOKEN": "tok-v2-1" }, "disabled": true },
      "beta": { "type": "remote", "url": "https://x.example/mcp" }
    }
  }
}
`;

async function transfer(srcText: string, tgtText: string | null, extra: Record<string, unknown> = {}) {
  const root = tmp();
  write(join(root, "src", "opencode.jsonc"), srcText);
  const out = join(root, "a.ocm");
  const res = await runExport({ configDir: join(root, "src"), stateDir: join(root, "ss"), home: "/home/zjc", tiers: ["config", "mcp"], out, opencodeBin: null });
  const tgtDir = join(root, "tgt");
  if (tgtText !== null) write(join(tgtDir, "opencode.jsonc"), tgtText);
  const plan = await planImport({ archive: out, configDir: tgtDir, stateDir: join(root, "ts"), home: "/Users/z", ...extra });
  applyPlan(plan);
  const text = readFileSync(join(tgtDir, "opencode.jsonc"), "utf8");
  return { text, cfg: parseJsonc(text, "t"), res, out, plan, tgtDir, root };
}

describe("MCP layouts", () => {
  it("detects layouts, including a legacy server literally named servers", () => {
    expect(detectMcpLayout(parseJsonc(LEGACY, "x"))).toBe("legacy");
    expect(detectMcpLayout(parseJsonc(V2, "x"))).toBe("v2");
    expect(detectMcpLayout({ mcp: { servers: { type: "local", command: ["x"] } } })).toBe("legacy");
    expect(detectMcpLayout({ mcp: { servers: {} } })).toBe("v2");
    expect(detectMcpLayout({ mcp: { timeout: { startup: 1 } } })).toBeNull();
    expect(detectMcpLayout({})).toBeNull();
  });

  it("legacy -> legacy keeps layout, paths rewritten, comments kept", async () => {
    const r = await transfer(LEGACY, '{\n  // mine\n  "mcp": { "other": { "type": "local", "command": ["x"] } }\n}\n');
    expect(r.res.manifest.mcpLayout).toBe("legacy");
    expect(r.cfg.mcp.alpha.enabled).toBe(false);
    expect(r.cfg.mcp.alpha.command[1]).toBe("/Users/z/a.js");
    expect(r.cfg.mcp.alpha.environment.API_TOKEN).toBe("{env:API_TOKEN}");
    expect(r.cfg.mcp.beta.type).toBe("remote");
    expect(r.cfg.mcp.servers).toBeUndefined();
    expect(r.text).toContain("// mine");
  });

  it("v2 -> v2 keeps layout, mcp.timeout and comments", async () => {
    const r = await transfer(V2, '{\n  // mine\n  "mcp": { "servers": { "other": { "type": "local", "command": ["x"] } } }\n}\n');
    expect(r.res.manifest.mcpLayout).toBe("v2");
    expect(r.cfg.mcp.servers.alpha.disabled).toBe(true);
    expect(r.cfg.mcp.servers.alpha.enabled).toBeUndefined();
    expect(r.cfg.mcp.servers.beta.disabled).toBeUndefined();
    expect(r.cfg.mcp.alpha).toBeUndefined();
    expect(r.text).toContain("// mine");
  });

  it("v2 archive into an empty target keeps mcp.timeout from the config tier", async () => {
    const r = await transfer(V2, null);
    expect(r.cfg.mcp.timeout.startup).toBe(5000);
    expect(r.cfg.mcp.servers.alpha.disabled).toBe(true);
    expect(r.text).toContain("// v2 src");
  });

  it("legacy -> v2 converts enabled to disabled", async () => {
    const r = await transfer(LEGACY, '{\n  // mine\n  "mcp": { "servers": { "other": { "type": "local", "command": ["x"] } } }\n}\n');
    expect(r.cfg.mcp.servers.alpha.disabled).toBe(true);
    expect(r.cfg.mcp.servers.alpha.enabled).toBeUndefined();
    expect(r.cfg.mcp.servers.beta.enabled).toBeUndefined();
    expect(r.cfg.mcp.servers.beta.disabled).toBeUndefined();
    expect(r.cfg.mcp.alpha).toBeUndefined();
    expect(r.text).toContain("// mine");
    // idempotent across layouts
    const again = await planImport({ archive: r.out, configDir: r.tgtDir, stateDir: join(r.root, "ts"), home: "/Users/z" });
    expect(again.mcp.filter((m) => m.name !== "other").every((m) => m.kind === "unchanged")).toBe(true);
  });

  it("v2 -> legacy converts disabled to enabled:false", async () => {
    const r = await transfer(V2, '{\n  // mine\n  "mcp": { "other": { "type": "local", "command": ["x"] } }\n}\n');
    expect(r.cfg.mcp.alpha.enabled).toBe(false);
    expect(r.cfg.mcp.alpha.disabled).toBeUndefined();
    expect(r.cfg.mcp.servers).toBeUndefined();
    expect(r.text).toContain("// mine");
  });

  it("empty target uses the archive's layout (legacy and v2)", async () => {
    expect((await transfer(LEGACY, null)).cfg.mcp.alpha).toBeDefined();
    expect((await transfer(V2, null)).cfg.mcp.servers.alpha).toBeDefined();
  });

  it("a legacy server named \"servers\" is exported and imported as a server", async () => {
    const src = '{ "mcp": { "servers": { "type": "local", "command": ["node", "s.js"], "environment": { "DB_PASSWORD": "pw-named-servers" } } } }';
    const r = await transfer(src, null);
    expect(r.res.manifest.mcpLayout).toBe("legacy");
    expect(r.res.manifest.mcp!.servers.map((s) => s.name)).toEqual(["servers"]);
    expect(r.cfg.mcp.servers.type).toBe("local");
    expect(r.cfg.mcp.servers.environment.DB_PASSWORD).toBe("{env:DB_PASSWORD}");
    const { files } = await readArchive(r.out);
    expect(files.get("mcp/mcp.json")!.toString()).not.toContain("pw-named-servers");
  });

  it("secrets are redacted and conflicts diffed in v2 layout", async () => {
    const r = await transfer(V2, null);
    expect(r.res.manifest.mcp!.redactions.map((x) => x.name)).toContain("API_TOKEN");
    const { files } = await readArchive(r.out);
    expect(files.get("mcp/mcp.json")!.toString()).not.toContain("tok-v2-1");
    const t2 = join(r.root, "t2");
    write(join(t2, "opencode.jsonc"), '{ "mcp": { "servers": { "alpha": { "type": "local", "command": ["other"] } } } }');
    const plan = await planImport({ archive: r.out, configDir: t2, stateDir: join(r.root, "s2"), home: "/Users/z" });
    const alpha = plan.mcp.find((m) => m.name === "alpha")!;
    expect(alpha.kind).toBe("conflict");
    expect(alpha.diffs.some((d) => d.field.startsWith("command"))).toBe(true);
  });

  it("--import-mcp-disabled works for both layouts", async () => {
    const a = await transfer(LEGACY, '{ "mcp": { "o": { "type": "local", "command": ["x"] } } }', { importMcpDisabled: true });
    expect(a.cfg.mcp.beta.enabled).toBe(false);
    const b = await transfer(LEGACY, '{ "mcp": { "servers": { "o": { "type": "local", "command": ["x"] } } } }', { importMcpDisabled: true });
    expect(b.cfg.mcp.servers.beta.disabled).toBe(true);
  });
});
