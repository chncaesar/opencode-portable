import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveBuilder, readArchive } from "../src/archive.js";
import { tmp } from "./helpers.js";

// Regression: extracting several large session files used to leave every file after the first one empty,
// while the checksum check still passed (it hashed the stream, not the written file).
describe("archive extraction of large session files", () => {
  it("writes every session file completely and byte-for-byte", async () => {
    const root = tmp("ocm-large-");
    const sizes = [400_000, 650_000, 90_000, 1_200_000];
    const bodies = sizes.map((n, i) => JSON.stringify({ info: { id: `ses_${i}` }, messages: [{ text: "x".repeat(n) }] }));

    const b = new ArchiveBuilder();
    try {
      bodies.forEach((body, i) => b.add(`sessions/ses_${i}.json`, "sessions", body));
      b.add("sessions/index.json", "sessions", "[]");
      const out = join(root, "big.ocm");
      await b.finish(out, {
        formatVersion: 1,
        toolVersion: "test",
        createdAt: new Date().toISOString(),
        sourceOs: "linux",
        sourceHome: "/home/x",
        opencodeVersion: null,
        tiers: ["sessions"],
        symlinks: [],
        mcpRedactions: [],
      } as never);

      const extractDir = join(root, "ext");
      const loaded = await readArchive(out, { extractDir });
      expect(loaded.extracted.size).toBe(bodies.length);
      bodies.forEach((body, i) => {
        const p = loaded.extracted.get(`sessions/ses_${i}.json`);
        expect(p).toBeTruthy();
        const text = readFileSync(p as string, "utf8");
        expect(text.length).toBe(body.length);
        expect(text).toBe(body);
      });
    } finally {
      b.dispose();
    }
  });
});
