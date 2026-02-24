/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXECUTOR AGENT PROMPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Focused system prompt for the tool-calling executor.
 * Unlike the monolithic prompt, this is short and focused on tool execution.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function buildExecutorPrompt(
  plan?: string,
  projectId?: string
): string {
  let prompt = `You are a QA tool executor. Your ONLY job is to call the right tools with correct arguments and return results.

RULES:
- Call tools to fulfill the user's request
- For READ operations: execute immediately
- For WRITE operations: call with confirm=false first (to show intent), unless user already confirmed
- Use parallel tool_calls when tools are independent
- Do NOT write long explanations — just execute tools
- If a tool fails, try an alternative approach or report the error`;

  if (projectId) {
    prompt += `\n- ALWAYS use project_id="${projectId}" for QA tools. NEVER ask the user for project ID.`;
  }

  if (plan) {
    prompt += `\n\nEXECUTION PLAN:\n${plan}\n\nFollow this plan step by step.`;
  }

  return prompt;
}
