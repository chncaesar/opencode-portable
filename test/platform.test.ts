import { describe, expect, it } from "vitest";
import { spawnSpec, winCmdQuote } from "../src/opencode.js";
import { applyRules, isUnder, parseRule, rewriteArg } from "../src/paths.js";

// These run on every OS: they check the Windows behaviour with plain strings.
describe("Windows launching", () => {
  it("quotes only what cmd.exe would misread", () => {
    expect(winCmdQuote("session")).toBe("session");
    expect(winCmdQuote("C:\\Program Files\\x.json")).toBe('"C:\\Program Files\\x.json"');
    expect(winCmdQuote("/api/session?limit=200&cursor=abc")).toBe('"/api/session?limit=200&cursor=abc"');
    expect(winCmdQuote("")).toBe('""');
    expect(winCmdQuote('a"b')).toBe('"a""b"');
  });

  it(".cmd and .bat launchers get a shell on Windows only", () => {
    const w = spawnSpec("C:\\Users\\me\\AppData\\npm\\opencode.cmd", ["auth", "export"], "win32");
    expect(w).toEqual({ command: "C:\\Users\\me\\AppData\\npm\\opencode.cmd", args: ["auth", "export"], shell: true });
    expect(spawnSpec("C:\\x\\opencode.exe", ["a"], "win32").shell).toBe(false);
    expect(spawnSpec("/usr/bin/opencode", ["a b"], "linux")).toEqual({ command: "/usr/bin/opencode", args: ["a b"], shell: false });
    expect(spawnSpec("/x/opencode.cmd", ["a"], "linux").shell).toBe(false);
    expect(spawnSpec("C:\\Program Files\\o\\opencode.cmd", ["x y"], "win32")).toMatchObject({ command: '"C:\\Program Files\\o\\opencode.cmd"', args: ['"x y"'] });
  });
});

describe("Windows paths (string level, any OS)", () => {
  it("maps Linux to Windows and back, ignoring case and separator style on Windows", () => {
    expect(applyRules("/home/zjc/code/app", [parseRule("/home/zjc=C:\\Users\\zjc")])).toBe("C:\\Users\\zjc\\code\\app");
    expect(applyRules("C:\\Users\\zjc\\code\\app", [parseRule("C:\\Users\\zjc=/home/zjc")])).toBe("/home/zjc/code/app");
    expect(applyRules("c:/users/ZJC/code", [parseRule("C:\\Users\\zjc=/home/z")])).toBe("/home/z/code");
    expect(applyRules("C:\\Users\\zjc2\\x", [parseRule("C:\\Users\\zjc=/home/z")])).toBe("C:\\Users\\zjc2\\x");
  });

  it("isUnder and rewriteArg understand drive letters; URLs are untouched", () => {
    expect(isUnder("D:\\work\\a\\b", "d:/work/a")).toBe(true);
    expect(isUnder("D:\\work\\ab", "D:\\work\\a")).toBe(false);
    const r = [parseRule("C:\\Users\\a=/home/a")];
    expect(rewriteArg("C:\\Users\\a\\tool.js", r)).toBe("/home/a/tool.js");
    expect(rewriteArg("https://C:\\Users\\a", r)).toBe("https://C:\\Users\\a");
  });
});
