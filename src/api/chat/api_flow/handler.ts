/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: API FLOW TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Triggered when user pastes a Swagger URL or uploads an API spec in chat.
 * Routes to FlowBuilderService to parse spec + build DAG.
 *
 * Intent: api_flow_test
 * Detected from: URLs containing swagger/openapi/api-docs or file attachments
 */

import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { ChatService } from '@/services/utils/chat.service';
import { emitProcessingStep } from '../shared/utils';
import { FlowBuilderService } from '@/services/testing/api/flow/flow-builder.service';
import { SpecParserService, isPythonScript } from '@/services/testing/api/flow/spec-parser.service';
import type { ParseSpecRequest } from '@/services/testing/api/flow/flow.types';
import type { ChatAttachment } from '../chat.types';

// Patterns that indicate a Swagger/OpenAPI spec URL
const SWAGGER_URL_PATTERNS = [
  /https?:\/\/[^\s]+\/(swagger|openapi|api-docs)[^\s]*/i,
  /https?:\/\/[^\s]+\.(json|yaml|yml)([^\s]*)?/i,
  /https?:\/\/[^\s]+\/v\d\/[^\s]*(openapi|swagger)[^\s]*/i,
];

// Patterns for Postman/HAR/etc from file attachments
const API_SPEC_EXTENSIONS = ['.json', '.yaml', '.yml', '.har', '.raml', '.py', '.zip', '.tar.gz', '.tgz'];

/**
 * Extract swagger/spec URL from a message
 */
function extractSpecUrl(message: string): string | undefined {
  for (const pattern of SWAGGER_URL_PATTERNS) {
    const match = message.match(pattern);
    if (match) return match[0].trim();
  }
  // Also detect any URL with swagger/openapi keywords nearby
  const urlMatch = message.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const url = urlMatch[0];
    const context = message.toLowerCase();
    if (context.includes('swagger') || context.includes('openapi') || context.includes('api') || context.includes('spec')) {
      return url;
    }
  }
  return undefined;
}

/**
 * Check if the message or attachments contain an API spec
 */
export function isApiFlowRequest(message: string, attachments?: ChatAttachment[]): boolean {
  // Check message for spec URL
  if (extractSpecUrl(message)) return true;

  // Check attachments for spec files
  if (attachments?.some(a =>
    API_SPEC_EXTENSIONS.some(ext => (a.name || '').toLowerCase().endsWith(ext))
  )) return true;

  // Check for curl commands
  const lower = message.toLowerCase();
  if (lower.includes('curl ') && lower.includes('http')) return true;

  // Check for a pasted Python API script
  if (isPythonScript(message)) return true;

  return false;
}

export async function handleApiFlowTest(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    abortSignal?: AbortSignal;
    attachments?: ChatAttachment[];
    /** Controller-resolved project (test-case scope). Global scope falls back to the session binding. */
    projectId?: string;
  }
): Promise<void> {
  const { message, userId, workspace_id, chatSessionId, abortSignal, attachments } = params;

  logger.info('[API_FLOW_HANDLER] Handling api_flow_test intent', {
    userId,
    chatSessionId,
    messageLength: message.length,
  });

  try {
    emitProcessingStep(chatSessionId, 'executing_test', 'Detecting API specification format...', 10);

    // Determine source and content
    let source: 'url' | 'file' = 'url';
    let url: string | undefined;
    let content: string | undefined;
    let fileName: string | undefined;

    // Priority: file attachment > cURL in message > URL in message
    const specAttachment = attachments?.find(a =>
      API_SPEC_EXTENSIONS.some(ext => (a.name || '').toLowerCase().endsWith(ext))
    );

    if (specAttachment) {
      source = 'file';
      // ChatAttachment uses extractedText for document content
      content = specAttachment.extractedText;
      fileName = specAttachment.name;
      if (!content) {
        if (chatSessionId) {
          await ChatService.saveChatMessages(chatSessionId, [{
            role: 'ai',
            content: 'Could not read the attached file content. Please ensure the file is a valid JSON/YAML API spec.',
          }]);
        }
        res.json({ success: true, timestamp: new Date().toISOString() });
        return;
      }
    } else if (message.toLowerCase().includes('curl ')) {
      source = 'file';
      content = message;
      fileName = 'curl-commands.txt';
    } else if (isPythonScript(message)) {
      source = 'file';
      content = message;
      fileName = 'script.py';
    } else {
      url = extractSpecUrl(message);
      if (!url) {
        if (chatSessionId) {
          await ChatService.saveChatMessages(chatSessionId, [{
            role: 'ai',
            content: `I'd like to test your API flow, but I couldn't find a Swagger/OpenAPI URL in your message. Please share:\n- A Swagger URL (e.g. \`https://api.example.com/swagger.json\`)\n- Or upload a Postman collection / OpenAPI file\n- Or paste a Python script (requests / httpx / pytest) or cURL commands`,
          }]);
        }
        res.json({ success: true, timestamp: new Date().toISOString() });
        return;
      }
      source = 'url';
    }

    // Get or detect project. Priority: intent → answers → the chat session's
    // bound project (the controller syncs the UI-selected project into
    // chat_sessions.project_id on every global turn). Without the session
    // fallback a force-routed upload would dead-end here, since the classifier
    // never populates parsedIntent.projectId for a files-only message.
    let projectId: string | undefined =
      params.parsedIntent?.projectId || params.answers?.projectId || params.projectId;
    if (!projectId && chatSessionId) {
      const session = await ChatService.getSessionWithProject(chatSessionId, userId);
      projectId = session?.project_id;
    }
    if (!projectId) {
      if (chatSessionId) {
        await ChatService.saveChatMessages(chatSessionId, [{
          role: 'ai',
          content: 'Please select a project first, then upload your API spec / project again so I can attach the flow to it.',
        }]);
      }
      res.json({ success: true, timestamp: new Date().toISOString() });
      return;
    }

    emitProcessingStep(chatSessionId, 'executing_test', `Parsing API specification from ${source === 'url' ? url : fileName}...`, 20);

    // Detect format early to give better feedback
    if (source === 'file' && content) {
      const detected = SpecParserService.detectFormat(content, fileName);
      emitProcessingStep(chatSessionId, 'executing_test', `Detected format: ${detected}. Building flow...`, 30);
    }

    const parseRequest: ParseSpecRequest = {
      source,
      url,
      content,
      fileName,
      projectId,
      chatSessionId,
    };

    // Build flow — this will emit real-time WS events internally
    const result = await FlowBuilderService.buildFromSpec(parseRequest, userId);
    const { flowSpec, dag, spec } = result;

    // If AI has questions (via chat, just proceed without asking — chat context is limited)
    if (!flowSpec || !dag) {
      const questionMsg = result.questions?.length
        ? `I'm analyzing your API spec but need some clarification. Please use the API Flows page to provide answers.`
        : `Parsed ${spec.endpoints.length} endpoints but couldn't build the execution plan. Try uploading via the API Flows page.`;

      if (chatSessionId) {
        await ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: questionMsg },
        ]);
      }
      res.json({ success: true, reply: questionMsg, timestamp: new Date().toISOString() });
      return;
    }

    // Build success message
    const unsupportedNote = dag.unsupportedEndpoints.length > 0
      ? `\n\n⚠️ ${dag.unsupportedEndpoints.length} endpoints were skipped (WebSocket/SSE — not supported for HTTP testing).`
      : '';

    const parallelNote = dag.parallelGroups.length > 1
      ? `\n⚡ ${dag.parallelGroups.filter(g => g.length > 1).length} groups can run in parallel.`
      : '';

    const authNode = dag.nodes.find(n => n.isAuthEndpoint);
    const authNote = authNode ? `\n🔐 Auth endpoint: \`${authNode.method} ${authNode.path}\`` : '';

    // Truncation transparency: an uploaded project archive is read only up to a
    // size cap, and lower-relevance files (tests first) are dropped silently in
    // the extractor. Surface that here so the user knows the flow may be partial
    // rather than assuming their whole project was understood.
    const archiveMeta = specAttachment?.archiveMeta;
    const truncationNote = archiveMeta?.truncated
      ? `\n\n⚠️ Only part of your project was read (size limit): ${archiveMeta.fileCount} file(s) used, ${archiveMeta.skipped.length} skipped. The flow may be incomplete — upload a smaller subset or the specific API client/spec files for full coverage.`
      : '';

    // Unverified variable links: the builder statically checked which values flow
    // between calls. Surface what it could NOT verify so a flow that LOOKS
    // connected doesn't silently 401/400 at run time. `no_producer` = a value no
    // call in the flow produces (you supply it before running); the others are
    // ordering/collision anomalies worth a look.
    const unverified = dag.unverifiedLinks ?? [];
    const needProvided = [...new Set(unverified.filter(l => l.kind === 'no_producer').map(l => l.variableName))];
    const anomalies = unverified.filter(l => l.kind !== 'no_producer');
    const unverifiedNote =
      needProvided.length > 0 || anomalies.length > 0
        ? `\n\n🔗 **Some variable links couldn't be verified:**` +
          (needProvided.length
            ? `\n• ${needProvided.length} value(s) no call produces — you'll set them before running: ${needProvided.map(v => `\`${v}\``).join(', ')}.`
            : '') +
          (anomalies.length
            ? `\n• ${anomalies.length} ordering/naming anomaly(ies) — the chain may not pass data as intended; check the flow view.`
            : '') +
          `\n(Static check only — a wrong response-field path can still fail at run time.)`
        : '';

    const successMessage = `✅ **API Flow built for "${spec.title}"**

📊 **${spec.endpoints.length} endpoints** analyzed and organized into an execution chain.
🔗 **${dag.nodes.filter(n => n.dependsOn.length > 0).length} dependencies** detected.
🔑 **${dag.nodes.filter(n => n.variableExtractions.length > 0).length} variable extractions** configured.${authNote}${unsupportedNote}${parallelNote}${truncationNote}${unverifiedNote}

You can see the flow visualization in the sidebar. When ready, click **Run** to execute the chain.

> Flow ID: \`${flowSpec.id}\``;

    const flowMetadata = {
      type: 'api_flow_built' as const,
      flowSpecId: flowSpec.id,
      totalEndpoints: spec.endpoints.length,
      ...(archiveMeta?.truncated
        ? { archiveTruncated: true, archiveFilesUsed: archiveMeta.fileCount, archiveFilesSkipped: archiveMeta.skipped.length }
        : {}),
      ...(unverified.length
        ? { unverifiedLinkCount: unverified.length, unverifiedVarsNeeded: needProvided, unverifiedAnomalies: anomalies.length }
        : {}),
    };

    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        {
          role: 'ai',
          content: successMessage,
          metadata: flowMetadata,
        },
      ]);
    }

    res.json({
      success: true,
      reply: successMessage,
      timestamp: new Date().toISOString(),
      metadata: flowMetadata,
    });
  } catch (error: any) {
    logger.error('[API_FLOW_HANDLER] Failed to build flow', {
      error: error.message,
      userId,
    });

    const errorMessage = `❌ Failed to parse the API specification: ${error.message}

**Supported formats:**
- OpenAPI/Swagger 2.0, 3.0, 3.1 (JSON or YAML)
- Postman Collection v2.0/v2.1
- cURL commands (paste them directly)
- HAR files (from Chrome DevTools)
- Insomnia export files
- Python scripts (requests / httpx / aiohttp / urllib / pytest)
- A .zip / .tar.gz archive of a Python project

Please check the URL or file and try again.`;

    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        { role: 'ai', content: errorMessage },
      ]);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to build API flow',
      timestamp: new Date().toISOString(),
    });
  }
}
