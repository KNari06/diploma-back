/**
 * Prompt for the release-readiness narrative — ADR-0012.
 *
 * Anti-fabrication is enforced structurally, not just by wording: the
 * requested output schema has NO verdict/status field, so there is nothing
 * for the model to contradict `computeReleaseVerdict`'s decision with. The
 * caller (release-narrative.service.ts) additionally drops any `bugId` in
 * `prioritizedActions` that isn't in the whitelist this prompt was given.
 */
import type { ReleaseVerdictStatus, ReleaseVerdictReason } from '@/types/testing.types';

export interface ReleaseNarrativeInput {
  verdict: ReleaseVerdictStatus;
  verdictReasons: ReleaseVerdictReason[];
  bugCounts: Record<string, number>;
  /** Hard-capped top 10, sorted severity then occurrences — never the full bug list. */
  topBugs: Array<{ id: string; title: string; severity: string; category: string; testCaseName: string; occurrences?: number }>;
  healthChecks: Array<{ category: string; severity: string; message: string }>;
  stats: { totalTests: number; passed: number; failed: number; skipped: number };
}

export function buildReleaseNarrativePrompt(input: ReleaseNarrativeInput): { system: string; user: string } {
  const system = `You are writing a short, factual summary of a QA regression run for a release-readiness report.

The verdict has ALREADY been decided by a separate, deterministic system: "${input.verdict}". This is FINAL.
- Do NOT state, imply, or restate a different verdict.
- Do NOT invent a bug, health check, or issue that is not present in the DATA block below.
- Only reference a bug by its exact "id" from the DATA block's topBugs list — never invent an id.
- If the DATA block is mostly empty (few/no bugs, no health failures), say so plainly — do not manufacture concerns to sound thorough.

Your job is ONLY to explain and prioritize the given facts for a human reader, in plain language a non-engineer can follow.

Respond with STRICT JSON matching exactly this shape (no extra fields, no markdown fences):
{
  "headline": string,               // one sentence, plain language, matches the given verdict's tone
  "prioritizedActions": [            // ordered by what to fix first; [] if there is nothing actionable
    { "bugId": string, "why": string }
  ],
  "summary": string                 // 2-4 sentences, references only the given data
}`;

  const user = `DATA:\n${JSON.stringify(input, null, 2)}`;

  return { system, user };
}
