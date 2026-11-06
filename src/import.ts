import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readArchive, type Manifest } from "./archive.js";
import { logError, resolveDirs, sha256, timestamp, UserError, type DirOptions, type Tier } from "./common.js";
import { findMainConfig, MAIN_CONFIG_NAMES } from "./export.js";
import {
  checkReadiness,
  restoreMarkers,
  diffServers,
  extractServers,
  type McpLayout,
  parseJsonc,
  rewriteServerPaths,
  setMcpServer,
  stripMcpBlock,
  type FieldDiff,
  type McpServer,
  type ReadinessReport,
  type Redaction,
} from "./mcp.js";
import { listSessions, opencodeBin, runOpencode, type SessionInfo } from "./opencode.js";
import type { PassphraseProvider } from "./passphrase.js";
import { authLabels, BUNDLE_NAME, collectSecretStrings, decryptBundle, scrub, type BundlePayload } from "./secrets.js";
import { parseRule, type PathRule } from "./paths.js";
import {
  applySessions,
  defaultScanRoots,
  loadMapping,
  parseIndex,
  planSessions,
  saveMapping,
  type MappingFile,
  type SessionApplyResult,
  type SessionsPlan,
} from "./sessions.js";

export interface ImportOptions extends DirOptions {
  archive: string;
  tiers?: Tier[];
  apply?: boolean;
  maps?: string[];
  importMcpDisabled?: boolean;
  overwriteMcp?: string[];
  overwriteConfig?: boolean;
  scanRoots?: string[];
  passphrase?: PassphraseProvider;
  restoreMcpSecrets?: boolean;
  importDetachedTo?: string;
  sessionTimeout?: number;
  env?: NodeJS.ProcessEnv;
}

export type FileKind = "add" | "skip" | "incoming" | "overwrite" | "update";

export interface FileAction {
  kind: FileKind;
  tier: Tier;
  /** Absolute path that will be written (for "incoming" this is the .incoming file). */
  path: string;
  /** Intended final path (differs from `path` for "incoming"). */
  target: string;
  data?: Buffer;
  note?: string;
}

export interface McpAction {
  name: string;
  kind: "add" | "unchanged" | "conflict" | "overwrite";
  /** True when real secret values were written into this server (--restore-mcp-secrets). */
  restored?: boolean;
  diffs: FieldDiff[];
  readiness: ReadinessReport;
  missing: Redaction[];
}

export interface CredentialsPlan {
  /** An encrypted bundle is in the archive. */
  present: boolean;
  bundleBytes: number;
  /** Decrypted contents are in memory (never printed). */
  payload?: BundlePayload;
  labels: string[];
  mcpSecretNames: string[];
  /** Why credentials will not be imported in this run, if so. */
  skippedReason?: string;
  restoreRequested: boolean;
}

export interface Plan {
  manifest: Manifest;
  tiers: Tier[];
  configDir: string;
  stateDir: string;
  rules: PathRule[];
  files: FileAction[];
  mcp: McpAction[];
  /** Placeholder names that need a real value on this machine. */
  missingSecrets: string[];
  warnings: string[];
  sessions?: SessionsPlan;
  credentials?: CredentialsPlan;
  /** Session files extracted to disk (apply only). */
  extracted: Map<string, string>;
  extractDir?: string;
  archive: string;
  previousMapping: MappingFile["projects"];
  sessionTimeout: number;
}

export interface ApplyResult {
  written: string[];
  backups: string[];
}

function decide(target: string, tier: Tier, data: Buffer, overwrite: boolean, same: (existing: Buffer) => boolean): FileAction {
  if (!existsSync(target)) return { kind: "add", tier, path: target, target, data };
  if (same(readFileSync(target))) return { kind: "skip", tier, path: target, target, note: "identical" };
  if (overwrite) return { kind: "overwrite", tier, path: target, target, data };
  return { kind: "incoming", tier, path: target + ".incoming", target, data, note: "differs; review and merge by hand" };
}

export async function planImport(opts: ImportOptions): Promise<Plan> {
  const dirs = resolveDirs(opts);
  const warnings: string[] = [];

  // Peek at the manifest through a full verified read; session bodies are only written to disk on --apply.
  const wantsSessions = (opts.tiers ?? null)?.includes("sessions") ?? true;
  let extractDir = opts.apply && wantsSessions ? mkdtempSync(join(tmpdir(), "ocm-sessions-")) : undefined;
  let loaded;
  try {
    loaded = await readArchive(opts.archive, { extractDir });
  } catch (e) {
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
    throw e;
  }
  const { manifest, files, extracted } = loaded;
  if (extractDir && extracted.size === 0) {
    rmSync(extractDir, { recursive: true, force: true });
    extractDir = undefined;
  }

  const tiers = opts.tiers ?? manifest.tiers;
  for (const t of tiers) {
    if (!manifest.tiers.includes(t)) throw new UserError(`The archive does not contain the "${t}" tier (it has: ${manifest.tiers.join(", ")}).`);
  }

  let credentials: CredentialsPlan | undefined;
  const bundleFile = manifest.files.find((f) => f.path === BUNDLE_NAME);
  if (bundleFile && tiers.includes("credentials")) {
    credentials = {
      present: true,
      bundleBytes: bundleFile.size,
      labels: [],
      mcpSecretNames: [],
      restoreRequested: !!opts.restoreMcpSecrets,
    };
    const explicit = !!opts.tiers?.includes("credentials");
    const pp = opts.passphrase;
    const wantsDecrypt = opts.apply
      ? true
      : !!pp && (pp.hasStaticSource || (explicit && pp.canPrompt));
    if (wantsDecrypt) {
      try {
        if (!pp || (!pp.hasStaticSource && !pp.canPrompt)) {
          if (explicit || opts.restoreMcpSecrets) {
            throw new UserError("A passphrase is needed for the credentials bundle. Use --passphrase-file PATH or set OPENCODE_PORTABLE_PASSPHRASE.");
          }
          credentials.skippedReason = "no passphrase available; run again with --tiers credentials and --passphrase-file PATH to import them";
        } else {
          const payload = await decryptBundle(files.get(BUNDLE_NAME)!, await pp.get({}));
          credentials.payload = payload;
          credentials.labels = authLabels(payload.auth);
          credentials.mcpSecretNames = Object.keys(payload.mcpSecrets).sort();
        }
      } catch (e) {
        if (extractDir) rmSync(extractDir, { recursive: true, force: true });
        throw e;
      }
    }
  } else if (opts.restoreMcpSecrets) {
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
    throw new UserError("--restore-mcp-secrets needs a credentials bundle in the archive, and --tiers (if given) must include credentials. Export with --tiers config,mcp,credentials and --keep-secrets.");
  }
  const restoreSecrets = opts.apply && opts.restoreMcpSecrets ? credentials?.payload?.mcpSecrets : undefined;
  if (opts.restoreMcpSecrets && opts.apply && !tiers.includes("mcp")) warnings.push("--restore-mcp-secrets has no effect without the mcp tier.");

  const rules: PathRule[] = (opts.maps ?? []).map(parseRule);
  if (manifest.sourceHome && manifest.sourceHome !== dirs.home) rules.push({ src: manifest.sourceHome, dst: dirs.home });

  const actions: FileAction[] = [];
  let mainOp: FileAction | undefined;
  const sameBytes = (data: Buffer) => (b: Buffer) => sha256(b) === sha256(data);

  for (const f of manifest.files) {
    if (!tiers.includes(f.tier)) continue;
    const data = files.get(f.path)!;
    if (f.tier === "config") {
      const rel = f.path.slice("config/".length);
      const target = join(dirs.configDir, rel);
      if (MAIN_CONFIG_NAMES.includes(rel)) {
        // Compare ignoring the target's own mcp block, which is handled by the mcp tier.
        const op = decide(target, "config", data, !!opts.overwriteConfig, (b) => sha256(stripMcpBlock(b.toString("utf8"))) === sha256(data.toString("utf8")));
        actions.push(op);
        mainOp = op;
      } else {
        actions.push(decide(target, "config", data, !!opts.overwriteConfig, sameBytes(data)));
      }
    } else if (f.tier === "state") {
      const rel = f.path.slice("state/".length);
      actions.push(decide(join(dirs.stateDir, rel), "state", data, !!opts.overwriteConfig, sameBytes(data)));
    }
  }

  const mcpActions: McpAction[] = [];
  const missingSecrets = new Set<string>();

  if (tiers.includes("mcp")) {
    const raw = files.get("mcp/mcp.json");
    if (!raw) throw new UserError("The archive says it contains MCP servers but mcp/mcp.json is missing.");
    const incomingAll = JSON.parse(raw.toString("utf8")) as Record<string, McpServer>;

    // Decide which file receives the merge and what its current text is.
    let cfgPath: string;
    let baseText: string;
    if (mainOp && (mainOp.kind === "add" || mainOp.kind === "overwrite")) {
      cfgPath = mainOp.path;
      baseText = mainOp.data!.toString("utf8");
    } else {
      const existing = findMainConfig(dirs.configDir);
      cfgPath = join(dirs.configDir, existing ?? "opencode.jsonc");
      baseText = existing ? readFileSync(cfgPath, "utf8") : "{}\n";
    }
    const targetCfg = parseJsonc(baseText, "The target opencode.jsonc") ?? {};
    const { layout: targetLayout, servers: existingMcp } = extractServers(targetCfg);
    const layout: McpLayout = targetLayout ?? manifest.mcpLayout ?? "legacy";

    for (const n of opts.overwriteMcp ?? []) {
      if (!(n in incomingAll)) warnings.push(`--overwrite-mcp ${n}: the archive has no MCP server with that name.`);
    }

    let text = baseText;
    for (const [name, srv] of Object.entries(incomingAll)) {
      let incoming = rewriteServerPaths(srv, rules);
      if (opts.importMcpDisabled) incoming.enabled = false;
      let restoredNames: Set<string> | undefined;
      if (restoreSecrets) {
        const r = restoreMarkers(incoming, restoreSecrets);
        const had = (manifest.mcp?.redactions ?? []).filter((x) => x.server === name).map((x) => x.name);
        restoredNames = new Set(had.filter((n) => !r.missing.includes(n)));
        incoming = r.server;
      }
      const readiness = checkReadiness(incoming, opts.env ?? process.env);
      const current = existingMcp[name];
      const missing = (manifest.mcp?.redactions ?? []).filter((r) => r.server === name);
      let kind: McpAction["kind"];
      let diffs: FieldDiff[] = [];
      if (current === undefined) {
        kind = "add";
        text = setMcpServer(text, name, incoming, layout);
      } else {
        diffs = diffServers(name, current, incoming);
        if (diffs.length === 0) kind = "unchanged";
        else if ((opts.overwriteMcp ?? []).includes(name)) {
          kind = "overwrite";
          text = setMcpServer(text, name, incoming, layout);
        } else kind = "conflict";
      }
      const applied = kind === "add" || kind === "overwrite";
      const stillMissing = missing.filter((r) => !(applied && restoredNames?.has(r.name)));
      if (applied) for (const r of stillMissing) missingSecrets.add(r.name);
      const restored = applied && !!restoredNames && restoredNames.size > 0;
      mcpActions.push({ name, kind, diffs, readiness, missing: applied ? stillMissing : [], ...(restored ? { restored } : {}) });
    }

    if (text !== baseText) {
      if (mainOp && (mainOp.kind === "add" || mainOp.kind === "overwrite")) {
        mainOp.data = Buffer.from(text, "utf8");
      } else {
        // The config tier either skipped or wrote ".incoming"; the real file still gets the MCP update.
        actions.push({
          kind: existsSync(cfgPath) ? "update" : "add",
          tier: "mcp",
          path: cfgPath,
          target: cfgPath,
          data: Buffer.from(text, "utf8"),
          note: "MCP servers merged",
        });
      }
    }
  }

  if (tiers.includes("config") && manifest.inlineSecrets?.length) {
    warnings.push(`The archive's config files hold ${manifest.inlineSecrets.length} possible inline secret(s) in plain text: ${manifest.inlineSecrets.map((f) => `${f.file} at ${f.where}`).join("; ")}.`);
  }
  if (manifest.files.some((f) => f.path === "config/package.json") && tiers.includes("config")) {
    warnings.push("Plugins listed in package.json are not installed by this tool. Start OpenCode once or run your package manager in the config directory.");
  }
  if (manifest.sourceOs !== process.platform) {
    warnings.push(`The archive comes from ${manifest.sourceOs}; this machine is ${process.platform}. Review MCP commands in the plan.`);
  }
  if (manifest.links.length > 0) {
    warnings.push(`${manifest.links.length} symlink(s) on the source are restored as regular files/directories.`);
  }

  let sessionsPlan: SessionsPlan | undefined;
  const previousMapping = tiers.includes("sessions") ? loadMapping(opts.archive, warnings) : {};
  if (tiers.includes("sessions")) {
    const index = parseIndex(files.get("sessions/index.json"));
    let targetSessions: Map<string, SessionInfo> | null = null;
    try {
      targetSessions = new Map((await listSessions()).map((x) => [x.id, x]));
    } catch (e) {
      if (opts.apply) {
        if (extractDir) rmSync(extractDir, { recursive: true, force: true });
        throw new UserError(
          "Cannot read the sessions already on this machine, so importing could create duplicates. Start OpenCode and try again.",
        );
      }
    }
    const explicit = (opts.maps ?? []).map(parseRule);
    const homeRule = manifest.sourceHome && manifest.sourceHome !== dirs.home ? { src: manifest.sourceHome, dst: dirs.home } : undefined;
    try {
      sessionsPlan = await planSessions(index, {
        explicitRules: explicit,
        homeRule,
        mapping: previousMapping,
        scanRoots: opts.scanRoots ?? defaultScanRoots(dirs.home),
        detachedTo: opts.importDetachedTo,
        targetSessions,
      });
    } catch (e) {
      if (extractDir) rmSync(extractDir, { recursive: true, force: true });
      throw e;
    }
  }

  return {
    manifest,
    tiers,
    sessions: sessionsPlan,
    credentials,
    extracted,
    extractDir,
    archive: opts.archive,
    previousMapping,
    sessionTimeout: opts.sessionTimeout ?? 120,
    configDir: dirs.configDir,
    stateDir: dirs.stateDir,
    rules,
    files: actions,
    mcp: mcpActions,
    missingSecrets: [...missingSecrets].sort(),
    warnings,
  };
}

/** Back up each existing destination, then write. */
export function applyPlan(plan: Plan): ApplyResult {
  const ts = timestamp();
  const written: string[] = [];
  const backups: string[] = [];
  for (const a of plan.files) {
    if (a.kind === "skip" || !a.data) continue;
    mkdirSync(dirname(a.path), { recursive: true });
    if (existsSync(a.path)) {
      const bak = `${a.path}.bak-${ts}`;
      copyFileSync(a.path, bak);
      backups.push(bak);
    }
    const tmp = `${a.path}.tmp-${process.pid}`;
    writeFileSync(tmp, a.data);
    renameSync(tmp, a.path);
    written.push(a.path);
  }
  return { written, backups };
}

export interface SessionsOutcome {
  result: SessionApplyResult;
  mappingFile: string | null;
}

/** Import sessions through `opencode session import`, one at a time, then save the confirmed mapping. */
export async function applySessionsPlan(plan: Plan, log?: (s: string) => void): Promise<SessionsOutcome | undefined> {
  if (!plan.sessions) {
    disposePlan(plan);
    return undefined;
  }
  try {
    const result = await applySessions(plan.sessions, plan.extracted, { timeoutSec: plan.sessionTimeout, stateDir: plan.stateDir, log });
    const mappingFile = saveMapping(plan.archive, plan.sessions, plan.previousMapping);
    return { result, mappingFile };
  } finally {
    if (plan.extractDir) rmSync(plan.extractDir, { recursive: true, force: true });
  }
}

export interface CredentialsOutcome {
  imported: number;
  skipped: number;
  failed?: string;
}

/** Hand the decrypted credentials to `opencode auth import` through a private temp file that is always deleted. */
export async function applyCredentialsPlan(plan: Plan): Promise<CredentialsOutcome | undefined> {
  const c = plan.credentials;
  if (!c?.payload || c.payload.auth.length === 0) return undefined;
  const secrets = collectSecretStrings(c.payload.auth, Object.values(c.payload.mcpSecrets));
  const dir = mkdtempSync(join(tmpdir(), "ocm-auth-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "auth.json");
    writeFileSync(file, JSON.stringify(c.payload.auth), { mode: 0o600 });
    chmodSync(file, 0o600);
    const r = await runOpencode(["auth", "import", file], 60_000);
    if (r.code !== 0) {
      const firstLine = scrub((r.stderr || r.message).split("\n")[0] ?? "", secrets);
      logError(plan.stateDir, `auth import failed (exit code ${r.code}): ${firstLine}`);
      const why = r.missing
        ? `the "${opencodeBin()}" program was not found`
        : r.timedOut
          ? "OpenCode did not answer in time"
          : "OpenCode refused the import (details are in the log file)";
      return { imported: 0, skipped: 0, failed: why };
    }
    // The real OpenCode v2.2.5 prints this summary on stderr; read both streams.
    const text = `${r.stdout}\n${r.stderr}`;
    const imported = Number(/Imported\s+(\d+)/i.exec(text)?.[1] ?? 0);
    const skipped = Number(/skipped\s+(\d+)/i.exec(text)?.[1] ?? 0);
    return { imported, skipped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Remove temporary files of a plan that will not be applied. */
export function disposePlan(plan: Plan): void {
  if (plan.extractDir) rmSync(plan.extractDir, { recursive: true, force: true });
}

const KIND_LABEL: Record<string, string> = { add: "add", skip: "skip", conflict: "conflict", detached: "detached" };

function formatSessions(plan: Plan, outcome?: SessionsOutcome): string[] {
  const sp = plan.sessions;
  if (!sp) return [];
  const L: string[] = ["", "Sessions"];
  if (sp.repoScan) L.push(`  Scanned ${sp.repoScan.scanned} git repo(s) under: ${sp.repoScan.roots.join(", ")}`);
  for (const p of sp.projects) {
    const n = p.sessions.length;
    const target = p.targetRoot ? `${p.targetRoot}  (${p.method})` : "NOT FOUND (detached)";
    L.push(`  Project ${p.projectID.slice(0, 12)}  ${p.sourceRoot || "(unknown path)"} -> ${target}, ${n} session(s)`);
    for (const note of p.notes) L.push(`      ${note}`);
    for (const s of p.sessions) {
      const when = new Date(s.entry.time.updated).toISOString().slice(0, 10);
      const dir = s.targetDir && s.targetDir !== p.targetRoot ? `  in ${s.targetDir}` : "";
      L.push(`    ${KIND_LABEL[s.kind].padEnd(9)} ${s.entry.id}  ${when}  ${s.entry.title}${dir}  [${s.reason}]`);
    }
    if (!p.targetRoot) {
      L.push(`      Fix: add --map ${p.sourceRoot || "SOURCE_PATH"}=LOCAL_PATH, or clone the repository under a --scan-root, or use --import-detached-to DIR.`);
    }
  }
  const all = sp.projects.flatMap((p) => p.sessions);
  const count = (k: string) => all.filter((s) => s.kind === k).length;
  L.push(`  Summary: ${count("add")} to add, ${count("skip")} already present, ${count("conflict")} conflict(s), ${count("detached")} detached (skipped).`);
  for (const w of sp.warnings) L.push(`  Note: ${w}`);
  if (outcome) {
    const r = outcome.result;
    L.push("", `Sessions imported: ${r.imported.length}, skipped: ${r.skipped}, failed: ${r.failed.length}.`);
    for (const f of r.failed) L.push(`  failed ${f.id}  ${f.title}: ${f.reason}`);
    if (outcome.mappingFile) L.push(`  Mapping saved to ${outcome.mappingFile} (reused on later imports).`);
    else L.push("  Could not save the mapping file next to the archive.");
  }
  return L;
}

function formatCredentials(plan: Plan, applied: boolean, outcome?: CredentialsOutcome): string[] {
  const c = plan.credentials;
  if (!c) return [];
  const L: string[] = ["", "Credentials"];
  L.push(`  The archive contains an encrypted credentials bundle (${c.bundleBytes} bytes).`);
  if (c.skippedReason) L.push(`  Not imported: ${c.skippedReason}.`);
  else if (!c.payload) L.push("  A passphrase is needed on --apply (use --passphrase-file PATH, OPENCODE_PORTABLE_PASSPHRASE, or the prompt).");
  else {
    L.push(`  ${applied ? "In the bundle" : "Decrypted for preview"}: ${c.labels.length} integration(s): ${c.labels.join(", ") || "none"}`);
    L.push("  They are imported with `opencode auth import`. A credential that already exists on this machine is left untouched.");
    if (c.mcpSecretNames.length) {
      const willRestore = new Set(
        plan.mcp.filter((m) => m.kind === "add" || m.kind === "overwrite").flatMap((m) => (plan.manifest.mcp?.redactions ?? []).filter((r) => r.server === m.name).map((r) => r.name)),
      );
      const names = c.mcpSecretNames.map((n) => `${n}${willRestore.has(n) ? "" : " (server not imported in this run)"}`);
      L.push(`  MCP secrets in the bundle: ${names.join(", ")}`);
      L.push(
        c.restoreRequested
          ? "  --restore-mcp-secrets: real values will be written into opencode.jsonc for the servers added or replaced in this run."
          : "  They stay as {env:NAME} markers unless you pass --restore-mcp-secrets with --apply.",
      );
    }
  }
  if (applied && outcome) {
    if (outcome.failed) L.push(`  Credentials NOT imported: ${outcome.failed}.`);
    else L.push(`  Credentials imported: ${outcome.imported}, already present and left untouched: ${outcome.skipped}.`);
  }
  L.push("  Remote MCP OAuth tokens are not transferred. For each remote server run: opencode mcp auth <name>");
  return L;
}

export function formatPlan(plan: Plan, applied?: ApplyResult, outcome?: SessionsOutcome, cred?: CredentialsOutcome): string {
  const m = plan.manifest;
  const L: string[] = [];
  L.push(applied ? "Import result" : "Import plan (dry run, nothing has been written)");
  L.push(`  Source: ${m.sourceOs}, home ${m.sourceHome}, OpenCode ${m.sourceOpencodeVersion ?? "unknown"}`);
  L.push(`  Tiers:  ${plan.tiers.join(", ")}`);
  L.push(`  Config dir: ${plan.configDir}`);
  L.push(`  State dir:  ${plan.stateDir}`);
  if (plan.rules.length) L.push(`  Path rules: ${plan.rules.map((r) => `${r.src} -> ${r.dst}`).join("; ")}`);

  if (plan.files.length) {
    L.push("", "Files");
    for (const f of plan.files) {
      const label = f.kind.padEnd(9);
      L.push(`  ${label} ${f.path}${f.note ? `  (${f.note})` : ""}`);
    }
  }
  if (plan.mcp.length) {
    L.push("", "MCP servers");
    for (const s of plan.mcp) {
      L.push(`  ${s.kind.padEnd(9)} ${s.name}  [${s.readiness.status}]`);
      for (const n of s.readiness.notes) L.push(`      ${n}`);
      for (const d of s.diffs) L.push(`      ${d.field}: ${d.from} -> ${d.to}`);
      if (s.kind === "conflict") L.push(`      Already exists here. Not changed. Use --overwrite-mcp ${s.name} to replace it.`);
    }
  }
  if (plan.missingSecrets.length) {
    L.push("", "Values you must fill in (they were removed from the archive for safety)");
    for (const n of plan.missingSecrets) {
      const where = plan.mcp.flatMap((s) => s.missing.filter((r) => r.name === n).map((r) => `${r.server} ${r.location}`));
      L.push(`  ${"{env:" + n + "}"}  used by ${where.join(", ")}`);
    }
    L.push("  OpenCode expands {env:NAME} from the environment when it starts. Set each variable in your shell profile (or replace the marker in opencode.jsonc with the real value).");
  }
  L.push(...formatSessions(plan, outcome));
  L.push(...formatCredentials(plan, !!applied, cred));
  const restoredServers = plan.mcp.filter((m) => m.restored).map((m) => m.name);
  if (applied && restoredServers.length) {
    L.push("", `Real secret values were written into opencode.jsonc for: ${restoredServers.join(", ")}. They were literal values on the source machine too.`);
  }
  for (const w of plan.warnings) L.push("", `Note: ${w}`);
  if (applied) {
    L.push("", `Wrote ${applied.written.length} file(s), made ${applied.backups.length} backup(s).`);
    for (const b of applied.backups) L.push(`  backup: ${b}`);
  } else {
    L.push("", "Dry run only. Re-run with --apply to write these changes.");
  }
  return L.join("\n");
}
