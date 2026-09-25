import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFixState,
  loadSyncState,
  prEntry,
  markFixed,
  saveFixState,
  saveSyncState,
} from "../src/state";

const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "st-")), name);

describe("fix state on-disk shape", () => {
  // Cut-over risk: the Python worker must still parse what we write. Whitespace
  // differs from Python's json.dumps separators, so pin the exact bytes here.
  test("saveFixState writes compact JSON with no indent", () => {
    const f = tmpFile("fix.json");
    saveFixState(f, { "o/r": { "1": { sha: "abc", notified: false } } });
    expect(readFileSync(f, "utf8")).toBe('{"o/r":{"1":{"sha":"abc","notified":false}}}');
  });

  test("saveFixState writes stringified PR keys, never numbers", () => {
    const f = tmpFile("fix.json");
    const s: any = {};
    markFixed(s, "o/r", 42, "abc");
    saveFixState(f, s);
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8"))["o/r"])).toEqual(["42"]);
  });

  test("markFixed drops skip_reason and resets notified", () => {
    const f = tmpFile("fix.json");
    const s: any = {};
    prEntry(s, "o/r", 7).skip_reason = "infra down";
    prEntry(s, "o/r", 7).notified = true;
    markFixed(s, "o/r", 7, "newsha");
    saveFixState(f, s);
    expect(JSON.parse(readFileSync(f, "utf8"))["o/r"]["7"]).toEqual({
      sha: "newsha",
      notified: false,
    });
  });

  test("save then load round-trips", () => {
    const f = tmpFile("fix.json");
    const s: any = {};
    prEntry(s, "o/r", 3).sha = "deadbeef";
    saveFixState(f, s);
    expect(loadFixState(f)).toEqual(s);
  });
});

describe("sync state on-disk shape", () => {
  // The two files use DIFFERENT serializers on purpose; do not unify them.
  test("saveSyncState writes indent=1", () => {
    const f = tmpFile("sync.json");
    saveSyncState(f, { "a/b": {} });
    expect(readFileSync(f, "utf8")).toBe('{\n "a/b": {}\n}');
  });

  test("missing and corrupt sync state load the empty shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-"));
    expect(loadSyncState(join(dir, "none.json"))).toEqual({});
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(loadSyncState(bad)).toEqual({});
  });

  test("an unwritable sync state path does not throw", () => {
    expect(() => saveSyncState("/proc/definitely/not/writable.json", { "a/b": {} })).not.toThrow();
  });
});
