import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { CANONICAL_XSS_PAYLOAD } from '@/services/testing/api/fuzzing/fuzzing-config';
import type { NegativeMeta, NegativeMutationType } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import * as negativeDb from './db/negative.db';

const VALID_MUTATION_TYPES: NegativeMutationType[] = [
  'empty_field',
  'invalid_format',
  'xss',
  'overflow',
  'double_submit',
  'skip_step',
  'wrong_credentials',
];

/**
 * Step types that carry a user-supplied `value` we can mutate (clear, replace
 * with a bad format / canonical payload). Value-injecting mutation types
 * (empty_field, invalid_format, xss, overflow, wrong_credentials) only make
 * sense on these. Mobile-only action types (open_app, swipe, biometric, otp,
 * permission, go_back, …) and clicks have no input value — mutating their
 * `value` produces a garbage step the runner can't execute, so the LLM's
 * choice is dropped rather than silently corrupting the step.
 */
const VALUE_MUTABLE_STEP_TYPES = new Set<string>([
  'type',
  'fill',
  'select',
  'check',
  'uncheck',
]);

/** Click-class types a double_submit (duplicate-and-resubmit) makes sense on. */
const CLICKABLE_STEP_TYPES = new Set<string>(['click', 'tap', 'double_tap', 'press']);

/**
 * Server-owned canonical payloads. The LLM decides WHICH step to mutate; the
 * server decides WHAT value to inject for security/boundary types so payloads
 * stay deterministic across runs (LLM-invented payloads vary per call and may
 * be malformed). See fuzzing-config.ts for the reflected-XSS probe set.
 */
// Overflow probe: long enough to blow past typical input/column limits
// (browser maxlength, varchar(255), textarea caps) and exercise server-side
// truncation/validation, while staying cheap to send and store.
const OVERFLOW_PAYLOAD_LENGTH = 10000;
const CANONICAL_OVERFLOW_PAYLOAD = 'a'.repeat(OVERFLOW_PAYLOAD_LENGTH);

interface GeneratedMutation {
  mutationType: NegativeMutationType;
  stepIndex: number;
  originalValue: string;
  mutatedValue: string;
  expectedBehavior: string;
  /** Why this step + attack is high-value. Quality signal + audit trail. */
  reasoning?: string;
}

const SYSTEM_PROMPT = `You are a senior QA engineer specializing in negative and boundary testing of web AND mobile applications.

GOAL: Given the happy-path steps of ONE test case, choose a SMALL set of HIGH-VALUE attacks — each one provoking a distinct failure-handling path the app should guard. Quality over quantity. You are not here to tick a box; a weak negative that always passes is worse than none.

UNDERSTAND THE FIELD FIRST. Each step carries identity signals: \`type\` (action), \`inputType\`, \`role\`, \`autocomplete\`, \`name\`, \`label\`, \`placeholder\`, \`nearText\`, \`elementDescription\` (an authored natural-language description — the strongest purpose hint), and the recorded \`value\`. Read them before mutating: an email, a password, a phone, an OTP, a free-text name each behave differently under bad input.

MUTATION TYPES:
- empty_field: clear a required field (mutatedValue = "")
- invalid_format: wrong format for the field's purpose (e.g. "not-an-email" for email, letters in a phone)
- xss: probe for reflected XSS — the SERVER supplies the payload, leave mutatedValue = "" (low value on native mobile inputs)
- overflow: extremely long input — the SERVER supplies the payload, leave mutatedValue = "" (low value on native mobile inputs)
- wrong_credentials: plausible-but-wrong value for an auth field (password/token/login)
- double_submit: a submit/confirm CLICK step clicked twice rapidly (idempotency)
- skip_step: remove a required step entirely

WHERE YOU MAY ATTACK (hard constraint):
- Value mutations (empty_field/invalid_format/xss/overflow/wrong_credentials) target ONLY steps that hold an input value: \`type\`/\`fill\`/\`select\`/\`check\`/\`uncheck\`. NEVER target navigation, taps, swipes, open_app, permission, scroll, or wait steps — they have no value and the mutation will be discarded.
- double_submit targets ONLY a click/tap/press step (a submit/confirm control).
- skip_step targets a required step whose removal should break the flow.

PRIORITIZATION (highest value first):
1. Authentication & security fields (password, token, login, OTP).
2. Validated inputs (email, phone, required fields, numeric/amount, payment).
3. Idempotency-sensitive submits (double_submit on a final confirm/pay).
Do NOT attack a field with no apparent validation just to produce a mutation. If nothing is worth attacking, return fewer — even zero — mutations.

SECURITY / BOUNDARY COVERAGE: on WEB, when a free-text field is likely reflected back or rendered (search query, name, comment, free-text field) include ONE xss probe; for any field with a length/format limit (codes, card, amount, names) include ONE overflow probe. These catch a different bug class than validation. On native MOBILE inputs xss/overflow are usually low value (no JS execution, hard client caps) — skip them unless the field is clearly a WebView or free-text area. Do not force xss/overflow where they make no sense.

RULES:
1. Mutate exactly ONE step per mutation. stepIndex must be a real index from the input.
2. No duplicate mutations (same mutationType + same stepIndex).
3. expectedBehavior must describe an OBSERVABLE error state the app should SHOW: a validation/error message visible on screen, staying on the same page, login NOT succeeding. The assertion checks the screen for this — do NOT describe the happy path.
4. LANGUAGE (strict): write expectedBehavior AND reasoning in the SAME human language the source UI uses — infer it from the steps' label / placeholder / value / description text. If that text is English, write in English. NEVER introduce a third language (e.g. do not answer in Spanish for an English/Russian app). When the language is genuinely ambiguous, default to English.
5. reasoning: one short sentence — why this step + attack is high-value.
6. Aim for the highest-value 3–6 mutations, not exhaustive coverage. Fewer strong negatives beat many weak ones.

OUTPUT: a single JSON object: { "mutations": [ ... ] }. No markdown, no prose.`;

const USER_PROMPT_TEMPLATE = `Test case: "{testCaseName}"
{platform}

Happy-path steps:

\`\`\`json
{steps}
\`\`\`

Return the mutations as a JSON object in this exact shape:
{
  "mutations": [
    {
      "mutationType": "empty_field",
      "stepIndex": 2,
      "originalValue": "user@example.com",
      "mutatedValue": "",
      "expectedBehavior": "Поле email обязательно — должна показаться ошибка валидации, форма не отправляется",
      "reasoning": "Email обязателен; пустое значение должно блокировать отправку"
    }
  ]
}`;

/**
 * Generates negative test cases by analyzing happy-path steps
 * and creating AI-powered boundary/negative mutations.
 */
export class NegativeTestGeneratorService {
  /**
   * Generate negative test cases for a given source (happy-path) test case.
   * Creates intent_test_cases rows with is_negative=true.
   *
   * @returns Created negative test case IDs
   */
  static async generateForTestCase(
    sourceTestCaseId: string,
    userId: string,
  ): Promise<string[]> {
    // 1. Load source test case
    const sourceCase = await negativeDb.getSourceTestCase(sourceTestCaseId);
    if (!sourceCase) {
      throw new Error(`Source test case not found: ${sourceTestCaseId}`);
    }

    const steps = sourceCase.steps_json;
    if (!Array.isArray(steps) || steps.length === 0) {
      logger.warn('[NEGATIVE_GEN] Source test case has no steps', { sourceTestCaseId });
      return [];
    }

    // Mobile negatives diverge in step-shape (no recordedInputType, mobile-only
    // action types) and in the ai_check verification source (a11y tree vs DOM).
    const isMobile = (sourceCase.platform ?? 'web').startsWith('mobile_');
    // Inherit the source's replay_strategy so the negative dispatches the same
    // way; fall back to the platform default if the source somehow lacks one.
    const replayStrategy =
      sourceCase.replay_strategy || (isMobile ? 'mobile_steps' : 'steps_editor');

    // 2. Generate mutations via AI
    const mutations = await this.generateMutations(steps, {
      isMobile,
      testCaseName: sourceCase.name,
    });
    if (mutations.length === 0) {
      logger.info('[NEGATIVE_GEN] No mutations generated', { sourceTestCaseId });
      return [];
    }

    // 3. Create negative test cases in DB
    const createdIds: string[] = [];
    for (const rawMutation of mutations) {
      try {
        // Normalize the injected value up-front so the built steps and the
        // persisted negative_meta agree (canonical payload for xss/overflow).
        const mutation: GeneratedMutation = {
          ...rawMutation,
          mutatedValue: this.resolveMutatedValue(rawMutation),
        };
        const negativeSteps = this.buildNegativeSteps(steps, mutation, isMobile);
        const name = `[NEG] ${sourceCase.name}: ${mutation.mutationType} on step ${mutation.stepIndex + 1}`;

        const createdId = await negativeDb.insertNegativeTestCase({
          projectId: sourceCase.project_id,
          userId,
          name,
          description: mutation.expectedBehavior,
          url: sourceCase.url || sourceCase.start_url,
          startUrl: sourceCase.start_url,
          stepsJson: negativeSteps,
          flowId: sourceCase.flow_id,
          sourceTestCaseId,
          negativeMeta: {
            mutationType: mutation.mutationType,
            mutatedStepIndex: mutation.stepIndex,
            originalValue: mutation.originalValue,
            mutatedValue: mutation.mutatedValue,
            expectedBehavior: mutation.expectedBehavior,
            ...(mutation.reasoning && { reasoning: mutation.reasoning }),
          } satisfies NegativeMeta,
          // Inherit source identity so the negative dispatches + runs like the
          // source (web vs mobile routing, param resolution, login setup, app
          // variant). Without these a mobile negative fails on setup, not on
          // the mutation. depends_on is omitted — mobile ignores it.
          platform: sourceCase.platform ?? 'web',
          replayStrategy,
          parametersSchema: sourceCase.parameters_schema,
          resourceBindings: sourceCase.resource_bindings,
          mobileVariantLabel: sourceCase.mobile_variant_label,
          hostPlatform: sourceCase.host_platform,
          triggers: sourceCase.triggers,
        });

        if (createdId) {
          createdIds.push(createdId);
        }
      } catch (err) {
        logger.error('[NEGATIVE_GEN] Error creating negative for mutation', {
          sourceTestCaseId,
          mutation: rawMutation?.mutationType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[NEGATIVE_GEN] Generated negative test cases', {
      sourceTestCaseId,
      sourceName: sourceCase.name,
      total: createdIds.length,
    });

    return createdIds;
  }

  /**
   * Delete existing negatives for a source test case (for regeneration).
   */
  static async deleteExistingNegatives(sourceTestCaseId: string): Promise<number> {
    return negativeDb.deleteNegativesBySource(sourceTestCaseId);
  }

  /**
   * Call AI to generate mutation list from happy-path steps.
   */
  private static async generateMutations(
    steps: any[],
    ctx: { isMobile: boolean; testCaseName: string },
  ): Promise<GeneratedMutation[]> {
    // Simplify steps for AI prompt — surface every field-identity signal the
    // recorder captures so the model understands each field's PURPOSE before
    // choosing an attack. Web steps carry recordedInputType; mobile steps do
    // not, so fall back to the a11y signals (role / label / placeholder /
    // nearText) the mobile recorder captures. recordedDescription is an
    // LLM-authored NL description ("password field in the login form") — the
    // single strongest purpose signal for icon-only / label-poor elements.
    const simplifiedSteps = steps.map((s, i) => {
      const hints = s.bindingHints || {};
      const inputType = s.recordedInputType || hints.type;
      return {
        index: i,
        type: s.type,
        description: s.description,
        value: s.value,
        ...(inputType && { inputType }),
        ...(hints.role && { role: hints.role }),
        ...(hints.autocomplete && { autocomplete: hints.autocomplete }),
        ...(hints.name && { name: hints.name }),
        ...(hints.label && { label: hints.label }),
        ...(hints.placeholder && { placeholder: hints.placeholder }),
        ...(hints.nearText && { nearText: hints.nearText }),
        ...(s.recordedDescription && { elementDescription: s.recordedDescription }),
      };
    });

    const platformLine = ctx.isMobile
      ? 'PLATFORM: mobile app (native/Flutter). Fields are identified by role / label / placeholder / nearText, not HTML input types. XSS/overflow rarely matter on native inputs — prefer empty/invalid/wrong-credentials and validation attacks. Only "type" steps hold an input value; do not target swipe/tap/open_app/permission steps with value mutations.'
      : 'PLATFORM: web. Standard HTML form semantics apply.';

    const userPrompt = USER_PROMPT_TEMPLATE.replace('{platform}', platformLine)
      .replace('{testCaseName}', ctx.testCaseName)
      .replace('{steps}', JSON.stringify(simplifiedSteps, null, 2));

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_TASK_MODELS.negativeGeneration,
          temperature: 0.3,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        },
      );

      const content = response.content;
      if (!content) return [];

      // Parse response. We ask for { "mutations": [...] } (json_object mode
      // forces an object root); tolerate a bare array as a defensive fallback.
      const parsed = JSON.parse(content);
      const mutations: any[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.mutations)
          ? parsed.mutations
          : [];

      // Validate and filter
      return mutations.filter((m): m is GeneratedMutation => {
        if (!m || typeof m !== 'object') return false;
        if (!VALID_MUTATION_TYPES.includes(m.mutationType)) return false;
        if (typeof m.stepIndex !== 'number' || m.stepIndex < 0 || m.stepIndex >= steps.length) return false;
        // expectedBehavior becomes the ai_check assertionText — must be non-empty
        // or the assertion fails validation at run time.
        if (typeof m.expectedBehavior !== 'string' || m.expectedBehavior.trim().length === 0) return false;
        return true;
      });
    } catch (err) {
      logger.error('[NEGATIVE_GEN] AI mutation generation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Build negative test steps by mutating one step in the happy path
   * and appending an ai_check assertion step.
   */
  private static buildNegativeSteps(
    originalSteps: any[],
    mutation: GeneratedMutation,
    isMobile: boolean,
  ): any[] {
    // Deep copy steps
    const steps = JSON.parse(JSON.stringify(originalSteps));

    // Strip any trailing ai_check the SOURCE case carried (exploration-sourced
    // cases now end with a positive expectedOutcome:'success' oracle). Left in
    // place, that positive check asserts the happy-path state on a flow we
    // deliberately BROKE — it can never pass, so the negative becomes
    // structurally unable to succeed. The negative's own error-oracle is
    // appended below; the source's happy oracle is meaningless here.
    while (steps.length > 0 && steps[steps.length - 1]?.type === 'ai_check') {
      steps.pop();
    }

    if (mutation.mutationType === 'skip_step') {
      // Remove the step entirely
      steps.splice(mutation.stepIndex, 1);
    } else if (mutation.mutationType === 'double_submit') {
      // Duplicate the click step. The duplicate is the one that should provoke
      // the rejection (idempotency / "already submitted"), so it carries the
      // expected-error marker.
      const step = steps[mutation.stepIndex];
      if (!step) {
        throw new Error(`double_submit target step ${mutation.stepIndex} missing`);
      }
      // Guard: duplicating a swipe / open_app / type produces a meaningless
      // "double submit". Only click-class steps model a real double-submit.
      if (!CLICKABLE_STEP_TYPES.has(step.type)) {
        throw new Error(
          `double_submit on non-clickable step type '${step.type}' — dropping mutation`,
        );
      }
      const duplicate = {
        ...step,
        id: `neg_dup_${Date.now().toString(36)}`,
        expectedOutcome: 'error' as const,
      };
      steps.splice(mutation.stepIndex + 1, 0, duplicate);
    } else {
      // Value-injecting mutation (empty_field / invalid_format / xss / overflow
      // / wrong_credentials). mutation.mutatedValue is already normalized by the
      // caller (canonical server payload for xss/overflow, LLM value otherwise).
      const step = steps[mutation.stepIndex];
      if (!step) {
        throw new Error(`mutation target step ${mutation.stepIndex} missing`);
      }
      // Guard (#A): only steps with an actual input value can be mutated.
      // The LLM occasionally targets a non-input step (esp. mobile-only types
      // like swipe / open_app / permission); mutating their `value` yields a
      // step the runner can't execute. Drop the mutation instead of corrupting.
      if (!VALUE_MUTABLE_STEP_TYPES.has(step.type)) {
        throw new Error(
          `${mutation.mutationType} on non-input step type '${step.type}' — dropping mutation`,
        );
      }
      step.value = mutation.mutatedValue;
      // Update description to reflect mutation
      step.description = `[MUTATED: ${mutation.mutationType}] ${step.description || ''}`;
      // Mark the mutated input as expecting an error outcome so the executor's
      // 4xx-aware branch (test-executor.ts) treats a same-origin validation
      // 4xx as a PASS, not a regression failure. Without this, an app that
      // CORRECTLY rejects the bad input flips allSuccess=false and the
      // negative fails for the wrong reason (inverted pass/fail).
      step.expectedOutcome = 'error';
    }

    // Append ai_check assertion step. assertionText is REQUIRED by both
    // executors (live apply + background replay converter) — omitting it makes
    // the assertion fail validation, so the negative never actually verifies.
    // aiContextMode html+a11y is enough for validation/error-message checks and
    // avoids the screenshot token cost of the default html+a11y+screenshot.
    // expectedOutcome:'error' carries the negative intent to the UI-level
    // assertion: this step verifies the app SHOWED an error / rejected the
    // input, it is NOT a positive happy-path assertion. For skip_step (no
    // mutated value step) this is the sole carrier of the negative expectation.
    // Platform-aware verification source:
    //  - web   → aiContextMode 'html+a11y' (DOM + a11y, no screenshot cost).
    //  - mobile → aiCheckSource 'tree': the runner's intent-step-converter maps
    //    ai_check + aiCheckSource to an `ai_visual_check` against the a11y tree
    //    (Gemini, OpenAI fallback). Without a source the runner degrades to a
    //    plain assert_text/assert_visible (no AI). 'tree' avoids the screenshot
    //    token cost while still doing a semantic check of the error state.
    const aiCheckOptions = isMobile
      ? { aiCheckSource: 'tree' as const }
      : { aiContextMode: 'html+a11y' as const };
    steps.push({
      id: `neg_check_${Date.now().toString(36)}`,
      type: 'ai_check',
      description: mutation.expectedBehavior,
      assertionText: mutation.expectedBehavior,
      value: mutation.expectedBehavior,
      expectedOutcome: 'error' as const,
      options: aiCheckOptions,
    });

    return steps;
  }

  /**
   * Resolve the value to inject for a value-mutating mutation. Security and
   * boundary types use server-owned canonical payloads so they stay
   * deterministic across runs; all other types use the LLM's chosen value.
   */
  private static resolveMutatedValue(mutation: GeneratedMutation): string {
    switch (mutation.mutationType) {
      case 'xss':
        return CANONICAL_XSS_PAYLOAD;
      case 'overflow':
        return CANONICAL_OVERFLOW_PAYLOAD;
      default:
        return mutation.mutatedValue;
    }
  }

  /**
   * Get count of existing (non-stale) negatives for a test case.
   */
  static async getNegativeCount(sourceTestCaseId: string): Promise<number> {
    return negativeDb.countFreshNegatives(sourceTestCaseId);
  }

  /**
   * Get all negative test cases for a source test case.
   */
  static async getNegativesForSource(
    sourceTestCaseId: string,
  ): Promise<Array<{ id: string; name: string; negativeMeta: NegativeMeta; staleReason: string | null }>> {
    return negativeDb.getNegativesForSource(sourceTestCaseId);
  }
}
