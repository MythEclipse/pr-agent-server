// Whole-file diff fallback, used when GitHub returns no `patch` for a file
// (large or binary-ish diffs). Split out of github/provider.ts to keep that
// file inside the plan's ≤400-line rule for logic files.

export function buildLargeDiff(filename: string, baseContent: string, headContent: string): string {
  if (!baseContent && !headContent) return "";
  if (baseContent === headContent) return "";
  const baseLines = baseContent.split("\n");
  const headLines = headContent.split("\n");
  // Simple whole-file diff: present as full add or full delete
  if (!baseContent) {
    return `@@ -0,0 +1,${headLines.length} @@\n${headLines.map((l) => "+" + l).join("\n")}`;
  }
  if (!headContent) {
    return `@@ -1,${baseLines.length} +0,0 @@\n${baseLines.map((l) => "-" + l).join("\n")}`;
  }
  // fallback: whole-file replace (approximation)
  return `@@ -1,${baseLines.length} +1,${headLines.length} @@\n${baseLines
    .map((l) => "-" + l)
    .concat(headLines.map((l) => "+" + l))
    .join("\n")}`;
}
