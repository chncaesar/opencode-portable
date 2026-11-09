#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { logError, parseTiers, resolveDirs, toolVersion, UserError } from "./common.js";
import { runExport } from "./export.js";
import { MIN_PASSPHRASE_LENGTH } from "./secrets.js";
import { makePassphraseProvider } from "./passphrase.js";
import { applyCredentialsPlan, applyPlan, applySessionsPlan, disposePlan, formatPlan, planImport } from "./import.js";
import { inspectArchive } from "./inspect.js";

const HELP = `opencode-portable ${toolVersion()}

Usage:
  opencode-portable export  [--tiers config,mcp,state] [--out FILE]
  opencode-portable inspect ARCHIVE
  opencode-portable import  ARCHIVE [--apply] [--tiers ...] [--map SRC=DST]...

Options:
  --tiers LIST            Tiers to include: config, mcp, state, sessions, credentials (export default: config,mcp)
  --out FILE              Archive path for export (default: ./opencode-export-<time>.ocm)
  --apply                 Import only: write changes (default is a dry run)
  --map SRC=DST           Path rule, repeatable. Longest whole-segment prefix wins.
  --import-mcp-disabled   Import new MCP servers with enabled=false
  --overwrite-mcp NAME    Replace an existing MCP server with the archived one (repeatable)
  --overwrite-config      Overwrite differing files instead of writing NAME.incoming
  --since WHEN            Export sessions: only those updated since 30d / 90d / 2026-01-01
  --project PATH_OR_ID    Export sessions: only this project (repeatable)
  --max-sessions N        Export sessions: newest N only
  --sanitize-sessions     Export sessions: pass --sanitize to "opencode session export"
  --scan-root DIR         Import sessions: where to look for git clones (repeatable;
                          default: home, /work, ~/code, ~/Projects, ~/src when present)
  --import-detached-to DIR  Import sessions of projects with no local match under DIR
  --session-timeout SEC   Import sessions: time limit per session (default 120)
  --keep-secrets          Export: also store MCP secret values in the encrypted bundle
                          (needs the credentials tier and mcp)
  --fail-on-secrets       Export: exit 1 if a plugin script holds an inline secret that
                          cannot be redacted
  --restore-secrets       Import with --apply: write real MCP and config secret values back
                          into the files written by this run (including NAME.incoming)
  --restore-mcp-secrets   Deprecated alias for --restore-secrets (MCP servers only)
  --passphrase-file PATH  Read the credentials passphrase from a file (chmod 600).
                          Or set OPENCODE_PORTABLE_PASSPHRASE, or type it when asked.
                          There is deliberately no --passphrase option.
  --config-dir DIR        Override the OpenCode config directory
  --state-dir DIR         Override the OpenCode state directory
  --home DIR              Override the home directory (used for default path rule)
  -v, --version           Print the version
  -h, --help              Show this help
`;

function positiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`${flag} must be a positive whole number.`);
  return n;
}

export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  let stateDirForLog: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tiers: { type: "string" },
        out: { type: "string" },
        apply: { type: "boolean" },
        map: { type: "string", multiple: true },
        "import-mcp-disabled": { type: "boolean" },
        "overwrite-mcp": { type: "string", multiple: true },
        "overwrite-config": { type: "boolean" },
        "keep-secrets": { type: "boolean" },
        "fail-on-secrets": { type: "boolean" },
        "restore-mcp-secrets": { type: "boolean" },
        "restore-secrets": { type: "boolean" },
        "passphrase-file": { type: "string" },
        passphrase: { type: "string" },
        since: { type: "string" },
        project: { type: "string", multiple: true },
        "max-sessions": { type: "string" },
        "sanitize-sessions": { type: "boolean" },
        "scan-root": { type: "string", multiple: true },
        "import-detached-to": { type: "string" },
        "session-timeout": { type: "string" },
        "config-dir": { type: "string" },
        "state-dir": { type: "string" },
        home: { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [cmd, arg] = positionals;
    if (values.version) {
      out(toolVersion());
      return 0;
    }
    if (values.help || !cmd) {
      out(HELP);
      return values.help ? 0 : 1;
    }
    const dirOpts = { configDir: values["config-dir"], stateDir: values["state-dir"], home: values.home };
    stateDirForLog = resolveDirs(dirOpts).stateDir;

    if (values.passphrase !== undefined) {
      out("There is no --passphrase option, because a passphrase on the command line is visible to other users (ps) and stays in shell history. Use --passphrase-file PATH, set OPENCODE_PORTABLE_PASSPHRASE, or type it when asked.");
      return 1;
    }
    const pp = makePassphraseProvider({ file: values["passphrase-file"], warn: (m) => out(`Warning: ${m}`) });

    if (cmd === "export") {
      const tiers = parseTiers(values.tiers, ["config", "mcp"]);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
      const sessionOnly = values.since || values.project || values["max-sessions"] || values["sanitize-sessions"];
      if (sessionOnly && !tiers.includes("sessions")) {
        throw new UserError("--since, --project, --max-sessions and --sanitize-sessions only apply when --tiers includes sessions.");
      }
      const res = await runExport({
        ...dirOpts,
        tiers,
        out: values.out ?? `opencode-export-${stamp}.ocm`,
        since: values.since,
        projects: values.project,
        maxSessions: positiveInt(values["max-sessions"], "--max-sessions"),
        sanitizeSessions: values["sanitize-sessions"],
        keepSecrets: values["keep-secrets"],
        failOnSecrets: values["fail-on-secrets"],
        passphrase: () => pp.get({ confirm: true, minLength: MIN_PASSPHRASE_LENGTH }),
        log: (s) => out(s),
      });
      out(`Wrote ${res.out}`);
      out(`  Tiers: ${res.manifest.tiers.join(", ")}; ${res.manifest.files.length} file(s)`);
      const red = res.manifest.mcp?.redactions ?? [];
      if (red.length) {
        out(`  ${red.length} secret value(s) in MCP servers were replaced with {env:NAME} markers:`);
        for (const r of red) out(`    ${r.server} ${r.location} -> {env:${r.name}}`);
        if (values["keep-secrets"]) out("  The real values are stored in the encrypted credentials bundle.");
      }
      for (const w of res.warnings) out(`  Note: ${w}`);
      return 0;
    }
    if (cmd === "inspect") {
      if (!arg) throw new UserError("Usage: opencode-portable inspect ARCHIVE");
      out(await inspectArchive(arg));
      return 0;
    }
    if (cmd === "import") {
      if (!arg) throw new UserError("Usage: opencode-portable import ARCHIVE [--apply]");
      const tiers = values.tiers ? parseTiers(values.tiers, []) : undefined;
      const plan = await planImport({
        ...dirOpts,
        archive: arg,
        tiers,
        apply: values.apply,
        maps: values.map,
        importMcpDisabled: values["import-mcp-disabled"],
        overwriteMcp: values["overwrite-mcp"],
        overwriteConfig: values["overwrite-config"],
        scanRoots: values["scan-root"],
        passphrase: pp,
        restoreMcpSecrets: values["restore-mcp-secrets"],
        restoreSecrets: values["restore-secrets"],
        importDetachedTo: values["import-detached-to"],
        sessionTimeout: positiveInt(values["session-timeout"], "--session-timeout"),
      });
      if (values.apply) {
        try {
          const res = applyPlan(plan);
          const outcome = await applySessionsPlan(plan, (s) => out(s));
          const cred = await applyCredentialsPlan(plan);
          out(formatPlan(plan, res, outcome, cred));
          return (outcome && outcome.result.failed.length > 0) || cred?.failed ? 1 : 0;
        } finally {
          disposePlan(plan);
        }
      }
      disposePlan(plan);
      out(formatPlan(plan));
      return 0;
    }
    throw new UserError(`Unknown command "${cmd}". Run with --help.`);
  } catch (err) {
    if (err instanceof UserError) {
      out(`Error: ${err.message}`);
      return 1;
    }
    if (err instanceof Error && String((err as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS")) {
      out(`Error: ${err.message.split("\n")[0]} Run with --help.`);
      return 1;
    }
    const msg = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EACCES" ? "Permission denied while reading or writing a file." : "Something went wrong.";
    const log = logError(stateDirForLog, err);
    out(`Error: ${msg} Details were written to ${log}`);
    return 1;
  }
}

function isDirect(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirect()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
