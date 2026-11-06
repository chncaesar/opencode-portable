import { readArchive } from "./archive.js";
import { parseIndex } from "./sessions.js";

export async function inspectArchive(file: string): Promise<string> {
  const { manifest: m, files } = await readArchive(file);
  const L: string[] = [];
  L.push(`Archive: ${file}`);
  L.push(`  Format version:   ${m.formatVersion}`);
  L.push(`  Created:          ${m.createdAt} by opencode-portable ${m.toolVersion}`);
  L.push(`  Source OS:        ${m.sourceOs}`);
  L.push(`  Source home:      ${m.sourceHome}`);
  L.push(`  OpenCode version: ${m.sourceOpencodeVersion ?? "unknown"}`);
  L.push(`  Tiers:            ${m.tiers.join(", ")}`);
  L.push("  Checksums:        verified");
  L.push("", "Size by tier");
  for (const t of m.tiers) {
    const fs = m.files.filter((f) => f.tier === t);
    const bytes = fs.reduce((n, f) => n + f.size, 0);
    L.push(`  ${t.padEnd(7)} ${String(fs.length).padStart(4)} file(s), ${bytes} bytes`);
  }
  if (m.mcp) {
    L.push("", `MCP servers (${m.mcp.servers.length})`);
    for (const s of m.mcp.servers) {
      const n = m.mcp.redactions.filter((r) => r.server === s.name).length;
      L.push(`  ${s.name} (${s.type})${n ? `, ${n} secret value(s) removed` : ""}`);
    }
  }
  if (m.tiers.includes("sessions")) {
    const idx = parseIndex(files.get("sessions/index.json"));
    const bytes = idx.reduce((n, e) => n + e.size, 0);
    const times = idx.flatMap((e) => [e.time.created, e.time.updated]).filter((t) => typeof t === "number");
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    L.push("", `Sessions (${idx.length}, ${(bytes / 1048576).toFixed(1)} MB uncompressed${m.sessions?.sanitized ? ", sanitized" : ""})`);
    if (times.length) L.push(`  Date range: ${day(Math.min(...times))} to ${day(Math.max(...times))}`);
    const by = new Map<string, typeof idx>();
    for (const e of idx) by.set(e.projectID, [...(by.get(e.projectID) ?? []), e]);
    for (const [pid, list] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      const root = list.find((e) => e.projectCanonical)?.projectCanonical ?? list[0].sourceDirectory ?? "(unknown path)";
      L.push(`  ${String(list.length).padStart(4)} session(s)  ${root}  [${pid.slice(0, 12)}]`);
    }
    L.push("  Session transcripts may contain secrets. Keep this archive private.");
  }
  if (m.tiers.includes("credentials")) {
    const f = m.files.find((x) => x.path === "secrets.enc");
    L.push("", f ? `Credentials: encrypted bundle present (${f.size} bytes). Not decrypted by inspect.` : "Credentials: tier listed but no bundle is present.");
  }
  if (m.links.length) {
    L.push("", "Symlinks on the source (stored as regular content)");
    for (const l of m.links) L.push(`  ${l.path} -> ${l.target}`);
  }
  L.push("", "Files");
  for (const f of m.files) L.push(`  ${f.path}  ${f.size} bytes`);
  return L.join("\n");
}
