import { getPreviewSessionService } from '../preview-session.service';

describe('PreviewSessionService recording state', () => {
  it('clears typing and drag state when recording is disabled', () => {
    const service = getPreviewSessionService() as any;
    const sessions: Map<string, any> = service.sessions;

    const sessionId = 'test-session';
    const userId = 'test-user';
    sessions.set(sessionId, {
      id: sessionId,
      userId,
      lastSeenAt: Date.now(),
      recording: true,
      recordingTypingBuffer: { text: 'abc', elementLabel: 'input', lastCharAt: Date.now() },
      recordingDragState: { startX: 1, startY: 2, startElement: null, startedAt: Date.now() },
    });

    const changed = service.setRecording(sessionId, userId, false);
    expect(changed).toBe(true);

    const updated = sessions.get(sessionId);
    expect(updated.recording).toBe(false);
    expect(updated.recordingTypingBuffer).toBeNull();
    expect(updated.recordingDragState).toBeNull();

    sessions.delete(sessionId);
  });
});
