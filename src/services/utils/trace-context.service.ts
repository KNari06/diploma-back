import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { TraceFile, TraceStep, PlaywrightCommand } from '@/types';

/**
 * Extract selectors from trace files
 */
export async function extractSelectorsFromTraces(
  traces: TraceFile[]
): Promise<Record<string, string>> {
  const selectors: Record<string, string> = {};

  for (const trace of traces) {
    if (!trace.parsed_data?.steps) continue;

    const steps = trace.parsed_data.steps as TraceStep[];

    for (const step of steps) {
      if (step.selector && step.type) {
        // Extract meaningful label from step
        const label = extractElementLabel(step);
        if (label && !selectors[label]) {
          selectors[label] = step.selector;
        }
      }
    }
  }

  logger.info('Extracted selectors from traces', {
    traceCount: traces.length,
    selectorCount: Object.keys(selectors).length,
  });

  return selectors;
}

/**
 * Extract meaningful element label from trace step
 */
function extractElementLabel(step: TraceStep): string | null {
  // Try to extract from text content
  if (step.text) {
    const elementType = guessElementType(step.type, step.selector);
    return `${step.text} ${elementType}`;
  }

  // Try to extract from selector
  if (step.selector) {
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
  if (!selector) return 'element';

  // Check selector for element type
  if (selector.includes('button') || selector.includes('btn')) return 'button';
  if (selector.includes('input')) return 'input';
  if (selector.includes('select')) return 'select';
  if (selector.includes('checkbox')) return 'checkbox';
  if (selector.includes('radio')) return 'radio';
  if (selector.includes('link') || selector.includes('a[')) return 'link';
  if (selector.includes('form')) return 'form';

  // Guess from action
  if (action === 'click') return 'button';
  if (action === 'fill' || action === 'type') return 'input';
  if (action === 'check') return 'checkbox';
  if (action === 'select') return 'select';

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
  try {
    // Check if projectId is a valid UUID
    const isValidUUID = projectId && projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    if (!isValidUUID) {
      logger.info('Skipping trace search - projectId is not a valid UUID', { projectId });
      return [];
    }

    // Extract domain from URL for matching
    const domain = extractDomain(url);

    logger.info('Searching traces by URL', { url, domain, projectId });

    // First, find tests with matching URL
    const { data: tests, error: testsError } = await supabaseAdmin
      .from('tests')
      .select('id')
      .eq('project_id', projectId)
      .ilike('url', `%${domain}%`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (testsError) {
      logger.error('Failed to fetch tests for traces', testsError);
      return [];
    }

    if (!tests || tests.length === 0) {
      logger.info('No tests found for URL', { url, domain });
      return [];
    }

    const testIds = tests.map((t: any) => t.id);

    // Find parsed trace files for these tests
    const { data: traces, error: tracesError } = await supabaseAdmin
      .from('trace_files')
      .select('*')
      .in('test_id', testIds)
      .eq('status', 'parsed')
      .not('parsed_data', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (tracesError) {
      logger.error('Failed to fetch trace files', tracesError);
      return [];
    }

    logger.info('Found traces for URL', {
      url,
      traceCount: traces?.length || 0,
    });

    return (traces as TraceFile[]) || [];
  } catch (error) {
    logger.error('Error finding traces by URL', error);
    return [];
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch {
    // If URL parsing fails, return cleaned string
    return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

/**
 * Convert trace steps to Playwright commands format
 */
export function convertTraceStepsToCommands(steps: TraceStep[]): PlaywrightCommand[] {
  const commands: PlaywrightCommand[] = [];

  for (const step of steps) {
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
  // Map trace step types to Playwright action types
  const actionMap: Record<string, string> = {
    'goto': 'goto',
    'click': 'click',
    'fill': 'fill',
    'type': 'type',
    'check': 'check',
    'uncheck': 'uncheck',
    'select': 'select',
    'hover': 'hover',
    'press': 'press',
    'wait': 'wait',
    'screenshot': 'screenshot',
  };

  const action = actionMap[step.type.toLowerCase()] || step.type;

  const command: PlaywrightCommand = {
    action: action as any,
    description: step.description || `${action} ${step.selector || ''}`.trim(),
  };

  if (step.selector) command.selector = step.selector;
  if (step.text) command.value = step.text;
  if (step.url) command.url = step.url;
  if (step.timestamp) command.timeout = 30000; // Default timeout

  return command;
}

/**
 * Get formatted context from traces for AI prompt
 */
export function formatTracesForPrompt(
  traces: TraceFile[],
  selectors: Record<string, string>
): string {
  let context = '';

  // Add known selectors
  if (Object.keys(selectors).length > 0) {
    context += '\n=== KNOWN SELECTORS FROM PREVIOUS TESTS ===\n';
    context += 'Use these exact selectors when they match the user request:\n\n';

    for (const [label, selector] of Object.entries(selectors)) {
      context += `- ${label}: "${selector}"\n`;
    }

    context += '\n⚠️ IMPORTANT: Prefer these known selectors over guessing!\n';
  }

  // Add example test flows
  if (traces.length > 0 && traces[0].parsed_data?.steps) {
    context += '\n=== EXAMPLE TEST FLOW FROM PREVIOUS TESTS ===\n';

    const steps = (traces[0].parsed_data.steps as TraceStep[]).slice(0, 10); // First 10 steps
    context += 'Here is how a similar test was performed:\n\n';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      context += `${i + 1}. ${step.type}`;
      if (step.selector) context += ` "${step.selector}"`;
      if (step.text) context += ` with text "${step.text}"`;
      if (step.url) context += ` to "${step.url}"`;
      context += '\n';
    }

    context += '\n💡 You can use this as a reference for creating similar commands.\n';
  }

  return context;
}
