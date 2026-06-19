import { shouldRecollectForReadiness, MIN_HEALTHY_INTERACTIVE_NODES } from '../replay-readiness';

describe('shouldRecollectForReadiness', () => {
  it('returns false when the feature flag is disabled', () => {
    expect(shouldRecollectForReadiness({ enabled: false, domNodeCount: 0, attempt: 0 })).toBe(false);
    expect(shouldRecollectForReadiness({ enabled: false, domNodeCount: 7, attempt: 0 })).toBe(false);
  });

  it('recollects when a fresh first-attempt snapshot is sparse', () => {
    expect(shouldRecollectForReadiness({ enabled: true, domNodeCount: 7, attempt: 0 })).toBe(true);
    expect(shouldRecollectForReadiness({ enabled: true, domNodeCount: 0, attempt: 0 })).toBe(true);
  });

  it('does not recollect when the snapshot already looks healthy', () => {
    expect(
      shouldRecollectForReadiness({ enabled: true, domNodeCount: MIN_HEALTHY_INTERACTIVE_NODES, attempt: 0 }),
    ).toBe(false);
    expect(shouldRecollectForReadiness({ enabled: true, domNodeCount: 177, attempt: 0 })).toBe(false);
  });

  it('only gates the first attempt — retries have their own recollect logic', () => {
    expect(shouldRecollectForReadiness({ enabled: true, domNodeCount: 1, attempt: 1 })).toBe(false);
    expect(shouldRecollectForReadiness({ enabled: true, domNodeCount: 1, attempt: 2 })).toBe(false);
  });
});
