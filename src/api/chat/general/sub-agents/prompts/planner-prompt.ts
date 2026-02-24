/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLANNER AGENT PROMPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Creates execution plan for multi-tool tasks.
 * Only used when Router classifies as multi_tool.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function buildPlannerPrompt(
  userMessage: string,
  toolDescriptions: string
): string {
  return `You are a task planner for a QA testing platform. Create a step-by-step execution plan.

USER REQUEST: "${userMessage}"

AVAILABLE TOOL CATEGORIES:
${toolDescriptions}

Create a plan with ordered steps. Each step should:
1. Be a single logical action (one tool call or related group)
2. Specify which tool category it uses
3. Note dependencies (what must complete first)

RULES:
- READ before WRITE (get data before acting on it)
- Keep plans minimal — only necessary steps
- For write operations, include a confirmation step

Respond in JSON:
{
  "summary": "brief plan description",
  "steps": [
    {
      "stepNumber": 1,
      "description": "what this step does",
      "category": "tool_category",
      "expectedTool": "optional_tool_name_hint",
      "dependsOn": []
    }
  ]
}`;
}
