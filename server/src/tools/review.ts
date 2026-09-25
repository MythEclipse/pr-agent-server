// PR Review tool — orchestrates the whole review: fetch PR, build diff,
// render prompts, call LLM, parse YAML, render markdown, publish.
// Port of pr_agent.tools.pr_reviewer.

import type { Config } from "../config";
import { GitHubProvider } from "../github";
import { getPrDiff, clipTokens } from "../diff";
import { countPromptTokens } from "../core/token";
import { renderTemplate } from "../core/render";
import { REVIEW_SYSTEM_TEMPLATE, REVIEW_USER_TEMPLATE } from "../prompts/review";
import { loadYaml } from "../core/yaml";
import { convertToMarkdownV2 } from "../core/markdown";
import { callWithFallback } from "../llm";
import { publishPersistent } from "./publish";

export interface ReviewResult {
  markdown: string;
  data: Record<string, unknown> | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  remainingFiles: string[];
  diff: string;
  status: string;
}

export async function runReview(
  cfg: Config,
  repoOwner: string,
  repoName: string,
  prNumber: number,
  privateKeyPem: string,
  opts?: {
    publish?: boolean;
    extraInstructions?: string;
  },
): Promise<ReviewResult> {
  const provider = new GitHubProvider(cfg, repoOwner, repoName, prNumber, privateKeyPem);
  const pr = await provider.getPr();
  const files = await provider.getDiffFiles();

  // main language
  let languages: Record<string, number> = {};
  try {
    languages = await provider.getLanguages();
  } catch {
    languages = {};
  }
  const mainLanguage = getMainPrLanguage(languages, files);

  const description = await provider.getPrDescription(true);
  const branch = await provider.getPrBranch();
  const commitMessagesStrRaw = await provider.getCommitMessagesStr(cfg.maxCommitsTokens);
  const commitMessagesStr = clipTokens(commitMessagesStrRaw, cfg.maxCommitsTokens);
  const title = pr.title;
  const date = new Date().toISOString().slice(0, 10);

  const r = cfg.prReviewer;
  const vars: Record<string, unknown> = {
    title,
    branch,
    description,
    language: mainLanguage,
    diff: "",
    num_pr_files: files.length,
    num_max_findings: r.numMaxFindings,
    require_score: r.requireScoreReview,
    require_tests: r.requireTestsReview,
    require_estimate_effort_to_review: r.requireEstimateEffortToReview,
    require_estimate_contribution_time_cost: r.requireEstimateContributionTimeCost,
    require_can_be_split_review: r.requireCanBeSplitReview,
    require_security_review: r.requireSecurityReview,
    require_todo_scan: r.requireTodoScan,
    question_str: "",
    answer_str: "",
    extra_instructions: opts?.extraInstructions ?? r.extraInstructions,
    skills_context: "",
    repo_context: "",
    commit_messages_str: commitMessagesStr,
    custom_labels: "",
    enable_custom_labels: false,
    is_ai_metadata: false,
    related_tickets: [],
    duplicate_prompt_examples: false,
    date,
  };

  // prompt tokens
  const promptTokens = countPromptTokens(
    REVIEW_SYSTEM_TEMPLATE,
    REVIEW_USER_TEMPLATE,
    vars,
    renderTemplate,
  );

  // build diff with token budget (reuses prompt tokens); main-language files
  // are ordered first inside getPrDiff using the languages fetched above
  const { diff, remainingFiles } = getPrDiff(files, promptTokens, cfg.modelReview, cfg, languages);

  // render final prompts with diff
  const systemPrompt = renderTemplate(REVIEW_SYSTEM_TEMPLATE, { ...vars, diff });
  const userPrompt = renderTemplate(REVIEW_USER_TEMPLATE, { ...vars, diff });

  // LLM call with per-model retry + fallback models
  const llm = await callWithFallback({
    models: [cfg.modelReview, ...cfg.fallbackModels],
    system: systemPrompt,
    user: userPrompt,
    temperature: cfg.temperature,
    cfg,
  });

  // parse YAML (resilient)
  const keysFix = [
    "ticket_compliance_check",
    "estimated_effort_to_review_[1-5]:",
    "security_concerns:",
    "key_issues_to_review:",
    "relevant_file:",
    "relevant_line:",
    "suggestion:",
  ];
  let data = loadYaml(llm.content, keysFix, "review", "security_concerns") as Record<string, unknown> | null;
  // loadYaml returns { review: ... } — keep as is
  if (data && !("review" in data) && "review" in (data as object)) {
    data = { review: (data as { review: unknown }).review };
  }

  // render markdown
  const markdown = data && "review" in data
    ? convertToMarkdownV2(data as { review: Record<string, unknown> }, true, r.enableIntroText)
    : "";

  // publish
  if (opts?.publish !== false) {
    if (markdown) {
      // persistent comment (replace prev "## PR Reviewer Guide 🔍")
      if (r.persistentComment) {
        await publishPersistent(provider, markdown, "## PR Reviewer Guide 🔍", "review", r.finalUpdateMessage);
      } else {
        await provider.publishComment(markdown);
      }
    }
  }

  return {
    markdown,
    data,
    model: llm.model,
    promptTokens: llm.usage.promptTokens || promptTokens,
    completionTokens: llm.usage.completionTokens,
    cachedTokens: llm.usage.cachedTokens,
    remainingFiles,
    diff,
    status: "success",
  };
}

function getMainPrLanguage(
  languages: Record<string, number>,
  files: { filename: string }[],
): string {
  if (!languages || Object.keys(languages).length === 0 || !files.length) return "";
  const top = Object.entries(languages).sort((a, b) => b[1] - a[1])[0][0].toLowerCase();
  const ext = files[0].filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    python: "Python", typescript: "TypeScript", javascript: "JavaScript",
    go: "Go", rust: "Rust", java: "Java", csharp: "C#", cpp: "C++", ruby: "Ruby",
    php: "PHP", swift: "Swift", kotlin: "Kotlin", shell: "Shell", html: "HTML",
    css: "CSS", vue: "Vue", scala: "Scala",
  };
  const extLang: Record<string, string> = {
    py: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    go: "go", rs: "rust", java: "java", cs: "csharp", cpp: "cpp", rb: "ruby",
    php: "php", swift: "swift", kt: "kotlin", sh: "shell", bash: "shell",
    html: "html", css: "css", vue: "vue", scala: "scala",
  };
  const langOfExt = extLang[ext] || "";
  if (langOfExt && langOfExt === top) return map[top] || top;
  return langOfExt ? map[langOfExt] || langOfExt : (map[top] || top);
}