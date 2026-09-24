// Generated/invalid file detection and patch-skip rules.

import type { Config } from "../config";

const AUTO_GENERATED_EXACT = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "go.sum",
  ".terraform.lock.hcl",
  "uv.lock",
  "Cargo.lock",
  "Pipfile.lock",
  "mix.lock",
  "pubspec.lock",
  "bun.lockb",
]);
const AUTO_GENERATED_SUFFIXES = [".min.js", ".min.css", ".js.map", ".ts.map", ".css.map"];

// Bad extensions: subset of pr_agent's large map. Kept small but functional;
// configurable via env if needed.
const BAD_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "gz", "tar", "7z", "rar", "pdf", "wasm", "mp3", "mp4", "mov",
  "avi", "mkv", "exe", "dll", "so", "bin",
]);

export function isGeneratedOrInvalidFile(filename: string): boolean {
  if (!filename) return false;
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  if (AUTO_GENERATED_EXACT.has(base)) return true;
  if (AUTO_GENERATED_SUFFIXES.some((s) => filename.endsWith(s))) return true;
  const ext = filename.split(".").pop() ?? "";
  return BAD_EXTENSIONS.has(ext);
}

export function shouldSkipPatch(filename: string, cfg?: Config): boolean {
  const skip = cfg?.patchExtensionSkipTypes ?? [".md", ".txt"];
  return skip.some((t) => filename.endsWith(t));
}
