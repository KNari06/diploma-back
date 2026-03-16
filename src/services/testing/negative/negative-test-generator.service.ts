import { supabaseAdmin } from '@/db/supabase';
import { AI_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import type { NegativeMeta, NegativeMutationType } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

const VALID_MUTATION_TYPES: NegativeMutationType[] = [
  'empty_field',
  'invalid_format',
  'xss',
  'overflow',
  'double_submit',
  'skip_step',
  'wrong_credentials',
];

interface GeneratedMutation {
  mutationType: NegativeMutationType;
  stepIndex: number;
  originalValue: string;
  mutatedValue: string;
  expectedBehavior: string;
}

const SYSTEM_PROMPT = `You are an expert QA engineer specializing in negative and boundary testing.

Given a list of happy-path test steps for a web application, generate negative/boundary test mutations.

For each mutable step (fill, type, select), produce one or more mutations:
- empty_field: Replace value with ""
- invalid_format: Use wrong format (e.g., "not-an-email" for email fields)
- xss: Inject <script>alert(1)</script> or similar XSS payloads
- overflow: Use extremely long strings (e.g., "a" repeated 10000 times)
- wrong_credentials: Use incorrect values for auth fields (passwords, tokens)
- double_submit: Click a submit button twice rapidly
- skip_step: Remove a required step entirely

Rules:
1. Only mutate ONE step per test case (isolated testing)
2. Focus on high-value mutations — fields with validation requirements
3. Skip steps that are purely navigational (goto, scroll)
4. For form fields, prioritize: email, password, phone, name fields
5. Don't generate duplicate mutations (same type + same step)
6. Each mutation should have a clear expectedBehavior describing what SHOULD happen (validation error, error message, etc.)

Output ONLY valid JSON array. No markdown, no explanation.`;

const USER_PROMPT_TEMPLATE = `Here are the happy-path test steps:

\`\`\`json
{steps}
\`\`\`

Generate negative test mutations as a JSON array:
[
  {
    "mutationType": "empty_field",
    "stepIndex": 2,
    "originalValue": "user@example.com",
    "mutatedValue": "",
    "expectedBehavior": "Should show validation error for required email field"
  }
]`;

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
    const { data: sourceCase, error: loadError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, flow_id, steps_json, url, start_url, project_id')
      .eq('id', sourceTestCaseId)
      .maybeSingle();

    if (loadError || !sourceCase) {
      logger.error('[NEGATIVE_GEN] Failed to load source test case', { sourceTestCaseId, error: loadError?.message });
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
    for (const mutation of mutations) {
      try {
        const negativeSteps = this.buildNegativeSteps(steps, mutation);
        const name = `[NEG] ${sourceCase.name}: ${mutation.mutationType} on step ${mutation.stepIndex + 1}`;

        const { data: created, error: createError } = await supabaseAdmin
          .from('intent_test_cases')
          .insert({
            project_id: sourceCase.project_id,
            user_id: userId,
            name,
            description: mutation.expectedBehavior,
            status: 'published',
            kind: 'regression_member',
            url: sourceCase.url || sourceCase.start_url,
            start_url: sourceCase.start_url,
            replay_strategy: 'steps_json',
            steps_json: negativeSteps,
            flow_id: sourceCase.flow_id,
            is_negative: true,
            source_intent_test_case_id: sourceTestCaseId,
            negative_meta: {
              mutationType: mutation.mutationType,
              mutatedStepIndex: mutation.stepIndex,
              originalValue: mutation.originalValue,
              mutatedValue: mutation.mutatedValue,
              expectedBehavior: mutation.expectedBehavior,
            } satisfies NegativeMeta,
          })
          .select('id')
          .single();

        if (createError) {
          logger.error('[NEGATIVE_GEN] Failed to create negative test case', {
            sourceTestCaseId,
            mutation: mutation.mutationType,
            error: createError.message,
          });
          continue;
        }

        if (created) {
          createdIds.push(created.id);
        }
      } catch (err) {
        logger.error('[NEGATIVE_GEN] Error creating negative for mutation', {
          sourceTestCaseId,
          mutation: mutation.mutationType,
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
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .delete()
      .eq('source_intent_test_case_id', sourceTestCaseId)
      .eq('is_negative', true)
      .select('id');

    if (error) {
      logger.error('[NEGATIVE_GEN] Failed to delete existing negatives', { sourceTestCaseId, error: error.message });
      return 0;
    }

    return data?.length || 0;
  }

  /**
   * Call AI to generate mutation list from happy-path steps.
   */
  private static async generateMutations(steps: any[]): Promise<GeneratedMutation[]> {
    // Simplify steps for AI prompt — only include relevant fields
    const simplifiedSteps = steps.map((s, i) => ({
      index: i,
      type: s.type,
      description: s.description,
      value: s.value,
      ...(s.bindingHints?.fieldType && { fieldType: s.bindingHints.fieldType }),
      ...(s.bindingHints?.label && { label: s.bindingHints.label }),
      ...(s.bindingHints?.placeholder && { placeholder: s.bindingHints.placeholder }),
    }));

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

      // Parse response
      const parsed = JSON.parse(content);
      const mutations: any[] = Array.isArray(parsed) ? parsed : (parsed.mutations || []);

      // Validate and filter
      return mutations.filter((m): m is GeneratedMutation => {
        if (!m || typeof m !== 'object') return false;
        if (!VALID_MUTATION_TYPES.includes(m.mutationType)) return false;
        if (typeof m.stepIndex !== 'number' || m.stepIndex < 0 || m.stepIndex >= steps.length) return false;
        if (typeof m.expectedBehavior !== 'string') return false;
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
      // Mutate the value of the step
      const step = steps[mutation.stepIndex];
      if (step) {
        step.value = mutation.mutatedValue;
        // Update description to reflect mutation
        step.description = `[MUTATED: ${mutation.mutationType}] ${step.description || ''}`;
      }
    }

    // Append ai_check assertion step
    steps.push({
      id: `neg_check_${Date.now().toString(36)}`,
      type: 'ai_check',
      description: mutation.expectedBehavior,
      value: mutation.expectedBehavior,
    });

    return steps;
  }

  /**
   * Get count of existing (non-stale) negatives for a test case.
   */
  static async getNegativeCount(sourceTestCaseId: string): Promise<number> {
    const { count } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('source_intent_test_case_id', sourceTestCaseId)
      .eq('is_negative', true)
      .is('negative_stale_reason', null);

    return count || 0;
  }

  /**
   * Get all negative test cases for a source test case.
   */
  static async getNegativesForSource(
    sourceTestCaseId: string,
  ): Promise<Array<{ id: string; name: string; negativeMeta: NegativeMeta; staleReason: string | null }>> {
    const { data } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, negative_meta, negative_stale_reason')
      .eq('source_intent_test_case_id', sourceTestCaseId)
      .eq('is_negative', true)
      .order('created_at', { ascending: true });

    return (data || []).map((row) => ({
      id: row.id,
      name: row.name,
      negativeMeta: row.negative_meta as NegativeMeta,
      staleReason: row.negative_stale_reason,
    }));
  }
}
