import { TraceSummaryAggregator, aggregateJsonl } from '../trace-analysis.util';

const er = (payload: unknown) => ({ eventType: 'element_resolution', payload });

describe('TraceSummaryAggregator — basics', () => {
  it('returns a zeroed summary when no events are consumed', () => {
    const s = new TraceSummaryAggregator().finalize();
    expect(s).toMatchObject({
      errors: 0,
      failedSteps: 0,
      totalSteps: 0,
      totalEvents: 0,
      resolveCount: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
    });
  });

  it('ignores non-object events and counts the rest in totalEvents', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume(null);
    agg.consume('nope' as unknown);
    agg.consume({ eventType: 'whatever' });
    expect(agg.finalize().totalEvents).toBe(1);
  });

  it('counts errors from stage or eventType', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume({ stage: 'error' });
    agg.consume({ eventType: 'error' });
    expect(agg.finalize().errors).toBe(2);
  });
});

describe('TraceSummaryAggregator — steps', () => {
  it('counts step_result events and failures', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume({ eventType: 'step_result', payload: { status: 'pass' } });
    agg.consume({ eventType: 'step_result', payload: { status: 'fail' } });
    const s = agg.finalize();
    expect(s.totalSteps).toBe(2);
    expect(s.failedSteps).toBe(1);
  });

  it('lets run_end override step totals', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume({ eventType: 'step_result', payload: { status: 'fail' } });
    agg.consume({ eventType: 'run_end', payload: { totalSteps: 10, failedSteps: 3 } });
    const s = agg.finalize();
    expect(s.totalSteps).toBe(10);
    expect(s.failedSteps).toBe(3);
  });

  it('takes the max of run_error_summary.totalErrors', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume({ stage: 'error' });
    agg.consume({ eventType: 'run_error_summary', payload: { totalErrors: 5 } });
    expect(agg.finalize().errors).toBe(5);
  });
});

describe('TraceSummaryAggregator — resolver health', () => {
  it('tallies resolverPath and fingerprintMatch with defaults', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume({ eventType: 'step_apply_result', payload: { resolverPath: 'llm', fingerprintMatch: 'exact' } });
    agg.consume({ eventType: 'step_apply_result', payload: {} });
    const s = agg.finalize();
    expect(s.resolverPathCounts).toEqual({ llm: 1, other: 1 });
    expect(s.fingerprintMatchCounts).toEqual({ exact: 1, no_recorded: 1 });
  });

  it('buckets LLM confidence and ignores non-LLM resolves', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume(er({ llm: {}, result: { chosen: { confidence: 0.5, ref: 'e1', label: 'x' } }, description: 'x' }));
    agg.consume(er({ llm: {}, result: { chosen: { confidence: 0.7, ref: 'e1', label: 'x' } }, description: 'x' }));
    agg.consume(er({ llm: {}, result: { chosen: { confidence: 0.8, ref: 'e1', label: 'x' } }, description: 'x' }));
    agg.consume(er({ llm: {}, result: { chosen: { confidence: 0.95, ref: 'e1', label: 'x' } }, description: 'x' }));
    agg.consume(er({ result: { chosen: { confidence: 0.5 } } })); // no llm → not bucketed
    expect(agg.finalize().confidenceBuckets).toEqual({ lt55: 1, lt75: 1, lt85: 1, ge85: 1 });
  });

  it('computes latency percentiles', () => {
    const agg = new TraceSummaryAggregator();
    for (const ms of [50, 10, 40, 20, 30]) agg.consume(er({ latencyMs: ms }));
    const s = agg.finalize();
    expect(s.resolveCount).toBe(5);
    expect(s.latencyP50Ms).toBe(30);
    expect(s.latencyP95Ms).toBe(40);
  });
});

describe('TraceSummaryAggregator — bug detectors', () => {
  it('flags a modal-detection miss when modal nodes exist but no modal rule fired', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume(er({ domSnapshot: [{ isInsideActiveModal: true }], rules: [] }));
    expect(agg.finalize().modalDetectionMisses).toBe(1);
  });

  it('does not flag a miss when a modal rule fired', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume(er({ domSnapshot: [{ isInsideActiveModal: true }], rules: [{ ruleId: 'modal.detected', count: 1 }] }));
    expect(agg.finalize().modalDetectionMisses).toBe(0);
  });

  it('flags Bug-A when the LLM label has no overlap with the intent', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume(er({ llm: {}, description: 'submit form', result: { chosen: { ref: 'e1', label: 'cancel' } } }));
    expect(agg.finalize().llmBugAOccurrences).toBe(1);
  });

  it('does not flag Bug-A when the label overlaps the intent', () => {
    const agg = new TraceSummaryAggregator();
    agg.consume(er({ llm: {}, description: 'submit form', result: { chosen: { ref: 'e1', label: 'submit' } } }));
    expect(agg.finalize().llmBugAOccurrences).toBe(0);
  });
});

describe('aggregateJsonl', () => {
  it('parses each line, skips blanks, and counts malformed lines in totalEvents', () => {
    const raw = [
      JSON.stringify({ eventType: 'step_result', payload: { status: 'fail' } }),
      '',
      'not-json',
      JSON.stringify({ eventType: 'error' }),
    ].join('\n');
    const s = aggregateJsonl(raw);
    expect(s.totalEvents).toBe(3); // valid step_result + malformed line + valid error
    expect(s.totalSteps).toBe(1);
    expect(s.failedSteps).toBe(1);
    expect(s.errors).toBe(1);
  });
});
