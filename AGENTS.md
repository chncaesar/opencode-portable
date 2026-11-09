# AGENTS.md

CLI that migrates OpenCode config / MCP servers / state / sessions / credentials between machines. Unofficial.

## Commands

- `npm test` — full vitest suite (`vitest run`).
- `npx tsc --noEmit` — typecheck (also `npm run typecheck`).
- `npm run build` — compile `src` → `dist/` via `tsconfig.build.json`.
- CI order matters: `npx tsc --noEmit` → `npm test` → `npm run build` (see `.github/workflows/ci.yml`).
- No linter or formatter is configured; typecheck + test is the whole gate.
- Node >= 20. ESM (`"type": "module"`) under `module: NodeNext`, so relative imports must use explicit `.js` extensions.

## Architecture

- Single CLI, no server. Entry point `src/cli.ts`; `bin` is `dist/cli.js`.
- Three commands: `export`, `inspect`, `import` (import is a dry run unless `--apply`).
- "Tiers" = the five data classes: `config`, `mcp`, `state`, `sessions`, `credentials` (`Tier` in `src/common.ts`).
- `.ocm` archive = gzip-compressed tar (`tar.c({ gzip: true })` in `src/archive.ts`), with a `manifest.json` holding per-file SHA-256 that is verified on read.
- Runtime deps are deliberately only `tar` + `jsonc-parser`; do not add more without a strong reason (see Design → Archive format below).
- Source is one-module-per-feature: `redact.ts`, `secrets.ts`, `sessions.ts`, `scan.ts`, `mcp.ts`, `paths.ts`.

## Design

Authoritative design intent (formerly `DESIGN.md`). `README.md` / `README.zh-CN.md` document user-facing behavior; trust code over prose.

### Tiers

Five independently-selectable data classes (`Tier` in `src/common.ts`):

- `config` — `opencode.jsonc`, `tui.json`, `AGENTS.md`, `command/`, `skills/`, agent defs, plugins (`package.json` + local files). Excludes `node_modules/`.
- `sessions` — sessions + messages for the chosen projects/time range.
- `credentials` — provider API keys + OAuth entries. Off by default; encrypted when included.
- `state` — model choice, prompt history, kv settings, saved permission decisions.
- `mcp` — the `mcp` block of the config (+ OAuth tokens for remote servers).

Never exported: service password, locks, logs, caches, `repos/`, `node_modules/`.

### Archive format

Single `.ocm` = gzip-compressed tar (`src/archive.ts`): `manifest.json` (format version, tool version, source OpenCode version, source OS, home, path roots, tiers, per-file SHA-256) plus `config/`, `state/`, `sessions/`, and `secrets.enc`. Large content is streamed, never loaded whole. `zstd` and a Windows zip fallback were dropped to keep the dependency list to `tar` + `jsonc-parser`.

### Session transfer — Backend A only

Drives `opencode session export` / `import` per session; the tool never touches the database. Sessions are listed via `opencode api GET /api/session` (cursor pagination), exported individually, imported with `--directory`. Sessions already on the target are never re-imported. Backend B (direct DB writes) was evaluated and dropped.

### Path remapping

Rewrites only structured path columns, never free text in messages/tool output. Per-project resolution order (implemented):

1. explicit `--map SRC=DST` (if the result exists)
2. mapping file from an earlier import of the same archive
3. local git clone with the same root commit (scan roots)
4. home-directory swap
5. the original path, if it exists

No match → the project is "detached" and its sessions are skipped. Sessions in a subfolder or worktree follow their project's mapping.

### Credentials & security model

- Credentials come only from `opencode auth export` — never from `auth.json` / `service.json`.
- `secrets.enc` = AES-256-GCM, key from the passphrase via scrypt (N=2^17, r=8, p=1). The passphrase is never a CLI argument. Argon2 was rejected (not in Node's built-in crypto).
- `--keep-secrets` stores the real MCP/config secret values in the bundle; `--restore-secrets` writes them back on import.
- Remote MCP OAuth tokens are not transferred (storage location unverified); the user re-authenticates with `opencode mcp auth <name>`.

### MCP servers

Secrets in `environment` / `headers` / `command` args are detected and replaced with `{env:NAME}` markers; real values go only in the encrypted bundle. Import checks each server's command availability, rewrites absolute paths, flags Windows↔Unix command mismatches, matches servers by name, and never overwrites an existing server without confirmation.

### Safety rules

- Import is a dry run unless `--apply`.
- Backup before any write; checksums verified before reading.
- Plain-language errors; internal details go to the log file.

## Key gotchas

- **Sessions tier shells out to the real `opencode` binary** (`OPENCODE_BIN` env var or PATH) and needs its background service running. `config`/`mcp`/`state` use plain files only.
- **Never read `service.json` or `auth.json`.** Credentials come only from `opencode auth export`.
- Inline secrets in config are replaced with `{env:NAME}` markers before anything is written; real values live only in `secrets.enc` (AES-256-GCM + scrypt). Session transcripts may contain secrets — keep every archive private.
- There is deliberately **no `--passphrase` CLI flag** (visible in `ps` / shell history). Passphrase comes from `--passphrase-file`, `OPENCODE_PORTABLE_PASSPHRASE`, or an interactive prompt.
- Import safety: dry-run by default; changed files are copied to `<file>.bak-<timestamp>` first; user-facing errors are plain English, technical details go to `opencode-portable.log`.

## Testing quirks

- Tests never touch the real `~/.config/opencode`. Build fixtures with `makeSource()` / `tmp()` from `test/helpers.ts`; temp dirs are cleaned by the global `afterAll` in `test/setup.ts`.
- `FakeOpencode` (`test/fake.ts`) stubs the `opencode` binary via a generated node script + the `OPENCODE_BIN` env var. Use it for anything hitting `api` / `auth` / `session` subcommands.
- `.gitattributes` forces `eol=lf` so fixtures and SHA-256 checksums stay stable across Windows checkouts.
- Cross-platform: CI runs Linux/macOS/Windows × Node 20/22. On Windows there is no `chmod 600`, and symlinked config folders are archived as regular files (see the `.cmd` wrapper in `test/fake.ts` and `trySymlinkDir` in `test/helpers.ts`).

## Naming note

`AGENTS.md` has two unrelated meanings here: this repo's dev-instruction file, and the OpenCode global-rules file (`~/.config/opencode/AGENTS.md`) that the tool exports as part of the `config` tier (`CONFIG_FILES` in `src/export.ts`). Do not conflate them.
