import { AI_MODELS } from '@/config/ai/ai-models.config';
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
}

const SYSTEM_PROMPT = `You are an expert QA engineer specializing in negative and boundary testing of web applications.

GOAL: Given the happy-path steps of ONE test case, decide which input steps are worth attacking and how, so that each mutation provokes a distinct failure-handling path in the app.

Each step carries hints about the field it touches: \`inputType\` (HTML type), \`autocomplete\`, \`name\`, \`label\`, \`placeholder\`, \`elementDescription\`, and the recorded \`value\`. Use them to understand the field's PURPOSE before mutating — an email field, a password, a phone, a free-text name behave differently under bad input.

MUTATION TYPES (pick the ones that fit the field):
- empty_field: clear a required field (mutatedValue = "")
- invalid_format: wrong format for the field's purpose (e.g. "not-an-email" for an email field, letters in a phone field)
- xss: probe for reflected XSS — the SERVER supplies the payload, you only choose the step (leave mutatedValue = "")
- overflow: extremely long input — the SERVER supplies the payload (leave mutatedValue = "")
- wrong_credentials: plausible-but-wrong value for an auth field (password/token/login)
- double_submit: submit/confirm clicked twice rapidly (choose a click step on a submit/confirm control)
- skip_step: remove a required step entirely

RULES:
1. Mutate exactly ONE step per mutation (isolated testing). stepIndex must be a real index from the input.
2. Prefer steps whose field clearly has validation (auth fields, email, required inputs). Skip purely navigational steps (goto, scroll, wait).
3. No duplicate mutations (same mutationType + same stepIndex).
4. expectedBehavior describes what the app SHOULD do (reject input, show a validation/error message, stay on the page). Write expectedBehavior in the SAME LANGUAGE as the UI of the source test case — infer the language from the steps' value/label/description text. If unclear, use the language those texts are written in.
5. Aim for the highest-value 3–6 mutations, not exhaustive coverage.

OUTPUT: a single JSON object: { "mutations": [ ... ] }. No markdown, no prose.`;

const USER_PROMPT_TEMPLATE = `Happy-path steps for the test case:

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
      "expectedBehavior": "Поле email обязательно — должно показать ошибку валидации"
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

    // 2. Generate mutations via AI
    const mutations = await this.generateMutations(steps);
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
        const negativeSteps = this.buildNegativeSteps(steps, mutation);
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
          } satisfies NegativeMeta,
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
  private static async generateMutations(steps: any[]): Promise<GeneratedMutation[]> {
    // Simplify steps for AI prompt — surface the field-identity signals the
    // recorder actually captures so the model understands each field's purpose.
    // (The old `bindingHints.fieldType` never existed — dead path. Real signals
    // are recordedInputType + bindingHints.{type,autocomplete,name,label,placeholder}.)
    const simplifiedSteps = steps.map((s, i) => {
      const hints = s.bindingHints || {};
      const inputType = s.recordedInputType || hints.type;
      return {
        index: i,
        type: s.type,
        description: s.description,
        value: s.value,
        ...(inputType && { inputType }),
        ...(hints.autocomplete && { autocomplete: hints.autocomplete }),
        ...(hints.name && { name: hints.name }),
        ...(hints.label && { label: hints.label }),
        ...(hints.placeholder && { placeholder: hints.placeholder }),
        ...(s.recordedDescription && { elementDescription: s.recordedDescription }),
      };
    });

    const userPrompt = USER_PROMPT_TEMPLATE.replace('{steps}', JSON.stringify(simplifiedSteps, null, 2));

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_MODELS.fast,
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
  ): any[] {
    // Deep copy steps
    const steps = JSON.parse(JSON.stringify(originalSteps));

    if (mutation.mutationType === 'skip_step') {
      // Remove the step entirely
      steps.splice(mutation.stepIndex, 1);
    } else if (mutation.mutationType === 'double_submit') {
      // Duplicate the click step
      const step = steps[mutation.stepIndex];
      if (step) {
        const duplicate = { ...step, id: `neg_dup_${Date.now().toString(36)}` };
        steps.splice(mutation.stepIndex + 1, 0, duplicate);
      }
    } else {
      // Mutate the value. mutation.mutatedValue is already normalized by the
      // caller (canonical server payload for xss/overflow, LLM value otherwise).
      const step = steps[mutation.stepIndex];
      if (step) {
        step.value = mutation.mutatedValue;
        // Update description to reflect mutation
        step.description = `[MUTATED: ${mutation.mutationType}] ${step.description || ''}`;
      }
    }

    // Append ai_check assertion step. assertionText is REQUIRED by both
    // executors (live apply + background replay converter) — omitting it makes
    // the assertion fail validation, so the negative never actually verifies.
    // aiContextMode html+a11y is enough for validation/error-message checks and
    // avoids the screenshot token cost of the default html+a11y+screenshot.
    steps.push({
      id: `neg_check_${Date.now().toString(36)}`,
      type: 'ai_check',
      description: mutation.expectedBehavior,
      assertionText: mutation.expectedBehavior,
      value: mutation.expectedBehavior,
      options: { aiContextMode: 'html+a11y' },
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
