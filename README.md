# opencode-portable

Move your OpenCode config, MCP servers and user state to another machine. Covers the config, mcp, state, sessions and credentials tiers.

Unofficial: this project is not affiliated with or endorsed by the OpenCode project.

## Why this exists

OpenCode has no supported way to move its state to another machine (upstream feature request: anomalyco/opencode#54534), so this tool does it with OpenCode's own commands and plain files.

## Install

Requires Node 20 or newer.

```
npm install -g opencode-portable
# or from a checkout
npm install && npm run build && npm link
```

## Usage

On the old machine:

```
opencode-portable export --tiers config,mcp,state --out my.ocm
opencode-portable inspect my.ocm
```

On the new machine (dry run first, nothing is written):

```
opencode-portable import my.ocm
opencode-portable import my.ocm --apply
```

Options:

- `--tiers config,mcp,state,sessions,credentials` choose what to include (export default: `config,mcp`; import default: everything in the archive).
- `--out FILE` archive path for export.
- `--map SRC=DST` path rule, repeatable. The longest whole-folder prefix wins, so `/home/me` never matches `/home/me2`. The source home to target home rule is added automatically.
- `--import-mcp-disabled` add new MCP servers with `enabled: false`.
- `--overwrite-mcp NAME` replace an existing MCP server (repeatable). Without it, existing servers are never changed.
- `--overwrite-config` overwrite differing files. By default they are written as `NAME.incoming`.
- `--fail-on-secrets` (export) exits with an error if the config files hold likely inline secrets.
- `--config-dir`, `--state-dir`, `--home` override locations. `XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honoured.

## Sessions

Sessions are opt-in: `--tiers config,mcp,state,sessions`. The tool does not read OpenCode's database. It lists sessions through the running OpenCode service (`opencode api GET /api/session`, following pagination), exports each with `opencode session export`, and imports each on the new machine with `opencode session import --directory DIR`. The `opencode` program must be on PATH (or set `OPENCODE_BIN`) and its background service must be running, on both machines.

Export filters:

- `--since 30d` (or `90d`, or a date like `2026-01-01`): sessions updated since then.
- `--project PATH_OR_ID` (repeatable): one project, by directory or project ID.
- `--max-sessions N`: the newest N sessions. Sub-agent sessions of a selected session are always included.
- `--sanitize-sessions`: passes `--sanitize` to `opencode session export`.

Session transcripts can contain secrets (keys pasted into chats, file contents, command output). Keep the archive private.

Import: a dry run prints, per project, the archive path, the local directory it maps to, how it was matched, and what each session will do (add, skip, conflict, detached). Matching order for each project:

1. An explicit `--map SRC=DST` rule, if the result exists.
2. The mapping file from an earlier import of the same archive.
3. A local git clone with the same root commit, found by scanning `--scan-root DIR` (repeatable; default: your home, `/work`, `~/code`, `~/Projects`, `~/src` when they exist; four levels deep).
4. The home-directory swap, if the folder exists.
5. The original path, if it exists on this machine.

A project with no match is detached and its sessions are skipped. Fix it with a `--map` rule, by cloning the repository under a scan root, or with `--import-detached-to DIR`.

Sessions already on this machine are skipped when the local copy is the same age or newer (OpenCode resets the update time on import, so an imported copy always looks newer). If the archive copy is newer than the local one, the session is reported as a conflict and left alone, because updating an existing session is not supported. With `--apply`, sessions are imported one at a time (`--session-timeout SEC`, default 120), a failure does not stop the rest, and a summary is printed. Details of failures go to `opencode-portable.log` in the state directory.

On `--apply` the confirmed mapping is written to `<archive>.mapping.json` and reused on later imports. An explicit `--map` still wins over the file. Message text is never rewritten; only the target directory is chosen.

## Inline secret warnings

When the config tier is exported, `opencode.jsonc` (outside the `mcp` block, which is handled separately), `tui.json` and plugin scripts (`plugins/*.js`, `.mjs`, `.ts`, `.json`) are scanned for likely inline secrets: values under keys such as key, token, secret or password, and well-known token formats (`sk-`, `ghp_`, `github_pat_`, `xoxb-`, `AKIA...`, long Bearer tokens). Values already written as `{env:NAME}` or `{file:...}` are fine. Findings are warnings that show the file and location only, never the value; the export still contains the file as is. Add `--fail-on-secrets` to stop instead. Markdown commands and skills are not scanned.

## Credentials and security model

Credentials are opt-in: add `credentials` to `--tiers`. They are never in the default tiers.

- What is encrypted: the output of `opencode auth export` (provider API keys and other stored credentials), and, with `--keep-secrets`, the real values of MCP secrets that were replaced by `{env:NAME}` markers in the archived config. Both are stored in one file inside the archive, `secrets.enc`, encrypted with AES-256-GCM. The key comes from your passphrase through scrypt (N=2^17, r=8, p=1, random salt). The parameters are stored in the file header and authenticated, so they can be raised later.
- What is not encrypted: everything else in the archive. Config files, the MCP block (secrets already replaced by markers), user state and session transcripts are plain files. Session transcripts may contain secrets (keys pasted into chats, file contents, command output), so keep every archive private. Labels of credentials are only visible after decrypting.
- Never exported: `service.json` and `auth.json` are not read. Credentials come only from `opencode auth export`.
- Remote MCP OAuth tokens are not transferred, because their storage location is not verified. On the new machine run `opencode mcp auth <name>` for each remote server.

Passphrase: there is deliberately no `--passphrase` option, because command-line arguments are visible to other users and stay in shell history. The tool reads it from, in this order: `--passphrase-file PATH` (a warning is printed if the file is readable by others; use `chmod 600`), the environment variable `OPENCODE_PORTABLE_PASSPHRASE`, or a hidden prompt in a terminal (asked twice on export). On export it must be at least 12 characters. If no source is available and there is no terminal, the command stops with an error. A wrong passphrase and a damaged file give the same message.

Export example:

```
opencode-portable export --tiers config,mcp,credentials --keep-secrets --passphrase-file ~/.ocm-pass --out my.ocm
```

Import: a dry run says the archive contains an encrypted bundle. If a passphrase is available through the file or the environment variable, it also lists the credential labels and the names (never values) of the MCP secrets. With `--apply` the credentials are handed to `opencode auth import` through a temporary file (mode 0600) that is deleted afterwards. A credential that already exists on the machine is left untouched. `--restore-mcp-secrets` (with `--apply`) writes the real MCP secret values into `opencode.jsonc`, only for servers added or replaced in that run, and prints which servers now contain literal secrets. Without it the `{env:NAME}` markers stay.

If you import without `--tiers` and no passphrase is available, credentials are skipped with a note. Pass `--tiers credentials` to make it an error instead.

## MCP layouts

Both OpenCode MCP layouts are supported: the older `mcp.<name>` entries (with `enabled`) and the v2 `mcp.servers.<name>` entries (with `disabled`). Import writes into the layout the target file already uses, converting `enabled`/`disabled` as needed. If the target has no MCP servers, the archive's layout is used.

## What is exported

- config: `opencode.jsonc` without its `mcp` block, `tui.json`, `AGENTS.md`, `package.json`, and the `command`, `skills`, `agent` and `plugins` folders (symlinks are followed). Not included: `node_modules`, `service.json`, `*.bak`.
- mcp: the `mcp` block. Secret values (environment variables, headers, passwords in URLs and arguments) are replaced with `{env:NAME}` markers (OpenCode expands these from environment variables at startup; verified on v2.2.5). The import plan lists the values you need to fill in.
- state: `kv.json`, `model.json`, `prompt-history.jsonl`.
- sessions: `sessions/<id>.json` (raw `opencode session export` output) and `sessions/index.json`.

## Safety

- Import is a dry run unless you pass `--apply`.
- Every file that will be changed is first copied to `<file>.bak-<timestamp>`.
- Archive checksums (SHA-256) are verified before anything is read.
- Errors are shown in plain English. Technical details go to `opencode-portable.log` in the state directory.

## Platforms

Tested on Linux in the development environment; CI runs the tests on Linux, macOS and Windows with Node 20 and 22. On Windows, `opencode.cmd` launchers are supported, file permission checks (`chmod 600`) do not apply, and symlinked folders in the config are archived as regular files.

## Development

```
npm test
npx tsc --noEmit
```
