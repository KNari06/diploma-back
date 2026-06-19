/**
 * Project resource mutation emit helpers.
 *
 * Thin wrappers the test-case / flow / module CRUD controllers call
 * (fire-and-forget) after a successful DB write, so editors open in other
 * tabs/sessions/users invalidate their cached lists without a page reload.
 *
 * All helpers are best-effort: any failure (missing projectId, dead socket
 * layer) is swallowed — a CRUD request must NEVER fail because of an emit.
 * Events route to the `project:<projectId>` room (see `subscribe:project`
 * in subscription.handler.ts). The room is access-gated at subscribe time,
 * so emitting to it cannot leak cross-tenant.
 */

import { webSocketService } from '@/websocket/core/websocket.service';
import type { ProjectResourceMutationPayload } from '@/websocket/types/types';
import { logger } from '@/utils/core/logger';

type MutationInput = Omit<ProjectResourceMutationPayload, 'timestamp'>;

function safeEmit(emit: () => void, context: Record<string, unknown>): void {
  try {
    emit();
  } catch (error) {
    logger.debug('[ProjectMutationEmit] Emit failed (non-fatal)', {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function withTimestamp(input: MutationInput): ProjectResourceMutationPayload {
  return { ...input, timestamp: new Date().toISOString() };
}

export function emitTestCaseMutated(input: MutationInput): void {
  if (!input.projectId) return;
  safeEmit(
    () => webSocketService.emitTestCaseMutation(withTimestamp(input)),
    { resource: 'testcase', ...input },
  );
}

export function emitFlowMutated(input: MutationInput): void {
  if (!input.projectId) return;
  safeEmit(
    () => webSocketService.emitFlowMutation(withTimestamp(input)),
    { resource: 'flow', ...input },
  );
}

export function emitModuleMutated(input: MutationInput): void {
  if (!input.projectId) return;
  safeEmit(
    () => webSocketService.emitModuleMutation(withTimestamp(input)),
    { resource: 'module', ...input },
  );
}
