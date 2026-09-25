// Snapshot test: the review prompts must render byte-identically to what the
// pre-refactor code produced (fixture captured from the old prompts.ts before
// Task 5 split it into prompts/). Regression guard for the split.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "../src/core/render";
import { REVIEW_SYSTEM_TEMPLATE, REVIEW_USER_TEMPLATE } from "../src/prompts/review";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "review-prompt.snapshot.txt"), "utf8");

// Same vars as test/review.test.ts "review prompts render with real vars",
// with the fixture's exact date.
const vars: Record<string, unknown> = {
  title: "T",
  branch: "b",
  description: "d",
  language: "TypeScript",
  diff: "DIFF",
  num_pr_files: 1,
  num_max_findings: 3,
  require_score: true,
  require_tests: true,
  require_estimate_effort_to_review: true,
  require_estimate_contribution_time_cost: false,
  require_can_be_split_review: false,
  require_security_review: true,
  require_todo_scan: false,
  question_str: "",
  answer_str: "",
  extra_instructions: "",
  skills_context: "",
  repo_context: "",
  commit_messages_str: "1. c",
  custom_labels: "",
  enable_custom_labels: false,
  is_ai_metadata: false,
  related_tickets: [],
  duplicate_prompt_examples: false,
  date: "2026-09-25",
};

describe("prompt snapshot", () => {
  test("review templates render byte-identically to the pre-refactor fixture", () => {
    const out =
      renderTemplate(REVIEW_SYSTEM_TEMPLATE, vars) +
      "\n===USER===\n" +
      renderTemplate(REVIEW_USER_TEMPLATE, vars);
    expect(out).toBe(fixture);
  });
});