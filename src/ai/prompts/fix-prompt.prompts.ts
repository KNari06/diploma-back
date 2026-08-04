/**
 * Prompt builder for the developer fix-prompt.
 *
 * Produces ONE self-contained, paste-ready markdown prompt a developer drops
 * into an AI coding assistant (Copilot / Claude / Cursor) to fix a bug found by
 * a test run. BLACK-BOX: the model has no repo/source access, so it must
 * describe the failure from external evidence only and must NOT invent file
 * paths, function names, or stack frames.
 */

export interface FixPromptInput {
  bugTitle: string;
  bugDescription: string;
  severity: string;
  pageUrl?: string;
  failingSelector?: string;
  expectedResult?: string;
  actualResult?: string;
  reproSteps?: string[];
  rootCauseHint?: string;            // from aiSummary.rootCauseStep / failure classification
  // Bounded, NOT redacted — raw console lines and full request URLs (query
  // string included) straight off the run. They reach every surface the
  // resulting prompt does, which now includes auto-filed Jira issues.
  consoleErrors?: string[];
  networkErrors?: string[];          // e.g. "POST /api/checkout → 500"
  screenshotUrl?: string;
}

const SYSTEM_PROMPT = `You write ONE self-contained bug-fix prompt that a developer will paste into an AI coding assistant to fix the bug.

CONSTRAINTS:
- You have NO access to the application's source code. Describe the failure purely from the black-box evidence given (URL, selector, console/network output, expected vs actual, reproduction steps).
- Do NOT invent file paths, function names, stack frames, line numbers, or framework internals. If you don't know where in the code it is, say so and let the developer's tool locate it.
- Output MARKDOWN only — no preamble, no "here is the prompt", just the prompt itself.
- Keep it under ~350 words. Be concrete and actionable.

STRUCTURE (use these sections, omit any with no data):
## Bug: <title> [<severity>]
**Where:** <url / page> — element <selector>
**What happens:** <actual>
**Expected:** <expected>

### Reproduce
1. <steps>

### Evidence (black-box)
- Console: <console errors>
- Network: <network failures>
- Root cause (observed): <hint>
- Screenshot: <url>

### Your task
Reproduce the bug with the steps above, locate the code responsible, and fix it so the expected behavior holds. Add or update a test if appropriate.`;

export function buildFixPromptMessages(input: FixPromptInput): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`Bug title: ${input.bugTitle}`);
  lines.push(`Severity: ${input.severity}`);
  if (input.bugDescription) lines.push(`Description: ${input.bugDescription}`);
  if (input.pageUrl) lines.push(`Page URL: ${input.pageUrl}`);
  if (input.failingSelector) lines.push(`Failing element selector: ${input.failingSelector}`);
  if (input.expectedResult) lines.push(`Expected result: ${input.expectedResult}`);
  if (input.actualResult) lines.push(`Actual result: ${input.actualResult}`);
  if (input.reproSteps?.length) {
    lines.push(`Reproduction steps:\n${input.reproSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }
  if (input.rootCauseHint) lines.push(`Observed root cause: ${input.rootCauseHint}`);
  if (input.consoleErrors?.length) lines.push(`Console errors:\n${input.consoleErrors.map((e) => `- ${e}`).join('\n')}`);
  if (input.networkErrors?.length) lines.push(`Network failures:\n${input.networkErrors.map((e) => `- ${e}`).join('\n')}`);
  if (input.screenshotUrl) lines.push(`Screenshot URL: ${input.screenshotUrl}`);

  lines.push('\nWrite the paste-ready developer fix prompt now.');

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}
