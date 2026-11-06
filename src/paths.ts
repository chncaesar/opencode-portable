export interface PathRule {
  src: string;
  dst: string;
}

export function parseRule(text: string): PathRule {
  const i = text.indexOf("=");
  if (i <= 0 || i === text.length - 1) {
    throw new UserError(`Invalid --map value "${text}". Use the form SOURCE=TARGET, for example /home/me=/Users/me.`);
  }
  return { src: text.slice(0, i), dst: text.slice(i + 1) };
}

export class UserError extends Error {}

function isWinLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || /^[A-Za-z]:$/.test(p);
}

function split(p: string): { win: boolean; segs: string[] } {
  const win = isWinLike(p);
  let norm = win ? p.replace(/\\/g, "/") : p;
  if (norm.length > 1) norm = norm.replace(/\/+$/, "") || "/";
  const segs = norm.split("/").filter((s, i) => i === 0 || s !== "");
  return { win, segs };
}

/**
 * Apply the rule with the longest whole-segment prefix match.
 * Rules earlier in the list win ties. Returns the input unchanged if nothing matches.
 */
export function applyRules(p: string, rules: PathRule[]): string {
  const target = split(p);
  let best: { rule: { segs: string[]; win: boolean }; dst: ReturnType<typeof split>; len: number } | null = null;
  for (const r of rules) {
    const s = split(r.src);
    if (s.segs.length > target.segs.length) continue;
    const ci = s.win || target.win;
    const ok = s.segs.every((seg, i) =>
      ci ? seg.toLowerCase() === target.segs[i].toLowerCase() : seg === target.segs[i],
    );
    if (!ok) continue;
    if (!best || s.segs.length > best.len) best = { rule: s, dst: split(r.dst), len: s.segs.length };
  }
  if (!best) return p;
  const rest = target.segs.slice(best.len);
  const segs = [...best.dst.segs, ...rest];
  if (best.dst.win) return segs.join("\\");
  const out = segs.join("/");
  return out === "" ? "/" : out;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isAbsolutePathLike(p: string): boolean {
  return p.startsWith("/") || isWinLike(p);
}

/** Rewrite a command argument. URLs are never touched. Handles `--flag=/abs/path` too. */
export function rewriteArg(arg: string, rules: PathRule[]): string {
  if (URL_RE.test(arg)) return arg;
  if (isAbsolutePathLike(arg)) return applyRules(arg, rules);
  const i = arg.indexOf("=");
  if (i > 0) {
    const value = arg.slice(i + 1);
    if (!URL_RE.test(value) && isAbsolutePathLike(value)) return arg.slice(0, i + 1) + applyRules(value, rules);
  }
  return arg;
}

/** True when `child` equals `parent` or lies below it, comparing whole path segments. */
export function isUnder(child: string, parent: string): boolean {
  const c = split(child);
  const p = split(parent);
  if (p.segs.length > c.segs.length) return false;
  const ci = c.win || p.win;
  return p.segs.every((seg, i) => (ci ? seg.toLowerCase() === c.segs[i].toLowerCase() : seg === c.segs[i]));
}
