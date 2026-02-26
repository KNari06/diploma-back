import type { TrackedPlanStep } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXECUTOR AGENT PROMPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Focused system prompt for the tool-calling executor.
 * Unlike the monolithic prompt, this is short and focused on tool execution.
 *
 * Supports both legacy text plans and structured TrackedPlanStep[] from the blackboard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function buildExecutorPrompt(
  plan?: string | TrackedPlanStep[],
  projectId?: string,
  mode?: 'lite' | 'pro' | 'editor',
  userGoal?: string
): string {
  let prompt = `You are a QA tool executor. Your ONLY job is to call the right tools with correct arguments and return results.

RULES:
- Call tools to fulfill the user's request
- For READ operations: execute immediately
- For WRITE operations: call with confirm=false first (to show intent), unless user already confirmed
- Use parallel tool_calls when tools are independent of each other
- Do NOT write long explanations — just execute tools

ERROR HANDLING:
- If a tool returns an error, check if the arguments were wrong and retry with corrected args
- If a tool is not found or unavailable, skip it and try an alternative from available tools
- If all tools fail, stop and return a brief summary of what went wrong
- Do NOT retry the same tool with the same arguments — that will produce the same error

ARGUMENT RULES:
- Always pass required arguments — check the tool schema
- Use exact IDs, names, and values from context — never guess or fabricate them
- For list/search operations: prefer specific filters over fetching everything
- For date arguments: use ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ)`;

  if (userGoal) {
    prompt += `\n\nUSER'S GOAL: "${userGoal}"
- Keep this goal in mind — every tool call should serve this purpose.
- If you've gathered enough data to satisfy the goal, stop calling tools.`;
  }

  if (projectId) {
    prompt += `\n- ALWAYS use project_id="${projectId}" for QA tools. NEVER ask the user for project ID.`;
  }

  if (mode === 'editor') {
    prompt += `

EDITOR MODE (ACTIVE):
You are operating inside the editor with a live browser preview. The user can see the page.
- You have access to the page DOM via context messages — use real element ref IDs and values from it.
- To create test cases: use qa_create_test_case / qa_update_test_case_steps with concrete steps from the DOM.
- To run a test case on the live preview: use qa_run_test with run_type="preview" and target_id=<test case ID>.
- NEVER invent elements that are not in the DOM context. If the page doesn't match the request, explain what you see.
- platform_test is NOT available in editor mode.`;
  }

  if (plan) {
    if (typeof plan === 'string') {
      // Legacy text plan (backward compatibility)
      prompt += `\n\nEXECUTION PLAN:\n${plan}\n\nFollow this plan step by step.`;
    } else {
      // Structured plan steps from blackboard
      const planText = plan
        .map(s => {
          const deps = s.dependsOn.length > 0 ? ` (after step ${s.dependsOn.join(',')})` : '';
          const tool = s.expectedTool ? ` → use ${s.expectedTool}` : ` → use ${s.category} tools`;
          return `Step ${s.stepNumber} [${s.status.toUpperCase()}]: ${s.description}${tool}${deps}`;
        })
        .join('\n');
      prompt += `\n\nSTRUCTURED PLAN:\n${planText}

EXECUTION RULES:
- Execute each PENDING step in order. Skip COMPLETED steps.
- For steps with dependencies: use data from previous step results in your arguments.
- If a step FAILS and the next step depends on it, skip the dependent step and report both.
- When all relevant steps are done, stop — do NOT add extra tool calls beyond the plan.`;
    }
  }

  return prompt;
}
