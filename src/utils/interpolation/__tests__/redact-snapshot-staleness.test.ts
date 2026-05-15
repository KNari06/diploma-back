/**
 * Phase 2.5 — pin the snapshot semantics of `collectSecretValues`.
 *
 * `command-executor.setRunVariables` and `replay-trace-writer.setRedactValues`
 * BOTH cache the secret-value list ONCE per run. Mid-run modifications
 * to the underlying Map are NOT reflected in the cached array.
 *
 * This is intentional today — `applyBindingsToContext` runs before the
 * step loop so all secrets are present before redaction is configured.
 * If a future change adds mid-run resource refresh (e.g. heal hook
 * applying a new secret resource), it must explicitly re-call
 * `executor.setRunVariables(...)` and `replayTrace.setRedactValues(...)`
 * to refresh the snapshot.
 *
 * This test locks the contract so that an accidental refactor to
 * "live Map reference" semantics doesn't slip through silently. If you
 * are intentionally moving to live-Map semantics, update this test AND
 * the comments in command-executor and replay-trace-writer.
 */

import { collectSecretValues } from '../redact-secrets';

describe('redact snapshot semantics', () => {
  it('collectSecretValues returns a snapshot, not a live view of the Map', () => {
    const map = new Map<string, unknown>([['secrets.A', 'aaaa_long_a']]);
    const snapshot = collectSecretValues(map);
    expect(snapshot).toEqual(['aaaa_long_a']);

    // Mutate the source map — the snapshot must NOT change.
    map.set('secrets.B', 'bbbb_long_b');
    expect(snapshot).toEqual(['aaaa_long_a']);

    // Recollecting picks up the new entry (this is the documented
    // "explicit refresh" path).
    const refreshed = collectSecretValues(map);
    expect(refreshed).toEqual(
      expect.arrayContaining(['aaaa_long_a', 'bbbb_long_b']),
    );
    expect(refreshed.length).toBe(2);
  });

  it('returns a fresh array on every call (no shared state across collects)', () => {
    const map = new Map<string, unknown>([['secrets.A', 'aaaa_long_a']]);
    const a = collectSecretValues(map);
    const b = collectSecretValues(map);
    expect(a).not.toBe(b); // distinct array references
    expect(a).toEqual(b);
  });
});
