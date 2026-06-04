/**
 * Request-Understanding Prompts
 *
 * Three cooperating prompts that turn a raw user message into a fully-specified,
 * routable request — the "understanding layer" that lets the autonomous QA agent
 * complete vague/contextual/compound requests instead of collapsing them to
 * needs_clarification or general_chat.
 *
 *   ANALYZE  — decompose: single vs sequence, extract a typed targetSelector
 *              and executionModifiers. Folds into the main intent classification
 *              call (no extra round-trip).
 *   IMPROVE  — route-selection: dedicated intent vs general_chat tool-pipeline,
 *              plus typed params for management intents. Also folds into the
 *              main call.
 *   ENRICH   — resolve: given resolver candidates + session context, pick the
 *              concrete IDs, fill defaults, and clarify AT MOST ONE field.
 *              Runs as a conditional second call only when resolution is
 *              ambiguous or a referential expression is unresolved.
 *
 * Design rules (see .claude/rules/prompt-optimization.md):
 *   - Context-first: understand intent, never keyword-match.
 *   - Output is strict JSON; field names English; values in the user's language.
 *   - Every prompt carries reasoning examples ("CONTEXT: ... → output").
 *
 * SECURITY: these prompts receive test metadata (names/urls/tags) and session
 * descriptors ONLY — never step bodies, never resolved {{secrets.*}} values.
 */

// ============================================================================
// SHARED TYPES (structured outputs)
// ============================================================================

export type TargetSelectorType =
  | 'test_case'
  | 'module'
  | 'plan'
  | 'flow'
  | 'tag'
  | 'keyword'
  | 'url'
  | 'element'
  | 'none';

export type ExecutionEnv = 'local' | 'staging' | 'prod';

export interface ExecutionModifiers {
  browser?: 'chromium' | 'firefox' | 'webkit';
  device?: string; // free-text device label, e.g. "iPhone 14"
  env?: ExecutionEnv;
  build?: string; // app build id / version
}

export interface AnalyzeResult {
  isCompound: boolean;
  subRequests: Array<{ text: string; order: number; dependsOnPrevious: boolean }>;
  targetSelector: { type: TargetSelectorType; value: string } | null;
  executionModifiers: ExecutionModifiers | null;
}

export interface EnrichInputCandidate {
  id: string;
  name: string;
  url?: string;
  tags?: string[];
}

export interface EnrichSessionContext {
  lastTestId?: string;
  lastTestGoal?: string;
  lastFailedTestId?: string;
  recentTestIds?: string[];
  projectDefaultUrl?: string;
}

export interface EnrichResult {
  resolvedTargetIds: string[];
  filledDefaults: ExecutionModifiers;
  needsClarification: boolean;
  clarificationField: string | null;
  clarificationQuestion: string | null;
  clarificationOptions: string[] | null;
}

// ============================================================================
// ANALYZE + IMPROVE — folded into the main intent-classification call
// ============================================================================

/**
 * Extension block appended to `buildIntentPrompt`. It adds the ANALYZE +
 * IMPROVE fields to the SAME JSON the classifier already returns, so there is
 * NO extra LLM round-trip for the common case. The fields land in the parsed
 * result and are lifted into IntentResult.metadata + targetSelector/
 * executionModifiers downstream.
 */
export function buildUnderstandingExtension(): string {
  return `
--- REQUEST UNDERSTANDING (ADDITIONAL FIELDS) ---

Beyond classifying the intent, ANALYZE the message and add these fields to the SAME JSON object.
Think about what the user actually wants — do NOT pattern-match on words.

1) COMPOUND DETECTION — "analysis.isCompound" + "analysis.subRequests"
   A request is compound when it asks for MORE THAN ONE distinct action that the
   system would handle as separate steps ("test login AND signup", "run smoke
   then send the report", "create a plan then run it"). A single action with
   several details is NOT compound ("test the login form with email and password"
   is one test).
   • isCompound=false → omit subRequests (or []).
   • isCompound=true  → subRequests = ordered list. Set dependsOnPrevious=true
     when a step needs a previous step's output (e.g. "...then save them as a
     plan" depends on the tests created before it).

2) TARGET SELECTOR — "analysis.targetSelector"
   When the message refers to test entities by DESCRIPTION rather than an explicit
   id, extract a typed selector so the system can resolve it to concrete ids:
     • type: "tag"      → "critical tests", "smoke-tagged", "run the smoke ones"
     • type: "module"   → "the checkout module", "auth module tests"
     • type: "plan"     → "Release v2 plan", "my nightly regression"
     • type: "flow"     → "the password-reset flow"
     • type: "keyword"  → free-text describing tests: "payment tests", "оплата-тесты", "login tests"
     • type: "test_case"→ a specific named test: "the Checkout Happy Path test"
     • type: "url"      → a page/endpoint URL is the target
     • type: "element"  → a UI element (editor actions): "the submit button"
     • type: "none"     → no entity descriptor present
   "value" is the RAW descriptor exactly as the user expressed it (do NOT invent
   an id). Resolution to ids happens later, deterministically.

3) EXECUTION MODIFIERS — "analysis.executionModifiers"
   Extract run-time overrides when present, else null:
     • browser: "chromium" | "firefox" | "webkit"   (map "chrome"→chromium, "safari"→webkit)
     • device:  free text, e.g. "iPhone 14", "Pixel 7"
     • env:     "local" | "staging" | "prod"          (map "production"→prod)
     • build:   app build id / version string
   Only include keys that are actually stated.

3b) LOOKBACK WINDOW — "analysis.lookbackDays"
   For history/analysis requests over a time range ("flaky tests in the last 2
   weeks", "failures за последние 7 дней"), set the number of DAYS as an integer
   (2 weeks → 14, last week → 7, last month → 30). Omit when no range is stated.

4) ROUTE HINT (IMPROVE) — "analysis.routeHint"
   For management/query requests, hint how to route:
     • "dedicated"  → a first-class intent should handle it (run/save/plan/module/schedule)
     • "tool"       → general_chat tool-pipeline is the right place (open-ended data/analysis)
   Omit when not a management/query request.

5) MANAGEMENT PARAMS (IMPROVE) — "analysis.manage"
   ONLY when the intent is a management op (manage_schedule / manage_module /
   manage_plan), extract the typed params the handler needs. Omit otherwise.
     • action: the operation — schedule: create|update|activate|deactivate|delete;
       module: create|update; plan: create|update|add_item|remove_item.
     • name: entity name when stated ("a plan called Auth Smoke" → "Auth Smoke").
     • cronExpression: for schedules, a cron string when derivable ("every day at
       9am" → "0 9 * * *"); else omit and let the handler ask.
     • timezone: IANA tz when stated ("Almaty time" → "Asia/Almaty").
     • planName / moduleName: the plan/module the op targets, by name.
     • platformKey: module platform — web_ui | api | mobile.
     • priority: critical | high | medium | low (modules).
     • itemType / itemName: for plan add_item/remove_item (module|flow|test_case + its name).
   Use plain names, NEVER invent ids — the handler resolves names to ids.

Place all of the above under a single "analysis" object. Examples:

Ex(compound): "test app.io login and signup, then save both as a plan called Auth Smoke"
CONTEXT: three distinct actions, the save depends on the two tests.
→ "analysis": {
     "isCompound": true,
     "subRequests": [
       {"text": "test app.io login", "order": 1, "dependsOnPrevious": false},
       {"text": "test app.io signup", "order": 2, "dependsOnPrevious": false},
       {"text": "save both as a plan called Auth Smoke", "order": 3, "dependsOnPrevious": true}
     ],
     "targetSelector": null,
     "executionModifiers": null
   }

Ex(selector+modifier): "run the smoke tests on firefox against staging"
CONTEXT: selects tests by tag, with browser + env overrides.
→ "analysis": {
     "isCompound": false,
     "targetSelector": {"type": "tag", "value": "smoke"},
     "executionModifiers": {"browser": "firefox", "env": "staging"},
     "routeHint": "dedicated"
   }

Ex(keyword RU): "добавь мои оплата-тесты в план Release v2"
CONTEXT: selects tests by free-text descriptor; target plan named.
→ "analysis": {
     "isCompound": false,
     "targetSelector": {"type": "keyword", "value": "оплата-тесты"},
     "executionModifiers": null,
     "routeHint": "dedicated"
   }

Ex(plain): "what can you help me with?"
CONTEXT: conversational, no entities, no actions.
→ "analysis": {"isCompound": false, "targetSelector": null, "executionModifiers": null}
`;
}

// ============================================================================
// ENRICH — conditional second call
//
// WIRED in intent-target-resolution.ts (enrichAmbiguous): fires only on the
// deterministic resolver's `resolution: 'ambiguous'` path, narrowing candidates
// via one extra LLM call (candidate pick + referential grounding). Best-effort;
// only ever picks from the real candidate set.
// ============================================================================

/**
 * Build the ENRICH prompt. Invoked only when the deterministic resolver returns
 * ambiguous candidates, or a referential expression ("them", "that plan", "the
 * last failing test") needs session context to ground. Its job is to COMPLETE
 * the request from available signal, asking the user only when truly stuck —
 * and then only ONE question.
 */
export function buildEnrichPrompt(params: {
  message: string;
  descriptor?: string;
  candidates: EnrichInputCandidate[];
  session: EnrichSessionContext;
  missingModifiers?: Array<keyof ExecutionModifiers>;
  userLanguage?: 'en' | 'ru' | 'neutral';
}): string {
  const { message, descriptor, candidates, session, missingModifiers } = params;

  const candidateLines = candidates.length
    ? candidates
        .map(
          (c, i) =>
            `  ${i + 1}. id=${c.id} | "${c.name}"${c.url ? ` | ${c.url}` : ''}${
              c.tags?.length ? ` | tags: ${c.tags.join(', ')}` : ''
            }`,
        )
        .join('\n')
    : '  (none)';

  const sessionLines = [
    session.lastTestId ? `  lastTestId: ${session.lastTestId}${session.lastTestGoal ? ` ("${session.lastTestGoal}")` : ''}` : null,
    session.lastFailedTestId ? `  lastFailedTestId: ${session.lastFailedTestId}` : null,
    session.recentTestIds?.length ? `  recentTestIds: ${session.recentTestIds.join(', ')}` : null,
    session.projectDefaultUrl ? `  projectDefaultUrl: ${session.projectDefaultUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n') || '  (no session context)';

  return `You are the request-enrichment stage of an autonomous QA agent. Your job is to COMPLETE the user's request from the signal already available, and to ask the user a question ONLY when something genuinely cannot be inferred.

USER MESSAGE:
"${message}"

${descriptor ? `DESCRIPTOR the user used to select tests: "${descriptor}"` : ''}

CANDIDATE TESTS the resolver already found (choose from THESE — do not invent ids):
${candidateLines}

SESSION CONTEXT (use it to resolve "them"/"that"/"the last one"/"again"):
${sessionLines}

${missingModifiers?.length ? `MISSING EXECUTION MODIFIERS that could be defaulted: ${missingModifiers.join(', ')}` : ''}

HOW TO DECIDE:
1. Resolve referential expressions from SESSION CONTEXT first ("the last failing test" → lastFailedTestId; "them"/"those" → the candidates the prior turn referred to).
2. If the descriptor maps clearly to one or several candidates, set resolvedTargetIds to their ids (it is fine to return MANY ids when the user means a set — "all my payment tests").
3. Fill sensible defaults for missing modifiers (browser→chromium, env→the project default if known) into filledDefaults.
4. Ask a clarifying question ONLY for the SINGLE most important field that cannot be inferred. Never ask two questions. If everything is resolvable, needsClarification=false.

OUTPUT — strict JSON (field names English; question text in the user's language):
{
  "resolvedTargetIds": string[],          // ids chosen from the candidates above (may be empty)
  "filledDefaults": { "browser"?: "chromium"|"firefox"|"webkit", "env"?: "local"|"staging"|"prod", "device"?: string, "build"?: string },
  "needsClarification": boolean,
  "clarificationField": string | null,    // e.g. "target_test", "environment"
  "clarificationQuestion": string | null, // ONE question, user's language, or null
  "clarificationOptions": string[] | null // short pick-list when helpful, else null
}

EXAMPLES:

Message: "rerun the one that just failed"
SESSION: lastFailedTestId: tc_42
CONTEXT: pure reference to session → resolvable, no question.
→ {"resolvedTargetIds": ["tc_42"], "filledDefaults": {}, "needsClarification": false, "clarificationField": null, "clarificationQuestion": null, "clarificationOptions": null}

Message: "add my payment tests to the plan"
CANDIDATES: tc_1 "Checkout payment", tc_2 "Refund payment", tc_3 "Login"
CONTEXT: "payment tests" → the two payment candidates (a set), not the login one.
→ {"resolvedTargetIds": ["tc_1","tc_2"], "filledDefaults": {}, "needsClarification": false, "clarificationField": null, "clarificationQuestion": null, "clarificationOptions": null}

Message: "run the checkout test"
CANDIDATES: tc_5 "Checkout — guest", tc_6 "Checkout — logged in"
CONTEXT: two equally-plausible checkout tests, cannot pick → ONE question with options.
→ {"resolvedTargetIds": [], "filledDefaults": {}, "needsClarification": true, "clarificationField": "target_test", "clarificationQuestion": "Which checkout test do you mean?", "clarificationOptions": ["Checkout — guest", "Checkout — logged in"]}
`;
}
