import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixState, prEntry, alreadyFixed, markFixed, markSkip, getSkipReason, wasSkipNotified, markSkipNotified } from "../src/state.ts";

describe("fix state", () => {
  test("missing file loads the empty shape", () => {
    expect(loadFixState(join(mkdtempSync(join(tmpdir(), "st-")), "none.json"))).toEqual({});
  });
  test("corrupt file loads the empty shape instead of throwing", () => {
    const f = join(mkdtempSync(join(tmpdir(), "st-")), "bad.json");
    writeFileSync(f, "{not json");
    expect(loadFixState(f)).toEqual({});
  });
  test("migrates the legacy bare-string entry", () => {
    const s: any = { "o/r": { "1": "abc123" } };
    prEntry(s, "o/r", 1);
    expect(s["o/r"]["1"].sha).toBe("abc123");
    expect(s["o/r"]["1"].notified).toBe(false);
  });
  test("skip reason is per head sha and notified once", () => {
    const s: any = {};
    markSkip(s, "o/r", 1, "sha1", "infra down");
    expect(getSkipReason(s, "o/r", 1, "sha1")).toBe("infra down");
    expect(getSkipReason(s, "o/r", 1, "sha2")).toBeFalsy();
    expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(false);
    markSkipNotified(s, "o/r", 1, "sha1");
    expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(true);
  });
  test("markFixed records the head sha", () => {
    const s: any = {};
    markFixed(s, "o/r", 1, "sha9");
    expect(alreadyFixed(s, "o/r", 1, "sha9")).toBe(true);
    expect(alreadyFixed(s, "o/r", 1, "other")).toBe(false);
  });
});
