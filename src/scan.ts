import { parseTree, type Node } from "jsonc-parser";

/** A likely inline secret in a plugin script (files that cannot be redacted safely). */
export interface SecretFinding {
  file: string;
  /** "line N". */
  where: string;
  key?: string;
  kind: "key-name" | "token-shape";
}

const KEY_RE = /key|token|secret|password|pass/i;
const REF_RE = /^\s*(Bearer\s+|Basic\s+|Token\s+)?(\$\{[^}]*\}|\{env:[^}]*\}|\{file:[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s*$/i;
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,
];
const MIN_VALUE_LENGTH = 6;

const hasTokenShape = (v: string): boolean => TOKEN_SHAPES.some((r) => r.test(v));
const looksLikeSecretValue = (v: string): boolean => v.length >= MIN_VALUE_LENGTH && !/\s/.test(v) && !REF_RE.test(v);

/** Plugin script files, the only non-JSON config files that are scanned for inline secrets. */
export function isPluginScript(path: string): boolean {
  return /^config\/plugins?\/[^/]+\.(js|mjs|ts)$/.test(path);
}

const ASSIGN_RE = /(["']?)([A-Za-z0-9_.-]+)\1\s*[:=]\s*(["'`])([^"'`\n]+)\3/g;

function scanScript(file: string, text: string, out: SecretFinding[]): void {
  text.split(/\r?\n/).forEach((line, i) => {
    let reported = false;
    for (const m of line.matchAll(ASSIGN_RE)) {
      if (KEY_RE.test(m[2]) && looksLikeSecretValue(m[4]) && !/^process\.env|^import\./.test(m[4])) {
        out.push({ file, where: `line ${i + 1}`, key: m[2], kind: "key-name" });
        reported = true;
      }
    }
    if (!reported && hasTokenShape(line)) out.push({ file, where: `line ${i + 1}`, kind: "token-shape" });
  });
}

/** Scan a plugin script for inline secrets that cannot be redacted. */
export function scanFile(archivePath: string, data: Buffer): SecretFinding[] {
  if (!isPluginScript(archivePath)) return [];
  const out: SecretFinding[] = [];
  scanScript(archivePath, data.toString("utf8"), out);
  return out;
}

export function describeFinding(f: SecretFinding): string {
  const k = f.key ? ` (key "${f.key}")` : "";
  const why = f.kind === "token-shape" ? "looks like a known token format" : "looks like a stored secret";
  return `${f.file} at ${f.where}${k} ${why}.`;
}
