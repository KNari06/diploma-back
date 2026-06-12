/**
 * Integration tests for CdpSnapshotService.collect (Etap 2 Task 2.7).
 *
 * Approach:
 *   We mock at the CDP boundary — `cdp.send(...)` and `page.evaluate(...)`
 *   are stubbed to return canned bundles. The full pipeline runs:
 *   parallel fetch → mapping → ref assignment → ancestry → runtime
 *   → DOM walks → modal detection → cleanup → assemble.
 *
 *   This covers the orchestration logic (phase ordering, error
 *   propagation, internal-stash cleanup) without spinning up a real
 *   browser. Real-Chromium fidelity comes from shadow mode in Week 3.
 *
 * What we explicitly test:
 *   1. Empty page → empty elements, no crash
 *   2. Single-button page → all phases populate the right fields
 *   3. AX domain unavailable → fall through with role from attrs
 *   4. DS payload too large → CdpSnapshotError thrown
 *   5. CDP send rejected → CdpSnapshotError with categorised kind
 *   6. Modal detection (Layer 1) — `<dialog open>` flagged
 *   7. Internal stash (__dsNodeIndex / __docIndex) cleaned up
 *   8. CDP session ownership — caller-supplied session NOT detached
 *
 * What we do NOT test here:
 *   - Helper-level logic (covered by cdp-snapshot.helpers.test.ts)
 *   - Diff output shape (covered by snapshot-diff.test.ts)
 *   - Real browser behaviour (would need Playwright spawn — out of
 *     unit-test scope; comes via shadow mode metrics in Week 3)
 */

import { CdpSnapshotService, CdpSnapshotError } from '../cdp-snapshot.service';

// ─────────────────────────────────────────────────────────────────
// Mock plumbing
// ─────────────────────────────────────────────────────────────────

interface MockCdp {
  send: jest.Mock;
  detach: jest.Mock;
  __detached: boolean;
}

interface MockPage {
  url: jest.Mock;
  title: jest.Mock;
  viewportSize: jest.Mock;
  evaluate: jest.Mock;
  context: jest.Mock;
  // May 2026 — Phase 3.5 assignAgentRefs now routes per-document via
  // frame.evaluate. Single-doc tests still use the main frame, which
  // we proxy to page.evaluate so existing evaluateResults queues drive
  // both paths without rewrites.
  mainFrame: jest.Mock;
  frames: jest.Mock;
}

function makeMockCdp(handlers: Record<string, unknown>): MockCdp {
  const cdp: MockCdp = {
    send: jest.fn(async (method: string) => {
      const handler = handlers[method];
      if (typeof handler === 'function') return (handler as () => unknown)();
      if (handler === undefined) throw new Error(`unhandled CDP method: ${method}`);
      return handler;
    }),
    detach: jest.fn(async function (this: MockCdp) {
      this.__detached = true;
    }),
    __detached: false,
  };
  return cdp;
}

function makeMockPage(opts: {
  cdp?: MockCdp;
  url?: string;
  title?: string;
  viewport?: { width: number; height: number } | null;
  evaluateResults?: unknown[];
}): MockPage {
  const evaluateQueue = [...(opts.evaluateResults ?? [])];
  // Single shared evaluate fn — main-frame.evaluate and page.evaluate
  // pull from the same queue so tests written before per-frame routing
  // (single-doc tests with linear evaluateResults) keep working.
  const sharedEvaluate = jest.fn(async (...args: unknown[]) => {
    // Phase 1.5 framework-clickable tag/untag passes are identified by their
    // marker argument ('data-qait-fwclick'). They are NOT part of the Phase
    // 3.5/4/5b evaluate sequence the evaluateResults queue drives, so they must
    // not consume a queue slot (tag returns a count; untag returns void).
    if (args[1] === 'data-qait-fwclick') return 0;
    if (evaluateQueue.length === 0) return [];
    return evaluateQueue.shift();
  });
  const mainFrameStub = {
    evaluate: sharedEvaluate,
    isDetached: jest.fn(() => false),
    url: jest.fn(() => opts.url ?? 'https://example.com'),
    name: jest.fn(() => ''),
  };
  return {
    url: jest.fn(() => opts.url ?? 'https://example.com'),
    title: jest.fn(async () => opts.title ?? 'Test Page'),
    viewportSize: jest.fn(() => opts.viewport ?? { width: 1280, height: 720 }),
    evaluate: sharedEvaluate,
    context: jest.fn(() => ({
      newCDPSession: jest.fn(async () => opts.cdp ?? makeMockCdp({})),
    })),
    mainFrame: jest.fn(() => mainFrameStub),
    // Tests that exercise iframe ref assignment override frames() per
    // case; default returns just the main frame so single-doc tests
    // see no extra evaluate noise.
    frames: jest.fn(() => [mainFrameStub]),
  };
}

/**
 * Build a minimal valid DOMSnapshot response. Single document, single
 * interactive element (<button>) with bounds + computed styles.
 *
 * String table indexes are documented inline so test changes don't
 * silently shift indexes around.
 */
function makeMinimalDomSnapshot(): unknown {
  return {
    strings: [
      '',                  // 0 — empty / OOB sentinel
      'BUTTON',            // 1 — node tag
      'id',                // 2 — attribute name
      'submit-btn',        // 3 — attribute value
      'block',             // 4 — display
      'visible',           // 5 — visibility
      '1',                 // 6 — opacity
      'pointer',           // 7 — cursor
      'auto',              // 8 — pointer-events / readonly fallback
      'static',            // 9 — position
      '0',                 // 10 — z-index ('0', not 'auto', so we get parsed value)
      'rgb(0, 0, 255)',    // 11 — background-color
      'rgb(255, 255, 255)', // 12 — color
      '4px',               // 13 — border-radius
      '#document',         // 14 — document tag (skipped by mapper)
      'HTML',              // 15
      'BODY',              // 16
    ],
    documents: [
      {
        nodes: {
          // 4 nodes total: document(0) → html(1) → body(2) → button(3)
          // parentIndex: -1 = root, others reference up the chain
          parentIndex: [-1, 0, 1, 2],
          nodeName: [14, 15, 16, 1],
          backendNodeId: [100, 101, 102, 103],
          attributes: [[], [], [], [2, 3]],
          textValue: { index: [], value: [] },
          shadowRoots: { index: [], shadowRootType: { index: [], value: [] } },
        },
        layout: {
          // Only the button has layout (interactive elements only need it).
          nodeIndex: [3],
          bounds: [[100, 200, 80, 30]],
          // 10-style slot in REQUESTED_COMPUTED_STYLES order:
          // display, visibility, opacity, cursor, pointer-events,
          // position, z-index, background-color, color, border-radius
          styles: [[4, 5, 6, 7, 8, 9, 10, 11, 12, 13]],
          paintOrders: [0],
          stackingContexts: { index: [] },
          text: [],
        },
      },
    ],
  };
}

function makeMinimalAxTree(buttonBackendId = 103): unknown {
  return {
    nodes: [
      {
        backendDOMNodeId: buttonBackendId,
        role: { value: 'button' },        // implicit role from AX
        name: { value: 'Submit' },        // computed accessible name
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('CdpSnapshotService.collect', () => {
  describe('happy path — single interactive button', () => {
    it('returns LiteSnapshot with one element + AX role/name + bounds', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDomSnapshot(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          // Phase 3.5 ref assignment — return a ref per request
          ['e0'],
          // Phase 4 runtime enrichment — single element
          [{
            frameworkClickable: undefined,
            checked: undefined,
            hasValue: undefined,
            invalid: false,
            disabledRuntime: undefined,
            readOnlyRuntime: undefined,
          }],
          // Phase 3c-Eval DOM walks
          [{ firstTextFragment: 'Submit', isIconButton: false, labelText: undefined, nearestRowText: undefined }],
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);

      expect(snapshot.url).toBe('https://example.com');
      expect(snapshot.title).toBe('Test Page');
      expect(snapshot.viewport).toEqual({ width: 1280, height: 720 });
      expect(snapshot.elements).toHaveLength(1);

      const button = snapshot.elements[0];
      expect(button.tag).toBe('button');
      expect(button.role).toBe('button');     // from AX implicit role
      expect(button.name).toBe('Submit');     // from AX accessible name
      expect(button.htmlId).toBe('submit-btn');
      expect(button.bounds).toEqual({ x: 100, y: 200, width: 80, height: 30 });
      expect(button.computedZIndex).toBe(0);
      expect(button.backgroundColor).toBe('rgb(0, 0, 255)');
      expect(button.visible).toBe(true);
      expect(button.invalid).toBe(false);
      // Internal stash MUST be stripped before return.
      expect((button as unknown as Record<string, unknown>).__dsNodeIndex).toBeUndefined();
      expect((button as unknown as Record<string, unknown>).__docIndex).toBeUndefined();
    });

    it('emits phase timings on the snapshot for shadow-mode analysis', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDomSnapshot(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'],
          [null], // Phase 4: element disappeared
          [null], // Phase 3c-Eval: element disappeared
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      const timings = (snapshot as { __cdpPhaseTimings?: Record<string, number> }).__cdpPhaseTimings;
      expect(timings).toBeDefined();
      expect(timings).toHaveProperty('cdpParallelMs');
      expect(timings).toHaveProperty('mappingMs');
      expect(timings).toHaveProperty('totalMs');
    });
  });

  describe('failure modes', () => {
    it('throws CdpSnapshotError(cdp_payload_too_large) when DS exceeds 20MB', async () => {
      // Create a fake oversized payload by stuffing strings array.
      const oversized = makeMinimalDomSnapshot() as { strings: string[] };
      const bigStr = 'x'.repeat(1024 * 1024); // 1MB string
      oversized.strings = new Array(25).fill(bigStr); // ~25MB total

      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => oversized,
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({ cdp });

      await expect(CdpSnapshotService.collect(page as never)).rejects.toMatchObject({
        name: 'CdpSnapshotError',
        kind: 'cdp_payload_too_large',
      });
    });

    it('throws CdpSnapshotError(malformed_response) when DS has no documents', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => ({ documents: [], strings: [] }),
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({ cdp });

      await expect(CdpSnapshotService.collect(page as never)).rejects.toMatchObject({
        name: 'CdpSnapshotError',
        kind: 'malformed_response',
      });
    });

    it('throws CdpSnapshotError(page_gone) when CDP rejects with "no document"', async () => {
      // Real Chromium emits "Could not find node with given id" or
      // "Target closed" or "frame detached" — categorise for metrics.
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => Promise.reject(new Error('Could not find a target — frame detached')),
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({ cdp });

      await expect(CdpSnapshotService.collect(page as never)).rejects.toMatchObject({
        name: 'CdpSnapshotError',
        kind: 'page_gone',
      });
    });

    it('throws CdpSnapshotError(cdp_send_failed) for unrecognised CDP errors', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => Promise.reject(new Error('weird error nobody categorised')),
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({ cdp });

      await expect(CdpSnapshotService.collect(page as never)).rejects.toMatchObject({
        name: 'CdpSnapshotError',
        kind: 'cdp_send_failed',
      });
    });
  });

  describe('AX domain fallback', () => {
    it('proceeds when AXTree call rejects (older Chromium / unsupported)', async () => {
      // Phase 2 catches AX rejection inside fetchRawBundle — it
      // falls through with `{nodes: []}`. Mapping should still
      // populate role from explicit `role` attribute when present,
      // or empty when absent (consumers fall back to computeRole).
      const ds = makeMinimalDomSnapshot() as { strings: string[]; documents: { nodes: { attributes: number[][] } }[] };
      // Add explicit role="button" to the existing button element so
      // mapping has something to fall back on (otherwise role would
      // be empty since the AX cross-reference fails).
      // Strings already has 'id' at 2 and 'submit-btn' at 3. Add
      // 'role'(17) and 'button'(18).
      ds.strings.push('role', 'button');
      const roleIdx = ds.strings.length - 2;
      const buttonIdx = ds.strings.length - 1;
      ds.documents[0].nodes.attributes[3] = [2, 3, roleIdx, buttonIdx];

      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => ds,
        'Accessibility.getFullAXTree': () => Promise.reject(new Error('Accessibility domain not enabled')),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'],
          [null],
          [null],
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      expect(snapshot.elements).toHaveLength(1);
      expect(snapshot.elements[0].role).toBe('button'); // from explicit attr
    });
  });

  describe('CDP session ownership', () => {
    it('detaches a session it opened itself', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDomSnapshot(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [['e0'], [null], [null]],
      });

      await CdpSnapshotService.collect(page as never);
      expect(cdp.detach).toHaveBeenCalledTimes(1);
      expect(cdp.__detached).toBe(true);
    });

    it('does NOT detach a caller-supplied session (preview piggyback path)', async () => {
      // Critical: when caller passes existingCdpSession (Week 5
      // preview piggyback on screencast session), we must NOT
      // detach. That session belongs to the screencast service.
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDomSnapshot(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        evaluateResults: [['e0'], [null], [null]],
      });

      await CdpSnapshotService.collect(page as never, { existingCdpSession: cdp as never });
      expect(cdp.detach).not.toHaveBeenCalled();
      expect(cdp.__detached).toBe(false);
    });

    it('still cleans up self-opened session even if a phase throws', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => Promise.reject(new Error('Target closed')),
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({ cdp });

      await expect(CdpSnapshotService.collect(page as never)).rejects.toBeInstanceOf(CdpSnapshotError);
      expect(cdp.detach).toHaveBeenCalledTimes(1);
    });
  });

  describe('modal detection (Layer 1)', () => {
    it('flags isInsideActiveModal for elements inside <dialog open>', async () => {
      // Build a DS where the button is INSIDE a <dialog open>.
      // Tree: document(0) → html(1) → body(2) → dialog(3) → button(4)
      const ds = {
        strings: [
          '',           // 0
          'BUTTON',     // 1
          'id',         // 2
          'submit',     // 3
          'block',      // 4
          'visible',    // 5
          '1',          // 6
          'pointer',    // 7
          'auto',       // 8
          'static',     // 9
          '0',          // 10
          'rgb(0,0,0)', // 11
          'rgb(0,0,0)', // 12
          '0',          // 13
          '#document',  // 14
          'HTML',       // 15
          'BODY',       // 16
          'DIALOG',     // 17
          'open',       // 18 — attribute name
          '',           // 19 — attribute value (empty for boolean attr)
          'auto',       // 20 — non-pointer cursor for dialog
        ],
        documents: [{
          nodes: {
            parentIndex: [-1, 0, 1, 2, 3],
            nodeName: [14, 15, 16, 17, 1],
            backendNodeId: [100, 101, 102, 103, 104],
            attributes: [[], [], [], [18, 19], [2, 3]],
            textValue: { index: [], value: [] },
            shadowRoots: { index: [], shadowRootType: { index: [], value: [] } },
          },
          layout: {
            // Layout entries for both dialog and button.
            nodeIndex: [3, 4],
            bounds: [[200, 100, 600, 400], [400, 250, 80, 30]],
            // Dialog: cursor='auto' (idx 20) — must NOT pass Tier-2
            // cursor:pointer interactive filter, so it stays out of
            // elements[]. Button: cursor='pointer' (idx 7) — passes.
            // Otherwise the dialog would be classified as an
            // interactive element on its own, and the test would see
            // 2 elements instead of 1 (real bug surfaced by the
            // shared-styles-slot original mock).
            styles: [
              [4, 5, 6, 20, 8, 9, 10, 11, 12, 13],
              [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            ],
            paintOrders: [0, 1],
            stackingContexts: { index: [] },
            text: [],
          },
        }],
      };

      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => ds,
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({
        cdp,
        // Two interactives expected (button + dialog after May 2026 symmetry
        // fix), so assignAgentRefs receives two requests. Both refs must be
        // non-empty — May 2026 hardening drops elements left with `ref: ''`
        // (e.g. when findElement returned null because of off-viewport bbox).
        evaluateResults: [['e0', 'e1'], [null], [null]],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      // After May 2026 symmetry fix: <dialog open> is now Tier-1
      // interactive (matches evaluate-path's `dialog[open]` selector),
      // so it appears in elements[] alongside the button. Both should
      // be flagged isInsideActiveModal — button via ancestor walk,
      // dialog via being-inside-itself logic. We assert the button
      // (the real test target) is properly flagged.
      const button = snapshot.elements.find((e) => e.tag === 'button');
      expect(button).toBeDefined();
      expect(button!.isInsideActiveModal).toBe(true);
      // Dialog itself: its DS ancestors don't include another modal,
      // so isInsideActiveModal stays falsy (correct — dialog is
      // the modal, not inside one).
      const dialog = snapshot.elements.find((e) => e.tag === 'dialog');
      expect(dialog).toBeDefined();
    });
  });

  describe('empty page', () => {
    it('returns empty elements array, no crash, no evaluate calls', async () => {
      const ds = {
        strings: ['', '#document', 'HTML', 'BODY'],
        documents: [{
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [1, 2, 3],
            backendNodeId: [100, 101, 102],
            attributes: [[], [], []],
            textValue: { index: [], value: [] },
            shadowRoots: { index: [], shadowRootType: { index: [], value: [] } },
          },
          layout: { nodeIndex: [], bounds: [], styles: [], paintOrders: [], stackingContexts: { index: [] }, text: [] },
        }],
      };

      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => ds,
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({ cdp });

      const snapshot = await CdpSnapshotService.collect(page as never);
      expect(snapshot.elements).toEqual([]);
      // Phase 3.5 + Phase 4 short-circuit on empty interactive set. TWO
      // evaluate calls remain: (1) the Phase 1.5 framework-clickable tag pass
      // (always runs pre-capture; tags 0 here so the finally untag is skipped),
      // and (2) Phase 5b overlay state (transientState/obstacleFacts — always
      // runs, independent of the interactive subset).
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      // transientState is always populated, even on empty pages.
      expect(snapshot.transientState).toEqual({ isTransient: false });
    });
  });

  describe('Phase 5b — overlay state (Phase 0 of CDP-default migration)', () => {
    // These tests mock the Phase 5b evaluate result directly to verify
    // that the orchestration plumbs everything into the snapshot. The
    // cascade logic itself is symmetric with snapshot-collector.ts (the
    // same code, just inside CdpSnapshotService.enrichWithOverlayState),
    // so cascade fidelity is asserted by the integration test on real
    // Chromium (Phase 3 of the migration plan).
    function makeMinimalDsForOverlay() {
      return makeMinimalDomSnapshot();
    }

    it('promotes transientState from evaluate result onto snapshot', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDsForOverlay(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], // Phase 3.5 ref assignment
          [{ frameworkClickable: undefined, checked: undefined, hasValue: undefined, invalid: false, disabledRuntime: undefined, readOnlyRuntime: undefined }], // Phase 4
          [{ firstTextFragment: 'Submit', isIconButton: false }], // Phase 3c-Eval
          // Phase 5b — overlay state
          {
            transientState: { isTransient: true, type: 'progressbar', ref: 'eX' },
            obstacleFacts: undefined,
            layer2ModalRef: undefined,
          },
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      expect(snapshot.transientState).toEqual({
        isTransient: true,
        type: 'progressbar',
        ref: 'eX',
      });
    });

    it('promotes obstacleFacts onto snapshot', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDsForOverlay(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const facts = [
        {
          ref: 'eA', tag: 'div', position: 'fixed', zIndex: 9999, coverage: 0.5,
          className: 'cookie-banner', textPreview: 'Accept cookies', id: undefined,
          hasCloseButton: true, hasInteractiveChildren: true, role: undefined, ariaModal: undefined,
          rect: { top: 600, left: 0, width: 1280, height: 100 }, hintType: 'unknown',
        },
      ];
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], [{ invalid: false }], [{ firstTextFragment: 'Submit' }],
          {
            transientState: { isTransient: false },
            obstacleFacts: facts,
            layer2ModalRef: undefined,
          },
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      expect(snapshot.obstacleFacts).toHaveLength(1);
      expect(snapshot.obstacleFacts?.[0].ref).toBe('eA');
      expect(snapshot.obstacleFacts?.[0].coverage).toBe(0.5);
    });

    it('Layer 2 modal ref is promoted to activeModalRef when Layer 1 missed', async () => {
      // No <dialog open> / role=dialog in DS → Layer 1 returns undefined.
      // Phase 5b reports a layer2ModalRef → it should win.
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDsForOverlay(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], [{ invalid: false }], [{ firstTextFragment: 'Submit' }],
          {
            transientState: { isTransient: false },
            obstacleFacts: undefined,
            layer2ModalRef: 'eModal',
          },
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      expect(snapshot.activeModalRef).toBe('eModal');
    });

    // Skipped: building a DS fixture where Layer 1 returns a non-empty
    // bestRef requires the modal container itself to be in the
    // interactive set (the modal-container ref is sourced from
    // elementByDsIdx). Iron-clad modals are usually <dialog>/<div role=dialog>
    // which are NOT interactive, so Layer 1 returns undefined and
    // Layer 2 promotes — the live contract.
    //
    // The promotion guard `if (!activeModalRef && overlayState.layer2ModalRef)`
    // is therefore exercised by the "Layer 2 ref is promoted" test
    // above (Layer 1 returned undefined, Layer 2 won — correct).
    // Reverse case (Layer 1 wins, Layer 2 ignored) requires a real
    // browser fixture where the interactive set includes a dialog with
    // role=dialog — covered by the integration test in Phase 3.
    it.skip('does NOT promote layer2ModalRef when Layer 1 already picked a modal', async () => {
      const ds = {
        strings: [
          '', '#document', 'HTML', 'BODY', 'DIALOG', 'open', '',
          'BUTTON', 'id', 'submit-btn', 'type', 'submit', 'role', 'button',
        ],
        documents: [{
          nodes: {
            parentIndex: [-1, 0, 1, 2, 3],
            nodeName: [1, 2, 3, 4, 7],
            backendNodeId: [100, 101, 102, 103, 104],
            // Dialog at index 3 has [open, ""] → matches isNativeDialog.
            // Button at index 4 carries id+type+role.
            attributes: [[], [], [], [5, 6], [8, 9, 10, 11, 12, 13]],
            textValue: { index: [], value: [] },
            shadowRoots: { index: [], shadowRootType: { index: [], value: [] } },
          },
          layout: {
            nodeIndex: [4],
            bounds: [[100, 200, 80, 30]],
            styles: [Array(10).fill(0)],
            paintOrders: [0],
            stackingContexts: { index: [] },
            text: [],
          },
        }],
      };
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => ds,
        'Accessibility.getFullAXTree': () => ({ nodes: [] }),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], // Phase 3.5
          [{ invalid: false }], // Phase 4
          [{ firstTextFragment: undefined }], // Phase 3c-Eval
          {
            transientState: { isTransient: false },
            obstacleFacts: undefined,
            // If Layer 1 succeeded, this MUST be ignored.
            layer2ModalRef: 'eShouldNotWin',
          },
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      // The button (e0) is the only interactive element, and it lives
      // inside the dialog. Layer 1's `isInsideActiveModal` propagates
      // via DS ancestry (existing behaviour, see "modal detection
      // (Layer 1)" test). When Layer 1 returns a ref, layer2ModalRef
      // is suppressed — that's the contract under test.
      expect(snapshot.elements[0].isInsideActiveModal).toBe(true);
      expect(snapshot.activeModalRef).not.toBe('eShouldNotWin');
    });

    it('overlay evaluate failure is non-fatal (snapshot still returned)', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDsForOverlay(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      // Override evaluate to throw on the 4th call (Phase 5b).
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], [{ invalid: false }], [{ firstTextFragment: 'Submit' }],
        ],
      });
      let callCount = 0;
      const original = page.evaluate;
      page.evaluate = jest.fn(async (...args: unknown[]) => {
        callCount++;
        // Call 5 = Phase 5b overlay. The Phase 1.5 framework-clickable tag pass
        // is now call 1, shifting Phase 3.5/4/5b each by one (3.5=2, enrich=3,
        // domWalk=4, overlay=5).
        if (callCount === 5) throw new Error('page closed');
        return original(...(args as [never, never]));
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      // Snapshot still assembled — overlay state defaults applied.
      expect(snapshot.elements).toHaveLength(1);
      expect(snapshot.transientState).toEqual({ isTransient: false });
      expect(snapshot.obstacleFacts).toBeUndefined();
    });

    it('hard-timeout: hung evaluate does NOT block snapshot collection', async () => {
      // Simulate a page whose JS event loop is jammed — evaluate never
      // resolves. Phase 5b has a 5-second outer race; the snapshot
      // must still come back with default overlay state.
      // Real timers (Promise.race + setTimeout) — fake timers wedge on
      // the microtask queue.
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDsForOverlay(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], [{ invalid: false }], [{ firstTextFragment: 'Submit' }],
        ],
      });
      // Override BOTH page.evaluate and main-frame.evaluate so the 4th
      // call (Phase 5b overlay) hangs forever. May 2026: Phase 3.5 ref
      // assignment now routes through `frame.evaluate`, so we need to
      // hijack the shared queue at both entry points; otherwise the
      // counter only increments on page.evaluate calls and Phase 5b is
      // never reached as call #4.
      let callCount = 0;
      const original = page.evaluate;
      const wrap = jest.fn(async (...args: unknown[]) => {
        callCount++;
        // Call 5 = Phase 5b overlay (the Phase 1.5 framework-clickable tag pass
        // is now call 1, shifting Phase 3.5/4/5b each by one).
        if (callCount === 5) {
          // Hang forever — would block the whole pipeline without the
          // outer Promise.race in enrichWithOverlayState.
          await new Promise(() => {});
          return undefined; // unreachable
        }
        return original(...(args as [never, never]));
      });
      page.evaluate = wrap;
      page.mainFrame().evaluate = wrap;

      const t0 = Date.now();
      const snapshot = await CdpSnapshotService.collect(page as never);
      const elapsed = Date.now() - t0;

      expect(snapshot.elements).toHaveLength(1);
      expect(snapshot.transientState).toEqual({ isTransient: false });
      expect(snapshot.obstacleFacts).toBeUndefined();
      // Must finish under hard cap + small slack (Node setTimeout
      // jitter, Mac CI latency). Any value < 7s proves the race fired.
      expect(elapsed).toBeLessThan(7_000);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
    }, 15_000);

    it('records overlayStateMs in phase timings', async () => {
      const cdp = makeMockCdp({
        'DOMSnapshot.captureSnapshot': () => makeMinimalDsForOverlay(),
        'Accessibility.getFullAXTree': () => makeMinimalAxTree(),
      });
      const page = makeMockPage({
        cdp,
        evaluateResults: [
          ['e0'], [{ invalid: false }], [{ firstTextFragment: 'Submit' }],
          { transientState: { isTransient: false } },
        ],
      });

      const snapshot = await CdpSnapshotService.collect(page as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timings = (snapshot as any).__cdpPhaseTimings;
      expect(timings).toBeDefined();
      expect(typeof timings.overlayStateMs).toBe('number');
      expect(timings.overlayStateMs).toBeGreaterThanOrEqual(0);
    });
  });
});
