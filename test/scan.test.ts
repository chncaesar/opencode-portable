import { describe, expect, it } from "vitest";
import { scanFile } from "../src/scan.js";

const S = {
  apiKey: "plainvalue-key-0001",
  sk: "sk-abcdefghijklmnopqrstuvwx",
  ghp: "ghp_abcdefghijklmnopqrstuvwxyz0123",
  aws: "AKIAABCDEFGHIJKLMNOP",
  bearer: "Bearer abcdefghijklmnopqrstuvwxyz012345",
  pass: "hunter2-hunter2",
};
const ALL = Object.values(S);

describe("plugin script scanner", () => {
  it("flags secret-named keys and token shapes, reports locations only", () => {
    const js = `const a = { apiKey: "${S.apiKey}" };\nconst x = { password: "${S.pass}" };\nfetch("x", { headers: { Authorization: "${S.bearer}" } });\nconst c = "${S.aws}";`;
    const f = scanFile("config/plugins/p.js", Buffer.from(js));
    expect(f.map((x) => x.where)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(f[0]).toMatchObject({ key: "apiKey", kind: "key-name" });
    expect(f[2].kind).toBe("token-shape");
    expect(JSON.stringify(f)).not.toContain(S.apiKey);
  });

  it("skips process.env/import refs and prose", () => {
    const js = `const a = process.env.API_KEY;\nimport tok from "./x";\nconst b = { token: "{env:T}" };\n`;
    expect(scanFile("config/plugins/p.js", Buffer.from(js))).toEqual([]);
    expect(scanFile("config/command/a.md", Buffer.from(`token: "${S.pass}"`))).toEqual([]);
    expect(scanFile("config/skills/s/SKILL.md", Buffer.from(S.sk))).toEqual([]);
    expect(scanFile("config/opencode.jsonc", Buffer.from(`{"apiKey":"${S.pass}"}`))).toEqual([]);
    expect(scanFile("config/plugins/readme.md", Buffer.from(S.sk))).toEqual([]);
  });
});
