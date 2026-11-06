import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SECRETS = ["envurl-pass-424", "s3cr3t-pg-pass", "tok-abc-123-xyz", "hdr-secret-999", "svc-pass-777", "url-pass-555"];

export const MAIN_CONFIG = `{
  // my provider settings
  "model": "anthropic/claude", /* keep me */
  "mcp": {
    "postgres": {
      "type": "local",
      "command": ["npx", "-y", "pg-mcp", "postgresql://admin:s3cr3t-pg-pass@localhost:5432/db"],
      "enabled": true
    },
    "github": {
      "type": "local",
      "command": ["node", "/home/zjc/tools/gh.js", "--token", "tok-abc-123-xyz"],
      "environment": { "GITHUB_TOKEN": "tok-abc-123-xyz", "LOG_LEVEL": "debug" }
    },
    "dburl": {
      "type": "local",
      "command": ["db-mcp"],
      "environment": { "DATABASE_URL": "postgresql://apt:envurl-pass-424@127.0.0.1:5432/x" }
    },
    "remote1": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer hdr-secret-999" }
    }
  }
}
`;

export function tmp(prefix = "ocm-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(p: string, content: string): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

/** Build a fake source profile. Never touches the real ~/.config/opencode. */
export function makeSource(): { root: string; configDir: string; stateDir: string; home: string } {
  const root = tmp();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  write(join(configDir, "opencode.jsonc"), MAIN_CONFIG);
  write(join(configDir, "tui.json"), '{"theme":"x"}');
  write(join(configDir, "AGENTS.md"), "# rules\n");
  write(join(configDir, "package.json"), '{"dependencies":{}}');
  write(join(configDir, "command", "a.md"), "do a");
  write(join(configDir, "plugins", "p.js"), "export default {}");
  write(join(configDir, "agent", "ag.md"), "agent");
  write(join(configDir, "node_modules", "dep", "index.js"), "x");
  write(join(configDir, "service.json"), '{"password":"svc-pass-777"}');
  write(join(configDir, "old.bak"), "bak");
  write(join(configDir, "AGENTS.md.bak-2026"), "bak");
  const ext = join(root, "external-skills");
  write(join(ext, "s1", "SKILL.md"), "skill one");
  symlinkSync(ext, join(configDir, "skills"));
  write(join(stateDir, "kv.json"), '{"a":1}');
  write(join(stateDir, "model.json"), '{"m":1}');
  write(join(stateDir, "prompt-history.jsonl"), '{"p":"hi"}\n');
  write(join(stateDir, "service.json"), '{"password":"svc-pass-777"}');
  write(join(stateDir, "session.json"), "{}");
  write(join(stateDir, "plugin-meta.json"), "{}");
  write(join(stateDir, "locks", "l"), "");
  return { root, configDir, stateDir, home: "/home/zjc" };
}
