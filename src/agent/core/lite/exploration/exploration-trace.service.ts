/**
 * Exploration Trace Service
 * JSONL trace logging for the Exploration feature (Survey + Flow phases).
 * Writes to test_logs/exploration/ for debugging and AI-assisted analysis.
 *
 * Wraps LiteTraceWriter with exploration-specific convenience methods
 * and per-run lifecycle management (one trace file per exploration run).
 *
 * Usage:
 *   const trace = new ExplorationTraceService(explorationId);
 *   trace.writeExplorationStart({ ... });
 *   // ... pass trace to SurveyAgent, FlowRunner, OverlayDismisser
 *   await trace.close();
 *
 * Reading trace files:
 *   cat test_logs/exploration/*.jsonl | jq 'select(.eventType == "page_classification_response")'
 *   cat test_logs/exploration/*.jsonl | jq 'select(.stage == "flow")'
 *   cat test_logs/exploration/*.jsonl | jq 'select(.eventType | test("prompt|response"))'
 */

import { LiteTraceWriter } from '@/agent/core/lite/trace/lite-trace-writer';
import * as path from 'path';
import type {
  ExplorationConfig,
  EntryPoint,
  FlowExplorationTask,
  DiscoveredStep,
  FlowError,
  ErrorClassification,
  BlockerType,
} from './types';
import type { DismissalAttempt } from './overlay-dismisser';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const EXPLORATION_LOGS_DIR = path.join(process.cwd(), 'test_logs', 'exploration');
const EXPLORATION_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per exploration run
const EXPLORATION_MAX_PAYLOAD_CHARS = 30_000; // prompts can be long

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

/** Owner context needed to upload the trace to Supabase Storage on prod. */
export interface ExplorationTraceUploadContext {
  explorationId: string;
  /** Server-derived run owner. Absent/non-UUID → anonymous upload, no DB record. */
  userId?: string;
}

export class ExplorationTraceService {
  private writer: LiteTraceWriter;
  private readonly uploadContext: ExplorationTraceUploadContext;
  private uploaded = false;

  constructor(explorationId: string, uploadContext?: ExplorationTraceUploadContext) {
    this.writer = new LiteTraceWriter({
      testId: `exploration_${explorationId}`,
      logsDir: EXPLORATION_LOGS_DIR,
      maxFileSizeBytes: EXPLORATION_MAX_FILE_SIZE,
      maxPayloadChars: EXPLORATION_MAX_PAYLOAD_CHARS,
    });
    this.uploadContext = uploadContext ?? { explorationId };
  }

  /**
   * Flush + close the trace file, then (on prod) upload it to Supabase Storage
   * so the run leaves the same trace we get locally. The upload is
   * fire-and-forget and idempotent (guarded by `uploaded`) — the engine has
   * several close() call sites across its return paths, and this must run
   * exactly once regardless of which one fires. Returns the local file path
   * (unchanged contract) WITHOUT waiting on the storage round-trip.
   */
  async close(): Promise<string> {
    const filePath = this.writer.getFilePath();
    await this.writer.close();
    if (!this.uploaded) {
      this.uploaded = true;
      // Fire-and-forget: never let a storage hiccup delay or fail the run.
      import('./exploration-trace-upload')
        .then(({ uploadExplorationTrace }) =>
          uploadExplorationTrace({
            filePath,
            userId: this.uploadContext.userId,
            explorationId: this.uploadContext.explorationId,
          }),
        )
        .catch(() => { /* best-effort — upload module logs its own failures */ });
    }
    return filePath;
  }

  getFilePath(): string {
    return this.writer.getFilePath();
  }

  /** Expose underlying writer so TestPipeline can use it for per-round trace logging */
  getWriter(): LiteTraceWriter {
    return this.writer;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LIFECYCLE EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeExplorationStart(config: ExplorationConfig): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'exploration_start',
      payload: {
        explorationId: config.explorationId,
        entryUrl: config.entryUrl,
        scopeHint: config.scopeHint,
        maxConcurrency: config.maxConcurrency,
        budget: config.budget,
        hasCredentials: !!config.credentials,
      },
    });
  }

  writeExplorationEnd(data: {
    // 'cancelled' is a distinct outcome from both: the run neither finished its
    // phases nor errored, so folding it into either would misreport why the
    // trace stops early.
    status: 'completed' | 'failed' | 'cancelled';
    durationMs: number;
    testCasesCount: number;
    summary: Record<string, any>;
    error?: string;
  }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'exploration_end',
      payload: data,
    });
  }

  writePhaseStart(phase: 'survey' | 'flow'): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: `phase_${phase}_start`,
      payload: { phase },
    });
  }

  writePhaseEnd(phase: 'survey' | 'flow', data: Record<string, any>): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: `phase_${phase}_end`,
      payload: { phase, ...data },
    });
  }

  writeCheckpointSaved(data: { phase: string; flowsCompleted?: number }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'checkpoint_saved',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESULT BUILD + PERSISTENCE EVENTS (END of the URL→test-cases path)
  // Previously the trace went silent after the last flow_end; these surface
  // what test cases were produced and whether they were saved — the part the
  // user cares most about ("did I get ready-to-use tests?").
  // ─────────────────────────────────────────────────────────────────────────

  writeTestCaseDiscovered(data: {
    name: string;
    category?: string;
    stepsCount: number;
    assertionsCount?: number;
    hasCompiledLocators?: boolean;
    sourceEntryPointId?: string;
    isNegative?: boolean;
  }): void {
    this.writer.write({
      stage: 'build',
      eventType: 'test_case_discovered',
      payload: data,
    });
  }

  writeResultBuilt(data: {
    testCasesCount: number;
    negativeCount?: number;
    totalSteps: number;
    categories?: string[];
  }): void {
    this.writer.write({
      stage: 'build',
      eventType: 'result_built',
      payload: data,
    });
  }

  writeTestCasesSaved(data: {
    requestedCount: number;
    savedCount: number;
    projectId: string;
    savedIds?: string[];
    error?: string;
  }): void {
    this.writer.write({
      stage: 'persistence',
      eventType: 'test_cases_saved',
      payload: data,
    });
  }

  writeRunCompleted(data: { explorationId: string; testCasesCount: number; durationMs: number }): void {
    this.writer.write({
      stage: 'persistence',
      eventType: 'run_completed',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SURVEY EVENTS (Phase 1)
  // ─────────────────────────────────────────────────────────────────────────

  writePageNavigate(data: { url: string; depth: number; fromUrl?: string }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'page_navigate',
      payload: data,
    });
  }

  writePageSnapshot(data: {
    url: string;
    elementCount: number;
    interactiveCount: number;
    hasScreenshot: boolean;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'page_snapshot',
      payload: data,
    });
  }

  writePageClassificationPrompt(data: {
    url: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    hasScreenshot: boolean;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'page_classification_prompt',
      payload: {
        ...data,
        // Avoid logging the same system prompt 10 times — log hash + length instead
        systemPrompt: `[${data.systemPrompt.length} chars, hash=${this.simpleHash(data.systemPrompt)}]`,
      },
    });
  }

  /** Fast non-crypto hash for dedup identification in logs */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  writePageClassificationResponse(data: {
    url: string;
    model: string;
    rawResponse: string;
    parsed: { pageType: string; entryPointCount: number; navLinkCount: number };
    latencyMs: number;
    tokensUsed?: number;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'page_classification_response',
      payload: data,
    });
  }

  writePageClassificationFallback(data: {
    url: string;
    reason: string;
    entryPointCount: number;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'page_classification_fallback',
      payload: data,
    });
  }

  writeEntryPointsDiscovered(data: {
    url: string;
    entryPoints: Array<{ name: string; category: string; priority: string }>;
    count: number;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'entry_points_discovered',
      payload: data,
    });
  }

  writeNavLinksDiscovered(data: {
    url: string;
    links: Array<{ ref: string; label: string; targetUrl?: string }>;
    count: number;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'nav_links_discovered',
      payload: data,
    });
  }

  writeHiddenNavDiscovered(data: {
    url: string;
    source: 'dom_harvest' | 'menu_click' | 'spa_route';
    linksFound: number;
    details?: string;
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'hidden_nav_discovered',
      payload: data,
    });
  }

  writePageDedupSkipped(data: {
    url: string;
    reason: 'same_url' | 'same_content' | 'same_template';
  }): void {
    this.writer.write({
      stage: 'survey',
      eventType: 'page_dedup_skipped',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OVERLAY EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeOverlayDetected(data: {
    url: string;
    mode: 'survey' | 'flow';
    obstacles: Array<{ ref: string; type: string; zIndex: number }>;
    count: number;
  }): void {
    this.writer.write({
      stage: 'overlay',
      eventType: 'overlay_detected',
      payload: data,
    });
  }

  writeOverlayDismissed(data: {
    url: string;
    attempts: DismissalAttempt[];
    durationMs: number;
  }): void {
    this.writer.write({
      stage: 'overlay',
      eventType: 'overlay_dismissed',
      payload: data,
    });
  }

  writeOverlaySummary(data: { url: string; summary: string | null }): void {
    this.writer.write({
      stage: 'overlay',
      eventType: 'overlay_summary',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FLOW EVENTS (Phase 2)
  // ─────────────────────────────────────────────────────────────────────────

  writeFlowStart(data: {
    entryPointId: string;
    name: string;
    goal: string;
    category: string;
    priority: string;
    contextType: 'clean' | 'authenticated';
    allocatedRounds: number;
    flowTimeoutMs: number;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_start',
      payload: data,
    });
  }

  writeFlowLoginAttempt(data: {
    goal: string;
    attempt: number;
    success: boolean;
    durationMs: number;
    error?: string;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_login_attempt',
      payload: data,
    });
  }

  writeFlowPipelineStart(data: {
    entryPointId: string;
    goal: string;
    url: string;
    maxRounds: number;
    timeoutMs: number;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_pipeline_start',
      payload: data,
    });
  }

  writeFlowPipelineEnd(data: {
    entryPointId: string;
    success: boolean;
    roundsUsed: number;
    progressScore: number;
    blockedReason?: string;
    stepsExtracted: number;
    durationMs: number;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_pipeline_end',
      payload: data,
    });
  }

  writeFlowStepsExtracted(data: {
    entryPointId: string;
    flowName?: string;
    status?: string;
    steps: DiscoveredStep[];
    count: number;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_steps_extracted',
      payload: data,
    });
  }

  writeFlowErrors(data: {
    entryPointId: string;
    flowName?: string;
    status?: string;
    errors: FlowError[];
    classification: ErrorClassification;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_errors',
      payload: data,
    });
  }

  writeFlowBlockerDetected(data: {
    entryPointId: string;
    blockerType: BlockerType;
    canUserHelp: boolean;
    reason?: string;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_blocker_detected',
      payload: data,
    });
  }

  writeFlowUserHelpRequested(data: {
    entryPointId: string;
    type: string;
    timeoutMs: number;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_user_help_requested',
      payload: data,
    });
  }

  writeFlowUserHelpReceived(data: {
    entryPointId: string;
    type: string;
    received: boolean;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_user_help_received',
      payload: data,
    });
  }

  writeFlowEnd(data: {
    entryPointId: string;
    name: string;
    status: string;
    durationMs: number;
    goalAchieved: boolean;
    progressScore: number;
    stepsCount: number;
    branchCount: number;
    roundsUsed: number;
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'flow_end',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BRANCH DETECTION EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeBranchDetectionPrompt(data: {
    entryPointId: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): void {
    this.writer.write({
      stage: 'branch',
      eventType: 'branch_detection_prompt',
      payload: {
        ...data,
        systemPrompt: `[${data.systemPrompt.length} chars, hash=${this.simpleHash(data.systemPrompt)}]`,
      },
    });
  }

  writeBranchDetectionResponse(data: {
    entryPointId: string;
    model: string;
    rawResponse: string;
    parsedBranches: Array<{ name: string; category: string; priority: string }>;
    latencyMs: number;
  }): void {
    this.writer.write({
      stage: 'branch',
      eventType: 'branch_detection_response',
      payload: data,
    });
  }

  writeBranchEnqueued(data: {
    sourceFlowId: string;
    sourceFlowName: string;
    branches: Array<{ name: string; category: string; priority: string }>;
    count: number;
  }): void {
    this.writer.write({
      stage: 'branch',
      eventType: 'branch_enqueued',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUEUE & BUDGET EVENTS
  // ─────────────────────────────────────────────────────────────────────────

  writeQueueDedup(data: {
    entryPointName: string;
    reason: 'exact_name' | 'name_similarity' | 'goal_similarity';
    matchedAgainst?: string;
    similarity?: number;
  }): void {
    this.writer.write({
      stage: 'queue',
      eventType: 'queue_dedup_rejected',
      payload: data,
    });
  }

  writeQueueState(data: {
    pendingCount: number;
    completedCount: number;
    totalEnqueued: number;
  }): void {
    this.writer.write({
      stage: 'queue',
      eventType: 'queue_state',
      payload: data,
    });
  }

  /** Log the full ordered queue so we can see execution priority */
  writeQueueOrder(data: {
    source: 'strategy' | 'fallback' | 'reorder';
    flows: Array<{ id: string; name: string; category: string; priority: string }>;
  }): void {
    this.writer.write({
      stage: 'queue',
      eventType: 'queue_order',
      payload: data,
    });
  }

  writeQueueDequeue(data: {
    entryPointId: string;
    name: string;
    category: string;
    priority: string;
    /** Budget snapshot at dequeue time — explains why allocatedRounds may be low */
    budget?: {
      flowsRemaining: number;
      roundsRemaining: number;
      allocatedRounds: number;
      timeRemainingMs: number;
    };
  }): void {
    this.writer.write({
      stage: 'queue',
      eventType: 'queue_dequeue',
      payload: data,
    });
  }

  writeBudgetCheck(data: {
    timeUsedMs: number;
    timeRemainingMs: number;
    flowsCompleted: number;
    flowsRemaining: number;
    roundsUsed: number;
    roundsRemaining: number;
    isExhausted: boolean;
  }): void {
    this.writer.write({
      stage: 'budget',
      eventType: 'budget_check',
      payload: data,
    });
  }

  writeBudgetExhausted(data: { reason: string; remaining: Record<string, any> }): void {
    this.writer.write({
      stage: 'budget',
      eventType: 'budget_exhausted',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGIST EVENTS (Phase 1.5)
  // ─────────────────────────────────────────────────────────────────────────

  writeStrategistPrompt(data: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    userDirective?: string;
  }): void {
    this.writer.write({
      stage: 'strategy',
      eventType: 'strategist_prompt',
      payload: {
        ...data,
        // System prompt is static — log hash + length instead of full text
        systemPrompt: `[${data.systemPrompt.length} chars, hash=${this.simpleHash(data.systemPrompt)}]`,
      },
    });
  }

  writeStrategistResponse(data: {
    model: string;
    rawResponse: string;
    parsed: { plannedFlows: number; loginFirst: boolean; continueSurvey: boolean; skipFlows: number; focusAreas: string[] } | null;
    latencyMs: number;
  }): void {
    this.writer.write({
      stage: 'strategy',
      eventType: 'strategist_response',
      payload: data,
    });
  }

  writeStrategistFallback(data: { reason: string; flowCount: number }): void {
    this.writer.write({
      stage: 'strategy',
      eventType: 'strategist_fallback',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SENTINEL EVENTS (Phase 2.5)
  // ─────────────────────────────────────────────────────────────────────────

  writeSentinelPrompt(data: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): void {
    this.writer.write({
      stage: 'coverage',
      eventType: 'sentinel_prompt',
      payload: data,
    });
  }

  writeSentinelResponse(data: {
    model: string;
    rawResponse: string;
    parsed: { coverageScore: number; gaps: number; continueExploring: boolean; riskAreas: number } | null;
    latencyMs: number;
  }): void {
    this.writer.write({
      stage: 'coverage',
      eventType: 'sentinel_response',
      payload: data,
    });
  }

  writeSentinelFallback(data: { reason: string; coverageScore: number }): void {
    this.writer.write({
      stage: 'coverage',
      eventType: 'sentinel_fallback',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PAGE HEALTH + ELEMENT RESOLUTION (per-action diagnostics)
  // Surface the RAW signals behind a health verdict and the locator waterfall,
  // so a reader can answer "why did the agent click that / why did it fail".
  // ─────────────────────────────────────────────────────────────────────────

  writePageHealth(data: {
    entryPointId?: string;
    round?: number;
    url: string;
    serverErrorStatus?: number;
    hasServerError: boolean;
    sessionLost: boolean;
    consoleErrorCount: number;
    networkErrors?: Array<{ url: string; method: string; status?: number }>;
    consoleErrors?: string[];
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'page_health',
      payload: data,
    });
  }

  writeElementResolution(data: {
    entryPointId?: string;
    round?: number;
    ref: string;
    command: string;
    stage: 'compiled' | 'evidence' | 'llm' | 'smart_locator' | 'screenshot' | 'identity';
    success: boolean;
    reason?: string;
    durationMs?: number;
    resolved?: { tag?: string; role?: string; name?: string; text?: string; visible?: boolean; covered?: boolean; disabled?: boolean };
  }): void {
    this.writer.write({
      stage: 'flow',
      eventType: 'element_resolution',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRE-ENGINE LIFECYCLE (START of the path — controller/job/browser)
  // Captures the previously-blind window between "URL dropped" and the first
  // in-engine event, including crashes before the engine ever runs.
  // ─────────────────────────────────────────────────────────────────────────

  writeJobStart(data: { explorationId: string; entryUrl: string; isResume: boolean; resumeCount?: number }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'job_start',
      payload: data,
    });
  }

  writeBrowserLaunched(data: { headless: boolean; durationMs: number }): void {
    this.writer.write({
      stage: 'lifecycle',
      eventType: 'browser_launched',
      payload: data,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ERROR & WARNING
  // ─────────────────────────────────────────────────────────────────────────

  /** Capture a crash with stack so a failed run is diagnosable from the trace alone. */
  writeFatal(data: { phase: string; error: string; stack?: string }): void {
    this.writer.write({
      stage: 'error',
      eventType: 'fatal',
      payload: data,
    });
  }

  writeError(error: string, context?: Record<string, any>): void {
    this.writer.write({
      stage: 'error',
      eventType: 'error',
      payload: { error, ...context },
    });
  }

  writeWarning(warning: string, context?: Record<string, any>): void {
    this.writer.write({
      stage: 'warning',
      eventType: 'warning',
      payload: { warning, ...context },
    });
  }
}
