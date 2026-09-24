import { describe, expect, test } from "bun:test";
import { getPrDiff, EditType, type FilePatchInfo } from "../src/diff";
import { loadConfig, getModelTokenLimit } from "../src/config";

const file = (filename: string, patch: string): FilePatchInfo => ({
  filename, baseFile: "a\nb\nc\n", headFile: "a\nB\nc\n", patch,
  editType: EditType.MODIFIED, numPlusLines: 1, numMinusLines: 1,
});

describe("getPrDiff language ordering", () => {
  test("main-language files come first when languages are supplied", () => {
    // NOTE: `maxModelTokens: 1500` forces getPrDiff's compressed pass, which is
    // the only pass that emits `## File:` headers — the brief's literal fixture
    // (default cfg, promptTokens 0) takes the extended fast path and returns
    // raw patch text with no filenames, so indexOf() is -1 for BOTH files and
    // the assertion is unsatisfiable even after sorting is wired up.
    const cfg = { ...loadConfig(), maxModelTokens: 1500 };
    const files = [
      file("docs/readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
      file("src/app.py", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
    ];
    const { diff } = getPrDiff(files, 0, "claude-opus-5", cfg, { Python: 9000, Markdown: 10 });
    expect(diff.indexOf("src/app.py")).toBeLessThan(diff.indexOf("docs/readme.md"));
  });
});

// Locks the S6 consolidation: diff/budget.ts + diff/multi.ts now use
// getModelTokenLimit from config, which is a strict superset of the deleted
// private copy. These pin the shared table + fallback + clamp behaviour.
describe("getModelTokenLimit parity (S6 consolidation)", () => {
  const unlimitedCfg = () => ({
    ...loadConfig(),
    maxModelTokens: 0,
    customModelMaxTokens: 0,
  });

  test("known models use the shared table", () => {
    const cfg = unlimitedCfg();
    expect(getModelTokenLimit("claude-opus-5", cfg)).toBe(1000000);
    expect(getModelTokenLimit("claude-haiku-4-5-20251001", cfg)).toBe(200000);
  });

  test("unknown model falls back to 128000 when no custom max is set", () => {
    expect(getModelTokenLimit("some-unknown-model", unlimitedCfg())).toBe(128000);
  });

  test("cfg.maxModelTokens still clamps a known model down", () => {
    const cfg = { ...loadConfig(), maxModelTokens: 200, customModelMaxTokens: 0 };
    expect(getModelTokenLimit("claude-opus-5", cfg)).toBe(200);
  });
});
