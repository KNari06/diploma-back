/**
 * Headless replay of a chat authoring request through the REAL
 * Planner→Executor→Reviewer pipeline — no frontend, no WebSocket, no DB writes.
 *
 * How it stays side-effect-light: a single-shot turn hits the confirm-gate,
 * which downgrades every write tool's confirm=true→false (no prior preview
 * turn recorded). So qa_create/update return a preview WITHOUT persisting, and
 * qa_run_draft_steps only caches an in-memory draft. The agent still *authors*
 * the steps — we capture them from the writeSteps trace (edit scope) and from
 * result.draftSteps (add scope). It DOES call the live LLM (real key + credits).
 *
 * Capture gap (acceptable for Tier-2a v1): if an add-scope turn jumps straight
 * to qa_create_test_case instead of drafting, we can't see its steps (no trace
 * in non-tc scope, create doesn't populate draftSteps). The editor prompt
 * drafts-first, so this is rare; documented rather than worked around.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { SubAgentPipeline } from '@/api/chat/general/sub-agents/pipeline';
import { buildChatSystemPrompt } from '@/ai/prompts/intent-and-chat-prompts';
import { SkillRegistry, registerAllSkills } from '@/services/skills';
import { ChatTestTraceService } from '@/services/chat/chat-test-trace.service';
import { findTraceFile } from '../lite-analyze/find-trace-file';
import { authoredViaFromTraceSource, hasUninstrumentedAuthoring } from './scoring';
import { normalizeStepField, stepsFromDraft } from './capture';
import type { AuthoredVia, CapturedRun, Scenario } from './types';

// Throwaway-but-valid UUIDs — the pipeline scopes by UUID but doesn't depend on
// real rows for the authoring path (mirrors eval-intent-understanding.ts).
const EVAL_USER_ID = '00000000-0000-4000-8000-000000000001';
const EVAL_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const EVAL_PROJECT_ID = '00000000-0000-4000-8000-000000000003';

// The skill registry is populated at server boot; a standalone script must do
// it explicitly or getAvailableTools() returns [] and the pipeline short-
// circuits. register() throws on dupes, so guard to exactly once per process.
let skillsRegistered = false;
async function ensureSkillsRegistered(): Promise<void> {
  if (skillsRegistered) return;
  try {
    await registerAllSkills();
  } catch (err) {
    if (!(err instanceof Error && /already registered/i.test(err.message))) throw err;
  }
  skillsRegistered = true;
}

/** Read the writeSteps events from a chat_test trace file for one session. */
async function readAuthoredFromTrace(
  chatSessionId: string,
): Promise<{ via: AuthoredVia[]; steps: Array<{ type?: string; description?: string }> }> {
  const via: AuthoredVia[] = [];
  const steps: Array<{ type?: string; description?: string }> = [];

  const file = await findTraceFile(`chat_test_${chatSessionId}`);
  if (!file) return { via, steps };

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { via, steps };
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.eventType !== 'test_steps') continue;
    const source = event?.payload?.source;
    const mapped = typeof source === 'string' ? authoredViaFromTraceSource(source) : null;
    if (mapped) via.push(mapped);
    const evSteps = event?.payload?.steps;
    if (Array.isArray(evSteps)) {
      for (const s of evSteps) {
        steps.push({ type: normalizeStepField(s?.type), description: normalizeStepField(s?.description) });
      }
    }
  }

  return { via, steps };
}

/** Replay one scenario once through the real pipeline. Requires OPENAI_API_KEY. */
export async function replayScenario(scenario: Scenario): Promise<CapturedRun> {
  const chatSessionId = randomUUID();
  const isEdit = scenario.scope === 'edit';
  const testCaseId = isEdit ? randomUUID() : undefined;

  const skillContext = {
    userId: EVAL_USER_ID,
    workspaceId: EVAL_WORKSPACE_ID,
    chatSessionId,
    projectId: EVAL_PROJECT_ID,
    // Editor authoring surface — offer the draft/run/update tools.
    mode: 'editor' as const,
    storeKind: isEdit ? ('testcase' as const) : ('global' as const),
    testCaseId,
  };

  try {
    await ensureSkillsRegistered();
    const availableTools = await SkillRegistry.getAvailableTools(skillContext);
    const skillDescriptions = await SkillRegistry.getSkillDescriptions(skillContext);
    const systemPrompt = buildChatSystemPrompt(skillDescriptions, EVAL_PROJECT_ID, undefined);

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: scenario.userMessage },
    ];

    const pipeline = new SubAgentPipeline({
      userId: EVAL_USER_ID,
      workspaceId: EVAL_WORKSPACE_ID,
      chatSessionId,
      projectId: EVAL_PROJECT_ID,
      // Synthetic preview session — never dereferenced on the confirm=false
      // paths, but its presence keeps the editor tools available.
      previewSessionId: `eval-preview-${chatSessionId}`,
      mode: 'editor',
      testCaseId,
      testCaseName: scenario.boundTestCaseName,
    });

    const result = await pipeline.execute({
      userMessage: scenario.userMessage,
      userContent: scenario.userMessage,
      messages,
      availableTools,
      skillDescriptions,
      needsTools: true,
    });

    // Flush the trace so the writeSteps events are readable, then capture.
    await ChatTestTraceService.close(chatSessionId);

    const fromTrace = isEdit ? await readAuthoredFromTrace(chatSessionId) : { via: [], steps: [] };
    const draftSteps = stepsFromDraft(result.draftSteps);

    const via: AuthoredVia[] = [...fromTrace.via];
    const steps = [...fromTrace.steps];
    if (draftSteps.length > 0) {
      via.push('run_draft');
      steps.push(...draftSteps);
    }

    // Did the executor pick an authoring tool the headless harness can't capture
    // (qa_author_test_iteratively)? Union the executed-tool names across every
    // pipeline path (metrics.toolsExecuted covers single/multi/parallel;
    // executedTools carries the fallback-path names). Lets the scorer mark the
    // run UNCAPTURABLE instead of false-failing it — README gotcha #6.
    const executedToolNames = [
      ...(result.metrics?.toolsExecuted ?? []),
      ...(result.executedTools?.map((t) => t.toolName) ?? []),
    ];
    const uninstrumentedAuthoring = hasUninstrumentedAuthoring(executedToolNames);

    return {
      scenarioId: scenario.id,
      ok: true,
      pipelinePath: result.path,
      content: result.content,
      needsClarification: result.needsClarification,
      uninstrumentedAuthoring,
      authoredVia: Array.from(new Set(via)),
      steps,
    };
  } catch (err) {
    // Best-effort trace close even on failure.
    await ChatTestTraceService.close(chatSessionId).catch(() => { /* ignore */ });
    return {
      scenarioId: scenario.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      authoredVia: [],
      steps: [],
    };
  }
}
