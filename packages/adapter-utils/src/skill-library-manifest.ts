import type { PaperclipSkillEntry } from "./server-utils.js";

/**
 * Flatten untrusted text to a single bounded line before it enters the
 * manifest. Skill keys and missing-source details can embed skill-authored
 * content (a hostile frontmatter name flows into materialization error
 * messages); a newline in either would let a skill append arbitrary
 * instruction lines to the agent's system context.
 */
function sanitizeManifestText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function buildSkillLibraryManifestMarkdown(input: {
  entries: readonly PaperclipSkillEntry[];
  desiredSkillKeys: ReadonlySet<string>;
}): string | null {
  const selected = input.entries.filter((entry) => input.desiredSkillKeys.has(entry.key));
  if (selected.length === 0) return null;
  const lines = selected
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => {
      const key = sanitizeManifestText(entry.key, 200);
      if (entry.sourceStatus === "missing") {
        const detail = entry.missingDetail ? sanitizeManifestText(entry.missingDetail, 200) : "";
        return `- ${key} — enabled but unavailable${detail ? `: ${detail}` : ""}`;
      }
      return `- ${key} — enabled`;
    });
  return ["## Assigned company skills", "", ...lines].join("\n");
}
