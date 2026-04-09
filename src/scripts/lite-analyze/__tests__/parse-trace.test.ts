/**
 * Tests for parse-trace — verify the JSONL parser correctly groups events
 * into steps and extracts timing / quality / token signals.
 *
 * Each test builds a minimal JSONL fixture in a tmp dir, invokes parseTrace,
 * and asserts on the shape of the ParsedTrace result.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseTrace, readTraceEvents } from '../parse-trace';
import type { RawTraceEvent } from '../parse-trace';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lite-analyze-parse-'));
}

/** Build a JSONL file from an array of events. */
async function writeJsonl(dir: string, name: string, events: RawTraceEvent[]): Promise<string> {
  const fullPath = path.join(dir, name);
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(fullPath, lines, 'utf8');
  return fullPath;
}

/** Short helper to create a trace event with sensible defaults. */
function ev(
  ts: string,
  eventType: string,
  payload: Record<string, any> = {},
  options: { iteration?: number; stage?: string } = {},
): RawTraceEvent {
  return {
    ts,
    testId: 'test-1',
    mode: 'lite',
    iteration: options.iteration,
    stage: options.stage ?? 'iteration',
    eventType,
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    payload,
  };
}

describe('readTraceEvents', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('reads all well-formed events', async () => {
    const file = await writeJsonl(tmpDir, 'a.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'run_start'),
      ev('2026-04-08T12:00:01.000Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:02.000Z', 'iteration_end', { reason: 'completed' }, { iteration: 0 }),
    ]);
    const result = await readTraceEvents(file);
    expect(result.events).toHaveLength(3);
    expect(result.malformedLines).toBe(0);
  });

  it('skips blank lines without counting them as malformed', async () => {
    const content = [
      JSON.stringify(ev('2026-04-08T12:00:00.000Z', 'run_start')),
      '',
      '   ',
      JSON.stringify(ev('2026-04-08T12:00:01.000Z', 'iteration_start', {}, { iteration: 0 })),
      '',
    ].join('\n');
    const file = path.join(tmpDir, 'blank.jsonl');
    await fs.writeFile(file, content);
    const result = await readTraceEvents(file);
    expect(result.events).toHaveLength(2);
    expect(result.malformedLines).toBe(0);
  });

  it('counts malformed JSON lines', async () => {
    const content = [
      JSON.stringify(ev('2026-04-08T12:00:00.000Z', 'run_start')),
      '{not valid json',
      JSON.stringify(ev('2026-04-08T12:00:01.000Z', 'iteration_start', {}, { iteration: 0 })),
      '{"missing": "eventType and ts"}',
    ].join('\n');
    const file = path.join(tmpDir, 'malformed.jsonl');
    await fs.writeFile(file, content);
    const result = await readTraceEvents(file);
    expect(result.events).toHaveLength(2);
    expect(result.malformedLines).toBe(2);
  });
});

describe('parseTrace — top-level metadata', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('extracts testId, start/end timestamps, and duration from run_start/run_end', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'run_start'),
      ev('2026-04-08T12:00:00.500Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:01.000Z', 'iteration_end', { reason: 'completed' }, { iteration: 0 }),
      ev('2026-04-08T12:00:02.000Z', 'run_end', {
        success: true,
        reason: 'Goal achieved',
        executionPath: 'hybrid_success',
      }),
    ]);
    const parsed = await parseTrace(file);
    expect(parsed.testId).toBe('test-1');
    expect(parsed.startedAt).toBe('2026-04-08T12:00:00.000Z');
    expect(parsed.endedAt).toBe('2026-04-08T12:00:02.000Z');
    expect(parsed.totalDurationMs).toBe(2000);
    expect(parsed.success).toBe(true);
    expect(parsed.reason).toBe('Goal achieved');
    expect(parsed.executionPath).toBe('hybrid_success');
  });

  it('throws on empty file', async () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    await fs.writeFile(file, '');
    await expect(parseTrace(file)).rejects.toThrow('empty');
  });

  it('throws on file with only malformed lines', async () => {
    const file = path.join(tmpDir, 'junk.jsonl');
    await fs.writeFile(file, 'not json\nalso not json\n');
    await expect(parseTrace(file)).rejects.toThrow('No parseable events');
  });
});

describe('parseTrace — legacy loop step grouping', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('creates one step per iteration_start', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'run_start'),
      ev('2026-04-08T12:00:00.500Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:01.500Z', 'iteration_end', { reason: 'completed' }, { iteration: 0 }),
      ev('2026-04-08T12:00:02.000Z', 'iteration_start', {}, { iteration: 1 }),
      ev('2026-04-08T12:00:03.000Z', 'iteration_end', { reason: 'completed' }, { iteration: 1 }),
    ]);
    const parsed = await parseTrace(file);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0].index).toBe(1);
    expect(parsed.steps[0].iteration).toBe(0);
    expect(parsed.steps[1].index).toBe(2);
    expect(parsed.steps[1].iteration).toBe(1);
  });

  it('captures action type/ref/value from action_execute_start', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'run_start'),
      ev('2026-04-08T12:00:00.500Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:01.000Z', 'action_execute_start', {
        command: { action: 'fill', ref: 'e3', value: 'user@example.com' },
      }, { iteration: 0 }),
      ev('2026-04-08T12:00:01.500Z', 'action_execute_end', {
        outcome: 'success',
        durationMs: 500,
      }, { iteration: 0 }),
    ]);
    const parsed = await parseTrace(file);
    expect(parsed.steps).toHaveLength(1);
    const step = parsed.steps[0];
    expect(step.action.type).toBe('fill');
    expect(step.action.ref).toBe('e3');
    expect(step.action.value).toBe('user@example.com');
    expect(step.description).toBe('fill(e3)');
    expect(step.quality.outcome).toBe('success');
    expect(step.phases.playwrightMs).toBe(500);
  });

  it('classifies outcome no_effect and error', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:00.100Z', 'action_execute_end', { outcome: 'no_effect', durationMs: 100 }, { iteration: 0 }),
      ev('2026-04-08T12:00:01.000Z', 'iteration_start', {}, { iteration: 1 }),
      ev('2026-04-08T12:00:01.100Z', 'action_execute_end', { outcome: 'error', durationMs: 100 }, { iteration: 1 }),
    ]);
    const parsed = await parseTrace(file);
    expect(parsed.steps[0].quality.outcome).toBe('no_effect');
    expect(parsed.steps[1].quality.outcome).toBe('error');
  });

  it('extracts multi-agent phase timings from multi_agent_debug', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:01.000Z', 'multi_agent_debug', {
        debug: {
          observerMs: 200,
          strategistMs: 400,
          actorMs: 150,
          criticMs: 100,
          totalMs: 950,
          criticVerdict: 'approve',
          supervisorRecoveryMode: true,
        },
      }, { iteration: 0 }),
      ev('2026-04-08T12:00:02.000Z', 'iteration_end', {}, { iteration: 0 }),
    ]);
    const parsed = await parseTrace(file);
    const step = parsed.steps[0];
    expect(step.phases.observerMs).toBe(200);
    expect(step.phases.strategistMs).toBe(400);
    expect(step.phases.actorMs).toBe(150);
    expect(step.phases.criticMs).toBe(100);
    expect(step.phases.multiAgentTotalMs).toBe(950);
    expect(step.quality.criticVerdict).toBe('approve');
    expect(step.quality.supervisorRecovery).toBe(true);
  });

  it('computes otherMs as wall-clock minus known phases', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:00.500Z', 'multi_agent_debug', {
        debug: { observerMs: 100, strategistMs: 100, actorMs: 50, criticMs: 50 },
      }, { iteration: 0 }),
      ev('2026-04-08T12:00:02.000Z', 'iteration_end', {}, { iteration: 0 }), // 2000ms wall-clock
    ]);
    const parsed = await parseTrace(file);
    const step = parsed.steps[0];
    expect(step.durationMs).toBe(2000);
    // 100+100+50+50 = 300 known; 2000-300 = 1700 "other"
    expect(step.phases.otherMs).toBe(1700);
  });
});

describe('parseTrace — pipeline v2 step grouping', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('creates one step per round_start', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'run_start'),
      ev('2026-04-08T12:00:00.500Z', 'round_start', { round: 1 }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:01.000Z', 'planner_done', { round: 1, summary: 'Login flow', durationMs: 300 }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:02.000Z', 'executor_command_result', {
        command: 'fill_field',
        args: { ref: 'e3', value: 'user@example.com' },
        success: true,
        durationMs: 200,
      }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:03.000Z', 'reviewer_done', { round: 1, verdict: 'continue', durationMs: 150 }, { stage: 'pipeline' }),
    ]);
    const parsed = await parseTrace(file);
    expect(parsed.steps).toHaveLength(1);
    const step = parsed.steps[0];
    expect(step.engine).toBe('pipeline_v2');
    expect(step.phases.plannerMs).toBe(300);
    expect(step.phases.reviewerMs).toBe(150);
    expect(step.action.type).toBe('fill_field');
    expect(step.quality.outcome).toBe('success');
  });

  it('detects SAFETY_INTERCEPTOR blocks from executor_command_result error', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'round_start', { round: 1 }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:01.000Z', 'executor_command_result', {
        command: 'click_element',
        args: { ref: 'e5' },
        success: false,
        error: 'SAFETY_INTERCEPTOR: Element ref "e5" is covered by overlay',
        durationMs: 10,
      }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:02.000Z', 'reviewer_done', { round: 1, verdict: 'replan' }, { stage: 'pipeline' }),
    ]);
    const parsed = await parseTrace(file);
    const step = parsed.steps[0];
    expect(step.quality.safetyBlocked).toBe(true);
    expect(step.quality.notes).toContain('safety interceptor block');
  });

  it('accumulates tokens from executor_tool_calls across sub-rounds', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'round_start', { round: 1 }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:00.500Z', 'executor_tool_calls', {
        tokensUsed: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
        model: 'gpt-4o-mini',
      }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:01.000Z', 'executor_tool_calls', {
        tokensUsed: { inputTokens: 1200, outputTokens: 150, totalTokens: 1350 },
        model: 'gpt-4o-mini',
      }, { stage: 'pipeline' }),
      ev('2026-04-08T12:00:02.000Z', 'reviewer_done', { round: 1, verdict: 'continue' }, { stage: 'pipeline' }),
    ]);
    const parsed = await parseTrace(file);
    const step = parsed.steps[0];
    expect(step.llm.calls).toBe(2);
    expect(step.llm.inputTokens).toBe(2200);
    expect(step.llm.outputTokens).toBe(250);
    expect(step.llm.totalTokens).toBe(2450);
    expect(step.llm.models).toEqual(['gpt-4o-mini']);
    expect(step.llm.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe('parseTrace — summary roll-up', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('aggregates timing, quality, and cost across all steps', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'run_start'),
      // Step 1
      ev('2026-04-08T12:00:00.100Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:00.500Z', 'multi_agent_debug', {
        debug: { observerMs: 100, strategistMs: 100, actorMs: 50, criticMs: 50 },
      }, { iteration: 0 }),
      ev('2026-04-08T12:00:00.900Z', 'action_execute_end', { outcome: 'success', durationMs: 300 }, { iteration: 0 }),
      // Step 2
      ev('2026-04-08T12:00:01.000Z', 'iteration_start', {}, { iteration: 1 }),
      ev('2026-04-08T12:00:01.200Z', 'multi_agent_debug', {
        debug: { observerMs: 120, strategistMs: 110, actorMs: 60, criticMs: 40 },
      }, { iteration: 1 }),
      ev('2026-04-08T12:00:01.900Z', 'action_execute_end', { outcome: 'no_effect', durationMs: 600 }, { iteration: 1 }),
      // Step 3 — error
      ev('2026-04-08T12:00:02.000Z', 'iteration_start', {}, { iteration: 2 }),
      ev('2026-04-08T12:00:02.500Z', 'action_execute_end', { outcome: 'error', durationMs: 500 }, { iteration: 2 }),
      ev('2026-04-08T12:00:03.000Z', 'run_end', { success: false }),
    ]);
    const parsed = await parseTrace(file);

    expect(parsed.steps).toHaveLength(3);
    expect(parsed.summary.stepCount).toBe(3);
    expect(parsed.summary.iterationCount).toBe(3);

    // Timing roll-up
    expect(parsed.summary.timingByPhase.observerMs).toBe(220);    // 100+120
    expect(parsed.summary.timingByPhase.strategistMs).toBe(210);  // 100+110
    expect(parsed.summary.timingByPhase.actorMs).toBe(110);       // 50+60
    expect(parsed.summary.timingByPhase.criticMs).toBe(90);       // 50+40
    expect(parsed.summary.timingByPhase.playwrightMs).toBe(1400); // 300+600+500

    // Quality roll-up
    expect(parsed.summary.quality.successfulActions).toBe(1);
    expect(parsed.summary.quality.noEffectActions).toBe(1);
    expect(parsed.summary.quality.errorActions).toBe(1);
  });

  it('reports zero tokens and no models when no LLM events present', async () => {
    const file = await writeJsonl(tmpDir, 't.jsonl', [
      ev('2026-04-08T12:00:00.000Z', 'iteration_start', {}, { iteration: 0 }),
      ev('2026-04-08T12:00:00.100Z', 'action_execute_end', { outcome: 'success', durationMs: 50 }, { iteration: 0 }),
    ]);
    const parsed = await parseTrace(file);
    expect(parsed.summary.cost.llmCalls).toBe(0);
    expect(parsed.summary.cost.inputTokens).toBe(0);
    expect(parsed.summary.cost.estimatedCostUsd).toBe(0);
    expect(parsed.summary.cost.models).toEqual([]);
  });
});

describe('parseTrace — malformed line tolerance', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('reports malformed line count without crashing', async () => {
    const content = [
      JSON.stringify(ev('2026-04-08T12:00:00.000Z', 'run_start')),
      'CRASH-mid-line-data',
      JSON.stringify(ev('2026-04-08T12:00:00.100Z', 'iteration_start', {}, { iteration: 0 })),
      JSON.stringify(ev('2026-04-08T12:00:00.200Z', 'iteration_end', {}, { iteration: 0 })),
    ].join('\n');
    const file = path.join(tmpDir, 't.jsonl');
    await fs.writeFile(file, content);
    const parsed = await parseTrace(file);
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.steps).toHaveLength(1);
  });
});
