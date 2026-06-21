import { evaluateEvidenceShortcut, EVIDENCE_REF_TTL_MS } from '../evidence-shortcut.utils';
import type { InteractiveNode, StepEvidence, BindingHints } from '../preview.types';

const URL = 'https://app.example.com/page';

const node = (ref: string, over: Partial<InteractiveNode> = {}): InteractiveNode =>
  ({ ref, ...over }) as unknown as InteractiveNode;

const evidence = (over: Partial<StepEvidence> = {}): StepEvidence =>
  ({
    lastSuccessRef: 'e1',
    pageUrl: URL,
    capturedAt: new Date().toISOString(),
    ...over,
  }) as unknown as StepEvidence;

const base = (over: Record<string, unknown> = {}) => ({
  evidence: evidence(),
  domNodes: [node('e1', { text: 'Login' })],
  currentUrl: URL,
  ...over,
});

describe('evaluateEvidenceShortcut — rejections', () => {
  it('rejects when there is no evidence', () => {
    const r = evaluateEvidenceShortcut(base({ evidence: undefined }));
    expect(r).toEqual({ ok: false, reason: 'no_evidence' });
  });

  it('rejects when the evidence has no cached ref', () => {
    const r = evaluateEvidenceShortcut(base({ evidence: evidence({ lastSuccessRef: undefined }) }));
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('no_cached_ref');
  });

  it('rejects when the session is newer than the evidence', () => {
    const r = evaluateEvidenceShortcut(
      base({
        evidence: evidence({ capturedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
        sessionCreatedAt: Date.now(),
      }),
    );
    expect((r as any).reason).toBe('session_newer_than_evidence');
  });

  it('rejects when the cached ref has expired (TTL)', () => {
    const r = evaluateEvidenceShortcut(
      base({ evidence: evidence({ capturedAt: new Date(Date.now() - EVIDENCE_REF_TTL_MS - 1000).toISOString() }) }),
    );
    expect((r as any).reason).toBe('ttl_expired');
  });

  it('rejects when no recorded URL is available', () => {
    const r = evaluateEvidenceShortcut(base({ evidence: evidence({ pageUrl: undefined }) }));
    expect((r as any).reason).toBe('no_recorded_url');
  });

  it('rejects on a URL mismatch', () => {
    const r = evaluateEvidenceShortcut(base({ currentUrl: 'https://app.example.com/other' }));
    expect((r as any).reason).toBe('url_mismatch');
  });

  it('rejects when the cached ref is not in the DOM', () => {
    const r = evaluateEvidenceShortcut(base({ domNodes: [node('different')] }));
    expect((r as any).reason).toBe('ref_not_in_dom');
  });

  it('rejects on a semantic mismatch against the recorded element text', () => {
    const r = evaluateEvidenceShortcut(
      base({
        domNodes: [node('e1', { text: 'Logout' })],
        bindingHints: { text: 'Login' } as BindingHints,
      }),
    );
    expect((r as any).reason).toBe('semantic_mismatch');
  });

  it('rejects a disabled node for a click-like action', () => {
    const r = evaluateEvidenceShortcut(
      base({ domNodes: [node('e1', { text: 'Login', isDisabled: true })], actionType: 'click' }),
    );
    expect((r as any).reason).toBe('node_disabled');
  });
});

describe('evaluateEvidenceShortcut — acceptance', () => {
  it('accepts a valid cached ref and reports the semantic source', () => {
    const r = evaluateEvidenceShortcut(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toBe('e1');
      expect(r.node.ref).toBe('e1');
      expect(r.semanticSource).toBe('skipped'); // no hints/description provided
    }
  });

  it('accepts when the recorded text matches the live node and uses bindingHints', () => {
    const r = evaluateEvidenceShortcut(
      base({
        domNodes: [node('e1', { text: 'Login', labelText: 'Login' })],
        bindingHints: { text: 'Login', label: 'Login' } as BindingHints,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.semanticSource).toBe('bindingHints');
  });

  it('does not reject a disabled node for a non-click action', () => {
    const r = evaluateEvidenceShortcut(
      base({ domNodes: [node('e1', { text: 'Login', isDisabled: true })], actionType: 'type' }),
    );
    expect(r.ok).toBe(true);
  });
});
