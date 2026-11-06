import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readArchive, writeArchive } from "../src/archive.js";
import { main } from "../src/cli.js";
import { runExport } from "../src/export.js";
import { applyPlan, planImport } from "../src/import.js";
import { parseJsonc } from "../src/mcp.js";
import type { Tier } from "../src/common.js";
import { makeSource, SECRETS, tmp, write } from "./helpers.js";

async function exportAll(src: ReturnType<typeof makeSource>, tiers: Tier[] = ["config", "mcp", "state"]) {
  const out = join(tmp(), "a.ocm");
  const res = await runExport({
    configDir: src.configDir, stateDir: src.stateDir, home: src.home,
    tiers: [...tiers], out, opencodeBin: null,
  });
  return { out, res };
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(join(dir, d.name), base) : [join(dir, d.name).slice(base.length)],
  ).sort();
}

describe("export", () => {
  it("includes the right files and excludes the wrong ones", async () => {
    const src = makeSource();
    const { res } = await exportAll(src);
    const paths = res.manifest.files.map((f) => f.path);
    expect(paths).toContain("config/opencode.jsonc");
    expect(paths).toContain("config/skills/s1/SKILL.md");
    expect(paths).toContain("config/command/a.md");
    expect(paths).toContain("config/plugins/p.js");
    expect(paths).toContain("state/kv.json");
    expect(paths).toContain("mcp/mcp.json");
    for (const bad of ["service.json", "node_modules", ".bak", "session.json", "locks", "plugin-meta"]) {
      expect(paths.some((p) => p.includes(bad))).toBe(false);
    }
    if (src.symlinked) expect(res.manifest.links.map((l) => l.path)).toContain("config/skills");
  });

  it("config tier strips the mcp block", async () => {
    const { out } = await exportAll(makeSource());
    const { files } = await readArchive(out);
    const cfg = files.get("config/opencode.jsonc")!.toString();
    expect(cfg).not.toContain("postgres");
    expect(cfg).toContain("// my provider settings");
  });

  it("never puts secret values in the archive (raw tar bytes)", async () => {
    const { out } = await exportAll(makeSource());
    const gz = readFileSync(out);
    const raw = gunzipSync(gz);
    for (const s of SECRETS) {
      expect(raw.includes(Buffer.from(s))).toBe(false);
      expect(gz.includes(Buffer.from(s))).toBe(false);
    }
    const { manifest, files } = await readArchive(out);
    const mcp = files.get("mcp/mcp.json")!.toString();
    expect(mcp).toContain("{env:GITHUB_TOKEN}");
    expect(mcp).toContain("Bearer {env:REMOTE1_AUTHORIZATION}");
    expect(mcp).toContain("admin:{env:");
    expect(mcp).toContain("debug");
    expect(manifest.mcp!.redactions.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(manifest)).not.toContain("s3cr3t");
  });

  it("--keep-secrets without the credentials tier is rejected", async () => {
    const src = makeSource();
    const lines: string[] = [];
    const code = await main(["export", "--keep-secrets", "--config-dir", src.configDir, "--state-dir", src.stateDir], (s) => lines.push(s));
    expect(code).not.toBe(0);
    expect(lines.join("\n")).toContain("needs the credentials tier");
  });
});

describe("import", () => {
  it("round-trips into empty dirs and is idempotent", async () => {
    const src = makeSource();
    const { out } = await exportAll(src);
    const tgt = { configDir: join(tmp(), "c"), stateDir: join(tmp(), "s"), home: "/Users/zjc" };
    const plan = await planImport({ archive: out, ...tgt });
    applyPlan(plan);

    expect(readFileSync(join(tgt.configDir, "AGENTS.md"), "utf8")).toBe("# rules\n");
    expect(readFileSync(join(tgt.configDir, "skills/s1/SKILL.md"), "utf8")).toBe("skill one");
    expect(readFileSync(join(tgt.stateDir, "kv.json"), "utf8")).toBe('{"a":1}');
    expect(existsSync(join(tgt.configDir, "service.json"))).toBe(false);
    const cfg = parseJsonc(readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8"), "cfg");
    expect(Object.keys(cfg.mcp).sort()).toEqual(["dburl", "github", "postgres", "remote1"]);
    expect(cfg.model).toBe("anthropic/claude");
    // home swap applied to command args, URL untouched
    expect(cfg.mcp.github.command[1]).toBe("/Users/zjc/tools/gh.js");
    expect(cfg.mcp.remote1.url).toBe("https://example.com/mcp");
    expect(plan.missingSecrets).toContain("GITHUB_TOKEN");

    const again = await planImport({ archive: out, ...tgt });
    expect(again.files.every((f) => f.kind === "skip")).toBe(true);
    expect(again.mcp.every((m) => m.kind === "unchanged")).toBe(true);
    expect(applyPlan(again).written).toEqual([]);
  });

  it("dry run writes nothing", async () => {
    const src = makeSource();
    const { out } = await exportAll(src);
    const root = tmp();
    const tgt = { configDir: join(root, "c"), stateDir: join(root, "s"), home: "/Users/zjc" };
    const lines: string[] = [];
    const code = await main(["import", out, "--config-dir", tgt.configDir, "--state-dir", tgt.stateDir, "--home", tgt.home], (s) => lines.push(s));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Dry run only");
    expect(listFiles(root)).toEqual([]);
  });

  it("merges MCP while keeping comments, never overwrites silently, backs up", async () => {
    const src = makeSource();
    const { out } = await exportAll(src, ["mcp"]);
    const root = tmp();
    const tgt = { configDir: join(root, "c"), stateDir: join(root, "s"), home: "/home/zjc" };
    const existing = `{
  // target comment
  "theme": "dark", /* inline */
  "mcp": {
    // my own server
    "postgres": { "type": "local", "command": ["psql-mcp"], "environment": { "PGPASSWORD": "local-secret-1" } }
  }
}
`;
    write(join(tgt.configDir, "opencode.jsonc"), existing);

    let plan = await planImport({ archive: out, ...tgt });
    const pg = plan.mcp.find((m) => m.name === "postgres")!;
    expect(pg.kind).toBe("conflict");
    expect(pg.diffs.length).toBeGreaterThan(0);
    expect(JSON.stringify(pg.diffs)).not.toContain("local-secret-1");
    const res = applyPlan(plan);
    expect(res.backups.length).toBe(1);
    expect(existsSync(res.backups[0])).toBe(true);
    expect(readFileSync(res.backups[0], "utf8")).toBe(existing);

    const text = readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8");
    for (const c of ["// target comment", "/* inline */", "// my own server"]) expect(text).toContain(c);
    const cfg = parseJsonc(text, "cfg");
    expect(cfg.mcp.postgres.command).toEqual(["psql-mcp"]);
    expect(cfg.mcp.github).toBeDefined();

    plan = await planImport({ archive: out, ...tgt, overwriteMcp: ["postgres"] });
    expect(plan.mcp.find((m) => m.name === "postgres")!.kind).toBe("overwrite");
    applyPlan(plan);
    const cfg2 = parseJsonc(readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8"), "cfg");
    expect(cfg2.mcp.postgres.command[0]).toBe("npx");
  });

  it("--import-mcp-disabled adds servers disabled and stays idempotent", async () => {
    const { out } = await exportAll(makeSource(), ["mcp"]);
    const root = tmp();
    const tgt = { configDir: join(root, "c"), stateDir: join(root, "s"), home: "/home/zjc", importMcpDisabled: true };
    applyPlan(await planImport({ archive: out, ...tgt }));
    const cfg = parseJsonc(readFileSync(join(tgt.configDir, "opencode.jsonc"), "utf8"), "cfg");
    expect(cfg.mcp.postgres.enabled).toBe(false);
    const again = await planImport({ archive: out, ...tgt });
    expect(again.mcp.every((m) => m.kind === "unchanged")).toBe(true);
  });

  it("writes .incoming for differing config files unless --overwrite-config", async () => {
    const { out } = await exportAll(makeSource(), ["config"]);
    const root = tmp();
    const tgt = { configDir: join(root, "c"), stateDir: join(root, "s"), home: "/home/zjc" };
    write(join(tgt.configDir, "AGENTS.md"), "local rules\n");
    applyPlan(await planImport({ archive: out, ...tgt }));
    expect(readFileSync(join(tgt.configDir, "AGENTS.md"), "utf8")).toBe("local rules\n");
    expect(readFileSync(join(tgt.configDir, "AGENTS.md.incoming"), "utf8")).toBe("# rules\n");

    const res = applyPlan(await planImport({ archive: out, ...tgt, overwriteConfig: true }));
    expect(readFileSync(join(tgt.configDir, "AGENTS.md"), "utf8")).toBe("# rules\n");
    expect(res.backups.some((b) => b.includes("AGENTS.md.bak-"))).toBe(true);
  });

  it("reports command readiness", async () => {
    const { out } = await exportAll(makeSource(), ["mcp"]);
    const root = tmp();
    const plan = await planImport({
      archive: out, configDir: join(root, "c"), stateDir: join(root, "s"), home: "/nonexistent-home",
      env: { PATH: "" },
    });
    const gh = plan.mcp.find((m) => m.name === "github")!;
    expect(gh.readiness.status).toBe("needs install");
    expect(plan.mcp.find((m) => m.name === "remote1")!.readiness.status).toBe("remote");
  });

  it("rejects a corrupted archive with a plain message", async () => {
    const out = join(tmp(), "bad.ocm");
    await writeArchive(
      out,
      { formatVersion: 1, toolVersion: "x", createdAt: "", sourceOs: "linux", sourceHome: "/h", sourceOpencodeVersion: null,
        tiers: ["config"], links: [], files: [{ path: "config/AGENTS.md", tier: "config", sha256: "0".repeat(64), size: 1 }] },
      [{ path: "config/AGENTS.md", tier: "config", data: Buffer.from("x") }],
    );
    await expect(planImport({ archive: out, configDir: tmp(), stateDir: tmp() })).rejects.toThrow(/Checksum mismatch/);
    const lines: string[] = [];
    const code = await main(["inspect", out], (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join("\n")).not.toMatch(/at .*\(.*:\d+/);
    writeFileSync(join(tmp(), "x"), "");
  });
});
