import { buildChatSystemPrompt } from '@/ai/prompts';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { autoEmbedOldMessages, hasEmbeddings, searchChatHistory } from '@/services/ai/embeddings/chat-embeddings.service';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { getSummariesForContext, summarizeOldMessages } from '@/services/ai/summarization/chat-summarization.service';
import { formatPageContextForChat, getPageContext, type PageContext } from '@/services/chat/editor-context.service';
import { ChatTestTraceService } from '@/services/chat/chat-test-trace.service';
import { wrapUntrustedContent, UNTRUSTED_WEB_CONTENT_INSTRUCTION } from '@/services/chat/untrusted-content-wrapper';
import { getProjectFiles, searchKB } from '@/services/kb/kb.service';
import { ChatService } from '@/services/utils/chat.service';
import { ChatPersistence } from '@/services/utils/chat-persistence';
import { GLOBAL_STORE, type ChatStore } from '@/services/utils/chat-store';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { convertRoleForOpenAI, injectTemporalMarkers } from '@/utils/helpers/chat-helpers';
import { isValidUUID } from '@/utils/validation/validation';
import { Request, Response } from 'express';
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from 'openai/resources/chat/completions';
import type { ChatAttachment } from '../chat.types';
import { CONSTANTS, PROGRESS } from '../shared/constants';
import { checkRequestAborted } from '../shared/request-cancellation';
import { compressMessageContent, deductChatCredits, emitProcessingStep } from '../shared/utils';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { SubAgentPipeline } from './sub-agents/pipeline';
import { SUB_AGENT_CONFIG } from './sub-agents/config';
import { executeTool } from '@/services/skills/tool-executor';
import { ToolCallTracker } from '@/services/skills/hooks/loop-detection.hook';
import { humanizeToolName, computeToolProgress } from './sub-agents/agents/executor-agent';
import { getLocalizedMessages } from '../regression/localization';
import { CredentialAuthoringFeature } from '@/config/features/credential-authoring';

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Resolve project ID (Tier 1: session → Tier 2: workspace default)
// ═══════════════════════════════════════════════════════════════════════════
async function resolveProjectId(
  chatSessionId: string | undefined,
  userId: string,
  workspaceId: string,
): Promise<{ id: string; name?: string } | null> {
  try {
    // Tier 1: Get projectId from chat session (linked when user ran tests)
    if (chatSessionId) {
      const sessionWithProject = await ChatService.getSessionWithProject(chatSessionId, userId);
      if (sessionWithProject?.project_id) {
        const sessionProjectId = sessionWithProject.project_id;

        // Validate: does this session-linked project actually have test data?
        const { count: testCaseCount } = await supabaseAdmin
          .from('intent_test_cases')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', sessionProjectId)
          .limit(1);

        if (testCaseCount && testCaseCount > 0) {
          const { data: proj } = await supabaseAdmin
            .from('projects')
            .select('name')
            .eq('id', sessionProjectId)
            .maybeSingle();
          logger.debug('[GENERAL_CHAT] Resolved projectId from chat session (validated: has test data)', {
            projectId: sessionProjectId,
            projectName: proj?.name,
            testCaseCount,
          });
          return { id: sessionProjectId, name: proj?.name };
        } else {
          logger.info('[GENERAL_CHAT] Session-linked project has NO test data, skipping to default project', {
            sessionProjectId,
            testCaseCount: testCaseCount ?? 0,
          });
        }
      }
    }
    // Tier 2: Get default project for workspace (most active project)
    const { ProjectContextService } = await import('@/services/utils/project-context.service');
    const defaultProject = await ProjectContextService.getDefaultProject(workspaceId, userId);
    if (defaultProject) {
      logger.debug('[GENERAL_CHAT] Resolved projectId from default workspace project', {
        projectId: defaultProject.id,
        projectName: defaultProject.name,
      });
      return { id: defaultProject.id, name: defaultProject.name };
    }
    return null;
  } catch (projectError) {
    logger.warn('[GENERAL_CHAT] Failed to auto-resolve projectId, continuing without it', {
      error: projectError instanceof Error ? projectError.message : String(projectError),
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Resolve editor page context + preview session ID
// ═══════════════════════════════════════════════════════════════════════════
async function resolveEditorPageContext(
  mode: string | undefined,
  parsedContext: Record<string, any> | undefined,
  userId: string,
): Promise<{ pageContext: PageContext | null; previewSessionId?: string }> {
  if (mode !== 'editor') {
    return { pageContext: null, previewSessionId: parsedContext?.previewSessionId };
  }

  let resolvedPreviewSessionId = parsedContext?.previewSessionId as string | undefined;

  // Resolve the correct previewSessionId for this user (client may send stale ID)
  if (parsedContext?.previewSessionId) {
    try {
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const previewService = getPreviewSessionService();
      if (!previewService.isSessionOwned(parsedContext.previewSessionId, userId)) {
        const userSession = previewService.getSessionForUser(userId);
        if (userSession) {
          logger.info('[GENERAL_CHAT] Client previewSessionId mismatch, resolved to user\'s active session', {
            clientSessionId: parsedContext.previewSessionId,
            resolvedSessionId: userSession.id,
            userId: userId.substring(0, 8) + '...',
          });
          resolvedPreviewSessionId = userSession.id;
        }
      }
    } catch { /* non-critical — getPageContext has its own fallback */ }
  } else {
    // No previewSessionId from client — try to find user's active session
    try {
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const userSession = getPreviewSessionService().getSessionForUser(userId);
      if (userSession) {
        resolvedPreviewSessionId = userSession.id;
        logger.info('[GENERAL_CHAT] Editor mode: no client previewSessionId, resolved from user session', {
          resolvedSessionId: userSession.id,
        });
      } else {
        logger.warn('[GENERAL_CHAT] Editor mode but no previewSessionId in context and no active session', {
          hasContext: !!parsedContext,
          contextKeys: parsedContext ? Object.keys(parsedContext) : [],
        });
      }
    } catch {
      logger.warn('[GENERAL_CHAT] Editor mode but no previewSessionId in context', {
        hasContext: !!parsedContext,
        contextKeys: parsedContext ? Object.keys(parsedContext) : [],
      });
    }
  }

  if (!resolvedPreviewSessionId) {
    return { pageContext: null, previewSessionId: undefined };
  }

  try {
    const editorPageContext = await getPageContext(resolvedPreviewSessionId, userId);

    // Merge frontend-provided pageContext (test steps, title) if available
    if (editorPageContext && parsedContext?.pageContext) {
      if (parsedContext.pageContext.title) editorPageContext.title = parsedContext.pageContext.title;
      if (parsedContext.pageContext.testSteps) editorPageContext.testSteps = parsedContext.pageContext.testSteps;
    }

    if (editorPageContext) {
      logger.info('[GENERAL_CHAT] Editor mode: page context loaded', {
        url: editorPageContext.url,
        domSummaryLength: editorPageContext.domSummary.length,
        hasTestSteps: !!editorPageContext.testSteps?.length,
      });
    } else {
      logger.warn('[GENERAL_CHAT] Editor mode: getPageContext returned null', {
        previewSessionId: resolvedPreviewSessionId,
        userId: userId.substring(0, 8) + '...',
      });
    }

    return { pageContext: editorPageContext, previewSessionId: resolvedPreviewSessionId };
  } catch (editorError) {
    logger.warn('[GENERAL_CHAT] Editor mode: failed to get page context', {
      error: editorError instanceof Error ? editorError.message : String(editorError),
      previewSessionId: resolvedPreviewSessionId,
    });
    return { pageContext: null, previewSessionId: resolvedPreviewSessionId };
  }
}

/** Plain-language labels for the frontend's blocker keys (no internal jargon). */
const EXPLORE_BLOCKER_LABELS: Record<string, string> = {
  backend: "can't reach QAIT (connection)",
  project: 'no project selected',
  app: 'no app build uploaded',
  runner: 'mobile testing service is offline',
  llm: 'testing service AI is not configured',
  capacity: 'no test device available right now',
};

/**
 * Render the frontend's facts-only Explore snapshot into a system message so
 * the agent can SEE the current screen. Returns null when there's nothing
 * useful (no state, or a plain web surface with no run). Never includes
 * secrets — the frontend only sends surface/platform/appId/ready/blockers.
 */
export function formatExploreStateForChat(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as {
    surface?: string; platform?: string; appId?: string;
    ready?: boolean; blockers?: string[];
  };
  if (s.surface !== 'mobile') {
    // Web surface carries no extra live state worth a message (yet).
    return null;
  }
  const lines: string[] = [
    '--- CURRENT EXPLORE SCREEN (the user is looking at this right now) ---',
    'Surface: Mobile app exploration.',
  ];
  if (s.platform) lines.push(`Platform: ${s.platform}.`);
  if (s.appId) lines.push(`App: ${s.appId}.`);
  if (s.ready) {
    lines.push('Status: READY — the user can start the run from the chat input (empty goal = whole app).');
  } else {
    const blockers = Array.isArray(s.blockers) ? s.blockers : [];
    const labels = blockers.map((b) => EXPLORE_BLOCKER_LABELS[b] || b);
    lines.push(
      blockers.length
        ? `Status: NOT READY — blocked by: ${labels.join('; ')}.`
        : 'Status: NOT READY (preparing).',
    );
    lines.push('If asked why it won\'t start, explain the blocker(s) above in plain language and the fix (try again later / contact support / upload an .apk-.ipa / use a Flutter debug build).');
  }
  return lines.join('\n');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: GENERAL CHAT
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function handleGeneralChat(
  req: Request,
  res: Response,
  params: {
    message: string;
    userId: string;
    chatSessionId?: string;
    context?: any;
    workspace_id?: string; // Workspace ID from validated route params (primary source)
    userLanguage?: 'en' | 'ru' | 'kk' | 'neutral'; // Language from intent parser (avoid re-detection)
    abortSignal?: AbortSignal;
    logger?: FunctionLogger;
    mode?: 'lite' | 'pro' | 'editor'; // Test execution mode
    attachments?: ChatAttachment[]; // File attachments (images + documents)
    needsTools?: boolean; // Signal from Intent Parser: false = skip Router in pipeline (~600ms saved)
    /**
     * Persistence backend (set by controller). When `kind === 'testcase'`,
     * history reads, message saves and auto-title all route to the per-
     * test-case tables. Default GLOBAL_STORE preserves the legacy workspace
     * chat path byte-for-byte. The actual table swap happens inside
     * ChatPersistence — handlers stay backend-agnostic.
     */
    chatStore?: ChatStore;
    /** Test-case scope marker; passed through for downstream loggers / WS rooms. */
    testCaseId?: string;
    /**
     * The test case's authoritative project id (from assertCanAccessTestCase),
     * threaded only in test-case scope. Trusted (access already verified). Used
     * to seed projectId so KB/file/project context and tool scope target the
     * test case's own project instead of falling back to the workspace default.
     */
    testCaseProjectId?: string;
  }
): Promise<void> {
  const { message, userId, chatSessionId, context: rawContext, workspace_id: paramWorkspaceId, abortSignal, logger: functionLogger, mode, attachments, needsTools, testCaseId, testCaseProjectId } = params;
  // Resolve persistence backend with safe default. Done at the top so
  // every read/write below uses the same store value, preventing a
  // mid-handler refactor mistake from sending some messages to one table
  // and some to the other.
  const store: ChatStore = params.chatStore ?? GLOBAL_STORE;

  // Per-test-case chat trace (test_logs/chat_test/). Captures the full
  // request → intent → context → tools → response cycle for analysis. Only
  // active in test-case scope; every write is best-effort and never throws.
  const chatTrace =
    store.kind === 'testcase' && chatSessionId
      ? ChatTestTraceService.getOrCreate(chatSessionId, userId, testCaseId)
      : null;

  // Normalize context: parse JSON string into object if needed (frontend may send stringified JSON)
  let context: any = rawContext;
  if (typeof rawContext === 'string' && rawContext.startsWith('{')) {
    try {
      context = JSON.parse(rawContext);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  logger.info('[GENERAL_CHAT] Handling general conversation', {
    hasSession: !!chatSessionId,
    messageLength: message.length
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: BUILD CONTEXT WITH HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  let conversationHistory: ChatCompletionMessageParam[] = [];
  let oldContextSummary = '';

  if (chatSessionId) {
    // Get recent messages (last 20) - always needed for conversationHistory.
    // Routed through ChatPersistence: legacy global path keeps the
    // userId-based session-access check; test-case path skips that check
    // because ownership has already been verified by requireTestCaseAccess
    // in the controller (single source of truth, no double round-trip).
    const getRecentMessagesWithLogging = functionLogger
      ? withFunctionLogging(
          ChatPersistence.getRecentMessages.bind(ChatPersistence),
          'ChatPersistence.getRecentMessages',
          functionLogger,
        )
      : ChatPersistence.getRecentMessages.bind(ChatPersistence);
    const recentMessages = await getRecentMessagesWithLogging(
      store,
      chatSessionId,
      userId,
      CONSTANTS.RECENT_MESSAGES_LIMIT,
    );
    if (abortSignal) {
      const checkRequestAbortedWithLogging = functionLogger
        ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
        : checkRequestAborted;
      checkRequestAbortedWithLogging(abortSignal);
    }

    logger.info('[GENERAL_CHAT] Retrieved recent history', {
      messageCount: recentMessages.length
    });

    // ═══════════════════════════════════════════════════════════════════════
    // VECTOR-BASED CONTEXT RETRIEVAL (Better than GPT summarization!)
    // ═══════════════════════════════════════════════════════════════════════
    // Benefits: 20x faster, 20x cheaper, more accurate semantic search
    // Cost: ~$0.0001 per 1K messages (vs $0.002 for GPT summary)
    // Speed: ~100ms (vs 2-3 sec for GPT summary)
    // ═══════════════════════════════════════════════════════════════════════

    // Check if we need vector search (only if we have old messages beyond the recent window)
    // If recentMessages returned exactly LIMIT messages, there are likely more old messages.
    //
    // Test-case scope guard: vector search reads chat_message_embeddings
    // (global table). For test-case sessions there are no embeddings yet
    // (Phase 11 wires them into test_case_chat_message_embeddings). Skip
    // the whole block — the test-case AI sees only the recent window,
    // which is acceptable for now and avoids any cross-table read.
    if (recentMessages.length >= CONSTANTS.RECENT_MESSAGES_LIMIT && chatSessionId && store.kind === 'global') {
      logger.info('[GENERAL_CHAT] Recent messages at limit, using vector search for old context', {
        sessionId: chatSessionId,
        recentCount: recentMessages.length
      });

      // History deep-dive can take 200-1500ms (embedding + vector search).
      // Without an emit here the indicator stalls between intent parsing
      // and the next pipeline event — that's the longest silent window
      // for return users with long chat histories.
      emitProcessingStep(
        chatSessionId,
        'enriching_context',
        'Recalling earlier context...',
        25,
        undefined,
        testCaseId,
      );

      try {
        // Ensure embeddings exist before searching — fixes first-request miss where
        // vector search returns empty because embeddings haven't been created yet.
        // autoEmbedOldMessages is idempotent (skips already-embedded messages).
        const embeddingsExist = await hasEmbeddings(chatSessionId);

        if (!embeddingsExist) {
          logger.info('[GENERAL_CHAT] No embeddings found, creating before search (first-time)', {
            sessionId: chatSessionId,
          });
          // Await with timeout — first time is slower but guarantees context is available
          const embedPromise = autoEmbedOldMessages(chatSessionId);
          const embedTimeout = new Promise<{ success: number; failed: number }>((resolve) =>
            setTimeout(() => resolve({ success: 0, failed: 0 }), 10_000) // 10s cap for first-time embed
          );
          const embedResult = await Promise.race([embedPromise, embedTimeout]);
          logger.info('[GENERAL_CHAT] First-time embedding complete', {
            sessionId: chatSessionId,
            ...embedResult,
          });
        }

        if (abortSignal) checkRequestAborted(abortSignal);

        // Search for relevant old messages using semantic similarity
        const searchChatHistoryWithLogging = functionLogger
          ? withFunctionLogging(searchChatHistory, 'searchChatHistory', functionLogger)
          : searchChatHistory;
        const relevantOldMessages = await searchChatHistoryWithLogging(
          chatSessionId,
          message, // Current user query
          {
            matchCount: 5, // Top 5 (increased from 3 for better recall)
            matchThreshold: 0.4, // Lowered from 0.5 for better recall on vague questions
          }
        );
        if (abortSignal) checkRequestAborted(abortSignal);

        if (relevantOldMessages.length > 0) {
          // Format relevant messages as context
          oldContextSummary = relevantOldMessages
            .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
            .join('\n\n');

          logger.info('[GENERAL_CHAT] Retrieved relevant old context via vectors', {
            retrievedCount: relevantOldMessages.length,
            avgSimilarity: (relevantOldMessages.reduce((sum, m) => sum + m.similarity, 0) / relevantOldMessages.length).toFixed(2),
            oldestDate: relevantOldMessages[0]?.created_at,
          });
        } else {
          logger.info('[GENERAL_CHAT] No relevant old messages found in vector search');
        }
      } catch (vectorError) {
        // Fallback: If vector search fails, continue without old context
        logger.error('[GENERAL_CHAT] Vector search failed, continuing without old context', {
          error: vectorError,
          sessionId: chatSessionId
        });
        oldContextSummary = ''; // No old context
      }
    }

    // Build conversation history with compressed content (use helper for role conversion)
    // ✅ FIX: Include test results from metadata so AI can see them
    // Build messages with timestamps preserved for temporal marker injection
    const messagesWithTime = recentMessages.map(msg => {
      let content = compressMessageContent(msg.content, msg.metadata);

      // ✅ FIX: If message has test results in metadata, append them to content
      if (msg.metadata?.testResult) {
        const testResult = msg.metadata.testResult;
        const testId = msg.metadata.testId;
        const testType = msg.metadata.testType || 'unknown';

        // Format test results for AI context
        let testResultsText = '\n\n--- TEST RESULTS ---\n';
        testResultsText += `Test ID: ${testId}\n`;
        testResultsText += `Test Type: ${testType}\n`;

        // API Test Results
        if (testResult.statusCode) {
          testResultsText += `HTTP Status: ${testResult.statusCode}\n`;
        }
        if (testResult.responseTime !== undefined) {
          testResultsText += `Response Time: ${testResult.responseTime}ms\n`;
        }
        if (testResult.method) {
          testResultsText += `Method: ${testResult.method}\n`;
        }
        if (testResult.responseBody) {
          // Truncate very long response bodies
          const bodyStr = typeof testResult.responseBody === 'string'
            ? testResult.responseBody
            : JSON.stringify(testResult.responseBody, null, 2);
          const truncatedBody = bodyStr.length > 2000
            ? bodyStr.substring(0, 2000) + '... [truncated]'
            : bodyStr;
          testResultsText += `Response Body: ${truncatedBody}\n`;
        }
        if (testResult.headers) {
          testResultsText += `Headers: ${JSON.stringify(testResult.headers)}\n`;
        }

        // UI Test Results
        if (testResult.status) {
          testResultsText += `Status: ${testResult.status}\n`;
        }
        if (testResult.browsers) {
          testResultsText += `Browsers: ${Array.isArray(testResult.browsers) ? testResult.browsers.join(', ') : testResult.browsers}\n`;
        }
        if (testResult.results && Array.isArray(testResult.results)) {
          testResultsText += `Browser Results:\n`;
          testResult.results.forEach((r: any) => {
            testResultsText += `  - ${r.browser}: ${r.status}`;
            if (r.errors && Array.isArray(r.errors) && r.errors.length > 0) {
              testResultsText += ` (${r.errors.length} errors)`;
            }
            testResultsText += '\n';
          });
        }

        if (testResult.url) {
          testResultsText += `URL: ${testResult.url}\n`;
        }
        if (testResult.error) {
          testResultsText += `Error: ${testResult.error}\n`;
        }
        if (testResult.completedAt) {
          testResultsText += `Completed At: ${testResult.completedAt}\n`;
        }
        if (msg.metadata.fuzzingReport) {
          const fuzz = msg.metadata.fuzzingReport;
          testResultsText += `\nFuzzing Report: ${fuzz.totalTests} tests, ${fuzz.passed} passed, ${fuzz.failed} failed, ${fuzz.issuesFound} issues found, Security Score: ${fuzz.securityScore}\n`;
        }

        content += testResultsText;
      }

      return {
        role: convertRoleForOpenAI(msg.role) as 'user' | 'assistant',
        content,
        created_at: msg.created_at,
      };
    });

    // Inject temporal markers (date prefixes + gap separators) for time-aware AI
    conversationHistory = injectTemporalMarkers(messagesWithTime, CONSTANTS.TEMPORAL_GAP_THRESHOLD_MS);

    // ═══════════════════════════════════════════════════════════════════════
    // EDITOR MODE: Compress old non-editor messages to reduce context noise
    // ═══════════════════════════════════════════════════════════════════════
    // In editor mode, old messages about API tests, analytics, etc. can confuse
    // the AI. Keep last 6 messages verbatim (3 exchanges), compress older non-editor
    // messages into a brief summary so the AI focuses on the current page context.
    //
    // Detection strategy (in priority order):
    // 1. metadata.mode === 'editor' — authoritative tag set by save calls (Change 4)
    // 2. metadata.editorAction === true — set by editor_action handler
    // 3. For old messages without tags: skip compression (keep verbatim) to avoid
    //    false positives from content heuristics. Over time, tagged messages will dominate.
    if (mode === 'editor' && conversationHistory.length > 6) {
      const KEEP_VERBATIM = 6;
      const recentVerbatim = conversationHistory.slice(-KEEP_VERBATIM);
      const olderMessages = conversationHistory.slice(0, -KEEP_VERBATIM);

      // Build a set of content strings that belong to editor-mode messages,
      // using the authoritative metadata from the original DB records.
      // injectTemporalMarkers may prepend date prefixes like "[12 Mar, 14:30] ",
      // so we store the ORIGINAL content to match via .endsWith() / .includes().
      const editorContentSignatures = new Set<string>();
      for (const msg of recentMessages) {
        if (msg.metadata?.mode === 'editor' || msg.metadata?.editorAction) {
          // Store first 200 chars as a signature — enough for unique matching
          const sig = (msg.content || '').substring(0, 200);
          if (sig) editorContentSignatures.add(sig);
        }
      }

      const keptOlder: ChatCompletionMessageParam[] = [];
      const compressedParts: string[] = [];

      for (const msg of olderMessages) {
        // Skip system messages (temporal gap markers like "── 2d later ──")
        if (msg.role === 'system') {
          keptOlder.push(msg);
          continue;
        }

        const content = typeof msg.content === 'string' ? msg.content : '';

        // Check if this message is editor-related via metadata signatures
        const isEditorRelated = [...editorContentSignatures].some(sig => content.includes(sig));

        if (isEditorRelated) {
          keptOlder.push(msg);
        } else {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          const preview = content.substring(0, 150).replace(/\n/g, ' ').trim();
          if (preview) {
            compressedParts.push(`${role}: ${preview}${content.length > 150 ? '...' : ''}`);
          }
        }
      }

      if (compressedParts.length > 0) {
        const summary: ChatCompletionMessageParam = {
          role: 'system',
          content: `--- Earlier conversation (non-editor, compressed) ---\n${compressedParts.join('\n')}\n--- End of earlier context ---\nThe user is now in EDITOR MODE. Focus on the current page and recent editor interactions.`,
        };
        conversationHistory = [summary, ...keptOlder, ...recentVerbatim];
      } else {
        conversationHistory = [...keptOlder, ...recentVerbatim];
      }

      logger.info('[GENERAL_CHAT] Editor mode: compressed conversation history', {
        originalCount: olderMessages.length + KEEP_VERBATIM,
        compressedNonEditor: compressedParts.length,
        keptEditorMessages: keptOlder.length,
        verbatimRecent: recentVerbatim.length,
        editorSignatures: editorContentSignatures.size,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: PARALLEL CONTEXT LOADING
  // ═══════════════════════════════════════════════════════════════════════
  // All context sources are independent — run concurrently to save ~400-800ms.
  // Only getAvailableTools depends on projectId, so it runs after.

  const contextStartMs = Date.now();

  // STEP 2 fans out 7 independent fetches (KB / memories / editor / project /
  // integrations / KB files). On a typical question this is the first 200-800ms
  // of silence after intent parsing. Emit a single update so the indicator
  // shows progress instead of freezing on the previous label.
  emitProcessingStep(
    chatSessionId,
    'enriching_context',
    'Gathering knowledge base, memory and project context...',
    35,
    undefined,
    testCaseId,
  );

  const clientProjectId = typeof context === 'object' ? context?.projectId : undefined;
  let projectId: string | undefined;
  // In test-case scope the client intentionally omits projectId, and
  // resolveProjectId can't recover it (it reads the GLOBAL chat_sessions
  // table, which a test_case_chat_sessions id misses → workspace default).
  // Seed from the test case's own access-checked project so KB/file/project
  // context and tool scope target the right project. See BUG-1.
  if (store.kind === 'testcase' && testCaseProjectId) {
    projectId = testCaseProjectId;
  } else if (clientProjectId) {
    // TIER 0 (global scope): the frontend sends the project the user selected
    // in the UI switcher. It is the authoritative source — but it's client
    // input, so verify access (owner OR workspace member) before trusting it,
    // mirroring the regression handlers' Tier-0. Used directly THIS turn for
    // KB/file/project context and tool scope. The controller separately syncs
    // chat_sessions.project_id to this same value so the stale-binding root
    // cause is cleared for every handler. See global-chat-wrong-project fix.
    const { getAccessibleProject } = await import('@/services/chat/mobile-project-context.service');
    const accessible = await getAccessibleProject(userId, clientProjectId);
    if (accessible) {
      projectId = accessible.id;
    } else {
      logger.warn('[GENERAL_CHAT] Client-supplied projectId rejected (no access) — falling back to resolution', {
        userId: userId.substring(0, 8) + '...',
        clientProjectId,
      });
    }
  }
  const parsedContext = typeof context === 'object' && context !== null && !Array.isArray(context)
    ? context as Record<string, any>
    : undefined;
  const workspaceId = paramWorkspaceId
    || (parsedContext?.workspaceId || parsedContext?.workspace_id);

  // Launch all independent fetches in parallel
  const [kbResult, agentMemoryResult, workspaceMemoryResult, editorContextResult, projectResult, integrationResult, kbFilesResult] =
    await Promise.allSettled([
      // 1. KB search (non-fatal) — telemetry fields let us attribute feedback later
      searchKB(message, projectId, {
        matchThreshold: 0.45,
        matchCount: 5,
        telemetry: { userId, sessionId: chatSessionId ?? null, callSite: 'chat-general' },
      })
        .catch((err: Error) => {
          logger.warn('[GENERAL_CHAT] KB search failed, continuing without KB context', {
            error: err.message,
          });
          return { chunks: [], citations: [], sources: { global: [], project: [] } };
        }),

      // 2. Agent memory — summaries from old conversations.
      // Test-case scope: getSummariesForContext reads chat_summaries
      // (global table). Test-case summaries land in test_case_chat_summaries
      // and aren't wired up yet (Phase 11). Skip cleanly, return empty
      // string so the prompt builder treats this as "no agent memory".
      chatSessionId && store.kind === 'global'
        ? getSummariesForContext(chatSessionId).catch((err: Error) => {
            logger.warn('[GENERAL_CHAT] Failed to load agent memory', { error: err.message });
            return '';
          })
        : Promise.resolve(''),

      // 3. Workspace memory — persistent semantic memory
      workspaceId
        ? import('@/services/ai/memory/workspace-memory.service')
            .then(m => m.WorkspaceMemoryService.getMemoryForContext(workspaceId!, 2000))
            .catch((err: Error) => {
              logger.warn('[GENERAL_CHAT] Failed to load workspace memory', {
                error: err.message, workspaceId,
              });
              return '';
            })
        : Promise.resolve(''),

      // 4. Editor page context (editor mode only)
      resolveEditorPageContext(mode, parsedContext, userId),

      // 5. Project ID resolution (Tier 1: session → Tier 2: default)
      !projectId && workspaceId
        ? resolveProjectId(chatSessionId, userId, workspaceId!)
        : Promise.resolve(projectId ? { id: projectId, name: undefined as string | undefined } : null),

      // 6. Integration status — which providers are connected
      userId && workspaceId
        ? import('@/services/api/integration-token.service')
            .then(m => m.IntegrationTokenService.getIntegrationSummary(userId!, workspaceId!))
            .catch(() => '')
        : Promise.resolve(''),

      // 7. KB file inventory — names only, fed into system prompt so the
      // model knows what's available to kb_search before it tries.
      projectId
        ? getProjectFiles(projectId).catch((err: Error) => {
            logger.warn('[GENERAL_CHAT] Failed to load KB file list', { error: err.message });
            return [] as Array<{ fileName: string }>;
          })
        : Promise.resolve([] as Array<{ fileName: string }>),
    ]);

  // Check if request was cancelled during parallel loading
  if (abortSignal) checkRequestAborted(abortSignal);

  // ── Extract results (allSettled never rejects) ──

  let kbContext = '';
  let kbSources: string[] = [];
  if (kbResult.status === 'fulfilled') {
    const kbResults = kbResult.value;
    if (kbResults.chunks.length > 0) {
      kbContext = kbResults.chunks.map((chunk: any) => {
        const source = chunk.source_file || chunk.file_name;
        return source
          ? `[Source: ${source}]\n${chunk.content}`
          : chunk.content;
      }).join('\n---\n');
      kbSources = [...kbResults.sources.project, ...kbResults.sources.global];
      logger.info('[GENERAL_CHAT] KB search returned results', {
        chunksCount: kbResults.chunks.length,
        sources: kbSources,
      });
    }
  }

  let agentMemory = '';
  if (agentMemoryResult.status === 'fulfilled' && agentMemoryResult.value) {
    agentMemory = agentMemoryResult.value;
    logger.info('[GENERAL_CHAT] Loaded agent memory (summaries)', {
      memoryLength: agentMemory.length,
    });
  }

  let workspaceMemory = '';
  if (workspaceMemoryResult.status === 'fulfilled' && workspaceMemoryResult.value) {
    workspaceMemory = workspaceMemoryResult.value;
    logger.info('[GENERAL_CHAT] Loaded workspace memory', {
      workspaceId, memoryLength: workspaceMemory.length,
    });
  }

  let editorPageContext: PageContext | null = null;
  let resolvedPreviewSessionId: string | undefined;
  if (editorContextResult.status === 'fulfilled') {
    editorPageContext = editorContextResult.value.pageContext;
    resolvedPreviewSessionId = editorContextResult.value.previewSessionId;
  }

  let projectName: string | undefined;
  if (projectResult.status === 'fulfilled' && projectResult.value) {
    projectId = projectResult.value.id;
    projectName = projectResult.value.name;
  }

  if (chatTrace) {
    chatTrace.writeRequest({
      message,
      mode,
      previewSessionId: resolvedPreviewSessionId,
      mobileSessionId: parsedContext?.mobileSessionId,
      projectId,
      projectName,
    });
    chatTrace.writePageContext(
      editorPageContext
        ? {
            available: true,
            url: editorPageContext.url,
            elementCount: editorPageContext.testSteps?.length,
            pageTextChars: editorPageContext.pageText?.length,
            hasConsole: !!editorPageContext.consoleErrors,
            hasNetwork: !!editorPageContext.networkSummary,
          }
        : { available: false, reason: mode === 'editor' ? 'no_active_preview_session' : 'not_editor_mode' },
    );
  }

  let integrationContext = '';
  if (integrationResult.status === 'fulfilled' && integrationResult.value) {
    integrationContext = integrationResult.value;
  }

  let kbFileNames: string[] = [];
  if (kbFilesResult.status === 'fulfilled' && Array.isArray(kbFilesResult.value)) {
    kbFileNames = kbFilesResult.value
      .map((f) => f?.fileName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }

  logger.info('[GENERAL_CHAT] Parallel context loading complete', {
    durationMs: Date.now() - contextStartMs,
    hasKB: !!kbContext,
    hasAgentMemory: !!agentMemory,
    hasWorkspaceMemory: !!workspaceMemory,
    hasEditorContext: !!editorPageContext,
    resolvedProjectId: !!projectId,
    hasIntegrationContext: !!integrationContext,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2.8: COLLECT AVAILABLE TOOLS (depends on projectId — sequential)
  // ═══════════════════════════════════════════════════════════════════════
  // Tool inventory load is fast (~30-150ms) but adds another tick of
  // silence after the parallel-context phase. Reuse `enriching_context`
  // so the indicator updates the same row instead of stacking.
  emitProcessingStep(
    chatSessionId,
    'enriching_context',
    'Selecting available tools...',
    45,
    undefined,
    testCaseId,
  );

  let availableTools: any[] = [];
  let skillDescriptions = '';

  if (workspaceId) {
    try {
      const { SkillRegistry } = await import('@/services/skills');

      const skillContext = { userId, workspaceId, chatSessionId, projectId, mode: mode as 'lite' | 'pro' | 'editor' | undefined, storeKind: store.kind, testCaseId };
      availableTools = await SkillRegistry.getAvailableTools(skillContext);
      skillDescriptions = await SkillRegistry.getSkillDescriptions(skillContext);

      logger.info('[GENERAL_CHAT] Tools collected', {
        totalTools: availableTools.length,
      });

      chatTrace?.writeToolsAvailable(
        availableTools
          .map((t) => t?.function?.name)
          .filter((n): n is string => typeof n === 'string'),
      );
    } catch (toolsError) {
      logger.warn('[GENERAL_CHAT] Failed to load tools, continuing without them', {
        error: toolsError instanceof Error ? toolsError.message : String(toolsError),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: BUILD MESSAGES ARRAY FOR OPENAI
  // ═══════════════════════════════════════════════════════════════════════

  const buildChatSystemPromptWithLogging = functionLogger
    ? withFunctionLogging(buildChatSystemPrompt, 'buildChatSystemPrompt', functionLogger)
    : buildChatSystemPrompt;
  let systemPrompt = buildChatSystemPromptWithLogging(skillDescriptions, projectId, projectName, integrationContext, kbFileNames);

  // SECURITY: when untrusted content (live page context OR uploaded documents)
  // is injected below, add the untrusted-content policy ONCE so every wrapped
  // block inherits the "treat as observation, never instructions" rule.
  const hasDocumentAttachments = !!attachments?.some(f => f.type === 'document' && f.extractedText);
  if (editorPageContext || hasDocumentAttachments) {
    systemPrompt += `\n\n${UNTRUSTED_WEB_CONTENT_INSTRUCTION}`;
  }

  // Append editor-specific instructions if in editor mode
  if (mode === 'editor' && editorPageContext) {
    // Full editor prompt — page context IS available
    systemPrompt += `\n\n--- EDITOR MODE (CRITICAL) ---
You are connected to the user's AI Editor with a live browser preview.
You CAN see the current page. A "CURRENT PAGE CONTEXT" system message contains the URL and interactive elements (buttons, inputs, links) visible on the page right now.
NEVER say "I can't view the page" or "I don't have the ability to view web pages" — you DO have page context provided below.
When the user asks about elements on the page, ALWAYS refer to the page context provided to you.
When referencing page elements, use their ref IDs (e.g., ref=b1, ref=i3).

YOU ARE A TEST AUTOMATION AGENT — NOT A TEXT ASSISTANT.
When the user asks to "create a test", "make a test case", "test X flow" — your job is to:
1. Analyze the page DOM and generate STRUCTURED IntentStep objects (not abstract text descriptions)
2. Show the steps in chat in a clear numbered list
3. Ask: "Shall I run these steps on the preview?" (or similar)
4. When user confirms ("да", "запусти", "run it", "давай", "go") → call qa_run_draft_steps

DO NOT just list abstract steps as text. Generate REAL structured steps with specific element references.
DO NOT run steps without user confirmation — always ask first.

STEP GENERATION FORMAT (CRITICAL):
Every step MUST be a valid IntentStep object with these fields:
- id: UUID string (generate with crypto.randomUUID() format, e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
- type: one of: navigate, click, type, select, hover, scroll, press, wait, ai_check, wait_for, upload, check, uncheck
- description: SPECIFIC description using real element labels/text from the DOM (e.g., "Click the 'Войти' button", NOT "Click login button")
- value: (for type/press/select) the actual value to enter
- assertionText: (for ai_check) natural language assertion

EXAMPLE — user says "create a login test" but gave you NO credentials:
NEVER fabricate the email/password. There is no credential store to draw from, so either ASK
("Which account should this test log in with — send the email and password, or the name of a saved login?")
or draft with {{placeholder}} values the user must fill before it can pass:
[
  {"id": "...", "type": "navigate", "description": "Navigate to login page", "value": "https://example.com/login"},
  {"id": "...", "type": "type", "description": "Type the email into the 'Email' input field", "value": "{{secrets.login_email}}"},
  {"id": "...", "type": "type", "description": "Type the password into the 'Password' input field", "value": "{{secrets.login_password}}"},
  {"id": "...", "type": "click", "description": "Click the 'Sign In' button"},
  {"id": "...", "type": "ai_check", "description": "Verify successful login", "assertionText": "The user is logged in and can see the dashboard"}
]
Then tell the user the login fields are placeholders and ask for the real credentials (or a saved login) before running.
When the user provides real credentials → substitute them and call qa_run_draft_steps(steps=<above>, start_url="<current URL>", confirm=true).

EDITOR WORKFLOW:
1. User asks to create/test something → Generate IntentSteps from DOM, show them in chat, ask "Shall I run these?"
2. User confirms ("да" / "запусти" / "run it" / "давай") → call qa_run_draft_steps with steps + start_url + suggested_name → steps execute on live browser
3. User says "save it" / "сохрани" → call qa_create_test_case with the same steps → saved to DB
4. User says "tweak step 3" → modify steps, show updated list, ask to re-run
5. User refers to saved test → qa_run_test with run_type="preview"
- EXCEPTION: If user explicitly says "create AND run" / "сделай и запусти" → generate + run immediately without asking
- ALWAYS pass suggested_name to qa_run_draft_steps — a short 3-5 word title like "Positive Login Flow" or "Checkout with Promo Code". This becomes the default test case name if the user clicks "Save as test case" later.

IMPORTANT RULES:
- Do NOT call qa_create_test_case unless user explicitly says "save" / "сохрани" / "persist"
- For SINGLE actions (one click, one type) → this is editor_action, handled automatically
- For MULTI-STEP flows (login, checkout, search+filter):
  • If the user just names a GOAL on the current page and you do NOT already have concrete steps ("test the login flow", "протестируй оформление заказа") → PREFER qa_author_test_iteratively(goal, confirm). It builds the test by doing it live on the page — each step is grounded in the real DOM and already verified, no guessing. TWO-TURN APPROVAL, in this order: (1) call it with confirm=false FIRST — that call validates the goal, the preview session and any named saved login, and returns the preview you must relay; (2) describe that preview to the user and wait for their explicit "yes"; (3) call it AGAIN with confirm=true. Do not ask the user for approval before the confirm=false call — you would be describing a test the server has not validated, and the approval will not be honoured. ${CredentialAuthoringFeature.isEnabled() ? 'LOGIN FLOWS: pass the name of a SAVED login as credential_secret_name — the server injects the stored credentials for the live run and freezes {{secrets.*}} into the steps, so the saved test replays. If you do not know which saved login to use, ASK ("which saved login should this test use?"); if the project has none, say so and draft with {{secrets.*}} placeholders via qa_run_draft_steps instead (see GROUNDING). Never invent credentials.' : 'EXCEPTION: if the goal needs credentials the user has NOT provided (e.g. a login flow), do NOT use qa_author_test_iteratively — it would fabricate or fail live. Ask for the login first, or draft with {{secrets.*}} placeholders via qa_run_draft_steps (see GROUNDING).'}
  • If YOU already produced explicit IntentSteps (the user gave exact steps, or you're re-running a known list) → use qa_run_draft_steps as before.
  • After either tool returns, the steps are cached — when the user says "save", call qa_create_test_case (the authored steps already passed; no re-run needed).

POST-RUN BEHAVIOR (CRITICAL):
- qa_run_draft_steps and qa_run_test (run_type="preview") AWAIT the full run. When the tool returns, the run is FINISHED.
- The result.data contains: { success, totalSteps, passedSteps, failedSteps, skippedSteps, cancelled, timedOut, duration, firstError? }
- After the tool returns, your reply MUST:
  1. Use past tense and report the actual numbers ("The run finished — 5/5 steps passed in 13.6s.")
  2. If failedSteps > 0 → quote firstError and the failed step description
  3. If you proposed multiple cases earlier and only ran one → name the remaining cases and offer to run them next
  4. If success and only one case → suggest "Save as test case" or related next actions
- NEVER say "I'll start the run" or "watching the browser" — by the time you reply, the run is already done

WHEN THE PAGE DOESN'T MATCH:
- If the requested test target isn't on the current page, add a "navigate" step first to go to the right URL
- The element resolver will resolve descriptions at runtime — you don't need exact selectors, just accurate descriptions
- NEVER invent elements not visible in the DOM context

STEP DESCRIPTIONS — BE SPECIFIC:
- Use REAL element labels, placeholder text, and ref IDs from the page context
- GOOD: "Click the 'Физика' subject filter button" / "Type the search term into the search input (ref=i3)"
- BAD: "Click the subject button" / "Enter email address"
- For elements not in the viewport, describe them by their text/label — the resolver will find them
- Describe WHAT to type, don't invent the value: a step's description names the field; the value comes from the user or a {{placeholder}} (see GROUNDING below), never a fabricated credential literal.

GROUNDING — NEVER FABRICATE INPUT VALUES:
- A step's value (login email/password, IDs, tokens, any specific data) MUST come from the user, the live DOM, or a saved resource — never an invented literal ("test@example.com", "password123", made-up IDs).
- No credential store exists yet: if the user did not give the login, ASK for it, or use {{secrets.login_email}} / {{secrets.login_password}} placeholders (the secrets.* namespace is the one that resolves at runtime and gets redacted) and have the user fill them before running. A fabricated credential looks fine but makes the test unrunnable.`;
  } else if (mode === 'editor' && !editorPageContext) {
    // Limited editor prompt — page context is NOT available (session expired, snapshot failed, etc.)
    systemPrompt += `\n\n--- EDITOR MODE (LIMITED) ---
You are connected to the user's AI Editor, but the live page context is temporarily unavailable.
This may happen if the preview browser session has expired or the page hasn't finished loading.
Do NOT say "I can't see images or screenshots" — instead explain that the page preview connection is temporarily unavailable.
Suggest the user to:
1. Refresh the preview page (click the refresh button in the preview toolbar)
2. Re-enter the URL in the AI Editor to start a new preview session
3. Try sending the message again after the page loads

You can still help with general questions, saved test cases, and test management even without live page context.`;
  }

  // Per-test-case scope reinforcement. Layered ON TOP of the editor-mode
  // block above: the chat lives inside ONE existing test case's editor, so the
  // agent must (a) treat save/update as editing THIS test case, and (b) use the
  // live page context confidently to build and immediately run the right test.
  if (testCaseId && mode === 'editor') {
    systemPrompt += `\n\n--- TEST-CASE SCOPE (you are editing ONE existing test case) ---
You are inside the editor for the test case currently open in the preview. The
"CURRENT PAGE CONTEXT" above is the live page this test targets. Act with that context:
- BUILD CONFIDENTLY: when the user asks to create/extend a flow, read the page
  context (URL, interactive elements with ref IDs, page text, console/network
  signals) and generate concrete IntentSteps yourself. Do NOT ask the user for
  element names or selectors you can already see in the context.
- CREATE + RUN IN ONE GO: for a clear request ("проверь логин", "test the search"),
  generate the steps and run them on the preview in the same turn via
  qa_run_draft_steps(confirm=true) — you do not need a separate confirmation round
  in editor mode. Only pause to ask when the request is genuinely ambiguous.
- SAVE = UPDATE THIS TEST CASE: when the user says "save"/"сохрани"/"обнови", call
  qa_update_test_case_steps for THIS test case. Use qa_create_test_case ONLY when
  the user explicitly wants a NEW/separate test case.
- After a run, report the real outcome (passed/failed counts, first error) in past
  tense — the user already saw the live progress.`;
  }

  // Enhance system prompt with old context summary from vector search
  const enhancedSystemPrompt = oldContextSummary
    ? `${systemPrompt}\n--- Previous Conversation Context ---\n${oldContextSummary}\n\nNote: The above is a summary of earlier messages. Recent messages follow below.`
    : systemPrompt;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: enhancedSystemPrompt },
  ];

  // Add agent memory (summaries of old conversations)
  if (agentMemory) {
    messages.push({
      role: 'system',
      content: `--- Agent Memory (Conversation History Summaries) ---\n${agentMemory}\n\nThis is a compressed summary of earlier conversations in this workspace chat.`,
    });
  }

  // Add workspace memory (persistent semantic memory)
  if (workspaceMemory) {
    messages.push({
      role: 'system',
      content: `--- Workspace Memory (Persistent Facts & Preferences) ---\n${workspaceMemory}\n\nThese are important facts, preferences, and patterns you've remembered about this workspace.`,
    });
  }

  // Add KB context if available (persistent background knowledge)
  if (kbContext) {
    messages.push({
      role: 'system',
      content: `--- Knowledge Base (Project Documentation) ---\n${kbContext}\n\nUse this documentation for accurate, product-specific answers. When referencing information from the KB, mention the source document name naturally (e.g., "According to your API docs..." or "Based on the requirements document...").`,
    });
  }

  // Add editor page context if available
  if (editorPageContext) {
    messages.push({
      role: 'system',
      content: formatPageContextForChat(editorPageContext),
    });
  }

  // Live Explore-screen state (Slice B): the frontend sends a facts-only
  // snapshot so the agent can SEE the current surface + mobile readiness and
  // answer "why won't it start / what do I do" about THIS screen. Pushed as a
  // system message so it reaches BOTH the monolithic and sub-agent paths
  // (the appended systemPrompt blocks above do NOT flow into the pipeline).
  const exploreStateMessage = formatExploreStateForChat(parsedContext?.exploreState);
  if (exploreStateMessage) {
    messages.push({ role: 'system', content: exploreStateMessage });
  }

  // Inject cached draft steps for cross-turn persistence (editor mode only)
  // Ensures the AI can retrieve structured steps when user says "run it" or "save it"
  // in a subsequent turn, without re-parsing from compressed message history
  if (mode === 'editor' && chatSessionId) {
    try {
      const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
      const cached = DraftStepsCache.get(chatSessionId);
      if (cached) {
        const stepsJson = JSON.stringify(cached.steps, null, 2);
        messages.push({
          role: 'system',
          content: `--- DRAFT TEST STEPS (generated earlier in this conversation) ---\nUse these when the user asks to "run it", "save it", or modify steps.\nStart URL: ${cached.startUrl}\nSteps (${cached.steps.length} total):\n${stepsJson}\n--- END DRAFT STEPS ---`,
        });

        logger.debug('[GENERAL_CHAT] Injected cached draft steps into context', {
          chatSessionId,
          stepCount: cached.steps.length,
          startUrl: cached.startUrl,
          ageMs: Date.now() - cached.createdAt,
        });
      }
    } catch (cacheError) {
      logger.warn('[GENERAL_CHAT] Failed to load draft steps cache', {
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });
    }
  }

  // Add additional context if provided (legacy support)
  const contextString = typeof context === 'string' ? context : undefined;
  if (contextString) {
    messages.push({
      role: 'system',
      content: `Additional Context: ${contextString}`,
    });
  }

  // Add conversation history
  messages.push(...conversationHistory);

  // Add editor page context AFTER history (closest to user message = highest priority).
  // LLMs give more weight to recent context (recency bias), so placing the current
  // page DOM/URL right before the user's message ensures it overrides stale history.
  if (editorPageContext) {
    messages.push({
      role: 'system',
      content: formatPageContextForChat(editorPageContext),
    });
  }

  // Add current message (with multimodal content if attachments present)
  const hasAttachments = attachments && attachments.length > 0;
  if (hasAttachments) {
    // Build content array with text + images
    const contentParts: ChatCompletionContentPart[] = [];

    // Text part: original message + appended document contents.
    // SECURITY: uploaded/forwarded documents are attacker-controllable, so
    // their text is wrapped in an untrusted-content fence (markers stripped
    // from the body so a planted delimiter can't break out) rather than a
    // bare Markdown code fence that ``` inside the doc could close.
    let textContent = message;
    for (const doc of attachments.filter(f => f.type === 'document' && f.extractedText)) {
      textContent += `\n\nAttached file "${doc.name}":\n${wrapUntrustedContent(doc.extractedText!, `DOCUMENT: ${doc.name}`)}`;
    }
    contentParts.push({ type: 'text', text: textContent });

    // Image parts (only include if base64 data is present)
    for (const img of attachments.filter(f => f.type === 'image' && f.base64)) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: img.base64!, detail: 'high' },
      });
    }

    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: message });
  }

  logger.info('[GENERAL_CHAT] Built context for AI', {
    totalMessages: messages.length,
    hasAgentMemory: !!agentMemory,
    hasOldSummary: !!oldContextSummary,
    hasKBContext: !!kbContext,
    hasEditorContext: !!editorPageContext,
    isEditorMode: mode === 'editor',
    recentHistoryCount: conversationHistory.length,
    attachments: hasAttachments ? {
      images: attachments.filter(a => a.type === 'image').length,
      documents: attachments.filter(a => a.type === 'document').length,
    } : undefined,
  });

  // NOTE: Credit check removed here — already performed in chat.controller.ts
  // (Step 1.5) before any handler is invoked. No need to check twice.

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: AGENTIC TOOL-CALLING LOOP
  // ═══════════════════════════════════════════════════════════════════════
  const emitProcessingStepWithLogging = functionLogger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
    : emitProcessingStep;
  const thinkingMessage = mode === 'editor' ? 'Analyzing the page...' : 'Thinking...';
  // Pass testCaseId so progress events also reach `chat:tc:<tcid>` room —
  // critical for the lazy-create window where the frontend subscribed
  // by testCaseId before the session existed.
  emitProcessingStepWithLogging(
    chatSessionId,
    'generating_response',
    thinkingMessage,
    PROGRESS.ROUTING,
    undefined,
    testCaseId,
  );

  let gptResponse: { content: string; usage?: any };
  let shouldDeductCredits = false;
  let requestCancelled = false;
  let pipelineClarification = false;
  /**
   * Quick action descriptors emitted by the sub-agent pipeline (or the
   * monolithic loop fallback). Attached to the AI message metadata so the
   * frontend renders inline action buttons. Undefined when no actions apply.
   */
  let pipelineQuickActions:
    | import('@/api/chat/shared/quick-action.types').QuickAction[]
    | undefined;
  /**
   * Structured draft steps authored by qa_run_draft_steps this turn. Lifted
   * onto the AI message metadata + HTTP reply so the chat renders them as
   * editable step widgets (parity with the mobile agent). Undefined when no
   * draft was authored.
   */
  let pipelineDraftSteps: unknown[] | undefined;
  let pipelineDraftMeta: Record<string, unknown> | undefined;
  const MAX_TOOL_ROUNDS = 5; // Prevent infinite loops

  // Wrap AI calls with tracking context
  const executeAgenticLoop = async () => {
    // Begin AI usage tracking session (only if workspaceId exists)
    const trackingSessionId = workspaceId ? chatSessionId : null;
    if (trackingSessionId && workspaceId) {
      AIUsageTracker.beginSession(trackingSessionId, {
        workspaceId,
        userId,
        operationType: 'chat',
      });
    }

    // Resolve the name of the test case in scope so the executor prompt can
    // address it by name ("you are editing \"Login Flow\""). Best-effort and
    // tc-scope-only — never blocks or fails the chat path.
    let testCaseName: string | undefined;
    if (testCaseId) {
      try {
        const { IntentTestCaseService } = await import(
          '@/services/testing/ui/preview/intent-test-case.service'
        );
        const tc = await IntentTestCaseService.getById(testCaseId, userId);
        testCaseName = tc?.name;
      } catch (nameErr) {
        logger.debug('[GENERAL_CHAT] Could not resolve test case name (non-critical)', {
          testCaseId,
          error: nameErr instanceof Error ? nameErr.message : String(nameErr),
        });
      }
    }

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // SUB-AGENT PIPELINE (preferred path — cheaper, faster, more focused)
      // Falls back to monolithic loop below if pipeline fails or is disabled
      // ═══════════════════════════════════════════════════════════════════════
      // Track tools executed by pipeline (used to seed monolithic tracker on fallback)
      let pipelineExecutedTools: Array<{ toolName: string; args: Record<string, any> }> | undefined;

      if (SUB_AGENT_CONFIG.enabled && workspaceId) {
        try {
          const pipeline = new SubAgentPipeline({
            userId,
            workspaceId,
            chatSessionId,
            projectId,
            projectName,
            previewSessionId: resolvedPreviewSessionId,
            mode: mode as 'lite' | 'pro' | 'editor' | undefined,
            // Pass testCaseId so the pipeline's emitStep dual-broadcasts
            // to `chat:tc:<tcid>` — without this, the test-case chat
            // sees zero progress events while sub-agents work.
            testCaseId,
            testCaseName,
            // Scope marker for every SkillContext the pipeline builds — see
            // PipelineContext.storeKind. The monolithic loop below already
            // passes it; the sub-agent path did not, which left skill-level
            // scope gates reading `undefined`.
            storeKind: store.kind,
          });

          // Extract the user content from the last message (may be multimodal array with images)
          const lastMsg = messages[messages.length - 1];
          const userContent = lastMsg?.role === 'user' ? lastMsg.content : undefined;

          const pipelineResult = await pipeline.execute({
            userMessage: message,
            userContent: userContent ?? message,
            messages,
            availableTools,
            skillDescriptions,
            abortSignal,
            needsTools,
          });

          // Store pipeline metrics for analytics (regardless of success/failure)
          if (trackingSessionId) {
            AIUsageTracker.recordPipelineMetrics(trackingSessionId, {
              path: pipelineResult.path,
              success: pipelineResult.success,
              ...pipelineResult.metrics,
            });
          }

          if (pipelineResult.success) {
            logger.info('[GENERAL_CHAT] Sub-agent pipeline succeeded', {
              path: pipelineResult.path,
              needsClarification: pipelineResult.needsClarification ?? false,
              metrics: pipelineResult.metrics,
              quickActionsCount: pipelineResult.quickActions?.length ?? 0,
            });

            gptResponse = { content: pipelineResult.content, usage: undefined };
            // Surface synthesized quick actions to the outer scope so the
            // metadata builder can attach them to the AI message.
            pipelineQuickActions = pipelineResult.quickActions;
            // Surface authored draft steps so the metadata builder attaches them
            // to the AI message (editable step widgets in chat).
            pipelineDraftSteps = pipelineResult.draftSteps;
            pipelineDraftMeta = pipelineResult.draftMeta;
            // Clarification responses don't deduct credits (user didn't get an answer)
            shouldDeductCredits = !pipelineResult.needsClarification;
            if (pipelineResult.needsClarification) {
              pipelineClarification = true;
            }
            return { gptResponse, shouldDeductCredits };
          }

          // Pipeline returned { success: false } — fall through to monolithic loop
          pipelineExecutedTools = pipelineResult.executedTools;
          logger.info('[GENERAL_CHAT] Sub-agent pipeline fell back to monolithic', {
            path: pipelineResult.path,
            routerClassification: pipelineResult.metrics.routerClassification,
            routerConfidence: pipelineResult.metrics.routerConfidence,
            priorToolsCount: pipelineExecutedTools?.length ?? 0,
          });
        } catch (pipelineError) {
          logger.warn('[GENERAL_CHAT] Sub-agent pipeline error, falling back', {
            error: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
          });
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // MONOLITHIC AGENTIC LOOP (fallback — original implementation)
      // ═══════════════════════════════════════════════════════════════════════
      let toolRound = 0;
      let finalResponse: string | null = null;
      const monolithicTracker = new ToolCallTracker(SUB_AGENT_CONFIG.loopDetection);
      // Accumulate tool execution records so we can run the quick-actions
      // injector at the end of the loop (mirrors pipeline behavior). Without
      // this, draft-run actions disappear when sub-agents are disabled.
      const monolithicToolResults: import('@/api/chat/general/sub-agents/types').ToolExecutionRecord[] = [];

      // Seed tracker with tools already executed by pipeline (prevents duplicate calls)
      if (pipelineExecutedTools?.length) {
        for (const prior of pipelineExecutedTools) {
          monolithicTracker.record(prior.toolName, prior.args);
        }
        logger.info('[GENERAL_CHAT] Monolithic tracker seeded with pipeline history', {
          count: pipelineExecutedTools.length,
          tools: pipelineExecutedTools.map(t => t.toolName),
        });
      }

      // Agentic loop: keep calling OpenAI until no more tool calls
      while (toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;

      logger.info('[GENERAL_CHAT] Tool round', { round: toolRound, messagesCount: messages.length });

      // Emit a "thinking" update only on the very first LLM call of the
      // fallback. On subsequent rounds we already had tool emits at 70-88%
      // — re-emitting "Drafting (round N)" at a lower progress would make
      // the bar regress, which looks like the request stalled.
      //
      // Progress 80 sits above most pipeline emits (router=60, planner=68,
      // executor=70-88) so even when the fallback follows a partially-
      // completed pipeline run, the indicator only ever moves forward.
      if (toolRound === 1) {
        emitProcessingStep(
          chatSessionId,
          'agent_thinking',
          'Drafting response...',
          80,
          { round: toolRound },
          testCaseId,
        );
      }

      const getChatCompletionWithMessagesWithLogging = functionLogger
        ? withFunctionLogging(getChatCompletionWithMessages, 'getChatCompletionWithMessages', functionLogger)
        : getChatCompletionWithMessages;

      // Call OpenAI with tools (if available)
      const response = await getChatCompletionWithMessagesWithLogging(messages, {
        temperature: 0.3,
        max_tokens: 2000,
        abortSignal,
        tools: availableTools.length > 0 ? availableTools : undefined,
        tool_choice: availableTools.length > 0 ? 'auto' : undefined,
      });

      // Check for tool calls
      const toolCalls = response.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls - this is the final text response
        finalResponse = response.content;
        break;
      }

      // Execute tool calls
      logger.info('[GENERAL_CHAT] Executing tool calls', {
        count: toolCalls.length,
        tools: toolCalls.map((tc) => tc.function.name),
      });

      // Add assistant message with tool calls to history
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: toolCalls,
      } as any);

      // Execute each tool call via centralized ToolExecutor
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;

        // Safely parse tool arguments — malformed JSON from LLM should not crash the loop
        let toolArgs: Record<string, any>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          logger.warn('[GENERAL_CHAT] Failed to parse tool arguments', {
            toolName,
            raw: toolCall.function.arguments?.substring(0, 200),
          });
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              success: false,
              message: 'Invalid arguments: failed to parse JSON',
            }),
          } as any);
          continue; // Skip this tool, continue with others
        }

        logger.info('[GENERAL_CHAT] Executing tool', {
          toolName,
          args: JSON.stringify(toolArgs),
        });

        // Mirror the executor-agent's before/after pair so the timeline
        // looks the same whether the pipeline or the fallback ran.
        // Progress uses CUMULATIVE tool count across all rounds (not the
        // current round's count) so it grows monotonically — going from
        // round 1 with 88% back down to ~76% in round 2 would look like
        // the bar reset. The "expected total" budget is conservative
        // (5 tools) so the first few tools step the bar a little; if
        // there are more, computeToolProgress just clamps at 88%.
        emitProcessingStep(
          chatSessionId,
          'agent_executing_tool',
          `Using ${humanizeToolName(toolName)}...`,
          computeToolProgress(monolithicToolResults.length, 5),
          { toolName, round: toolRound },
          testCaseId,
        );

        // Execute through centralized pipeline (routing, hooks, timeout, screenshot handling)
        const skillContext = {
          userId,
          workspaceId: workspaceId!,
          chatSessionId,
          projectId,
          previewSessionId: resolvedPreviewSessionId,
          mode: mode as 'lite' | 'pro' | 'editor' | undefined,
          storeKind: store.kind,
          testCaseId,
        };

        const callResult = await executeTool({
          toolName,
          toolCallId: toolCall.id,
          args: toolArgs,
          skillContext,
          abortSignal,
          tracker: monolithicTracker,
        });

        messages.push(...callResult.messages);
        // Accumulate for quick-actions injection at end of loop
        monolithicToolResults.push(callResult.record);

        emitProcessingStep(
          chatSessionId,
          'agent_executing_tool',
          callResult.toolResult.success
            ? `${humanizeToolName(toolName)} done`
            : `${humanizeToolName(toolName)} had an issue`,
          computeToolProgress(monolithicToolResults.length, 5),
          { toolName, success: callResult.toolResult.success, durationMs: callResult.record.durationMs },
          testCaseId,
        );

        logger.info('[GENERAL_CHAT] Tool executed', {
          toolName,
          success: callResult.toolResult.success,
          durationMs: callResult.record.durationMs,
        });
      }

      // Continue loop to get next response from OpenAI
    }

    if (!finalResponse) {
      // Max rounds reached without final response — provide partial context if available
      const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
      finalResponse = lastAssistantMsg?.content
        ? `${lastAssistantMsg.content}\n\n(Note: I reached the maximum number of analysis steps. The above may be incomplete — feel free to ask a follow-up question for more detail.)`
        : "I ran out of analysis steps before completing my response. Could you try asking a more specific question so I can answer within fewer steps?";
      logger.warn('[GENERAL_CHAT] Max tool rounds reached', { rounds: MAX_TOOL_ROUNDS });
    }

    // Record monolithic fallback metrics for agent health tracking
    if (trackingSessionId) {
      AIUsageTracker.recordPipelineMetrics(trackingSessionId, {
        path: 'monolithic_fallback',
        success: true,
        totalMs: 0, // not tracked in monolithic loop
        toolRounds: toolRound,
      });
    }

    // Inject quick actions from the monolithic loop's tool results so editor
    // mode users still get the Save button when sub-agent pipeline is bypassed.
    if (monolithicToolResults.length > 0) {
      try {
        const { injectQuickActions, extractDraftSteps } = await import('@/api/chat/general/sub-agents/quick-actions-injector');
        const monolithicQuickActions = injectQuickActions(monolithicToolResults, {
          mode: mode as 'lite' | 'pro' | 'editor' | undefined,
          previewSessionId: resolvedPreviewSessionId,
          chatSessionId,
          projectId,
          userId,
        });
        if (monolithicQuickActions.length > 0) {
          pipelineQuickActions = monolithicQuickActions;
        }
        const monolithicDraft = extractDraftSteps(monolithicToolResults);
        if (monolithicDraft) {
          pipelineDraftSteps = monolithicDraft.draftSteps;
          pipelineDraftMeta = monolithicDraft.draftMeta;
        }
      } catch (injErr) {
        logger.warn('[GENERAL_CHAT] Failed to inject quick actions from monolithic loop', {
          error: injErr instanceof Error ? injErr.message : String(injErr),
        });
      }
    }

    gptResponse = { content: finalResponse, usage: undefined };
    shouldDeductCredits = true;
  } catch (openaiError: any) {
    // Check if request was aborted (client closed connection)
    if (openaiError?.message?.includes('cancelled') ||
      openaiError?.message?.includes('aborted') ||
      openaiError?.message?.includes('signal')) {
      logger.warn('[GENERAL_CHAT] Request was cancelled by client', {
        error: openaiError instanceof Error ? openaiError.message : String(openaiError),
        userId,
      });

      // Check if response already sent
      if (!res.headersSent) {
        res.status(499).json({
          success: false,
          error: 'Request was cancelled',
          message: 'The request was cancelled. Please try again.',
          timestamp: new Date().toISOString(),
        });
      }

      // Signal to outer handler that request was cancelled
      requestCancelled = true;
      return {
        gptResponse: { content: '', usage: undefined },
        shouldDeductCredits: false,
      };
    }

    // Fallback response if OpenAI fails
    logger.error('[GENERAL_CHAT] OpenAI API failed, using fallback response', {
      error: openaiError instanceof Error ? openaiError.message : String(openaiError),
      status: openaiError?.status,
      code: openaiError?.code,
      userId,
    });

    // Classify the failure and surface a SPECIFIC, localized message per class
    // (not one catch-all). Language comes from the intent parser (userLanguage),
    // so the user reads the hint in their own language.
    const chatErrors = getLocalizedMessages(params.userLanguage).chatError;
    const status = openaiError?.status;
    const code = openaiError?.code;
    const msg = String(openaiError?.message || '').toLowerCase();

    let fallbackMessage: string;
    if (status === 401 || status === 403 || code === 'invalid_api_key') {
      // Auth/config — user can't fix it; team is notified.
      fallbackMessage = chatErrors.config;
    } else if (status === 429 || code === 'insufficient_quota' || code === 'rate_limit_exceeded') {
      fallbackMessage = chatErrors.rateLimit;
    } else if (
      code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
      || msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket hang up')
    ) {
      fallbackMessage = chatErrors.network;
    } else if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('took too long')) {
      fallbackMessage = chatErrors.timeout;
    } else {
      // 500/502/503 or anything unclassified.
      fallbackMessage = chatErrors.generic;
    }

      gptResponse = {
        content: fallbackMessage,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'fallback',
        },
      };
      // Don't deduct credits for fallback responses
      shouldDeductCredits = false;
    } finally {
      // End AI usage tracking session
      if (trackingSessionId) {
        const usageStats = await AIUsageTracker.endSession(trackingSessionId);
        if (usageStats) {
          logger.info('[GENERAL_CHAT] AI usage stats', {
            chatSessionId: trackingSessionId,
            workspaceId,
            ...usageStats,
          });
        }
      }
    }

    return { gptResponse, shouldDeductCredits };
  };

  // Execute agentic loop within AI tracking context
  if (workspaceId) {
    const agenticResult = await withAIContext(
      { workspaceId, userId, operationType: 'chat' },
      executeAgenticLoop
    );
    gptResponse = agenticResult.gptResponse;
    shouldDeductCredits = agenticResult.shouldDeductCredits;
  } else {
    const agenticResult = await executeAgenticLoop();
    gptResponse = agenticResult.gptResponse;
    shouldDeductCredits = agenticResult.shouldDeductCredits;
  }

  // If request was cancelled, stop all further processing (no message saving, no response)
  if (requestCancelled) {
    return;
  }

  // Pipeline's last emit ('Composing response...') is at 90% but then we
  // still have credit deduction + DB save + auto-title before res.json
  // (1.5-4s on slow networks). One last update so the indicator doesn't
  // freeze on the previous label while the message is being persisted.
  // Reuses `agent_formatting` so it overwrites the pipeline's row instead
  // of stacking a new one.
  emitProcessingStep(
    chatSessionId,
    'agent_formatting',
    'Saving response...',
    96,
    undefined,
    testCaseId,
  );

  // Honor cancellation BEFORE deducting credits. If the user aborted after the
  // response was generated, this throws and the reply is neither saved nor
  // delivered — so charging for it would lose the user a credit for nothing.
  // Checking here (not after deduction) keeps "no charge" and "no save"
  // consistent on the cancel path.
  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3.5: DEDUCT CREDITS AFTER SUCCESSFUL RESPONSE
  // ═══════════════════════════════════════════════════════════════════════
  // Deduct 1 credit for chat message (fixed cost per message)
  // Only deduct if we got a real OpenAI response (not fallback)

  if (shouldDeductCredits && gptResponse && gptResponse.content) {
    try {
      const deductChatCreditsWithLogging = functionLogger
        ? withFunctionLogging(deductChatCredits, 'deductChatCredits', functionLogger)
        : deductChatCredits;
      await deductChatCreditsWithLogging(userId, shouldDeductCredits);
    } catch (creditError) {
      // Credit deduction failure must NEVER drop the AI response.
      // The response is already generated — deliver it to the user regardless.
      // Credits can be reconciled later via background audit.
      logger.error('[GENERAL_CHAT] Credit deduction failed — delivering response anyway', {
        error: creditError instanceof Error ? creditError.message : String(creditError),
        userId,
        chatSessionId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: SAVE MESSAGES
  // ═══════════════════════════════════════════════════════════════════════

  let userMessageTimestamp: string | undefined;
  let aiReplyTimestamp: string | undefined;

  // AI message metadata is built before the chatSessionId block (so it's
  // always available for the HTTP response below) and then conditionally
  // persisted inside the block.
  const aiMessageMetadata: Record<string, any> = {};

  if (pipelineClarification) {
    aiMessageMetadata.requiresAnswers = true;
    aiMessageMetadata.needsMoreInfo = true;
    aiMessageMetadata.source = 'sub_agent_pipeline';
  }
  // Attach quick action descriptors so the frontend renders inline buttons.
  // Empty/undefined → no actions key on metadata (frontend renders nothing).
  if (pipelineQuickActions && pipelineQuickActions.length > 0) {
    aiMessageMetadata.actions = pipelineQuickActions;
  }

  if (chatSessionId) {
    // Save through the persistence façade — backend selected by `store`
    // (set at the top of this function from params.chatStore || GLOBAL_STORE).
    // This is the line that prevents test-case writes from leaking into
    // the global chat_messages table. Do not replace with a direct
    // ChatService call.
    const saveChatMessagesWithLogging = functionLogger
      ? withFunctionLogging(
          ChatPersistence.saveMessages.bind(ChatPersistence),
          'ChatPersistence.saveMessages',
          functionLogger,
        )
      : ChatPersistence.saveMessages.bind(ChatPersistence);

    // Build user message metadata (include file info if attachments present)
    const modeTag = mode || 'lite';
    const userMessageMetadata: Record<string, any> = { mode: modeTag };
    if (hasAttachments) {
      userMessageMetadata.files = attachments.map(f => ({ name: f.name, type: f.type, mimeType: f.mimeType, size: f.size }));
    }

    // Tag messages with draft steps so they won't be compressed on future history loads
    if (mode === 'editor' && chatSessionId) {
      try {
        const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
        if (DraftStepsCache.get(chatSessionId)) {
          aiMessageMetadata.hasDraftSteps = true;
        }
      } catch { /* non-critical */ }
    }
    // Structured draft steps → editable step widgets in chat (parity with
    // mobile). Persisted on the message + mirrored to the HTTP reply below.
    if (Array.isArray(pipelineDraftSteps) && pipelineDraftSteps.length > 0 && pipelineDraftMeta) {
      aiMessageMetadata.draftSteps = pipelineDraftSteps;
      aiMessageMetadata.draftMeta = pipelineDraftMeta;
    }

    const timestamps = await saveChatMessagesWithLogging(store, chatSessionId, [
      { role: 'user', content: message, metadata: userMessageMetadata },
      {
        role: 'ai',
        content: gptResponse.content,
        metadata: Object.keys(aiMessageMetadata).length > 0 ? aiMessageMetadata : undefined,
      },
    ]);

    // Extract timestamps + IDs: first is user message, second is AI reply
    if (timestamps.length >= 2) {
      userMessageTimestamp = timestamps[0].created_at;
      aiReplyTimestamp = timestamps[1].created_at;

      // Link the assistant message to the retrieval event we logged earlier.
      // Fire-and-forget — telemetry must never block the response.
      const aiMessageId = timestamps[1].id;
      if (chatSessionId && aiMessageId) {
        import('@/services/kb/retrieval-telemetry.service')
          .then((mod) => mod.linkMessageToLastRetrieval(chatSessionId, aiMessageId))
          .catch(() => { /* telemetry is non-fatal */ });
      }
    }

    // Auto-generate title for new chats (after first user message).
    // Routed through ChatPersistence so test-case sessions update their
    // own row, not the global one. Fire-and-forget — title gen must
    // never block the response.
    ChatPersistence.autoGenerateTitle(store, chatSessionId).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-generate title', {
        error,
        chatSessionId,
        chatStore: store.kind,
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-EMBED OLD MESSAGES (AFTER SAVING - for NEXT request)
    // ═══════════════════════════════════════════════════════════════════════
    // Skip the embed/summary path entirely for test-case scope.
    //
    // The downstream services (autoEmbedOldMessages, summarizeOldMessages)
    // are hard-coded to read from `chat_messages` / write to
    // `chat_message_embeddings` / `chat_summaries`. If we fed them a
    // test-case session id they would either silently no-op (count = 0,
    // session not found in chat_messages) or — worse — risk inserting
    // ghost rows into the global tables. Wiring them up properly for
    // test-case storage is a separate phase; until then, we just don't
    // call them for test-case sessions. Acceptable cost: per-test-case
    // chats lose long-context recall after 20 messages until embeddings
    // are wired in. Tracked as TODO (Phase 11).
    let totalMessagesNow = 0;
    if (store.kind === 'global') {
      const { count: totalMessageCountAfterSave } = await supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', chatSessionId);
      totalMessagesNow = totalMessageCountAfterSave || 0;
    }

    // If we now have more than 20 messages, create embeddings for old ones
    if (totalMessagesNow > CONSTANTS.RECENT_MESSAGES_LIMIT) {
      logger.info('[GENERAL_CHAT] Creating embeddings for old messages (background)', {
        sessionId: chatSessionId,
        totalMessages: totalMessagesNow
      });

      // Auto-embed with timeout to prevent memory leak
      // This runs in background and doesn't block the response
      const embedPromise = autoEmbedOldMessages(chatSessionId);
      const embedTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Auto-embed timeout')), CONSTANTS.AUTO_EMBED_TIMEOUT)
      );

      Promise.race([embedPromise, embedTimeout]).catch(error => {
        logger.warn('[GENERAL_CHAT] Failed to auto-embed messages (background)', {
          error: error instanceof Error ? error.message : String(error),
          timeout: CONSTANTS.AUTO_EMBED_TIMEOUT,
          sessionId: chatSessionId
        });
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-SUMMARIZE OLD MESSAGES (AFTER SAVING - "Agent Memory")
    // ═══════════════════════════════════════════════════════════════════════
    // If total messages exceed threshold, summarize oldest batch in background.
    // Fire-and-forget — doesn't block the response.
    if (totalMessagesNow > CONSTANTS.SUMMARIZE_THRESHOLD) {
      logger.info('[GENERAL_CHAT] Triggering auto-summarization (background)', {
        sessionId: chatSessionId,
        totalMessages: totalMessagesNow,
      });
      // summarizeOldMessages() already does threshold check internally, no need to call shouldSummarize()
      summarizeOldMessages(chatSessionId).catch(error => {
        logger.warn('[GENERAL_CHAT] Background summarization failed', {
          error: error instanceof Error ? error.message : String(error),
          sessionId: chatSessionId,
        });
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: RESPOND
  // ═══════════════════════════════════════════════════════════════════════
  // Credits are deducted above (1 credit per chat message)

  // Check if client connection is still alive before sending response
  if (req.aborted || req.socket?.destroyed) {
    logger.warn('[GENERAL_CHAT] Client connection closed, cannot send response', {
      userId,
      chatSessionId,
    });
    return;
  }

  // Check if response already sent
  if (res.headersSent) {
    logger.warn('[GENERAL_CHAT] Response already sent', { userId, chatSessionId });
    return;
  }

  const response: any = {
    success: true, // ← Frontend expects this!
    reply: gptResponse.content,
    timestamp: aiReplyTimestamp || new Date().toISOString(), // Use saved timestamp or fallback
    userMessageTimestamp: userMessageTimestamp, // Include user message timestamp
    sessionId: chatSessionId,
    // Mirror the AI message metadata so the frontend gets quick actions and
    // other contextual UI hints in the same round-trip (instead of waiting for
    // the next history reload). The same object is also persisted to the DB.
    ...(Object.keys(aiMessageMetadata).length > 0 && { metadata: aiMessageMetadata }),
    // Include active project info so frontend can display which project is being queried
    ...(projectId && { activeProject: { id: projectId, name: projectName || projectId } }),
  };

  // Show user's current credit balance and remaining daily/monthly limits
  if (userId && isValidUUID(userId)) {
    try {
      const credits = await UserCreditsService.getUserCredits(userId);
      const planInfo = await PricingPlansService.getUserPlanInfo(userId);

      response.creditsRemaining = credits?.credits_balance || 0;

      if (planInfo) {
        response.dailyRemaining = planInfo.daily_remaining;
        response.monthlyRemaining = planInfo.monthly_remaining;
      }
    } catch (error) {
      logger.warn('[GENERAL_CHAT] Failed to get credits info', { error, userId });
    }
  }

  chatTrace?.writeResponse({
    content: gptResponse.content,
    intent: 'general_chat',
    toolsUsed: availableTools.length,
  });

  res.json(response);
}
