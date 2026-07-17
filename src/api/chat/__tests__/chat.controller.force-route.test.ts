/**
 * Phase B1 — unit tests for `decideForceRoute`.
 *
 * The full `handleChat` flow is integration territory; this file
 * isolates the force-route decision so we can confirm the contract:
 *
 *   - Force-route fires when MOBILE_EDITOR_FORCE_ROUTE is on AND
 *     context.mobileEditorMode === true — with or without a
 *     mobileSessionId. A missing/invalid session id still force-routes
 *     (tagged `metadata.missingSession`) so mobile_agent replies with
 *     its own `NO_SESSION_REPLY` instead of the classifier silently
 *     misrouting the message to web general_chat.
 *   - Anything else returns null (the caller then runs the normal
 *     intent classifier).
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

  it('force-routes with missingSession when mobileSessionId is absent (no silent misroute)', () => {
    expect(decideForceRoute({ mobileEditorMode: true }, true)).toEqual({
      intent: 'mobile_agent',
      intent_confidence: 1.0,
      confidence: 1.0,
      metadata: { routingSource: 'force_route', missingSession: true },
    });
  });

  it('treats an empty-string mobileSessionId as missing (still force-routes)', () => {
    expect(
      decideForceRoute({ mobileEditorMode: true, mobileSessionId: '' }, true)?.metadata,
    ).toEqual({ routingSource: 'force_route', missingSession: true });
  });

  it('treats a non-string mobileSessionId as missing (defensive)', () => {
    expect(
      decideForceRoute({ mobileEditorMode: true, mobileSessionId: 12345 }, true)?.metadata,
    ).toEqual({ routingSource: 'force_route', missingSession: true });
    expect(
      decideForceRoute({ mobileEditorMode: true, mobileSessionId: null }, true)?.metadata,
    ).toEqual({ routingSource: 'force_route', missingSession: true });
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
