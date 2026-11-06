import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ArchiveBuilder, FORMAT_VERSION, type ArchiveEntry, type Manifest } from "./archive.js";
import { describeFinding, scanFile, type SecretFinding } from "./scan.js";
import { opencodeBin, runOpencode, spawnSpec } from "./opencode.js";
import { authLabels, BUNDLE_NAME, encryptBundle, validateAuthArray, type BundlePayload } from "./secrets.js";
import { exportSessionsInto } from "./sessions.js";
import { logError, resolveDirs, toolVersion, UserError, type DirOptions, type Tier } from "./common.js";
import { extractServers, type McpLayout, type McpServer, parseJsonc, redactMcp, stripMcpBlock } from "./mcp.js";

export const MAIN_CONFIG_NAMES = ["opencode.jsonc", "opencode.json"];
const CONFIG_FILES = ["tui.json", "AGENTS.md", "package.json"];
const CONFIG_DIRS = ["command", "commands", "skill", "skills", "agent", "agents", "plugin", "plugins"];
export const STATE_FILES = ["kv.json", "model.json", "prompt-history.jsonl"];

const EXCLUDED_NAME = /^(node_modules|\.git|\.DS_Store|service\.json)$|\.bak([-.].*)?$|\.incoming$/;

export interface ExportOptions extends DirOptions {
  tiers: Tier[];
  out: string;
  keepSecrets?: boolean;
  /** Passphrase for the credentials bundle, or a function that asks for it only when a bundle is needed. */
  passphrase?: string | (() => Promise<string>);
  /** Fail (UserError, no archive kept) when the scanner finds likely inline secrets in config files. */
  failOnSecrets?: boolean;
  since?: string;
  projects?: string[];
  maxSessions?: number;
  sanitizeSessions?: boolean;
  log?: (s: string) => void;
  /** Path of the opencode binary, or null to skip version detection. */
  opencodeBin?: string | null;
}

export interface ExportResult {
  out: string;
  manifest: Manifest;
  warnings: string[];
}

function detectOpencodeVersion(bin: string | null | undefined): string | null {
  if (bin === null) return null;
  try {
    const spec = spawnSpec(bin ?? opencodeBin(), ["--version"]);
    const v = execFileSync(spec.command, spec.args, { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: spec.shell, windowsHide: true });
    return v.trim() || null;
  } catch {
    return null;
  }
}

function walk(
  absDir: string,
  relDir: string,
  prefix: string,
  tier: Tier,
  entries: ArchiveEntry[],
  links: Manifest["links"],
  warnings: string[],
  ancestors: string[],
): void {
  let real: string;
  try {
    real = realpathSync(absDir);
  } catch {
    warnings.push(`Skipped unreadable directory: ${absDir}`);
    return;
  }
  if (ancestors.includes(real)) {
    warnings.push(`Skipped circular symlink: ${absDir}`);
    return;
  }
  for (const d of readdirSync(absDir, { withFileTypes: true })) {
    if (EXCLUDED_NAME.test(d.name)) continue;
    const abs = join(absDir, d.name);
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      warnings.push(`Skipped broken symlink: ${abs}`);
      continue;
    }
    if (lstatSync(abs).isSymbolicLink()) links.push({ path: `${prefix}/${rel}`, target: readlinkSync(abs) });
    if (st.isDirectory()) walk(abs, rel, prefix, tier, entries, links, warnings, [...ancestors, real]);
    else if (st.isFile()) entries.push({ path: `${prefix}/${rel}`, tier, data: readFileSync(abs) });
  }
}

export function findMainConfig(configDir: string): string | null {
  for (const n of MAIN_CONFIG_NAMES) if (existsSync(join(configDir, n))) return n;
  return null;
}

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  if (opts.keepSecrets) {
    if (!opts.tiers.includes("credentials")) {
      throw new UserError("--keep-secrets stores MCP secret values in the encrypted bundle, so it needs the credentials tier. Add it, for example: --tiers config,mcp,credentials");
    }
    if (!opts.tiers.includes("mcp")) throw new UserError("--keep-secrets applies to MCP servers. Add mcp to --tiers.");
  }
  const dirs = resolveDirs(opts);
  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  const links: Manifest["links"] = [];
  let mcpInfo: Manifest["mcp"];
  let mcpLayout: McpLayout | undefined;
  let mcpSecrets: Record<string, string> = {};

  const mainName = findMainConfig(dirs.configDir);
  let mainText: string | null = null;
  if (mainName) mainText = readFileSync(join(dirs.configDir, mainName), "utf8");

  if (opts.tiers.includes("config")) {
    if (!existsSync(dirs.configDir)) throw new UserError(`Config directory not found: ${dirs.configDir}`);
    if (mainName && mainText !== null) {
      parseJsonc(mainText, mainName);
      entries.push({ path: `config/${mainName}`, tier: "config", data: Buffer.from(stripMcpBlock(mainText), "utf8") });
    }
    for (const f of CONFIG_FILES) {
      const abs = join(dirs.configDir, f);
      if (existsSync(abs) && statSync(abs).isFile()) entries.push({ path: `config/${f}`, tier: "config", data: readFileSync(abs) });
    }
    for (const d of CONFIG_DIRS) {
      const abs = join(dirs.configDir, d);
      if (!existsSync(abs)) continue;
      if (lstatSync(abs).isSymbolicLink()) links.push({ path: `config/${d}`, target: readlinkSync(abs) });
      if (statSync(abs).isDirectory()) walk(abs, d, "config", "config", entries, links, warnings, []);
    }
  }

  if (opts.tiers.includes("mcp")) {
    if (mainText === null) throw new UserError(`No opencode.jsonc found in ${dirs.configDir}, so there are no MCP servers to export.`);
    const cfg = parseJsonc(mainText, mainName!);
    if (cfg !== undefined && cfg !== null && typeof cfg.mcp !== "undefined" && (typeof cfg.mcp !== "object" || cfg.mcp === null || Array.isArray(cfg.mcp))) {
      throw new UserError("The mcp block in opencode.jsonc is not an object.");
    }
    const { layout, servers } = extractServers(cfg);
    mcpLayout = layout ?? "legacy";
    const { mcp: redacted, redactions, secrets } = redactMcp(servers);
    if (opts.keepSecrets) mcpSecrets = secrets;
    entries.push({ path: "mcp/mcp.json", tier: "mcp", data: Buffer.from(JSON.stringify(redacted, null, 2), "utf8") });
    mcpInfo = {
      servers: Object.entries(redacted).map(([name, s]) => ({
        name,
        type: String((s as McpServer)?.type ?? (Array.isArray((s as McpServer)?.command) ? "local" : "remote")),
      })),
      redactions,
    };
  }

  if (opts.tiers.includes("state")) {
    for (const f of STATE_FILES) {
      const abs = join(dirs.stateDir, f);
      if (existsSync(abs) && statSync(abs).isFile()) entries.push({ path: `state/${f}`, tier: "state", data: readFileSync(abs) });
    }
  }

  const findings: SecretFinding[] = entries.flatMap((e) => (e.tier === "config" ? scanFile(e.path, e.data) : []));
  for (const f of findings) warnings.push(`Possible inline secret: ${describeFinding(f)}`);
  if (opts.failOnSecrets && findings.length > 0) {
    throw new UserError(`${findings.length} possible inline secret(s) found in config files (see the notes above; values are never printed). Move them to environment variables with {env:NAME}, or run without --fail-on-secrets.\n${findings.map((f) => `  - ${describeFinding(f)}`).join("\n")}`);
  }
  const builder = new ArchiveBuilder();
  try {
    for (const e of entries) builder.add(e.path, e.tier, e.data);
    let sessionInfo: Manifest["sessions"];
    if (opts.tiers.includes("sessions")) {
      opts.log?.("Note: session transcripts may contain secrets (API keys pasted in chats, file contents, command output). Keep the archive private.");
      const r = await exportSessionsInto(builder, {
        since: opts.since,
        projects: opts.projects,
        maxSessions: opts.maxSessions,
        sanitize: opts.sanitizeSessions,
        log: opts.log,
        stateDir: dirs.stateDir,
      });
      warnings.push(...r.warnings);
      sessionInfo = { count: r.count, sanitized: !!opts.sanitizeSessions };
    }
    let credentialsInfo: Manifest["credentials"];
    if (opts.tiers.includes("credentials")) {
      const r = await runOpencode(["auth", "export"], 60_000);
      if (r.missing) throw new UserError(`The "${opencodeBin()}" program was not found. Install OpenCode or set OPENCODE_BIN to its path.`);
      if (r.code !== 0) {
        logError(dirs.stateDir, `auth export failed (exit code ${r.code})`);
        throw new UserError("Could not read credentials from OpenCode. Make sure OpenCode is installed and its background service is running.");
      }
      let auth: unknown[];
      try {
        auth = validateAuthArray(JSON.parse(r.stdout));
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UserError("OpenCode returned credentials in an unexpected format.");
      }
      const nMcp = Object.keys(mcpSecrets).length;
      if (auth.length === 0 && nMcp === 0) {
        warnings.push("No stored credentials were found, so no credentials bundle was created.");
      } else {
        if (!opts.passphrase) throw new UserError("A passphrase is needed to encrypt the credentials.");
        const pass = typeof opts.passphrase === "function" ? await opts.passphrase() : opts.passphrase;
        const payload: BundlePayload = { auth, mcpSecrets };
        opts.log?.("Encrypting credentials (this takes a moment)...");
        builder.add(BUNDLE_NAME, "credentials", await encryptBundle(payload, pass));
        credentialsInfo = { bundle: BUNDLE_NAME, kdf: "scrypt-N131072-r8-p1/aes-256-gcm" };
        if (auth.length > 0) opts.log?.(`Credentials: ${auth.length} integration(s): ${authLabels(auth).join(", ")}`);
        if (nMcp > 0) opts.log?.(`MCP secrets kept in the encrypted bundle: ${nMcp}`);
        warnings.push("Remote MCP OAuth tokens are not transferred. On the new machine run: opencode mcp auth <name>");
      }
    }
    const out = resolve(opts.out);
    opts.log?.(`Writing archive (${(builder.totalBytes / 1048576).toFixed(1)} MB before compression)...`);
    const manifest = await builder.finish(out, {
      formatVersion: FORMAT_VERSION,
      toolVersion: toolVersion(),
      createdAt: new Date().toISOString(),
      sourceOs: process.platform,
      sourceHome: dirs.home,
      sourceOpencodeVersion: detectOpencodeVersion(opts.opencodeBin),
      tiers: opts.tiers,
      links,
      ...(mcpInfo ? { mcp: mcpInfo, mcpLayout } : {}),
      ...(sessionInfo ? { sessions: sessionInfo } : {}),
      ...(credentialsInfo ? { credentials: credentialsInfo } : {}),
      ...(findings.length ? { inlineSecrets: findings } : {}),
    });
    return { out, manifest, warnings };
  } finally {
    builder.dispose();
  }
}
