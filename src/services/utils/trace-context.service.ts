import { supabaseAdmin } from '@/db/supabase';
import { PlaywrightCommand, TraceFile, TraceStep } from '@/types';
import { logger } from '@/utils/core/logger';

/**
 * Extract selectors from trace files
 */
export async function extractSelectorsFromTraces(
  traces: TraceFile[]
): Promise<Record<string, string>> {
  // Validate input
  if (!traces || !Array.isArray(traces) || traces.length === 0) {
    logger.debug('[TRACE_CONTEXT] No traces provided to extractSelectorsFromTraces');
    return {};
  }

  const selectors: Record<string, string> = {};

  for (const trace of traces) {
    if (!trace || typeof trace !== 'object' || !trace.parsed_data) continue;

    // Validate parsed_data structure
    if (!trace.parsed_data.steps || !Array.isArray(trace.parsed_data.steps)) continue;

    const steps = trace.parsed_data.steps as TraceStep[];

    for (const step of steps) {
      if (
        step &&
        typeof step === 'object' &&
        step.selector &&
        typeof step.selector === 'string' &&
        step.selector.trim().length > 0 &&
        step.type &&
        typeof step.type === 'string'
      ) {
        // Extract meaningful label from step
        const label = extractElementLabel(step);
        if (label && typeof label === 'string' && label.trim().length > 0 && !selectors[label]) {
          selectors[label] = step.selector.trim();
        }
      }
    }
  }

  logger.info('[TRACE_CONTEXT] Extracted selectors from traces', {
    traceCount: traces.length,
    selectorCount: Object.keys(selectors).length,
  });

  return selectors;
}

/**
 * Extract meaningful element label from trace step
 */
function extractElementLabel(step: TraceStep): string | null {
  // Validate step
  if (!step || typeof step !== 'object' || !step.type) {
    return null;
  }

  // Try to extract from text content
  if (step.text && typeof step.text === 'string' && step.text.trim().length > 0) {
    const elementType = guessElementType(step.type, step.selector);
    return `${step.text.trim()} ${elementType}`;
  }

  // Try to extract from selector
  if (step.selector && typeof step.selector === 'string' && step.selector.trim().length > 0) {
    // "button:has-text('Buy')" → "Buy button"
    const textMatch = step.selector.match(/has-text\(['"](.+?)['"]\)/);
    if (textMatch) {
      const elementType = guessElementType(step.type, step.selector);
      return `${textMatch[1]} ${elementType}`;
    }

    // "input[placeholder='Email']" → "Email input"
    const placeholderMatch = step.selector.match(/placeholder=['"](.+?)['"]/);
    if (placeholderMatch) {
      return `${placeholderMatch[1]} input`;
    }

    // "button[aria-label='Submit']" → "Submit button"
    const ariaMatch = step.selector.match(/aria-label=['"](.+?)['"]/);
    if (ariaMatch) {
      const elementType = guessElementType(step.type, step.selector);
      return `${ariaMatch[1]} ${elementType}`;
    }
  }

  return null;
}

/**
 * Guess element type from action and selector
 */
function guessElementType(action: string, selector?: string): string {
  // Validate inputs
  if (!action || typeof action !== 'string') {
    return 'element';
  }

  const actionLC = action.toLowerCase();

  if (selector && typeof selector === 'string') {
    const selectorLC = selector.toLowerCase();

    // Check selector for element type
    if (selectorLC.includes('button') || selectorLC.includes('btn')) return 'button';
    if (selectorLC.includes('input')) return 'input';
    if (selectorLC.includes('select')) return 'select';
    if (selectorLC.includes('checkbox')) return 'checkbox';
    if (selectorLC.includes('radio')) return 'radio';
    if (selectorLC.includes('link') || selectorLC.includes('a[')) return 'link';
    if (selectorLC.includes('form')) return 'form';
  }

  // Guess from action
  if (actionLC === 'click') return 'button';
  if (actionLC === 'fill' || actionLC === 'type') return 'input';
  if (actionLC === 'check') return 'checkbox';
  if (actionLC === 'select') return 'select';

  return 'element';
}

/**
 * Find trace files by URL pattern
 */
export async function findTracesByUrl(
  url: string,
  projectId: string,
  limit: number = 5
): Promise<TraceFile[]> {
  // Validate inputs
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    logger.debug('[TRACE_CONTEXT] Invalid url in findTracesByUrl', { url: typeof url });
    return [];
  }

  if (!projectId || typeof projectId !== 'string') {
    logger.debug('[TRACE_CONTEXT] Invalid projectId in findTracesByUrl', { projectId: typeof projectId });
    return [];
  }

  // Validate and clamp limit
  const validLimit = Math.max(1, Math.min(50, Math.floor(limit || 5)));

  try {
    // Check if projectId is a valid UUID
    const isValidUUID = projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    if (!isValidUUID) {
      logger.info('[TRACE_CONTEXT] Skipping trace search - projectId is not a valid UUID', {
        projectId: projectId.substring(0, 50),
      });
      return [];
    }

    // Extract domain from URL for matching
    const domain = extractDomain(url);

    if (!domain || domain.trim().length === 0) {
      logger.warn('[TRACE_CONTEXT] Could not extract domain from URL', { url: url.substring(0, 100) });
      return [];
    }

    logger.info('[TRACE_CONTEXT] Searching traces by URL', { url: url.substring(0, 100), domain, projectId });

    // First, find tests with matching URL
    const { data: tests, error: testsError } = await supabaseAdmin
      .from('tests')
      .select('id')
      .eq('project_id', projectId)
      .ilike('url', `%${domain}%`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (testsError) {
      logger.error('[TRACE_CONTEXT] Failed to fetch tests for traces', {
        error: testsError instanceof Error ? testsError.message : String(testsError),
        code: testsError.code,
        url: url.substring(0, 100),
        projectId,
      });
      return [];
    }

    const validTests = Array.isArray(tests) ? tests : [];
    if (validTests.length === 0) {
      logger.info('[TRACE_CONTEXT] No tests found for URL', { url: url.substring(0, 100), domain });
      return [];
    }

    // Extract test IDs safely
    const testIds = validTests
      .filter((t: any) => t && t.id && typeof t.id === 'string')
      .map((t: any) => t.id);

    if (testIds.length === 0) {
      logger.warn('[TRACE_CONTEXT] No valid test IDs found', { testCount: validTests.length });
      return [];
    }

    // Find parsed trace files for these tests
    const { data: traces, error: tracesError } = await supabaseAdmin
      .from('trace_files')
      .select('*')
      .in('test_id', testIds)
      .eq('status', 'parsed')
      .not('parsed_data', 'is', null)
      .order('created_at', { ascending: false })
      .limit(validLimit);

    if (tracesError) {
      logger.error('[TRACE_CONTEXT] Failed to fetch trace files', {
        error: tracesError instanceof Error ? tracesError.message : String(tracesError),
        code: tracesError.code,
        testIdCount: testIds.length,
      });
      return [];
    }

    const validTraces = Array.isArray(traces) ? traces : [];

    logger.info('[TRACE_CONTEXT] Found traces for URL', {
      url: url.substring(0, 100),
      traceCount: validTraces.length,
    });

    return (validTraces as TraceFile[]) || [];
  } catch (error) {
    logger.error('[TRACE_CONTEXT] Error finding traces by URL', {
      error: error instanceof Error ? error.message : String(error),
      url: url.substring(0, 100),
      projectId,
    });
    return [];
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  // Validate input
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return '';
  }

  try {
    const urlObj = new URL(url.trim());
    const hostname = urlObj.hostname;

    if (!hostname || hostname.length === 0) {
      return '';
    }

    return hostname.replace(/^www\./, '');
  } catch {
    // If URL parsing fails, try to extract manually
    try {
      const cleaned = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      return cleaned && cleaned.trim().length > 0 ? cleaned.trim() : '';
    } catch {
      return '';
    }
  }
}

/**
 * Convert trace steps to Playwright commands format
 */
export function convertTraceStepsToCommands(steps: TraceStep[]): PlaywrightCommand[] {
  // Validate input
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return [];
  }

  const commands: PlaywrightCommand[] = [];

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;

    const command = convertStepToCommand(step);
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

/**
 * Convert single trace step to Playwright command
 */
function convertStepToCommand(step: TraceStep): PlaywrightCommand | null {
  // Validate step
  if (!step || typeof step !== 'object' || !step.type || typeof step.type !== 'string') {
    return null;
  }

  // Map trace step types to Playwright action types
  const actionMap: Record<string, string> = {
    goto: 'goto',
    click: 'click',
    fill: 'fill',
    type: 'type',
    check: 'check',
    uncheck: 'uncheck',
    select: 'select',
    hover: 'hover',
    press: 'press',
    wait: 'wait',
    screenshot: 'screenshot',
  };

  const stepTypeLC = step.type.toLowerCase();
  const action = actionMap[stepTypeLC] || step.type;

  const command: PlaywrightCommand = {
    action: action as any,
    description:
      (step.description && typeof step.description === 'string' ? step.description : '') ||
      `${action} ${step.selector || ''}`.trim() ||
      action,
  };

  if (step.selector && typeof step.selector === 'string' && step.selector.trim().length > 0) {
    command.selector = step.selector.trim();
  }
  if (step.text && typeof step.text === 'string') {
    command.value = step.text;
  }
  if (step.url && typeof step.url === 'string') {
    command.url = step.url;
  }
  if (step.timestamp) {
    command.timeout = 30000; // Default timeout
  }

  return command;
}

/**
 * Get formatted context from traces for AI prompt
 */
export function formatTracesForPrompt(
  traces: TraceFile[],
  selectors: Record<string, string>
): string {
  // Validate inputs
  const validTraces = Array.isArray(traces) ? traces.filter((t) => t && typeof t === 'object') : [];
  const validSelectors =
    selectors && typeof selectors === 'object'
      ? Object.fromEntries(
          Object.entries(selectors).filter(
            ([key, value]) =>
              key &&
              typeof key === 'string' &&
              value &&
              typeof value === 'string' &&
              value.trim().length > 0
          )
        )
      : {};

  let context = '';

  // Add known selectors
  if (Object.keys(validSelectors).length > 0) {
    context += '\n=== KNOWN SELECTORS FROM PREVIOUS TESTS ===\n';
    context += 'Use these exact selectors when they match the user request:\n';

    for (const [label, selector] of Object.entries(validSelectors)) {
      context += `- ${label}: "${selector}"\n`;
    }

    context += '\n⚠️ IMPORTANT: Prefer these known selectors over guessing!\n';
  }

  // Add example test flows
  if (validTraces.length > 0 && validTraces[0].parsed_data?.steps && Array.isArray(validTraces[0].parsed_data.steps)) {
    context += '\n=== EXAMPLE TEST FLOW FROM PREVIOUS TESTS ===\n';

    const steps = (validTraces[0].parsed_data.steps as TraceStep[]).slice(0, 10); // First 10 steps
    context += 'Here is how a similar test was performed:\n';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== 'object' || !step.type) continue;

      context += `${i + 1}. ${step.type}`;
      if (step.selector && typeof step.selector === 'string') {
        context += ` "${step.selector}"`;
      }
      if (step.text && typeof step.text === 'string') {
        context += ` with text "${step.text}"`;
      }
      if (step.url && typeof step.url === 'string') {
        context += ` to "${step.url}"`;
      }
      context += '\n';
    }

    context += '\n💡 You can use this as a reference for creating similar commands.\n';
  }

  return context;
}
