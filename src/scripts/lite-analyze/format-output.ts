/**
 * format-output — render a ParsedTrace as a human-readable ANSI table.
 *
 * Pure functions. No I/O. Deterministic output for a given input (modulo
 * the ANSI flag). Easy to snapshot-test.
 *
 * Colors are opt-out via `{ ansi: false }` so tests can assert on plain
 * strings without escape codes.
 */

import type { ParsedStep, ParsedTrace, StepPhaseTiming } from './parse-trace';

export interface FormatOptions {
  /** Use ANSI colors. Default: true for interactive terminals. */
  ansi?: boolean;
  /** Show the per-step timeline (event offsets). Verbose — default off. */
  verbose?: boolean;
  /** Maximum step description width in the table. Default: 48. */
  maxDescWidth?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANSI helpers — tiny, no external deps
// ═══════════════════════════════════════════════════════════════════════════

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function c(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatters for individual fields
// ═══════════════════════════════════════════════════════════════════════════

function fmtMs(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtOutcome(outcome: ParsedStep['quality']['outcome'], ansi: boolean): string {
  switch (outcome) {
    case 'success':
      return c(ANSI.green, '✓ success', ansi);
    case 'no_effect':
      return c(ANSI.yellow, '⚠ no_effect', ansi);
    case 'error':
      return c(ANSI.red, '✗ error', ansi);
    case 'skipped':
      return c(ANSI.gray, '· skipped', ansi);
    default:
      return c(ANSI.gray, '? unknown', ansi);
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase timing rendering
// ═══════════════════════════════════════════════════════════════════════════

/** Order + display labels for phase keys. Missing phases are skipped. */
const PHASE_DISPLAY: Array<{ key: keyof StepPhaseTiming; label: string }> = [
  { key: 'observerMs',   label: 'observer' },
  { key: 'strategistMs', label: 'strategist' },
  { key: 'actorMs',      label: 'actor' },
  { key: 'criticMs',     label: 'critic' },
  { key: 'plannerMs',    label: 'planner' },
  { key: 'executorMs',   label: 'executor' },
  { key: 'reviewerMs',   label: 'reviewer' },
  { key: 'playwrightMs', label: 'playwright' },
  { key: 'otherMs',      label: 'other' },
];

function renderPhaseLine(phases: StepPhaseTiming, ansi: boolean): string {
  const parts: string[] = [];
  for (const { key, label } of PHASE_DISPLAY) {
    const value = phases[key];
    if (typeof value === 'number' && value > 0) {
      parts.push(`${c(ANSI.dim, label, ansi)} ${fmtMs(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(c(ANSI.dim, ' | ', ansi)) : c(ANSI.dim, '(no phase timing)', ansi);
}

// ═══════════════════════════════════════════════════════════════════════════
// Header / summary sections
// ═══════════════════════════════════════════════════════════════════════════

function renderHeader(trace: ParsedTrace, ansi: boolean): string {
  const lines: string[] = [];
  const hr = c(ANSI.cyan, '═'.repeat(75), ansi);
  lines.push(hr);
  lines.push(
    '  ' +
      c(ANSI.bold, 'LITE MODE ANALYZER', ansi) +
      '  |  ' +
      c(ANSI.dim, 'Test: ', ansi) +
      c(ANSI.cyan, truncate(trace.testId, 48), ansi),
  );
  lines.push(hr);
  lines.push('');

  // Status line
  const executionPath = trace.executionPath ?? 'unknown';
  const successIcon = trace.success === true
    ? c(ANSI.green, '✓ SUCCESS', ansi)
    : trace.success === false
      ? c(ANSI.red, '✗ FAILED', ansi)
      : c(ANSI.gray, '? UNKNOWN', ansi);

  lines.push(`  Mode: ${successIcon}   Path: ${c(ANSI.magenta, executionPath, ansi)}`);
  lines.push(
    `  Duration: ${c(ANSI.bold, fmtMs(trace.totalDurationMs), ansi)}   ` +
      `Steps: ${c(ANSI.bold, String(trace.summary.stepCount), ansi)}   ` +
      `Iterations: ${c(ANSI.bold, String(trace.summary.iterationCount), ansi)}`,
  );
  lines.push(
    `  LLM: ${c(ANSI.bold, String(trace.summary.cost.llmCalls), ansi)} calls, ` +
      `${c(ANSI.bold, fmtTokens(trace.summary.cost.inputTokens), ansi)} in + ` +
      `${c(ANSI.bold, fmtTokens(trace.summary.cost.outputTokens), ansi)} out  ` +
      `(${c(ANSI.yellow, fmtUsd(trace.summary.cost.estimatedCostUsd), ansi)})`,
  );
  if (trace.enginePathsObserved.length > 0) {
    lines.push(
      `  Engines observed: ${c(ANSI.dim, trace.enginePathsObserved.join(', '), ansi)}`,
    );
  }
  if (trace.reason) {
    lines.push(`  Reason: ${c(ANSI.dim, truncate(trace.reason, 70), ansi)}`);
  }
  if (trace.malformedLines > 0) {
    lines.push(c(ANSI.yellow, `  ⚠ ${trace.malformedLines} malformed lines skipped`, ansi));
  }
  lines.push('');
  return lines.join('\n');
}

function renderStep(step: ParsedStep, opts: Required<FormatOptions>): string {
  const lines: string[] = [];
  const { ansi } = opts;

  const header =
    c(ANSI.bold, `Step ${step.index}`, ansi) +
    c(ANSI.dim, `  [iter ${step.iteration}${step.engine !== 'unknown' ? ' · ' + step.engine : ''}]`, ansi) +
    '   ' +
    truncate(step.description || '(no description)', opts.maxDescWidth);
  lines.push(header);

  // Action + outcome line
  const actionBits: string[] = [];
  actionBits.push(c(ANSI.dim, 'Action:', ansi));
  actionBits.push(step.action.type + (step.action.ref ? `(${step.action.ref})` : ''));
  if (step.action.value && step.action.value !== '[SENSITIVE]') {
    actionBits.push(c(ANSI.dim, `"${truncate(String(step.action.value), 24)}"`, ansi));
  } else if (step.action.value === '[SENSITIVE]') {
    actionBits.push(c(ANSI.dim, '[sensitive]', ansi));
  }
  if (step.action.url) {
    actionBits.push(c(ANSI.dim, `→ ${truncate(step.action.url, 40)}`, ansi));
  }
  lines.push(
    '  ' +
      c(ANSI.dim, 'Duration:', ansi) +
      ' ' +
      fmtMs(step.durationMs) +
      '   ' +
      actionBits.join(' ') +
      '   ' +
      fmtOutcome(step.quality.outcome, ansi),
  );

  // Phase timing
  lines.push('  ' + c(ANSI.dim, 'Phases: ', ansi) + renderPhaseLine(step.phases, ansi));

  // LLM usage
  if (step.llm.calls > 0 || step.llm.totalTokens > 0) {
    const modelLabel =
      step.llm.models.length > 0 ? c(ANSI.dim, ` [${step.llm.models.join(', ')}]`, ansi) : '';
    lines.push(
      '  ' +
        c(ANSI.dim, 'LLM:    ', ansi) +
        `${step.llm.calls} calls, ` +
        `${fmtTokens(step.llm.inputTokens)} in + ${fmtTokens(step.llm.outputTokens)} out` +
        `  (${fmtUsd(step.llm.estimatedCostUsd)})` +
        modelLabel,
    );
  }

  // Quality notes
  const notes: string[] = [];
  if (step.quality.criticVerdict && step.quality.criticVerdict !== 'approve') {
    notes.push(c(ANSI.yellow, `critic: ${step.quality.criticVerdict}`, ansi));
  }
  if (step.quality.criticWarnings > 0) {
    notes.push(c(ANSI.yellow, `${step.quality.criticWarnings} critic warnings`, ansi));
  }
  if (step.quality.safetyBlocked) {
    notes.push(c(ANSI.red, 'safety blocked', ansi));
  }
  if (step.quality.supervisorRecovery) {
    notes.push(c(ANSI.yellow, 'supervisor recovery', ansi));
  }
  if (step.quality.staleRefDetected) {
    notes.push(c(ANSI.yellow, 'stale ref', ansi));
  }
  if (step.quality.monolithicFallback) {
    notes.push(c(ANSI.yellow, 'monolithic fallback', ansi));
  }
  if (step.quality.stuckFlagged) {
    notes.push(c(ANSI.yellow, 'stuck flag', ansi));
  }
  notes.push(...step.quality.notes.map((n) => c(ANSI.dim, n, ansi)));
  if (notes.length > 0) {
    lines.push('  ' + c(ANSI.dim, 'Notes:  ', ansi) + notes.join(', '));
  }

  if (opts.verbose && step.timeline.length > 0) {
    const timelineStr = step.timeline
      .map((t) => `${t.eventType}(+${t.offsetMs}ms)`)
      .join(' → ');
    lines.push('  ' + c(ANSI.dim, 'Events: ', ansi) + c(ANSI.dim, truncate(timelineStr, 200), ansi));
  }

  return lines.join('\n');
}

function renderSummary(trace: ParsedTrace, ansi: boolean): string {
  const lines: string[] = [];
  const hr = c(ANSI.cyan, '─'.repeat(75), ansi);
  lines.push('');
  lines.push(hr);
  lines.push('  ' + c(ANSI.bold, 'SUMMARY', ansi));
  lines.push(hr);

  // Timing by phase — sorted descending
  const phaseEntries = Object.entries(trace.summary.timingByPhase).sort((a, b) => b[1] - a[1]);
  if (phaseEntries.length > 0) {
    lines.push('');
    lines.push('  ' + c(ANSI.bold, 'Timing by phase:', ansi));
    const maxValue = Math.max(...phaseEntries.map(([, v]) => v), 1);
    for (const [key, value] of phaseEntries) {
      const label = key.replace(/Ms$/, '').padEnd(12);
      const pct = (value / maxValue) * 100;
      const barLen = Math.round(pct / 3); // max ~33 chars
      const bar = '█'.repeat(barLen);
      const pctTotal = trace.totalDurationMs > 0
        ? ((value / trace.totalDurationMs) * 100).toFixed(1) + '%'
        : '-';
      lines.push(
        `    ${c(ANSI.dim, label, ansi)} ${c(ANSI.cyan, bar.padEnd(33), ansi)} ${fmtMs(value).padStart(8)}  ${c(ANSI.dim, `(${pctTotal} of total)`, ansi)}`,
      );
    }
  }

  // Quality
  const q = trace.summary.quality;
  lines.push('');
  lines.push('  ' + c(ANSI.bold, 'Quality:', ansi));
  lines.push(
    `    ${c(ANSI.green, '✓', ansi)} successful actions:   ${q.successfulActions}/${trace.summary.stepCount}`,
  );
  if (q.noEffectActions > 0) {
    lines.push(`    ${c(ANSI.yellow, '⚠', ansi)} no-effect actions:    ${q.noEffectActions}`);
  }
  if (q.errorActions > 0) {
    lines.push(`    ${c(ANSI.red, '✗', ansi)} error actions:        ${q.errorActions}`);
  }
  if (q.criticWarnings > 0) {
    lines.push(`    ${c(ANSI.yellow, '⚠', ansi)} critic warnings:      ${q.criticWarnings}`);
  }
  if (q.safetyBlocks > 0) {
    lines.push(`    ${c(ANSI.red, '⊘', ansi)} safety blocks:        ${q.safetyBlocks}`);
  }
  if (q.supervisorRecoveryRounds > 0) {
    lines.push(`    ${c(ANSI.yellow, '↻', ansi)} supervisor recovery:  ${q.supervisorRecoveryRounds} step(s)`);
  }
  if (q.staleRefRetries > 0) {
    lines.push(`    ${c(ANSI.yellow, '↻', ansi)} stale ref retries:    ${q.staleRefRetries}`);
  }
  if (q.monolithicFallbacks > 0) {
    lines.push(`    ${c(ANSI.yellow, '⤳', ansi)} monolithic fallbacks: ${q.monolithicFallbacks}`);
  }

  // Cost
  const cost = trace.summary.cost;
  lines.push('');
  lines.push('  ' + c(ANSI.bold, 'Cost:', ansi));
  lines.push(`    LLM calls:       ${c(ANSI.bold, String(cost.llmCalls), ansi)}`);
  lines.push(`    Input tokens:    ${fmtTokens(cost.inputTokens).padStart(10)}`);
  lines.push(`    Output tokens:   ${fmtTokens(cost.outputTokens).padStart(10)}`);
  lines.push(`    Total tokens:    ${fmtTokens(cost.totalTokens).padStart(10)}`);
  lines.push(`    Estimated USD:   ${c(ANSI.yellow, fmtUsd(cost.estimatedCostUsd).padStart(10), ansi)}`);
  if (cost.models.length > 0) {
    lines.push(`    Models:          ${c(ANSI.dim, cost.models.join(', '), ansi)}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render a ParsedTrace as a human-readable text report.
 * Pure function — no I/O, no ANSI escapes when `ansi: false`.
 */
export function formatTable(trace: ParsedTrace, options: FormatOptions = {}): string {
  const opts: Required<FormatOptions> = {
    ansi: options.ansi ?? true,
    verbose: options.verbose ?? false,
    maxDescWidth: options.maxDescWidth ?? 48,
  };

  const chunks: string[] = [];
  chunks.push(renderHeader(trace, opts.ansi));

  if (trace.steps.length === 0) {
    chunks.push(c(ANSI.yellow, '  (no steps parsed from trace)', opts.ansi));
  } else {
    chunks.push(c(ANSI.dim, '─'.repeat(75), opts.ansi));
    chunks.push('  ' + c(ANSI.bold, 'PER-STEP BREAKDOWN', opts.ansi));
    chunks.push(c(ANSI.dim, '─'.repeat(75), opts.ansi));
    chunks.push('');
    for (const step of trace.steps) {
      chunks.push(renderStep(step, opts));
      chunks.push('');
    }
  }

  chunks.push(renderSummary(trace, opts.ansi));
  return chunks.join('\n');
}
