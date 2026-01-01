/**
 * Lite Graph Adapter
 * Converts Lite types (AICommand, ExecutionResult, etc.) to Pro-compatible types
 * for use with GraphBuilder (DynamicAction, GraphActionResult)
 */

import type { DynamicAction } from '@/agent/types/intelligent-testing.types';
import type { GraphActionResult } from '@/agent/utils/visualization/graph-builder.service';
import type { AICommand, AIDecision, ExecutionResult, LiteSnapshot, StateDiff } from '../lite-types';

// DynamicAction.action union type (matches intelligent-testing.types.ts)
type DynamicActionType = DynamicAction['action'];

/**
 * Map Lite AICommand.action to DynamicAction.action
 */
function mapActionType(action: AICommand['action']): DynamicActionType {
  const mapping: Record<AICommand['action'], DynamicActionType> = {
    click: 'click',
    fill: 'fill',
    press: 'press',
    goto: 'goto',
    scroll: 'scroll',
    select: 'select',
    hover: 'hover',
    wait: 'wait',
  };
  return mapping[action] || 'click';
}

/**
 * Convert Lite AICommand to Pro-compatible DynamicAction for GraphBuilder
 */
export function toDynamicAction(
  decision: AIDecision,
  snapshotBefore: LiteSnapshot
): DynamicAction {
  const { command } = decision;
  const ref = command.ref;

  // Build selector from ref (Lite uses data-agent-ref)
  let selector: string | undefined;
  if (ref) {
    selector = `[data-agent-ref="${ref}"]`;
  }

  // Find element in snapshot for better description
  let elementInfo = '';
  if (ref) {
    const element = snapshotBefore.elements.find(el => el.ref === ref);
    if (element) {
      const name = element.name || element.placeholder || '';
      elementInfo = name ? ` "${name.slice(0, 30)}"` : '';
    }
  }

  // Build human-readable description
  let description: string;
  switch (command.action) {
    case 'click':
      description = `Click${elementInfo || (ref ? ` element ${ref}` : '')}`;
      break;
    case 'fill':
      description = `Fill${elementInfo || (ref ? ` element ${ref}` : '')} with "${command.value?.slice(0, 20) || ''}"`;
      break;
    case 'press':
      description = `Press key "${command.key || ''}"`;
      break;
    case 'goto':
      description = `Navigate to ${command.url || ''}`;
      break;
    case 'scroll':
      description = `Scroll ${command.direction || 'down'}`;
      break;
    case 'select':
      description = `Select "${command.value || ''}"${elementInfo ? ` in${elementInfo}` : ''}`;
      break;
    case 'hover':
      description = `Hover${elementInfo || (ref ? ` element ${ref}` : '')}`;
      break;
    case 'wait':
      description = 'Wait for page stability';
      break;
    default:
      description = `${command.action}${elementInfo || ''}`;
  }

  return {
    action: mapActionType(command.action),
    selector,
    value: command.value,
    description,
    // Optional fields for Pro compatibility
    optional: false,
  };
}

/**
 * Convert Lite ExecutionResult + StateDiff to Pro-compatible GraphActionResult
 */
export function toGraphActionResult(
  execResult: ExecutionResult,
  diff: StateDiff,
  screenshotMeta?: {
    screenshotBefore?: string; // URL after upload
    screenshotAfter?: string;  // URL after upload
  }
): GraphActionResult {
  return {
    success: execResult.success,
    error: execResult.error,
    durationMs: execResult.duration,
    urlChanged: diff.urlChanged,
    urlBefore: diff.urlBefore,
    urlAfter: diff.urlAfter,
    retryCount: 0, // Lite doesn't have retry logic yet
    isTimeout: execResult.error?.toLowerCase().includes('timeout') ?? false,

    // Screenshots (URLs after upload, initially undefined)
    screenshotBefore: screenshotMeta?.screenshotBefore,
    screenshotAfter: screenshotMeta?.screenshotAfter,
  };
}
