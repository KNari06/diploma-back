/**
 * Editor Resolver Prompts
 * AI prompts for semantic element matching in step editor
 */

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

/**
 * V4: Simplified prompt for fallback mode only
 * Primary matching is now done via multilingual embeddings
 * LLM is used for: ranking refinement and clarification text generation
 */
export const EDITOR_RESOLVER_SYSTEM_PROMPT = `You are an AI UI action resolver inside a browser testing editor.

YOUR GOAL:
- Understand the user's natural language command (ANY language is supported)
- Match it to the most semantically relevant UI element from the provided candidates
- Use your multilingual understanding - do NOT rely on hardcoded translations
- Never hallucinate elements that are not present
- Prefer asking for clarification over guessing when confidence is low

YOU DO NOT EXECUTE ACTIONS.
You only reason and propose:
- intent interpretation (in the same language as user's command)
- target element ranking with confidence (0.0-1.0)
- whether clarification is needed
- clarification question (in user's language)

CRITICAL RULES:
1. ONLY use refs from the provided candidates list - never invent refs
2. If no candidate matches semantically - return empty ranked array
3. If 2+ candidates match equally well - set needsClarification: true
4. Provide brief reasoning for each ranked candidate
5. Never invent element refs or attributes
6. Respond ONLY with valid JSON, no markdown or extra text
7. Clarification questions MUST be in the SAME LANGUAGE as user's command`;

// ============================================================================
// TYPES
// ============================================================================

export interface EditorResolverCandidate {
  ref: string;
  label: string;
  tag: string;
  role?: string;
  placeholder?: string;
  ariaLabel?: string;
  name?: string;
  type?: string;
}

export interface EditorResolverParams {
  userIntent: string;
  actionType: string;
  pageUrl: string;
  candidates: EditorResolverCandidate[];
}

export interface ResolverRankedCandidate {
  ref: string;
  confidence: number;
  reason: string;
}

export interface ResolverResponse {
  interpretation: string;
  ranked: ResolverRankedCandidate[];
  needsClarification: boolean;
  clarificationQuestion?: string;
}

// ============================================================================
// USER PROMPT BUILDER
// ============================================================================

export function buildEditorResolverUserPrompt(params: EditorResolverParams): string {
  const candidatesList = params.candidates
    .map((c, i) => {
      const attrs = [
        c.label && `label="${c.label}"`,
        c.role && `role="${c.role}"`,
        c.placeholder && `placeholder="${c.placeholder}"`,
        c.ariaLabel && `aria-label="${c.ariaLabel}"`,
        c.name && `name="${c.name}"`,
        c.type && `type="${c.type}"`,
      ]
        .filter(Boolean)
        .join(' ');
      return `${i + 1}. ref="${c.ref}" <${c.tag}> ${attrs}`;
    })
    .join('\n');

  return `USER COMMAND: "${params.userIntent}"
ACTION TYPE: ${params.actionType}
PAGE URL: ${params.pageUrl}

CANDIDATE ELEMENTS ON PAGE:
${candidatesList}

Analyze and respond with JSON:
{
  "interpretation": "what user wants to do",
  "ranked": [
    { "ref": "eXX", "confidence": 0.95, "reason": "brief explanation" }
  ],
  "needsClarification": false,
  "clarificationQuestion": null
}

If needsClarification is true, provide clarificationQuestion in user's language.`;
}

// ============================================================================
// RESPONSE PARSER
// ============================================================================

/**
 * Parse LLM response and validate refs against known candidates
 * Filters out any hallucinated refs not present in validRefs
 */
export function parseEditorResolverResponse(
  response: string,
  validRefs: string[]
): ResolverResponse | null {
  try {
    // Extract JSON from response (handles markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as ResolverResponse;

    // Validate required fields
    if (!parsed.interpretation || !Array.isArray(parsed.ranked)) {
      return null;
    }

    // Filter out hallucinated refs (only keep refs that exist in candidates)
    parsed.ranked = parsed.ranked.filter((r) => validRefs.includes(r.ref));

    // Ensure confidence is a number between 0 and 1
    parsed.ranked = parsed.ranked.map((r) => ({
      ...r,
      confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
    }));

    // Sort by confidence descending
    parsed.ranked.sort((a, b) => b.confidence - a.confidence);

    // Ensure needsClarification is boolean
    parsed.needsClarification = Boolean(parsed.needsClarification);

    return parsed;
  } catch {
    return null;
  }
}
