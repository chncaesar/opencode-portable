# opencode-portable: Design

Working name: `opencode-portable` (rename before first release). Status: draft for discussion, nothing implemented.

## 1. Problem and positioning

OpenCode state is spread over several directories and an SQLite database. There is no supported way to move it to another machine, so users lose sessions, config, and per-project memory when they change laptops, usernames, or sandboxes.

- Upstream request: anomalyco/opencode issue #54534 ("Move all opencode state to another machine"). Related: #32696 (single-session export in desktop), #50014 (export truncation), and a community comment from a user who lost sessions after moving between Macs because absolute paths changed.
- A contributor has said in that issue that they will implement `opencode migrate export/import` inside core. This tool does not depend on that landing and does not compete for the same PR. It differentiates on things core is unlikely to do first: selective and incremental transfer, encrypted credentials, path remapping, dry-run, and cross-OS moves.
- Goal for the author: a useful public tool that sends traffic to the GitHub profile and jczhu.com. It is not meant to be merged upstream.

## 2. Verified facts about OpenCode v2.2.5 (checked on this machine)

- Data root `~/.local/share/opencode`: `opencode.db` (SQLite, WAL mode), `auth.json` (V1 credentials, still present), `storage/`, `snapshot/`, `tool-output/`, `log/`, `repos/`, `shell/`, `insights/`. Total here: 3.6 GB.
- Config root `~/.config/opencode`: `opencode.jsonc`, `tui.json`, `AGENTS.md`, `command/`, `skills/`, `plugins/`, `package.json`, plus `service.json` (contains a local service password) and `node_modules/`. Contents can include symlinks (this machine has one).
- State root `~/.local/state/opencode`: `kv.json`, `model.json`, `prompt-history.jsonl`, `session.json`, `plugin-meta.json`, `service.json`, `locks/`.
- The database holds two session generations: `session` (938 rows, V1 style) and `session_v2` (364 rows, with `session_message`). Messages and parts are large (about 47k and 172k rows). There is a `credential` table, a `permission` table, a `project` table, a `migration` table (59 applied migrations) and an `event` / `event_sequence` pair that suggests an event-sourced design.
- A project's ID is the git root commit hash (for example `e840c215...`), with `global` for non-git directories. The ID is therefore the same on every machine that has a clone of the repo. This is the key that makes cross-machine mapping possible.
- Absolute paths are stored in `project.worktree`, `project_directory.directory`, `session.directory`, `session.path`, and `worktree` rows. These are what break after a move.
- The CLI already offers `opencode session export [--sanitize]` and `opencode session import` (JSON, file or URL), per session.
- Not yet verified (see spike M0): whether `session export` covers `session_v2`; whether `session import` preserves IDs and attaches to the right project; what the `event` table is used for and whether sessions can be restored without it.

### 2.1 M0 spike findings (run 2026-11-06 on v2.2.5, isolated profile)

- `opencode session export <id>` returns JSON with two keys, `info` and `messages`. It works for v2 sessions. The old-style `session` rows are not found by this command, so those sessions cannot be moved through the official path (to be sized: how many of the 938 old rows are duplicated in `session_v2`).
- `opencode session import --directory <dir> <file>` keeps the session ID and the title. It does not keep the project: the project ID is derived from the target directory, so it differs from the source. This means path mapping is done by passing the right `--directory` per session; the tool needs no database access.
- The `event` table (1,952 rows) holds only message and session update events. Import works without it.
- Credentials have official commands: `opencode auth export` (prints all credentials as JSON, secrets included) and `opencode auth import`. Credential transfer therefore also needs no database access.
- `opencode mcp auth <name>` exists for re-authenticating remote OAuth servers. Where the tokens are stored is still not verified.
- Decision: Backend A (official commands) is confirmed as the base for v0.1 and v0.2. Backend B (direct database writes) is dropped from the plan unless a real need appears.

## 3. Scope

Feature tiers, each independently selectable:

- Tier 1, config: `opencode.jsonc`, `tui.json`, `AGENTS.md`, `command/`, `skills/`, agent definitions, plugin list (`package.json`, local plugin files). Excludes `node_modules/`, which is reinstalled on the target.
- Tier 2, sessions: sessions, messages, parts, todos for chosen projects and time range. Optional: `tool-output/` and `snapshot/`.
- Tier 3, credentials: provider API keys and OAuth entries. Off by default; encrypted when included.
- Tier 4, user state: model choice, prompt history, UI key-value settings, saved permission decisions.
- Later: desktop app state (Electron user data), and project-local `.opencode/` directories (these normally belong in git, so only a warning is given).

- MCP servers (own tier, see 5.9): the `mcp` block of the config, plus stored OAuth tokens for remote servers. Included in the plan from M1.

Never exported: service password, locks, logs, caches, `repos/`, `node_modules/`.

## 4. User experience

Commands (names tentative):

- `export`: choose tiers, projects, and time range; write one archive file. Interactive wizard by default, flags for scripts.
- `inspect`: show what an archive contains, its size breakdown by tier, and its source OS, username, and OpenCode version, without touching anything.
- `import`: dry-run by default. Prints a plan (what will be added, skipped, rewritten, conflicting). Requires `--apply` to write.
- `remap`: show and edit the path mapping between source and target.
- Later: `push` / `pull` against a folder or git repo for repeated syncing.

Typical flow: on the old machine run `export`, copy the file, on the new machine run `import`, review the plan, apply. The tool prints which local repos it found for each imported project and which projects have no local clone.

## 5. Technical design

### 5.1 Form factor and runtime

Standalone CLI written in TypeScript, shipped on npm (`npx`) and as compiled single binaries for Linux, macOS, and Windows. Reasons for a CLI instead of a plugin: it must work on a fresh machine before any plugin is configured, and it must be able to stop or bypass the running service. A thin plugin that exposes a `/migrate` slash command can come later, and gives extra discoverability.

### 5.2 Archive format

One file, `.ocm`. Implemented as a gzip-compressed tar on all platforms (zstd and the Windows zip fallback were dropped to keep the dependency list to `tar` and `jsonc-parser`). Contents:

- `manifest.json`: format version, tool version, source OpenCode version, schema version (latest applied migration), source OS, home directory, path roots, tiers included, per-file SHA-256.
- `config/`: Tier 1 files, keeping relative paths.
- `state/`: Tier 4 files.
- `sessions/`: one NDJSON file per table, or per project, each row tagged with schema version.
- `secrets.enc`: Tier 3, encrypted with a passphrase (scrypt or argon2 key derivation, authenticated encryption). Kept as a separate file so the rest can be inspected or shared safely.

Large content (3.6 GB here) is streamed, never loaded whole. Defaults keep the archive small: tool output and snapshots are off, and `--since 90d` limits history.

### 5.3 Session transfer: two backends

- Backend A, official path (first release): drive `opencode session export` and `import` per session, apply path rewriting to the JSON in between. Safe against schema changes and works while the service is running. Slow for hundreds of sessions, and limited by whatever the official format omits.
- Backend B, direct database path (later): read selected rows from the source database and insert them into the target database. Fast and complete, but tied to the schema version, and risky while the service holds the database open. Requires: service stopped, target schema version equal to or newer than source, automatic backup of the target database first, transaction around the whole import, integrity check afterwards, and a decision on the `event` tables (see spike).

Implemented (M2): Backend A. Sessions are listed through the service's session list endpoint (`opencode api`, which paginates with a cursor), each one is exported with `opencode session export`, and on the target each one is brought in with `opencode session import --directory`, one at a time. Sessions that already exist on the target are never re-imported. Importing over an existing session is deliberately not attempted, because what the official command does with an existing ID is not verified. The archive stores the raw export JSON per session plus an index file (project, source directory, project root path, times, parent).

Decision: ship A first because it is robust and supported. Add B once A's limits are measured. This avoids betting the whole project on an unstable internal schema.

### 5.4 Path remapping

Rewrite only structured path columns, never free text inside messages or tool output (that would corrupt transcripts, and the paths there are history, not live references).

Resolution order for each imported project. Implemented order (M2) differs slightly: an explicit rule given by the user comes first, then the mapping file saved by an earlier import of the same archive, then the repository scan, then the home-directory swap, then the original path if it exists on the target. A project with no match is "detached": its sessions are skipped and reported with a fix hint, unless the user names a fallback directory. Sessions in a subfolder or worktree of a project follow the project's mapping.

Original order:

1. Match by project ID: scan user-provided roots (default: home directory, `/work`, `~/code`, `~/Projects`) for git repos and compare their root commit with the project ID.
2. Match by explicit rule: `--map /home/zjc=/Users/zjc` or a rule file. Prefix rules, longest match first.
3. Home-directory heuristic: swap source home for target home, check the directory exists.
4. No match: import under the original path, mark the session as "detached", and list it in the report so the user can fix it later with `remap`.

Windows handling: normalize drive letters and separators on both sides before comparing; store the original string untouched in the manifest.

### 5.5 Credentials

- Default: excluded. Implemented (M3) as an opt-in tier named `credentials` instead of an `--include-credentials` flag. The credentials come only from `opencode auth export`, so the tool never reads OpenCode's credential files or database. They are written to `secrets.enc` inside the archive, encrypted with AES-256-GCM under a key derived from the passphrase with scrypt (N=2^17, r=8, p=1, random salt and IV). The scrypt parameters live in the file header, which is authenticated, so they can be raised later. Argon2 was not used because it is not in Node's built-in crypto, and the tool takes no cryptography dependency.
- The passphrase is never a command-line argument. It comes from a file, an environment variable, or a hidden prompt. A wrong passphrase and a damaged file give one indistinguishable message.
- With `--keep-secrets`, the real values of the MCP secrets that are replaced by `{env:NAME}` markers in the archived config are stored in the same bundle, keyed by marker name. On import they come back into the config only when the user passes `--restore-mcp-secrets`, and only for servers added or replaced in that run.
- On import: written through `opencode auth import` via a private temporary file that is always deleted. An existing credential with the same ID is left untouched; the official command skips it.
- Not covered: tokens of remote MCP servers that use OAuth. Their storage location is not verified. The user re-authenticates with `opencode mcp auth <name>`.
- Not built: the config scanner that warns about inline tokens in `opencode.jsonc` outside the MCP block.

### 5.9 MCP servers

Verified on this machine: MCP servers live in the `mcp` block of `opencode.jsonc`. All nine are local servers (a `command` plus optional `environment`); five of them carry an `environment` block that holds database passwords or API tokens. The CLI has `opencode mcp list/add/auth/logout`, so remote OAuth servers keep their tokens in a store outside the config (location not yet verified; added to spike M0).

What breaks on a move, and what the tool does about it:

- Secrets in `environment`, `headers`, and `command` arguments (the author's own `postgres` server has a database URL with a password inside its arguments): detected per server. On export the user picks, per server, between keeping the value (goes into the encrypted bundle, never the plain archive), replacing it with an environment-variable reference, or blanking it. The import plan lists which values are missing on the target.
- Commands that do not exist on the target: for each local server the import runs a check (is the executable on PATH, does the absolute path exist, is it a `npx` / `uvx` / `docker` call that needs a runtime). The report marks each server as ready, needs install, or needs path fix. The tool does not install anything itself.
- Absolute paths inside `command` arguments: rewritten with the same remap rules as sessions (5.4), only for arguments that match a known source root.
- OS differences: a Windows `.cmd` or `.exe` command is flagged when moving to Linux or macOS, and the reverse.
- Remote OAuth servers: tokens are machine-bound in practice and often expire, so by default the tool exports only the server definition and prints the `opencode mcp auth <name>` command to run on the target. Token transfer is opt-in and goes through the encrypted bundle.
- Enabled flag: preserved, with an option to import everything as disabled until the user has checked the report.
- Merge behaviour: servers are matched by name. A server that already exists on the target is never overwritten without confirmation; the plan shows a field-level difference.
- Project-level MCP config (`opencode.json` inside a repository) belongs to the repo, so it is only reported, not copied.

A standalone `mcp-only` mode (export or import just this tier) is worth having, since many users want exactly this and nothing else. It is also the smallest useful first release.

### 5.6 Conflicts and idempotency

- Sessions are matched by ID. Same ID and same last-updated time: skip. Same ID, different time: keep the newer, report the other.
- Config files are never overwritten silently. Changed files are written alongside as `.incoming` or merged by the user from the plan output; originals are backed up with a timestamp.
- Running import twice gives the same result. This is also what makes the later `push` / `pull` sync mode possible.

### 5.7 Safety rules

- Dry-run is the default for import.
- Backup of everything about to be changed, before any write.
- Refuse to write to the database while the OpenCode service is running (Backend B), and say how to stop it.
- Checksums verified before reading an archive.
- Clear, plain-language error messages; internal exceptions go to a log file only.

### 5.8 Testing

- Fixture databases at several schema versions, including one with both session generations.
- Round trip test: export from fixture A, import into an empty profile B, compare.
- Path remap unit tests, including Linux to macOS, Linux to Windows, username change, missing repo.
- Compatibility check across the last N OpenCode releases in CI.
- Test that secrets never appear in an archive unless requested (scan the archive bytes).
- Manual end-to-end test between the three machines the author already uses.

## 6. Development plan

Part-time estimates.

- M0, spike (1 to 2 days): answer the unverified questions in section 2. Output: a short findings note and a go/no-go on Backend A.
  - Does `session export` include `session_v2` sessions and their messages?
  - Does `session import` keep IDs and attach to the right project, and does it accept rewritten paths?
  - What does the `event` table do, and can sessions be restored without it?
  - Are credentials in `auth.json`, the `credential` table, or both?
  - Where do remote MCP OAuth tokens live, and can they be re-imported through a CLI command?
  - Some plugin state in the key-value table is keyed by session ID; decide whether Tier 4 carries it along with the sessions it belongs to.
- M1, config and MCP MVP (4 to 5 days): `export` / `inspect` / `import` for Tier 1, MCP servers (5.9) and Tier 4, archive format, manifest, dry-run, backups. Already useful on its own and enough for a first public post.
- M2, sessions via Backend A (4 to 5 days): selective session transfer, project matching by root commit, path remapping, detached-session report.
- M3, credentials (2 days): encrypted bundle, config scanner.
- M4, polish and release (3 days): Windows and macOS testing, README with a terminal GIF, Chinese README, npm and binary releases, CI.
- M5, optional: Backend B, `push` / `pull` sync, plugin slash command, desktop state.

Release milestones: v0.1 after M1, v0.2 after M2 (the version worth promoting), v1.0 after M4.

## 7. Traffic and distribution plan

- Reply on issue #54534 with a link once v0.2 works, framed as an interim tool that anyone in the thread can use today.
- Submit to the awesome-opencode list (about 10.9k stars).
- Blog post on jczhu.com, written from the author's real move between several machines, with real numbers (3.6 GB of data, hundreds of sessions).
- Chinese-language README and a short post for Chinese developer communities.
- README links to jczhu.com and the GitHub profile; repository topics `opencode`, `opencode-plugin`, `migration`.

## 8. Risks

- Core ships its own migrate command. Mitigation: differentiate on selective and incremental transfer, encrypted credentials, and path remapping; keep Backend A so the tool keeps working with whatever core exports.
- V2 schema and plugin API are still changing (version 2.2.5 is about a month old). Mitigation: prefer official commands, pin tested versions, and show a clear unsupported-version error instead of guessing.
- Credential handling is a trust issue for a new tool. Mitigation: off by default, small auditable encryption code, secrets in a separate file, no network calls.
- Event-sourced storage could make direct row import produce inconsistent state. Mitigation: spike first, and ship the official-path backend before the direct one.

## 9. Open decisions

- Final name and repository location.
- Runtime: TypeScript on Bun (compiled binaries) versus Node (simpler `npx`).
- Whether desktop-app state is in scope for v1.0.
- Whether to also offer a core-compatible archive format if the upstream implementation lands.
