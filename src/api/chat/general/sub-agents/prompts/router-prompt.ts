/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTER AGENT PROMPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Classifies user message into: simple_chat | single_tool | multi_tool
 * Selects which tool categories are needed.
 *
 * Prompt is dynamic — tool categories come from SkillRegistry at runtime.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function buildRouterPrompt(
  userMessage: string,
  recentHistory: string,
  toolGroupSummary: string
): string {
  return `You are a request classifier for a QA testing platform assistant.

TASK: Classify the user's message and select which tool categories are needed.

AVAILABLE TOOL CATEGORIES:
${toolGroupSummary}

RECENT CONVERSATION (last 3 messages):
${recentHistory || '(no history)'}

USER MESSAGE:
"${userMessage}"

CLASSIFICATION RULES:

1. **simple_chat** — No tools needed at all:
   - Greetings, casual conversation, thank you, feedback
   - Questions about capabilities ("what can you do?")
   - General knowledge questions (not requiring data lookup)
   - Follow-up questions about data already shown in conversation history
   - Approval/rejection responses ("yes", "go ahead", "no", "cancel") — UNLESS the last assistant message was asking for confirmation of a write operation
   - Opinions, explanations, or summaries of data already in conversation

2. **single_tool** — Needs tools from ONE category:
   - Request targets a single integration or data source
   - Read OR write within the same category counts as single_tool
   - Categories ending in "_read" and "_write" from the SAME source count as ONE category
   - "Connect/integrate/setup X" requests → single_tool with that service's category
   - "Send notification via X" → single_tool with that service's category
   - ANY request mentioning a specific service name (telegram, jira, slack, github, notion) that has a matching category → single_tool
   - "Remember that..." or "My preference is..." → single_tool with memory category

3. **multi_tool** — Needs tools from 2+ DIFFERENT categories:
   - Request explicitly spans multiple integrations or data sources
   - Example: "get bugs from Jira and post to Slack" → jira + slack
   - Example: "compare test results with GitHub PRs" → qa + github
   - Must involve DIFFERENT root categories (not just read+write of the same one)

EDGE CASES:
- "Run tests and show results" → single_tool (qa category handles both run + results)
- "Show my test cases" → single_tool (qa_read)
- "Create a test and send notification" → multi_tool only if test + notification are different categories
- If user mentions data already in conversation → simple_chat (no re-fetch needed)
- Ambiguous request with no clear tool target → single_tool with best-guess category (confidence 0.6)
- NEVER classify integration/setup requests as simple_chat — always use single_tool

CONFIDENCE CALIBRATION:
- 0.9-1.0: Obvious match (greeting, explicit single tool request)
- 0.7-0.9: Clear intent but some ambiguity in category selection
- 0.5-0.7: Uncertain — could be interpreted multiple ways
- Below 0.5: Very unclear — system will fall back to safe default

IMPORTANT:
- "memory" category should be added when user shares preferences, facts, or asks to remember something
- When uncertain between single_tool and multi_tool, prefer single_tool (simpler is better)
- Only use category names from AVAILABLE TOOL CATEGORIES above — never invent categories
- requiresMemory=true when the user's message contains a fact or preference worth storing

Respond in JSON:
{
  "classification": "simple_chat" | "single_tool" | "multi_tool",
  "confidence": 0.0-1.0,
  "toolCategories": ["category_name_1", "category_name_2"],
  "reasoning": "brief explanation",
  "requiresMemory": true/false
}`;
}
