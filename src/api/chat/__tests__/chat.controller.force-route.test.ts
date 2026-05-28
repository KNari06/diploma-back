/**
 * Phase B1 — unit tests for `decideForceRoute`.
 *
 * The full `handleChat` flow is integration territory; this file
 * isolates the force-route decision so we can confirm the contract:
 *
 *   - Force-route fires when MOBILE_EDITOR_FORCE_ROUTE is on AND
 *     context.mobileEditorMode === true AND mobileSessionId is set.
 *   - Anything else returns null (the caller then runs the normal
 *     intent classifier).
 *
 * Critical edge: `mobileEditorMode=true` WITHOUT `mobileSessionId` is
 * a frontend race; we MUST fall through so mobile_agent can reply with
 * its own `NO_SESSION_REPLY`.
 */

import { decideForceRoute } from '../chat.controller';

describe('decideForceRoute', () => {
  it('returns synthesised mobile_agent intent on full mobile-editor signal', () => {
    const result = decideForceRoute(
      { mobileEditorMode: true, mobileSessionId: 'sess-1' },
      true,
    );
    expect(result).toEqual({
      intent: 'mobile_agent',
      intent_confidence: 1.0,
      confidence: 1.0,
      metadata: { routingSource: 'force_route' },
    });
  });

  it('returns null when kill switch is off', () => {
    const result = decideForceRoute(
      { mobileEditorMode: true, mobileSessionId: 'sess-1' },
      false,
    );
    expect(result).toBeNull();
  });

  it('returns null when mobileEditorMode is missing', () => {
    expect(decideForceRoute({ mobileSessionId: 'sess-1' }, true)).toBeNull();
  });

  it('returns null when mobileEditorMode is anything other than true (no truthy coercion)', () => {
    // Strict equality — 'yes', 1, 'true' string all NOT acceptable.
    expect(decideForceRoute({ mobileEditorMode: 'true', mobileSessionId: 's1' }, true)).toBeNull();
    expect(decideForceRoute({ mobileEditorMode: 1, mobileSessionId: 's1' }, true)).toBeNull();
    expect(decideForceRoute({ mobileEditorMode: false, mobileSessionId: 's1' }, true)).toBeNull();
  });

  it('returns null when mobileSessionId is missing (frontend race → let classifier handle)', () => {
    expect(decideForceRoute({ mobileEditorMode: true }, true)).toBeNull();
  });

  it('returns null when mobileSessionId is empty string', () => {
    expect(decideForceRoute({ mobileEditorMode: true, mobileSessionId: '' }, true)).toBeNull();
  });

  it('returns null when mobileSessionId is not a string (defensive)', () => {
    expect(
      decideForceRoute({ mobileEditorMode: true, mobileSessionId: 12345 }, true),
    ).toBeNull();
    expect(
      decideForceRoute({ mobileEditorMode: true, mobileSessionId: null }, true),
    ).toBeNull();
  });

  it('accepts a JSON-string context (matches frontend serialization)', () => {
    const ctxStr = JSON.stringify({ mobileEditorMode: true, mobileSessionId: 'sess-1' });
    const result = decideForceRoute(ctxStr, true);
    expect(result?.intent).toBe('mobile_agent');
  });

  it('returns null for malformed JSON-string context', () => {
    expect(decideForceRoute('{not json', true)).toBeNull();
  });

  it('returns null for null / undefined context', () => {
    expect(decideForceRoute(null, true)).toBeNull();
    expect(decideForceRoute(undefined, true)).toBeNull();
  });

  it('does NOT mis-fire on a web editor request (mode=editor + previewSessionId)', () => {
    // Web requests carry previewSessionId, not mobileSessionId.
    expect(
      decideForceRoute(
        { mode: 'editor', previewSessionId: 'preview-1' },
        true,
      ),
    ).toBeNull();
  });
});
