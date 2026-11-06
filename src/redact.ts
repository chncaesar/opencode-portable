import { applyEdits, parseTree, type Edit, type Node } from "jsonc-parser";

/**
 * Redacts inline secrets found in JSON/JSONC config files by replacing them with
 * {env:NAME} markers, using jsonc-parser edits so comments and formatting survive.
 * The source file is never modified; this works on an in-memory copy.
 */

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

export interface RedactionRecord {
  file: string;
  /** JSON path (e.g. provider.anthropic.options.apiKey) or "line N" for scripts. */
  where: string;
  key?: string;
  /** Marker name written into the file (e.g. PROVIDER_ANTHROPIC_OPTIONS_APIKEY). */
  name: string;
  /** The secret value, kept in memory for the encrypted bundle. Never printed. */
  value: string;
}

/** Derive a marker name from a JSON path: provider.anthropic.options.apiKey -> PROVIDER_ANTHROPIC_OPTIONS_APIKEY. */
function baseNameFromPath(path: (string | number)[]): string {
  return path
    .map((p) => (typeof p === "number" ? `_${p}` : p))
    .join("_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** The raw string value of a node, read from the source text (preserves escapes exactly). */
function rawNodeValue(text: string, n: Node): string {
  return text.slice(n.offset + 1, n.offset + n.length - 1);
}

interface Target {
  node: Node;
  path: (string | number)[];
  key: string | undefined;
  kind: "key-name" | "token-shape";
  /** The token substring to swap for token-shape findings. */
  token?: string;
}

function findTargets(root: Node, text: string): Target[] {
  const out: Target[] = [];
  const visit = (n: Node, path: (string | number)[], key: string | undefined, underKeybinds: boolean): void => {
    if (n.type === "string" && typeof n.value === "string") {
      const raw = rawNodeValue(text, n);
      if (REF_RE.test(n.value)) return;
      if (key && !underKeybinds && KEY_RE.test(key) && looksLikeSecretValue(n.value)) {
        out.push({ node: n, path, key, kind: "key-name" });
      } else {
        for (const r of TOKEN_SHAPES) {
          const m = r.exec(n.value);
          if (m) {
            out.push({ node: n, path, key, kind: "token-shape", token: m[0] });
            break;
          }
        }
      }
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
  return out;
}

/** Replace {env:NAME} markers in JSONC text with real values, preserving comments and formatting. */
export function restoreConfigMarkers(text: string, names: string[], values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  let out = text;
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(values, n)) {
      missing.push(n);
      continue;
    }
    const marker = `{env:${n}}`;
    if (out.includes(marker)) out = out.split(marker).join(values[n]);
  }
  return { text: out, missing };
}

function uniqueName(base: string, used: Set<string>): string {
  let n = base;
  let i = 2;
  while (used.has(n)) {
    n = `${base}_${i}`;
    i++;
  }
  used.add(n);
  return n;
}

/**
 * Redact a JSON/JSONC file. Returns the new text and one record per secret.
 * `usedNames` guarantees the marker names are unique across the whole export.
 * `collectValues` (optional) receives marker -> value for the encrypted bundle.
 */
export function redactJsonc(
  file: string,
  data: Buffer,
  usedNames: Set<string>,
  collectValues?: Map<string, string>,
): { text: string; records: RedactionRecord[] } {
  const text = data.toString("utf8");
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root) return { text, records: [] };
  const targets = findTargets(root, text);
  const edits: Edit[] = [];
  const records: RedactionRecord[] = [];
  for (const t of targets) {
    const where = t.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("").replace(/^\./, "") || "(root)";
    const name = uniqueName(baseNameFromPath(t.path), usedNames);
    let newValue: string;
    if (t.kind === "key-name") {
      newValue = `{env:${name}}`;
    } else {
      // Swap only the token substring, keep any surrounding text (e.g. "Bearer ...").
      newValue = rawNodeValue(text, t.node).replace(t.token!, `{env:${name}}`);
    }
    edits.push({ offset: t.node.offset, length: t.node.length, content: JSON.stringify(newValue) });
    records.push({ file, where, ...(t.key ? { key: t.key } : {}), name, value: t.kind === "key-name" ? t.node.value : t.token! });
    collectValues?.set(name, t.kind === "key-name" ? t.node.value : t.token!);
  }
  if (edits.length === 0) return { text, records: [] };
  // applyEdits needs descending offsets; findTargets is depth-first so they are ascending — reverse.
  edits.sort((a, b) => b.offset - a.offset);
  return { text: applyEdits(text, edits), records };
}
