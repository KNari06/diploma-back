/**
 * Verifies the CDP→client scroll plumbing: a `Page.screencastFrame` carries
 * `scrollOffsetX/Y` + `pageScaleFactor` in its metadata, and the service must
 * forward those onto the `preview:video:frame` payload so the editor can convert
 * document-relative highlight bboxes to the frame's viewport.
 *
 * Drives the real (private) handleScreencastFrame path with a captured nsp +
 * stubbed CDP session — no live browser.
 */

import { PreviewVideoStreamService } from '../preview-video-stream.service';

type EmittedFrame = { payload: any; frame: unknown };

/** Build a service with a captured nsp + stub CDP session, ready to receive frames. */
function makeStreamingService(): { svc: PreviewVideoStreamService; emitted: EmittedFrame[] } {
  const emitted: EmittedFrame[] = [];
  const svc = new PreviewVideoStreamService('sess-scroll', 'user-1', 'room-1') as any;

  // Minimal nsp: .to(room).volatile.emit(event, payload, frame) captures the frame.
  const sink = {
    volatile: { emit: (_event: string, payload: any, frame: unknown) => { emitted.push({ payload, frame }); } },
    emit: (_event: string, payload: any, frame: unknown) => { emitted.push({ payload, frame }); },
  };
  svc.nsp = { to: () => sink };

  // Stub CDP session so the ACK send() resolves.
  svc.cdpSession = { send: async () => undefined };

  // Put the instance into the streaming state handleScreencastFrame requires.
  svc.isStreaming = true;
  svc.isStopped = false;
  svc.cdpSessionClosed = false;
  svc.lastFrameTime = 0; // ensure the throttle gate passes

  return { svc, emitted };
}

function frameParams(over: Partial<{ scrollOffsetX: number; scrollOffsetY: number; pageScaleFactor: number }> = {}) {
  return {
    // 1x1 white JPEG is unnecessary — any base64 decodes to bytes; use a small valid b64.
    data: Buffer.from('hello').toString('base64'),
    metadata: {
      offsetTop: 0,
      pageScaleFactor: over.pageScaleFactor ?? 1,
      deviceWidth: 1280,
      deviceHeight: 720,
      scrollOffsetX: over.scrollOffsetX ?? 0,
      scrollOffsetY: over.scrollOffsetY ?? 0,
    },
    sessionId: 1,
  };
}

describe('PreviewVideoStreamService — scroll forwarding on preview:video:frame', () => {
  it('forwards scrollOffsetX/Y + pageScaleFactor from screencast metadata to the payload', async () => {
    const { svc, emitted } = makeStreamingService();
    await (svc as any).handleScreencastFrame(frameParams({ scrollOffsetX: 12, scrollOffsetY: 2900, pageScaleFactor: 1 }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.scrollX).toBe(12);
    expect(emitted[0].payload.scrollY).toBe(2900);
    expect(emitted[0].payload.pageScaleFactor).toBe(1);
    // Binary frame bytes ride as the 2nd emit arg.
    expect(emitted[0].frame).toBeInstanceOf(Buffer);
  });

  it('forwards a non-1 pageScaleFactor (pinch-zoom)', async () => {
    const { svc, emitted } = makeStreamingService();
    await (svc as any).handleScreencastFrame(frameParams({ scrollOffsetY: 500, pageScaleFactor: 2 }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.scrollY).toBe(500);
    expect(emitted[0].payload.pageScaleFactor).toBe(2);
  });

  it('carries zero scroll for a top-of-page frame', async () => {
    const { svc, emitted } = makeStreamingService();
    await (svc as any).handleScreencastFrame(frameParams({ scrollOffsetX: 0, scrollOffsetY: 0 }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.scrollX).toBe(0);
    expect(emitted[0].payload.scrollY).toBe(0);
  });
});
