import { buildChatSystemPrompt } from '@/ai/prompts';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { autoEmbedOldMessages, searchChatHistory } from '@/services/ai/embeddings/chat-embeddings.service';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { getSummariesForContext, summarizeOldMessages } from '@/services/ai/summarization/chat-summarization.service';
import { formatPageContextForChat, getPageContext, type PageContext } from '@/services/chat/editor-context.service';
import { searchKB } from '@/services/kb/kb.service';
import { ChatService } from '@/services/utils/chat.service';
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
    userLanguage?: 'en' | 'ru' | 'neutral'; // Language from intent parser (avoid re-detection)
    abortSignal?: AbortSignal;
    logger?: FunctionLogger;
    mode?: 'lite' | 'pro' | 'editor'; // Test execution mode
    attachments?: ChatAttachment[]; // File attachments (images + documents)
    needsTools?: boolean; // Signal from Intent Parser: false = skip Router in pipeline (~600ms saved)
  }
): Promise<void> {
  const { message, userId, chatSessionId, context: rawContext, workspace_id: paramWorkspaceId, abortSignal, logger: functionLogger, mode, attachments, needsTools } = params;

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
    // Get recent messages (last 20) - always needed for conversationHistory
    const getRecentMessagesWithLogging = functionLogger
      ? withFunctionLogging(ChatService.getRecentMessages.bind(ChatService), 'ChatService.getRecentMessages', functionLogger)
      : ChatService.getRecentMessages.bind(ChatService);
    const recentMessages = await getRecentMessagesWithLogging(chatSessionId, userId, CONSTANTS.RECENT_MESSAGES_LIMIT); // SECURITY: Pass userId for verification
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

    // Check if we need vector search (only if we have old messages beyond last 20)
    // If recentMessages returned exactly LIMIT messages, there are likely more old messages
    if (recentMessages.length >= CONSTANTS.RECENT_MESSAGES_LIMIT && chatSessionId) {
      logger.info('[GENERAL_CHAT] Recent messages at limit, using vector search for old context', {
        sessionId: chatSessionId,
        recentCount: recentMessages.length
      });

      // recentMessages.length >= LIMIT implies there are older messages
      {
        logger.info('[GENERAL_CHAT] Chat has old messages, using vector search');

        try {
          // Search for relevant old messages using semantic similarity
          // Note: We don't await autoEmbedOldMessages - it runs in background for NEXT request
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

  let projectId = typeof context === 'object' ? context?.projectId : undefined;
  const parsedContext = typeof context === 'object' && context !== null && !Array.isArray(context)
    ? context as Record<string, any>
    : undefined;
  const workspaceId = paramWorkspaceId
    || (parsedContext?.workspaceId || parsedContext?.workspace_id);

  // Launch all independent fetches in parallel
  const [kbResult, agentMemoryResult, workspaceMemoryResult, editorContextResult, projectResult, integrationResult] =
    await Promise.allSettled([
      // 1. KB search (non-fatal)
      searchKB(message, projectId, { matchThreshold: 0.45, matchCount: 5 })
        .catch((err: Error) => {
          logger.warn('[GENERAL_CHAT] KB search failed, continuing without KB context', {
            error: err.message,
          });
          return { chunks: [], sources: { global: [], project: [] } };
        }),

      // 2. Agent memory — summaries from old conversations
      chatSessionId
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

  let integrationContext = '';
  if (integrationResult.status === 'fulfilled' && integrationResult.value) {
    integrationContext = integrationResult.value;
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
  let availableTools: any[] = [];
  let skillDescriptions = '';

  if (workspaceId) {
    try {
      const { SkillRegistry } = await import('@/services/skills');

      const skillContext = { userId, workspaceId, chatSessionId, projectId, mode: mode as 'lite' | 'pro' | 'editor' | undefined };
      availableTools = await SkillRegistry.getAvailableTools(skillContext);
      skillDescriptions = await SkillRegistry.getSkillDescriptions(skillContext);

      logger.info('[GENERAL_CHAT] Tools collected', {
        totalTools: availableTools.length,
      });
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
  let systemPrompt = buildChatSystemPromptWithLogging(skillDescriptions, projectId, projectName, integrationContext);

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

EXAMPLE — user says "create a login test":
You should generate steps like:
[
  {"id": "...", "type": "navigate", "description": "Navigate to login page", "value": "https://example.com/login"},
  {"id": "...", "type": "type", "description": "Type username into the 'Email' input field", "value": "test@example.com"},
  {"id": "...", "type": "type", "description": "Type password into the 'Password' input field", "value": "password123"},
  {"id": "...", "type": "click", "description": "Click the 'Sign In' button"},
  {"id": "...", "type": "ai_check", "description": "Verify successful login", "assertionText": "The user is logged in and can see the dashboard"}
]
Then ask the user: "Ready to run these on the preview?"
When user says yes → call qa_run_draft_steps(steps=<above>, start_url="<current URL>", confirm=true).

EDITOR WORKFLOW:
1. User asks to create/test something → Generate IntentSteps from DOM, show them in chat, ask "Shall I run these?"
2. User confirms ("да" / "запусти" / "run it" / "давай") → call qa_run_draft_steps → steps execute on live browser
3. User says "save it" / "сохрани" → call qa_create_test_case with the same steps → saved to DB
4. User says "tweak step 3" → modify steps, show updated list, ask to re-run
5. User refers to saved test → qa_run_test with run_type="preview"
- EXCEPTION: If user explicitly says "create AND run" / "сделай и запусти" → generate + run immediately without asking

IMPORTANT RULES:
- Do NOT call qa_create_test_case unless user explicitly says "save" / "сохрани" / "persist"
- After a successful run, tell the user: "Test ran successfully on the preview. Say 'save' to persist."
- For SINGLE actions (one click, one type) → this is editor_action, handled automatically
- For MULTI-STEP flows (login, checkout, search+filter) → generate IntentSteps, ask to run, then qa_run_draft_steps

WHEN THE PAGE DOESN'T MATCH:
- If the requested test target isn't on the current page, add a "navigate" step first to go to the right URL
- The element resolver will resolve descriptions at runtime — you don't need exact selectors, just accurate descriptions
- NEVER invent elements not visible in the DOM context

STEP DESCRIPTIONS — BE SPECIFIC:
- Use REAL element labels, placeholder text, and ref IDs from the page context
- GOOD: "Click the 'Физика' subject filter button" / "Type 'test@mail.com' into the email input (ref=i3)"
- BAD: "Click the subject button" / "Enter email address"
- For elements not in the viewport, describe them by their text/label — the resolver will find them`;
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

    // Text part: original message + appended document contents
    let textContent = message;
    for (const doc of attachments.filter(f => f.type === 'document' && f.extractedText)) {
      const ext = doc.name.split('.').pop()?.toLowerCase() || '';
      const langHint = ext === 'json' ? 'json' : ext === 'md' ? 'markdown' : '';
      textContent += `\n\nAttached file "${doc.name}":\n\`\`\`${langHint}\n${doc.extractedText}\n\`\`\``;
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
  emitProcessingStepWithLogging(chatSessionId, 'generating_response', thinkingMessage, PROGRESS.ROUTING);

  let gptResponse: { content: string; usage?: any };
  let shouldDeductCredits = false;
  let requestCancelled = false;
  let pipelineClarification = false;
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
            });

            gptResponse = { content: pipelineResult.content, usage: undefined };
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

        // Execute through centralized pipeline (routing, hooks, timeout, screenshot handling)
        const skillContext = {
          userId,
          workspaceId: workspaceId!,
          chatSessionId,
          projectId,
          previewSessionId: resolvedPreviewSessionId,
          mode: mode as 'lite' | 'pro' | 'editor' | undefined,
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

    // Provide helpful fallback message based on error type
    let fallbackMessage = 'I apologize, but I\'m currently experiencing technical difficulties. Please try again in a few moments.';

    if (openaiError?.status === 401 || openaiError?.code === 'invalid_api_key') {
      fallbackMessage = 'I\'m temporarily unavailable due to a configuration issue. Our team has been notified.';
    } else if (openaiError?.status === 429 || openaiError?.code === 'insufficient_quota') {
      fallbackMessage = 'I\'m temporarily unavailable due to high demand. Please try again in a few minutes.';
    } else if (openaiError?.message?.includes('timeout') || openaiError?.message?.includes('took too long')) {
      fallbackMessage = 'The request took too long to process. Please try again with a shorter message.';
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

  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: SAVE MESSAGES
  // ═══════════════════════════════════════════════════════════════════════

  let userMessageTimestamp: string | undefined;
  let aiReplyTimestamp: string | undefined;

  if (chatSessionId) {
    const saveChatMessagesWithLogging = functionLogger
      ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
      : ChatService.saveChatMessages.bind(ChatService);

    // Build user message metadata (include file info if attachments present)
    const modeTag = mode || 'lite';
    const userMessageMetadata: Record<string, any> = { mode: modeTag };
    if (hasAttachments) {
      userMessageMetadata.files = attachments.map(f => ({ name: f.name, type: f.type, mimeType: f.mimeType, size: f.size }));
    }

    // Build AI message metadata
    const aiMessageMetadata: Record<string, any> = {};
    if (pipelineClarification) {
      aiMessageMetadata.requiresAnswers = true;
      aiMessageMetadata.needsMoreInfo = true;
      aiMessageMetadata.source = 'sub_agent_pipeline';
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

    const timestamps = await saveChatMessagesWithLogging(chatSessionId, [
      { role: 'user', content: message, metadata: userMessageMetadata },
      {
        role: 'ai',
        content: gptResponse.content,
        metadata: Object.keys(aiMessageMetadata).length > 0 ? aiMessageMetadata : undefined,
      },
    ]);

    // Extract timestamps: first is user message, second is AI reply
    if (timestamps.length >= 2) {
      userMessageTimestamp = timestamps[0];
      aiReplyTimestamp = timestamps[1];
    }

    // Auto-generate title for new chats (after first user message)
    // This runs in background, doesn't block response
    ChatService.autoGenerateTitle(chatSessionId).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-generate title', { error, chatSessionId });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-EMBED OLD MESSAGES (AFTER SAVING - for NEXT request)
    // ═══════════════════════════════════════════════════════════════════════
    // Now that we saved new messages, check if we need to create embeddings
    // This runs in background and prepares embeddings for the NEXT request
    const { count: totalMessageCountAfterSave } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', chatSessionId);

    const totalMessagesNow = totalMessageCountAfterSave || 0;

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

  res.json(response);
}
