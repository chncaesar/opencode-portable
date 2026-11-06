import { parseTree, type Node } from "jsonc-parser";

/** A likely inline secret. Holds where it is, never the value. */
export interface SecretFinding {
  file: string;
  /** JSON path (for JSON files) or "line N" (for scripts). */
  where: string;
  /** The key name, when there is one. */
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

/** Files worth scanning, by archive path. Prose (Markdown, commands, skills) is deliberately not scanned. */
export function isScannable(path: string): boolean {
  if (/^config\/opencode\.jsonc?$/.test(path) || path === "config/tui.json") return true;
  return /^config\/plugins?\/[^/]+\.(js|mjs|ts|json)$/.test(path);
}

function scanJson(file: string, text: string, out: SecretFinding[]): void {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root) return;
  const visit = (n: Node, path: (string | number)[], key: string | undefined, underKeybinds: boolean): void => {
    const where = path.length ? path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("").replace(/^\./, "") : "(root)";
    if (n.type === "string" && typeof n.value === "string") {
      const v = n.value;
      if (REF_RE.test(v)) return;
      if (key && !underKeybinds && KEY_RE.test(key) && looksLikeSecretValue(v)) out.push({ file, where, key, kind: "key-name" });
      else if (hasTokenShape(v)) out.push({ file, where, ...(key ? { key } : {}), kind: "token-shape" });
    } else if (n.type === "object") {
      for (const prop of n.children ?? []) {
        const [k, v] = prop.children ?? [];
        if (!k || !v || typeof k.value !== "string") continue;
        visit(v, [...path, k.value], k.value, underKeybinds || /^keybinds?$/i.test(k.value));
      }
    } else if (n.type === "array") {
      (n.children ?? []).forEach((c, i) => visit(c, [...path, i], key, underKeybinds));
    }
  };
  visit(root, [], undefined, false);
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

export function scanFile(archivePath: string, data: Buffer): SecretFinding[] {
  if (!isScannable(archivePath)) return [];
  const text = data.toString("utf8");
  const out: SecretFinding[] = [];
  if (/\.(jsonc?)$/.test(archivePath)) scanJson(archivePath, text, out);
  else scanScript(archivePath, text, out);
  return out;
}

export function describeFinding(f: SecretFinding): string {
  const k = f.key ? ` (key "${f.key}")` : "";
  const why = f.kind === "token-shape" ? "looks like a known token format" : "looks like a stored secret";
  return `${f.file} at ${f.where}${k} ${why}. Consider replacing it with {env:NAME}.`;
}
