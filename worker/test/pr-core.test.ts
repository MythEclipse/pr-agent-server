import { describe, expect, test } from "bun:test";
import { analyzeReviewSafety } from "../src/pr/safety";
import { toolchainPinViolation } from "../src/pr/pins";
import { checkCiPassed } from "../src/pr/ci";
import { findReviewComment, findTrivialNoReviewMarker, triggerReview } from "../src/pr/review";
import { gatherOpenPrs } from "../src/pr/scan";
import { closeStaleCiPr } from "../src/pr/ci";
import { closeToolchainPr } from "../src/pr/pins";
import { createHmac } from "node:crypto";
import type { GhAppClient, GhClient } from "../src/pr/scan";

describe("safety", () => {
  const clean = "🔒 No security concerns identified\n⚡ No major issues detected\n🧪 No relevant tests\n⏱️ Estimated effort to review [1-5]: 1 🔵⚪⚪⚪⚪";
  test("clean review passes with score >= 6", () => {
    const r = analyzeReviewSafety(clean);
    expect(r.safe).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(6);
  });
  test("an error body blocks", () => {
    expect(analyzeReviewSafety("Failed to generate").safe).toBe(false);
    expect(analyzeReviewSafety("RetryError").safe).toBe(false);
    expect(analyzeReviewSafety("traceback").safe).toBe(false);
  });
  test("a security concern blocks", () => {
    expect(analyzeReviewSafety("🔒 Security concerns: SQL injection risk").safe).toBe(false);
  });
  test("a major issue blocks", () => {
    expect(analyzeReviewSafety("⚡ Breaking change detected").safe).toBe(false);
  });
  test("empty body blocks", () => {
    expect(analyzeReviewSafety("").safe).toBe(false);
  });
});

describe("toolchain pins", () => {
  test("flags a disallowed major on a pinned package", () => {
    expect(toolchainPinViolation("asepharyana/nextjs-template", "chore(deps): bump typescript from 5.9.0 to 7.0.0"))
      .toEqual(["typescript", "5.9.0", "7.0.0"]);
  });
  test("allows the pinned major", () => {
    expect(toolchainPinViolation("asepharyana/nextjs-template", "chore(deps-dev): bump typescript from 6.0.0 to 6.1.0")).toBeNull();
  });
  test("ignores repos without pins", () => {
    expect(toolchainPinViolation("o/r", "chore(deps): bump typescript from 5.0.0 to 7.0.0")).toBeNull();
  });
});

describe("ci gate", () => {
  const api = (data: unknown) => ({ request: async () => ({ status: 200, data }) }) as any;
  test("no checks configured passes", async () => {
    expect(await checkCiPassed(api({ check_runs: [] }), "t", "o/r", "sha")).toEqual({ ok: true, msg: "✅ No CI configured — skipping CI gate" });
  });
  test("failure blocks", async () => {
    const r = await checkCiPassed(api({ check_runs: [{ name: "ci", conclusion: "failure", status: "completed" }] }), "t", "o/r", "sha");
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("ci");
  });
  test("pending blocks", async () => {
    const r = await checkCiPassed(api({ check_runs: [{ name: "ci", conclusion: null, status: "in_progress" }] }), "t", "o/r", "sha");
    expect(r.ok).toBe(false);
  });
  test("all green passes", async () => {
    expect((await checkCiPassed(api({ check_runs: [{ name: "ci", conclusion: "success", status: "completed" }] }), "t", "o/r", "sha")).ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Everything below is this task's own coverage of the behaviour the brief's
// table does not reach: the comment finders, the close-PR request sequences,
// the scan fan-out, and triggerReview's wire contract.
// ═══════════════════════════════════════════════════════════════════════════

/** Records every call so a test can assert the exact request sequence. */
type Call = { method: string; path: string; token?: string; json?: unknown };

function recorder(
  handler: (call: Call, n: number) => { status: number; data: unknown } = () => ({ status: 200, data: {} }),
): { api: GhClient; calls: Call[] } {
  const calls: Call[] = [];
  const api: GhClient = {
    async request(method, path, opts) {
      const call = { method, path, token: opts?.token, json: opts?.json };
      calls.push(call);
      return handler(call, calls.length) as any;
    },
  };
  return { api, calls };
}

describe("safety — detail beyond the brief table", () => {
  test("an empty body reports the Python's own reason strings", () => {
    // Python line 354: `return False, ["❌ No review"], 0`.
    expect(analyzeReviewSafety("")).toEqual({ safe: false, reasons: ["❌ No review"], score: 0 });
  });
  test("an error body names the pattern that tripped it", () => {
    // Python line 359: the reason embeds the matched pattern verbatim.
    expect(analyzeReviewSafety("all good\nInternal Server Error happened")).toEqual({
      safe: false,
      reasons: ["❌ Review error: Internal Server Error"],
      score: 0,
    });
  });
  test("an unclear section costs a point rather than blocking", () => {
    // Security present but neither "no concerns" nor a danger marker.
    const r = analyzeReviewSafety("🔒 unclear\n⚡ unclear\n⏱️ effort: 2");
    expect(r.reasons).toEqual(["⚠️ Security unclear", "⚠️ Issues unclear"]);
    expect(r.score).toBe(4); // 5 -1 -1 +1
    expect(r.safe).toBe(false); // 4 < 6, so this one blocks
  });
  test("effort >= 4 on the same line costs a point", () => {
    // The effort regex is LAZY (`.*?(\d+)`) and `.` does not cross a newline, so
    // it reads the FIRST digit on the ⏱️ line only.
    const r = analyzeReviewSafety(
      "🔒 No security concerns identified\n⚡ No major issues detected\n⏱️ 4 of 5 files to review",
    );
    expect(r.reasons).toContain("⚠️ Large PR (effort: 4)");
    expect(r.score).toBe(8); // 5 +2 +2 -1
  });
  test("a later line's digit does not leak into the effort score", () => {
    // Line-scoping proof: a 9 on the following line must be invisible to the
    // ⏱️ pattern. With the dot unescaped and non-newline-matching, effort = 1.
    const r = analyzeReviewSafety(
      "🔒 No security concerns identified\n⚡ No major issues detected\n⏱️ Estimated effort to review: 1\n9 files changed",
    );
    expect(r.reasons.some((x) => x.startsWith("⚠️ Large PR"))).toBe(false);
    expect(r.score).toBe(10);
  });
  test("tests missing costs a point but does not block", () => {
    const r = analyzeReviewSafety(
      "🔒 No security concerns identified\n⚡ No major issues detected\n🧪 tests missing for the new branch\n⏱️ effort: 1",
    );
    expect(r.reasons).toContain("⚠️ Tests missing");
    expect(r.safe).toBe(true);
  });
  test("an unclear section can push a review below the threshold", () => {
    // 5 -1 (security) -1 (issues) -1 (tests) -1 (effort 5) = 1 → blocked.
    const r = analyzeReviewSafety("🔒 ?\n⚡ ?\n🧪 Test required\n⏱️ effort: 5");
    expect(r.safe).toBe(false);
    expect(r.score).toBe(1);
  });
  test("the reachable score range is 1..10, so neither clamp in safety.ts can bind", () => {
    // WHAT THIS PINS, precisely. `Math.max(0, Math.min(10, score))` is a
    // byte-for-byte port of Python line 390 and stays in safety.ts. This test
    // does NOT claim to exercise the floor — it proves the floor is
    // unreachable, and pins the real bounds:
    //   * every body that REACHES the clamp scores in 1..10, so `max(0, ·)` is
    //     dead defensive code against the current scoring and
    //   * 10 is the maximum, reached at the all-clear body, so `min(10, ·)`
    //     passes that value through unchanged.
    // The two clamping-zero paths (a security concern, a major issue) are the
    // EARLY RETURNS at lines 97 / 107 — they never reach line 137, which is
    // why they are excluded from the enumeration below.
    const SEC = { clear: "🔒 No security concerns identified", unclear: "🔒 ?" };
    const ISS = { clear: "⚡ No major issues detected", unclear: "⚡ ?" };
    const TST = { absent: null, missing: "🧪 tests missing", irrelevant: "🧪 No relevant tests" };
    const EFF = { absent: null, small: "⏱️ effort: 1", large: "⏱️ effort: 4" };

    const reached: number[] = [];
    for (const s of Object.values(SEC))
      for (const i of Object.values(ISS))
        for (const t of Object.values(TST))
          for (const e of Object.values(EFF)) {
            const body = [s, i, t, e].filter(Boolean).join("\n");
            reached.push(analyzeReviewSafety(body).score);
          }
    // The bound itself. Run against the REAL Python (line 390) this array is
    // [1..10] there too — see the task-12 fix report for the cross-check.
    expect([...new Set(reached)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Every all-negative path converges on 1: 5 −1 (security) −1 (issues)
    // −1 (tests) −1 (effort). The rating is 5 vs 9, and it makes NO difference,
    // which is the fact the old "second missing-tests hit" comment invented a
    // mechanism for and never had.
    expect(analyzeReviewSafety("🔒 ?\n⚡ ?\n🧪 Test required\n⏱️ effort: 5").score).toBe(1);
    expect(analyzeReviewSafety("🔒 ?\n⚡ ?\n🧪 Test required\n⏱️ effort: 9").score).toBe(1);

    // The ceiling: 5 +2 (security clean) +2 (issues clear) +1 (small effort).
    expect(
      analyzeReviewSafety("🔒 No security concerns identified\n⚡ No major issues detected\n⏱️ effort: 1")
        .score,
    ).toBe(10);
  });
});

describe("toolchain pins — the full map", () => {
  const REPO = "asepharyana/nextjs-template";
  test("every pinned package is enforced", () => {
    // Python lines 510-520, transcribed package for package.
    for (const [pkg, major] of [
      ["typescript", 6],
      ["eslint", 9],
      ["eslint-config-next", 16],
      ["eslint-plugin-react", 7],
      ["@tsparticles/react", 3],
      ["@tsparticles/engine", 3],
      ["@tsparticles/slim", 3],
    ] as const) {
      expect(toolchainPinViolation(REPO, `chore(deps): bump ${pkg} from 1.0.0 to ${major + 1}.0.0`)).toEqual([
        pkg,
        "1.0.0",
        `${major + 1}.0.0`,
      ]);
      expect(toolchainPinViolation(REPO, `chore(deps): bump ${pkg} from 1.0.0 to ${major}.4.2`)).toBeNull();
    }
  });
  test("a non-pinned package in a pinned repo is ignored", () => {
    expect(toolchainPinViolation(REPO, "chore(deps): bump left-pad from 1.0.0 to 9.0.0")).toBeNull();
  });
  test("the title must match the whole dependabot shape", () => {
    expect(toolchainPinViolation(REPO, "Bump typescript from 5.9.0 to 7.0.0")).toBeNull();
    expect(toolchainPinViolation(REPO, "chore: bump typescript from 5.9.0 to 7.0.0")).toBeNull();
    expect(toolchainPinViolation(REPO, "chore(deps): bump typescript to 7.0.0")).toBeNull();
  });
  test("a malformed version fails open instead of throwing", () => {
    // DELIBERATE DIVERGENCE from Python line 538, which does
    // `int(new_ver.split(".")[0])` and raises ValueError on a version whose
    // first segment is empty — a raised exception would abort the whole tick.
    // Probed against the real function: "to .9" raises in Python.
    expect(toolchainPinViolation(REPO, "chore(deps): bump typescript from 1.0.0 to .9")).toBeNull();
    expect(toolchainPinViolation(REPO, "chore(deps): bump typescript from 1.0.0 to ..7")).toBeNull();
  });
  test("a trailing-dot version still flags like Python", () => {
    // `int("7")` is 7 in both languages: not a divergence, a real violation.
    expect(toolchainPinViolation(REPO, "chore(deps): bump typescript from 1.0.0 to 7.")).toEqual([
      "typescript",
      "1.0.0",
      "7.",
    ]);
  });
});

describe("ci gate — messages and guard", () => {
  test("names up to three failures are joined", async () => {
    const r = await checkCiPassed(
      {
        request: async () => ({
          status: 200,
          data: {
            check_runs: [
              { name: "typecheck", conclusion: "failure", status: "completed" },
              { name: "build", conclusion: "failure", status: "completed" },
              { name: "lint", conclusion: "failure", status: "completed" },
              { name: "fourth", conclusion: "failure", status: "completed" },
            ],
          },
        }),
      },
      "t",
      "o/r",
      "sha",
    );
    // Python line 403: `failed[:3]` then ", ".join.
    expect(r).toEqual({ ok: false, msg: "CI FAILED: typecheck, build, lint" });
  });
  test("pending names up to three are joined", async () => {
    const r = await checkCiPassed(
      {
        request: async () => ({
          status: 200,
          data: { check_runs: [{ name: "typecheck", status: "queued" }] },
        }),
      },
      "t",
      "o/r",
      "sha",
    );
    expect(r).toEqual({ ok: false, msg: "CI pending: typecheck" });
  });
  test("a failure outranks a pending run", async () => {
    const r = await checkCiPassed(
      {
        request: async () => ({
          status: 200,
          data: {
            check_runs: [
              { name: "late", status: "in_progress" },
              { name: "boom", conclusion: "failure", status: "completed" },
            ],
          },
        }),
      },
      "t",
      "o/r",
      "sha",
    );
    expect(r.msg).toBe("CI FAILED: boom");
  });
  test("all green reports the count", async () => {
    const r = await checkCiPassed(
      {
        request: async () => ({
          status: 200,
          data: {
            check_runs: [
              { name: "a", conclusion: "success", status: "completed" },
              { name: "b", conclusion: "neutral", status: "completed" },
            ],
          },
        }),
      },
      "t",
      "o/r",
      "sha",
    );
    expect(r).toEqual({ ok: true, msg: "✅ 2 checks green" });
  });
  test("a transport failure (status 0, empty data) is treated as no CI", async () => {
    const r = await checkCiPassed({ request: async () => ({ status: 0, data: {} }) }, "t", "o/r", "sha");
    expect(r).toEqual({ ok: true, msg: "✅ No CI configured — skipping CI gate" });
  });
  test("a non-object body is treated as no CI", async () => {
    const r = await checkCiPassed({ request: async () => ({ status: 200, data: null }) }, "t", "o/r", "sha");
    expect(r.ok).toBe(true);
  });
  test("the check-runs path and the installation token are used", async () => {
    const { api, calls } = recorder();
    await checkCiPassed(api, "tok", "o/r", "abc123");
    expect(calls).toEqual([
      { method: "GET", path: "/repos/o/r/commits/abc123/check-runs", token: "tok", json: undefined },
    ]);
  });
});

describe("closeStaleCiPr", () => {
  test("comments first, then PATCHes the PR closed", async () => {
    const { api, calls } = recorder();
    const r = await closeStaleCiPr(api, "tok", "o/r", 7, "some title", "CI FAILED: typecheck");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/o/r/issues/7/comments",
      "PATCH /repos/o/r/pulls/7",
    ]);
    expect(calls[0].json).toEqual({ body: expect.stringContaining("**stale failing CI**") });
    expect(calls[0].json).toEqual({ body: expect.stringContaining("CI has been failing for 2+ days") });
    expect(calls[0].json).toEqual({ body: expect.stringContaining("`CI FAILED: typecheck`") });
    expect(calls[1].json).toEqual({ state: "closed" });
    expect(calls.every((c) => c.token === "tok")).toBe(true);
    expect(r).toEqual({ status: 200, commentStatus: 200 });
  });
  test("a failed comment does not stop the close", async () => {
    const { api, calls } = recorder((c) =>
      c.method === "POST" ? { status: 422, data: { message: "nope" } } : { status: 200, data: {} },
    );
    const r = await closeStaleCiPr(api, "tok", "o/r", 7, "t", "CI pending: ci");
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ status: 200, commentStatus: 422 });
  });
  test("a failed close reports the close status", async () => {
    const { api } = recorder((c) =>
      c.method === "POST" ? { status: 201, data: {} } : { status: 403, data: {} },
    );
    expect(await closeStaleCiPr(api, "tok", "o/r", 7, "t", "m")).toEqual({
      status: 403,
      commentStatus: 201,
    });
  });
});

describe("closeToolchainPr", () => {
  test("comments first, then PATCHes the PR closed", async () => {
    const { api, calls } = recorder();
    const r = await closeToolchainPr(api, "tok", "o/r", 12, "typescript", "5.9.0", "7.0.0");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/o/r/issues/12/comments",
      "PATCH /repos/o/r/pulls/12",
    ]);
    expect(calls[0].json).toEqual({ body: expect.stringContaining("**toolchain pin violation**") });
    expect(calls[0].json).toEqual({ body: expect.stringContaining("`typescript` 5.9.0 → 7.0.0") });
    expect(calls[0].json).toEqual({ body: expect.stringContaining("it will **not** be merged") });
    expect(calls[1].json).toEqual({ state: "closed" });
    expect(calls.every((c) => c.token === "tok")).toBe(true);
    expect(r).toEqual({ status: 200, commentStatus: 200 });
  });
  test("a failed comment does not stop the close", async () => {
    const { api, calls } = recorder((c) =>
      c.method === "POST" ? { status: 500, data: {} } : { status: 200, data: {} },
    );
    const r = await closeToolchainPr(api, "tok", "o/r", 12, "eslint", "9.0.0", "10.0.0");
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ status: 200, commentStatus: 500 });
  });
});

describe("findReviewComment", () => {
  const guide = "## PR Reviewer Guide 🔍\n🔒 No security concerns identified";
  test("returns the bot comment body containing the guide", async () => {
    const { api, calls } = recorder(() => ({
      status: 200,
      data: [
        { user: { login: "dependabot[bot]" }, body: "bump stuff" },
        { user: { login: "mytheclipsebotreview[bot]" }, body: guide },
      ],
    }));
    expect(await findReviewComment(api, "tok", "o/r", 7)).toBe(guide);
    expect(calls).toEqual([
      { method: "GET", path: "/repos/o/r/issues/7/comments", token: "tok", json: undefined },
    ]);
  });
  test("matches a login CONTAINING the bot login", async () => {
    // Python line 326: `if BOT_LOGIN in login` — a substring test, not equality.
    const { api } = recorder(() => ({
      status: 200,
      data: [{ user: { login: "prefix-mytheclipsebotreview-suffix" }, body: guide }],
    }));
    expect(await findReviewComment(api, "tok", "o/r", 7)).toBe(guide);
  });
  test("a bot comment without the guide is skipped, and null is the default", async () => {
    const { api } = recorder(() => ({
      status: 200,
      data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: "PR Code Suggestions" }],
    }));
    expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull();
  });
  test("another author's guide does not count", async () => {
    const { api } = recorder(() => ({
      status: 200,
      data: [{ user: { login: "somebody-else" }, body: guide }],
    }));
    expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull();
  });
  test("a non-array response is null", async () => {
    const { api } = recorder(() => ({ status: 200, data: { message: "Not Found" } }));
    expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull();
  });
  test("a comment with no user or body does not throw", async () => {
    const { api } = recorder(() => ({ status: 200, data: [{}, { user: {} }] }));
    expect(await findReviewComment(api, "tok", "o/r", 7)).toBeNull();
  });
});

describe("findTrivialNoReviewMarker", () => {
  const marker = "## PR Code Suggestions\n\nNo code suggestions found";
  test("true only when both markers are in a bot comment", async () => {
    const { api } = recorder(() => ({
      status: 200,
      data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: marker }],
    }));
    expect(await findTrivialNoReviewMarker(api, "tok", "o/r", 7)).toBe(true);
  });
  test("one marker alone is not enough", async () => {
    const onlySuggestions = recorder(() => ({
      status: 200,
      data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: "## PR Code Suggestions" }],
    }));
    expect(await findTrivialNoReviewMarker(onlySuggestions.api, "tok", "o/r", 7)).toBe(false);
    const onlyEmpty = recorder(() => ({
      status: 200,
      data: [{ user: { login: "mytheclipsebotreview[bot]" }, body: "No code suggestions found" }],
    }));
    expect(await findTrivialNoReviewMarker(onlyEmpty.api, "tok", "o/r", 7)).toBe(false);
  });
  test("both markers from a different author is false", async () => {
    const { api } = recorder(() => ({
      status: 200,
      data: [{ user: { login: "dependabot[bot]" }, body: marker }],
    }));
    expect(await findTrivialNoReviewMarker(api, "tok", "o/r", 7)).toBe(false);
  });
  test("a non-array response is false", async () => {
    const { api } = recorder(() => ({ status: 200, data: { message: "Not Found" } }));
    expect(await findTrivialNoReviewMarker(api, "tok", "o/r", 7)).toBe(false);
  });
});

describe("gatherOpenPrs", () => {
  /** Installs 1 and 2; the target repo lives under install 2 only. */
  function appApi(pulls: unknown): { api: GhAppClient; calls: Call[] } {
    const calls: Call[] = [];
    const api: GhAppClient = {
      async request(method, path, opts) {
        calls.push({ method, path, token: opts?.token, json: opts?.json });
        if (path === "/app/installations") {
          return { status: 200, data: [{ id: 1 }, { id: 2 }] } as any;
        }
        if (path === "/installation/repositories") {
          return {
            status: 200,
            data: {
              repositories:
                opts?.token === "tok-2"
                  ? [{ full_name: "owner/target" }]
                  : [{ full_name: "owner/other" }],
            },
          } as any;
        }
        return { status: 200, data: pulls } as any;
      },
      async installationToken(installId: number) {
        return `tok-${installId}`;
      },
    };
    return { api, calls };
  }

  test("fans out installs → repos → pulls and pairs each PR with its token", async () => {
    const { api, calls } = appApi([{ number: 5 }]);
    const out = await gatherOpenPrs(api);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /app/installations",
      "GET /installation/repositories",
      "GET /repos/owner/other/pulls?state=open&per_page=20&sort=updated",
      "GET /installation/repositories",
      "GET /repos/owner/target/pulls?state=open&per_page=20&sort=updated",
    ]);
    expect(out).toEqual([
      { token: "tok-1", repo: "owner/other", pr: { number: 5 } },
      { token: "tok-2", repo: "owner/target", pr: { number: 5 } },
    ]);
  });
  test("an empty installation list yields nothing", async () => {
    const api: GhAppClient = {
      request: async () => ({ status: 200, data: [] }),
      installationToken: async () => "tok",
    };
    expect(await gatherOpenPrs(api)).toEqual([]);
  });
  test("a non-array installs body yields nothing (transport failure sentinel)", async () => {
    const api: GhAppClient = {
      request: async () => ({ status: 0, data: {} }),
      installationToken: async () => "tok",
    };
    expect(await gatherOpenPrs(api)).toEqual([]);
  });
  test("an installation with no token is skipped", async () => {
    const api: GhAppClient = {
      request: async (method, path) =>
        path === "/app/installations"
          ? ({ status: 200, data: [{ id: 1 }] } as any)
          : ({ status: 200, data: { repositories: [{ full_name: "o/r" }] } } as any),
      installationToken: async () => "",
    };
    expect(await gatherOpenPrs(api)).toEqual([]);
  });
  test("a missing repositories field is an empty list", async () => {
    const api: GhAppClient = {
      request: async (method, path) =>
        path === "/app/installations"
          ? ({ status: 200, data: [{ id: 1 }] } as any)
          : ({ status: 200, data: {} } as any),
      installationToken: async () => "tok",
    };
    expect(await gatherOpenPrs(api)).toEqual([]);
  });
  test("a non-array pulls body contributes nothing", async () => {
    const { api } = appApi({ message: "API rate limit exceeded" });
    expect(await gatherOpenPrs(api)).toEqual([]);
  });
});

describe("triggerReview", () => {
  const SECRET = "s3cr3t-webhook-key";
  const REPO = "owner/target";
  const PR = 42;
  const NOW = 1_750_000_000;

  /**
   * The payload written INDEPENDENTLY of the implementation, with the Python's
   * key order (line 431-443). The test signs THIS string and then asserts the
   * exact bytes sent and the exact header, so neither can drift.
   */
  const expectedPayload = (installId: number) =>
    JSON.stringify({
      action: "opened",
      number: PR,
      sender: { login: "mytheclipsebotreview", id: 0, type: "Bot" },
      installation: { id: installId },
      pull_request: {
        url: `https://api.github.com/repos/${REPO}/pulls/${PR}`,
        number: PR,
        title: "feat: add a thing",
        state: "open",
        draft: false,
        labels: [],
        head: { sha: "deadbeef", ref: "feat/thing" },
        base: { ref: "main", repo: { full_name: REPO } },
      },
      repository: { full_name: REPO },
    });

  const expectedSig = (payload: string) =>
    `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;

  /** Fake fetch: records the call, answers 200. */
  function fakeFetch(): { fetchImpl: typeof fetch; calls: { url: string; init: any }[] } {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  function appApi(opts: { installs?: unknown; repos?: unknown; installToken?: string } = {}) {
    const calls: Call[] = [];
    const api: GhAppClient = {
      async request(method, path, o) {
        calls.push({ method, path, token: o?.token });
        if (path === "/app/installations") return { status: 200, data: opts.installs ?? [] } as any;
        if (path.startsWith("/installation/repositories")) {
          // Only installation 77 owns the target repo, so the walk must pass
          // over 1 and match on 77.
          return {
            status: 200,
            data:
              opts.repos ??
              (o?.token === "itok-77"
                ? { repositories: [{ full_name: REPO }] }
                : { repositories: [] }),
          } as any;
        }
        return { status: 200, data: {} } as any;
      },
      async installationToken(installId: number) {
        return opts.installToken ?? `itok-${installId}`;
      },
    };
    return { api, calls };
  }

  test("sends the full synthetic webhook with the exact headers and signature", async () => {
    const { api } = appApi();
    const { fetchImpl, calls } = fakeFetch();
    const r = await triggerReview(
      { api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
      REPO,
      PR,
      "feat: add a thing",
      "deadbeef",
      "feat/thing",
      "main",
    );
    expect(r).toBe(200);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://hook.test/hook");
    expect(init.method).toBe("POST");
    // Signed over EXACTLY the bytes sent, verified against an HMAC computed
    // here from a payload written out by hand.
    const payload = expectedPayload(0);
    expect(init.body).toBe(payload);
    expect(init.headers["x-hub-signature-256"]).toBe(expectedSig(payload));
    expect(init.headers["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(init.headers["x-github-event"]).toBe("pull_request");
    expect(init.headers["x-github-delivery"]).toBe(`cron-${NOW}-${PR}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  test("the payload carries every field PR-Agent's _check_pull_request_event needs", async () => {
    const { api } = appApi();
    const { fetchImpl, calls } = fakeFetch();
    await triggerReview(
      { api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
      REPO,
      PR,
      "feat: add a thing",
      "deadbeef",
      "feat/thing",
      "main",
    );
    const body = JSON.parse(calls[0].init.body);
    expect(Object.keys(body)).toEqual([
      "action",
      "number",
      "sender",
      "installation",
      "pull_request",
      "repository",
    ]);
    expect(body.action).toBe("opened");
    expect(body.number).toBe(PR);
    expect(body.pull_request.url).toBe(`https://api.github.com/repos/${REPO}/pulls/${PR}`);
    expect(body.pull_request.state).toBe("open");
    expect(body.pull_request.draft).toBe(false);
    expect(body.pull_request.labels).toEqual([]);
    expect(body.pull_request.head).toEqual({ sha: "deadbeef", ref: "feat/thing" });
    expect(body.pull_request.base).toEqual({ ref: "main", repo: { full_name: REPO } });
    expect(body.repository.full_name).toBe(REPO);
  });

  test("resolves the installation id from the repo's installation", async () => {
    const { api, calls } = appApi({ installs: [{ id: 1 }, { id: 77 }] });
    const { fetchImpl, calls: fetches } = fakeFetch();
    await triggerReview(
      { api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
      REPO,
      PR,
      "feat: add a thing",
      "deadbeef",
      "feat/thing",
      "main",
    );
    // The walk probes install 1 first, does not match, then matches on 77 —
    // so `/installation/repositories` is fetched TWICE (Python lines 423-428
    // break on match, they do not skip ahead).
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /app/installations",
      "GET /installation/repositories?per_page=100",
      "GET /installation/repositories?per_page=100",
    ]);
    expect(calls.map((c) => c.token)).toEqual([undefined, "itok-1", "itok-77"]);
    // Signature recomputed over the payload that now carries id 77.
    const payload = expectedPayload(77);
    expect(fetches[0].init.body).toBe(payload);
    expect(fetches[0].init.headers["x-hub-signature-256"]).toBe(expectedSig(payload));
  });

  test("a failed installation lookup degrades to id 0 and still posts", async () => {
    const api: GhAppClient = {
      request: async (method, path) => {
        if (path === "/app/installations") return { status: 200, data: [{ id: 1 }] } as any;
        throw new Error("boom");
      },
      installationToken: async () => "itok",
    };
    const { fetchImpl, calls } = fakeFetch();
    const r = await triggerReview(
      { api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
      REPO,
      PR,
      "t",
      "s",
      "h",
      "b",
    );
    expect(r).toBe(200);
    expect(JSON.parse(calls[0].init.body).installation.id).toBe(0);
  });

  test("a transport failure returns the Python's error string, not a throw", async () => {
    const { api } = appApi();
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await triggerReview(
      { api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
      REPO,
      PR,
      "t",
      "s",
      "h",
      "b",
    );
    expect(r).toBe("error: connect ECONNREFUSED");
  });

  test("the webhook URL and secret default to the Python's config values", async () => {
    const { api } = appApi();
    const { fetchImpl, calls } = fakeFetch();
    // Same arguments `expectedPayload` encodes, so the two payloads are the
    // same bytes and the signature below is a real comparison.
    await triggerReview(
      { api, fetchImpl, nowSec: NOW },
      REPO,
      PR,
      "feat: add a thing",
      "deadbeef",
      "feat/thing",
      "main",
    );
    expect(calls[0].url).toBe("https://pr-agent.asepharyana.my.id/api/v1/github_webhooks");
    // Default secret is "" — an HMAC over the empty key, not a missing header.
    const payload = expectedPayload(0);
    expect(calls[0].init.body).toBe(payload);
    expect(calls[0].init.headers["x-hub-signature-256"]).toBe(
      `sha256=${createHmac("sha256", "").update(payload).digest("hex")}`,
    );
  });

  test("a non-2xx status is returned verbatim for the caller to judge", async () => {
    const { api } = appApi();
    const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const r = await triggerReview(
      { api, fetchImpl, webhookSecret: SECRET, webhookUrl: "https://hook.test/hook", nowSec: NOW },
      REPO,
      PR,
      "t",
      "s",
      "h",
      "b",
    );
    expect(r).toBe(403);
  });
});
