import { describe, expect, it } from "vitest";
import { applyRules, parseRule, rewriteArg } from "../src/paths.js";

describe("path rules", () => {
  it("swaps Linux home for macOS home", () => {
    const rules = [parseRule("/home/zjc=/Users/zjc")];
    expect(applyRules("/home/zjc/code/app", rules)).toBe("/Users/zjc/code/app");
    expect(applyRules("/home/zjc", rules)).toBe("/Users/zjc");
  });
  it("handles a username change", () => {
    expect(applyRules("/home/old/x/y", [parseRule("/home/old=/home/new")])).toBe("/home/new/x/y");
  });
  it("matches whole segments only", () => {
    const rules = [parseRule("/home/zjc=/Users/zjc")];
    expect(applyRules("/home/zjc2/code", rules)).toBe("/home/zjc2/code");
    expect(applyRules("/home/zjcx", rules)).toBe("/home/zjcx");
  });
  it("longest prefix wins regardless of order", () => {
    const rules = [parseRule("/home/zjc=/Users/zjc"), parseRule("/home/zjc/work=/Volumes/work")];
    expect(applyRules("/home/zjc/work/a", rules)).toBe("/Volumes/work/a");
    expect(applyRules("/home/zjc/other", rules)).toBe("/Users/zjc/other");
  });
  it("handles Windows paths", () => {
    expect(applyRules("C:\\Users\\a\\proj", [parseRule("C:\\Users\\a=D:\\u")])).toBe("D:\\u\\proj");
    expect(applyRules("c:/users/a/proj", [parseRule("C:\\Users\\a=/home/a")])).toBe("/home/a/proj");
  });
  it("never rewrites URLs, handles --flag=path", () => {
    const rules = [parseRule("/home/zjc=/Users/zjc")];
    expect(rewriteArg("file:///home/zjc/x", rules)).toBe("file:///home/zjc/x");
    expect(rewriteArg("--dir=/home/zjc/x", rules)).toBe("--dir=/Users/zjc/x");
    expect(rewriteArg("-y", rules)).toBe("-y");
  });
  it("rejects malformed rules", () => {
    expect(() => parseRule("nope")).toThrow();
  });
});
