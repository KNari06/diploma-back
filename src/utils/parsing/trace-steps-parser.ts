import type { TraceStep } from '@/types';
import AdmZip from 'adm-zip';

/**
 * Parse Playwright trace ZIP buffer into steps (unzip and extract trace events).
 * Used at upload time to populate trace_files.parsed_data and at read time in getTraceSteps.
 */
export function parsePlaywrightTraceSteps(buffer: Buffer): TraceStep[] {
  const steps: TraceStep[] = [];
  const zip = new AdmZip(buffer);
  const zipEntries = zip.getEntries();

  const traceEntry = zipEntries.find(
    (entry) => entry.entryName.includes('trace') && !entry.isDirectory
  );

  if (!traceEntry) {
    throw new Error('No trace file found in ZIP');
  }

  const traceData = traceEntry.getData().toString('utf8');
  const traceLines = traceData.split('\n').filter((line) => line.trim());

  let stepId = 1;
  for (const line of traceLines) {
    try {
      const event = JSON.parse(line);

      if (event.type === 'action' || event.type === 'apiCall') {
        const step: TraceStep = {
          stepId: stepId++,
          type: event.apiName || event.method || 'unknown',
          timestamp: event.time || Date.now(),
        };

        if (event.params) {
          if (event.params.url) step.url = event.params.url;
          if (event.params.selector) step.selector = event.params.selector;
          if (event.params.text) step.text = event.params.text;
        }

        step.description = generatePlaywrightStepDescription(step);
        steps.push(step);
      }
    } catch {
      continue;
    }
  }

  return steps;
}

function generatePlaywrightStepDescription(step: TraceStep): string {
  switch (step.type) {
    case 'goto':
    case 'navigate':
      return `Navigate to ${step.url}`;
    case 'click':
      return `Click on ${step.selector || 'element'}`;
    case 'fill':
    case 'type':
      return `Fill "${step.text}" into ${step.selector || 'input'}`;
    case 'check':
    case 'uncheck':
      return `${step.type} ${step.selector || 'checkbox'}`;
    case 'select':
      return `Select "${step.text}" in ${step.selector || 'dropdown'}`;
    case 'waitForSelector':
      return `Wait for ${step.selector}`;
    case 'screenshot':
      return 'Take screenshot';
    case 'expect':
    case 'assert':
      return `Assert: ${step.text || step.selector}`;
    default:
      return `${step.type}${step.selector ? ` (${step.selector})` : ''}`;
  }
}
