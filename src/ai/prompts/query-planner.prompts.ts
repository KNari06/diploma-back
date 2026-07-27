/**
 * Query-planner prompt (retrieval planning).
 *
 * Given a task's summary + description, a cheap LLM extracts WHAT to search for
 * before we retrieve context — so a payment ticket pulls "checkout / Stripe /
 * validation" instead of only the literal ticket words. This is query-driven
 * RAG: the LLM plans terms in ONE pass, the CODE then executes the searches.
 * It is NOT a tool-using loop — the model never fetches anything itself.
 *
 * Anti-hallucination: terms/entities must be grounded in the ticket text; the
 * model must NOT invent product areas that aren't implied by the task.
 */

const SYSTEM_PROMPT = `You are a QA retrieval planner. Given a task, list the search terms that would surface the MOST relevant existing knowledge (test cases, past bugs, docs) for testing it.

Return JSON only:
{
  "searchTerms": ["short phrase", ...],   // 3-8 concrete phrases to search existing tests/bugs/docs
  "entities": ["feature/page/endpoint", ...], // named features, pages, endpoints, or components in the task
  "hypotheses": ["what might break / what to check", ...] // 0-4 short testable angles implied by the task
}

RULES:
- Ground everything in the task text. Do NOT invent features, pages, or endpoints that aren't mentioned or clearly implied.
- searchTerms are for semantic search — prefer domain phrases ("checkout flow", "password reset email") over generic words ("bug", "test", "issue").
- If the task is tiny/self-contained, return few terms — do NOT pad.
- Keep phrases short (2-5 words). No sentences.

EXAMPLES:

Task: "Payment form validation broken on checkout"
{"searchTerms":["checkout payment form","card validation","payment error handling","Stripe checkout"],"entities":["checkout page","payment form"],"hypotheses":["invalid card is not rejected","expiry/CVV validation missing","error message not shown"]}

Task: "Add a Copy link button to the share dialog"
{"searchTerms":["share dialog","copy link button","clipboard copy"],"entities":["share dialog"],"hypotheses":["clipboard copy fails","toast not shown"]}`;

export interface QueryPlanInput {
  summary: string;
  description?: string | null;
}

export function buildQueryPlanMessages(input: QueryPlanInput): { system: string; user: string } {
  const user = `TASK:
Summary: ${input.summary}
Description: ${input.description || '(none)'}

Return the retrieval plan as JSON.`;
  return { system: SYSTEM_PROMPT, user };
}

export { SYSTEM_PROMPT as QUERY_PLANNER_SYSTEM_PROMPT };
