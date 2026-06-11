/**
 * Intent-understanding test dataset.
 *
 * A declarative corpus of "what the user typed" → "what the system should do".
 * Purpose: stress the intent classifier + scope guards + editor routing so we
 * can answer "does our logic actually understand what the user wants?" — both
 * by eye (read the table) and by an automated harness
 * (intent-understanding.test.ts) that feeds each `input`+`context` through
 * `parseUserIntent` and asserts the routed intent.
 *
 * This is the SOURCE OF TRUTH for expectations. When you add a new intent, a
 * new scope rule, or change routing, add/adjust cases here FIRST, then make
 * the system pass them.
 *
 * Ground truth references:
 *   - Intent set: src/api/chat/shared/handler-registry.ts (INTENT_HANDLERS)
 *   - Editor/mobile routing rules: src/ai/prompts/intent-and-chat-prompts.ts
 *   - Test-case scope blocklist: src/api/chat/shared/intent-parsing.ts
 *     (BLOCKED_IN_TEST_CASE_SCOPE) — blocked intents collapse to general_chat
 *   - Hard invariant #16 (per-test-case chat) in CLAUDE.md
 */

/** The 23 canonical chat intents (handler-registry.ts). */
export type ChatIntent =
  | 'platform_test'
  | 'api_test'
  | 'api_flow_test'
  | 'general_chat'
  | 'needs_clarification'
  | 'save_test'
  | 'run_regression'
  | 'run_plan'
  | 'run_module'
  | 'run_by_tag'
  | 'create_plan'
  | 'add_to_plan'
  | 'analyze_failure'
  | 'test_recommendations'
  | 'coverage_analysis'
  | 'editor_action'
  | 'mobile_test'
  | 'mobile_action'
  | 'mobile_agent'
  | 'flaky_report'
  | 'manage_schedule'
  | 'manage_module'
  | 'manage_plan';

/** Which surface the message arrives from — drives context flags + guards. */
export type Surface =
  | 'global' // workspace chat, no testCaseId
  | 'web_editor' // testCaseId set + web preview (mode=editor, previewSessionId)
  | 'mobile_editor'; // testCaseId set + mobile runner (mobileSessionId)

export interface IntentCase {
  /** Short label for the test report. */
  name: string;
  /** Exact text the user types. */
  input: string;
  /** Where the message comes from. */
  surface: Surface;
  /**
   * Intent the system SHOULD route to AFTER all guards (the intent that
   * actually reaches a handler). For blocked-in-scope intents this is the
   * collapsed result (general_chat), not what the raw classifier emits.
   */
  expectedIntent: ChatIntent;
  /**
   * Optional: the raw classifier output we expect BEFORE the scope guard
   * rewrites it. Use when the point of the case is "classifier says X but
   * scope collapses it to Y".
   */
  expectedRawIntent?: ChatIntent;
  /** What the user actually wants, in plain words — the bar for "understood". */
  wants: string;
  /** Why this case matters / what it guards against. */
  rationale: string;
  /** Language tag for multilingual coverage. */
  lang: 'en' | 'ru' | 'kz' | 'mixed';
}

// ════════════════════════════════════════════════════════════════════════════
// 1. GLOBAL CHAT — creating / running / managing across the workspace
// ════════════════════════════════════════════════════════════════════════════

export const GLOBAL_CASES: IntentCase[] = [
  {
    name: 'create web test from URL',
    input: 'Протестируй логин на https://app.example.com/login',
    surface: 'global',
    expectedIntent: 'platform_test',
    wants: 'Create + run a new UI test for the login page',
    rationale: 'URL + action verb → new platform test, not a question',
    lang: 'ru',
  },
  {
    name: 'question about past test ≠ command',
    input: 'А ты уже тестировал логин вчера?',
    surface: 'global',
    expectedIntent: 'general_chat',
    wants: 'Answer about history, NOT start a new test',
    rationale: 'Past-tense question must NOT trigger platform_test (keyword trap)',
    lang: 'ru',
  },
  {
    name: 'API test explicit',
    input: 'Test this API POST https://api.example.com/v1/users',
    surface: 'global',
    expectedIntent: 'api_test',
    wants: 'Run an API test against the endpoint',
    rationale: 'Endpoint + method → api_test',
    lang: 'en',
  },
  {
    name: 'run regression by descriptor',
    input: 'запусти все платежные тесты',
    surface: 'global',
    expectedIntent: 'run_regression',
    wants: 'Resolve "payment tests" → IDs and run them in background',
    rationale: 'Descriptor resolution + background run',
    lang: 'ru',
  },
  {
    name: 'run by tag (explicit)',
    input: 'run all tests tagged smoke',
    surface: 'global',
    expectedIntent: 'run_by_tag',
    wants: 'Run every test tagged smoke',
    rationale: 'Explicit "tagged" phrasing → run_by_tag',
    lang: 'en',
  },
  {
    name: 'run by tag (bare label)',
    input: 'run smoke',
    surface: 'global',
    expectedIntent: 'run_by_tag',
    wants: 'Run every test tagged smoke',
    rationale:
      'Run verb + bare tag label → run_by_tag (prompt rule 6a). Was ambiguous before the classifier learned the tag-run pattern.',
    lang: 'en',
  },
  {
    name: 'schedule management',
    input: 'каждый день в 9 утра гоняй регресс на проде',
    surface: 'global',
    expectedIntent: 'manage_schedule',
    wants: 'Create a daily 09:00 recurring schedule',
    rationale: 'Recurring cron phrasing → manage_schedule (two-phase confirm)',
    lang: 'ru',
  },
  {
    name: 'flaky report',
    input: 'какие тесты у меня флапают?',
    surface: 'global',
    expectedIntent: 'flaky_report',
    wants: 'List unreliable / inconsistent tests',
    rationale: 'Analytics read across the workspace',
    lang: 'ru',
  },
  {
    name: 'analyze a failure',
    input: 'why did the checkout test fail?',
    surface: 'global',
    expectedIntent: 'analyze_failure',
    wants: 'Explain the latest failure root cause',
    rationale: 'Failure analysis read',
    lang: 'en',
  },
  {
    name: 'coverage question',
    input: 'покрытие по чекауту нормальное?',
    surface: 'global',
    expectedIntent: 'coverage_analysis',
    wants: 'Report coverage for the checkout area',
    rationale: 'Coverage analytics read',
    lang: 'ru',
  },
  {
    name: 'pure chit-chat',
    input: 'привет, что ты умеешь?',
    surface: 'global',
    expectedIntent: 'general_chat',
    wants: 'Explain capabilities — no test action',
    rationale: 'Greeting / capability question → general_chat',
    lang: 'ru',
  },
  {
    name: 'compound request',
    input: 'протестируй логин и чекаут, потом собери план Release v2',
    surface: 'global',
    expectedIntent: 'platform_test',
    wants: 'Run step 1 (login) now, queue checkout + create_plan for next turns',
    rationale: 'Compound splitter: first sub-request runs, rest queue',
    lang: 'ru',
  },
];

// ════════════════════════════════════════════════════════════════════════════
// 2. WEB EDITOR (inside a test case, live preview) — invariant #16
//    Blocked intents must collapse to general_chat; editor flow handles
//    create/run/save on the CURRENT test case.
// ════════════════════════════════════════════════════════════════════════════

export const WEB_EDITOR_CASES: IntentCase[] = [
  {
    name: 'make a login test on this page',
    input: 'сделай мне тестирование логин кейса',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    expectedRawIntent: 'platform_test',
    wants:
      'Generate login IntentSteps from the live page, show them, run on preview, and on "save" UPDATE this test case',
    rationale:
      'platform_test is blocked in tc-scope → general_chat → editor flow builds+runs from page context',
    lang: 'ru',
  },
  {
    name: 'single action on the page',
    input: 'нажми кнопку войти',
    surface: 'web_editor',
    expectedIntent: 'editor_action',
    wants: 'Click the login button directly on the live preview',
    rationale: 'Single atomic action → editor_action fast-path',
    lang: 'ru',
  },
  {
    name: 'run the current test',
    input: 'запусти это на превью',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    wants: 'Run THIS test case / draft steps on the live preview (qa_run_draft_steps / qa_run_test preview)',
    rationale: 'Run phrasing in editor → general_chat sub-agent runs draft/saved steps',
    lang: 'ru',
  },
  {
    name: 'save = update THIS test (not new)',
    input: 'сохрани эти шаги',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    wants: 'Persist via qa_update_test_case_steps for THIS test case — never a duplicate qa_create_test_case',
    rationale: 'Invariant #16(c): scope-aware prompt routes save → update current test',
    lang: 'ru',
  },
  {
    name: 'blocked: run regression from inside a test',
    input: 'запусти всю регрессию',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    expectedRawIntent: 'run_regression',
    wants: 'Politely handle as chat — suite-level run is out of scope inside one test',
    rationale: 'run_regression ∈ BLOCKED_IN_TEST_CASE_SCOPE → general_chat',
    lang: 'ru',
  },
  {
    name: 'blocked: manage schedule from inside a test',
    input: 'поставь расписание на этот тест каждый час',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    expectedRawIntent: 'manage_schedule',
    wants: 'Handled as chat — scheduling is a workspace op, not per-test',
    rationale: 'manage_schedule blocked in tc-scope',
    lang: 'ru',
  },
  {
    name: 'page question uses live DOM',
    input: 'что на этой странице есть?',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    wants: 'Describe the current page from injected page context (elements/text)',
    rationale: 'Editor page-context (previewSessionId) feeds the answer',
    lang: 'ru',
  },
  {
    name: 'create AND run in one go',
    input: 'сделай тест на поиск и сразу запусти',
    surface: 'web_editor',
    expectedIntent: 'general_chat',
    wants: 'Generate search steps and run on preview immediately (no extra confirm)',
    rationale: 'Scope prompt "CREATE + RUN IN ONE GO" for explicit requests',
    lang: 'ru',
  },
];

// ════════════════════════════════════════════════════════════════════════════
// 3. MOBILE EDITOR (inside a test case, live emulator/runner)
//    mobile_action / mobile_agent are NOT blocked; force-route applies.
// ════════════════════════════════════════════════════════════════════════════

export const MOBILE_EDITOR_CASES: IntentCase[] = [
  {
    name: 'observe the mobile screen',
    input: 'что сейчас на экране?',
    surface: 'mobile_editor',
    expectedIntent: 'mobile_agent',
    wants: 'Read the current screen via observe_mobile_page and answer',
    rationale: 'Mobile editor force-route → mobile_agent (never web general_chat)',
    lang: 'ru',
  },
  {
    name: 'single tap on device',
    input: 'tap the Skip button',
    surface: 'mobile_editor',
    expectedIntent: 'mobile_action',
    wants: 'Tap the Skip element on the live device',
    rationale: 'A single atomic action on the device → mobile_action (the fast-path); mobile_agent is for multi-step/observation',
    lang: 'en',
  },
  {
    name: 'build a mobile flow',
    input: 'создай тест на онбординг в этом приложении',
    surface: 'mobile_editor',
    expectedIntent: 'mobile_agent',
    wants: 'Plan + build onboarding steps against the live emulator',
    rationale: 'Mobile multi-step planning → mobile_agent (mobile_test is blocked in scope)',
    lang: 'ru',
  },
];

// ════════════════════════════════════════════════════════════════════════════
// 4. AMBIGUITY / TRAPS — where naive keyword matching breaks
// ════════════════════════════════════════════════════════════════════════════

export const TRAP_CASES: IntentCase[] = [
  {
    name: 'word "test" in a question, not a command',
    input: 'is this API tested already?',
    surface: 'global',
    expectedIntent: 'general_chat',
    wants: 'Answer a yes/no question — do NOT start an api_test',
    rationale: 'Question form > keyword "API"/"test"',
    lang: 'en',
  },
  {
    name: 'cross-language element intent (capot)',
    input: 'type my email into the Почта field',
    surface: 'web_editor',
    expectedIntent: 'editor_action',
    wants: 'Type into the email input even though its label is Russian',
    rationale: 'English intent vs localized label — must still resolve the field',
    lang: 'mixed',
  },
  {
    name: 'bare affirmative without pending context',
    input: 'да, запускай',
    surface: 'web_editor',
    expectedIntent: 'needs_clarification',
    wants: 'With NO prior steps in context, ask WHAT to run',
    rationale:
      'Confirmation ("да, запускай") is handled by the pending-state interceptor BEFORE intent parsing (Redis pending preview). This isolated harness has no pending state, so the classifier correctly asks to clarify. The real confirm path is covered by the manage-confirm / draft-run flow, not here. Documents the boundary: a bare affirmative is only meaningful WITH pending context.',
    lang: 'ru',
  },
  {
    name: 'cancel a multi-step flow',
    input: 'хватит, отмена',
    surface: 'global',
    expectedIntent: 'general_chat',
    wants: 'Abort the pending compound queue cleanly',
    rationale: 'Cyrillic cancel phrase (unicode boundary)',
    lang: 'ru',
  },
  {
    name: 'vague request needs clarification',
    input: 'протестируй',
    surface: 'global',
    expectedIntent: 'needs_clarification',
    wants: 'Ask WHAT to test — too vague to act',
    rationale: 'No target, no URL → clarify instead of guessing',
    lang: 'ru',
  },
];

// ════════════════════════════════════════════════════════════════════════════
// 5. KAZAKH (kk) — verify the third product language routes like ru/en
// ════════════════════════════════════════════════════════════════════════════

export const KAZAKH_CASES: IntentCase[] = [
  {
    name: 'kk: create web test from URL',
    input: 'repetino.kz сайтында тіркелуді тексер',
    surface: 'global',
    expectedIntent: 'platform_test',
    wants: 'Create a UI test for registration on the site',
    rationale: 'Kazakh command + URL → platform_test (LLM is language-agnostic)',
    lang: 'kz',
  },
  {
    name: 'kk: run regression by descriptor',
    input: 'төлем тесттерін іске қос',
    surface: 'global',
    expectedIntent: 'run_regression',
    wants: 'Resolve "payment tests" (kk descriptor) → run them',
    rationale: 'Kazakh descriptive phrase → run_regression, not run_by_tag',
    lang: 'kz',
  },
  {
    name: 'kk: greeting is chitchat',
    input: 'сәлеметсіз бе',
    surface: 'global',
    expectedIntent: 'general_chat',
    wants: 'Respond as conversation — no test action',
    rationale: 'Kazakh greeting → general_chat (central CHITCHAT list)',
    lang: 'kz',
  },
  {
    name: 'kk: single action on the page',
    input: 'кіру батырмасын бас',
    surface: 'web_editor',
    expectedIntent: 'editor_action',
    wants: 'Click the login button on the live preview',
    rationale: 'Kazakh single action in editor → editor_action',
    lang: 'kz',
  },
  {
    name: 'kk: vague request needs clarification',
    input: 'тексер',
    surface: 'global',
    expectedIntent: 'needs_clarification',
    wants: 'Ask WHAT to test — bare "check" is too vague',
    rationale: 'No target → clarify (parity with ru "протестируй")',
    lang: 'kz',
  },
];

/** Every case, flattened — what the harness iterates. */
export const ALL_INTENT_CASES: IntentCase[] = [
  ...GLOBAL_CASES,
  ...WEB_EDITOR_CASES,
  ...MOBILE_EDITOR_CASES,
  ...TRAP_CASES,
  ...KAZAKH_CASES,
];
