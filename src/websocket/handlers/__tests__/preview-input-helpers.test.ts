import {
  validateInputRequest,
  emitInputError,
  emitInputSuccess,
} from '../preview-input-helpers';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fakeSocket() {
  return { emit: jest.fn() } as any;
}

describe('validateInputRequest', () => {
  it('returns the trimmed previewSessionId for a valid request', () => {
    expect(validateInputRequest({ previewSessionId: '  sess-1  ' }, 'sock', 'user')).toBe('sess-1');
  });

  it('returns null when previewSessionId is missing', () => {
    expect(validateInputRequest({}, 'sock', 'user')).toBeNull();
  });

  it('returns null for a whitespace-only previewSessionId', () => {
    expect(validateInputRequest({ previewSessionId: '   ' }, 'sock', 'user')).toBeNull();
  });

  it('returns null for a non-string previewSessionId', () => {
    expect(validateInputRequest({ previewSessionId: 123 as any }, 'sock', 'user')).toBeNull();
  });
});

describe('emitInputError', () => {
  it('emits a failure result with the action, error, and an ISO timestamp', () => {
    const socket = fakeSocket();
    emitInputError(socket, 'sess-1', 'click', 'boom');
    expect(socket.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = socket.emit.mock.calls[0];
    expect(event).toBe('preview:mouse:result');
    expect(payload).toMatchObject({
      previewSessionId: 'sess-1',
      success: false,
      action: 'click',
      error: 'boom',
    });
    expect(payload.timestamp).toMatch(ISO);
  });

  it('coerces an undefined previewSessionId to an empty string', () => {
    const socket = fakeSocket();
    emitInputError(socket, undefined, 'click', 'boom');
    expect(socket.emit.mock.calls[0][1].previewSessionId).toBe('');
  });
});

describe('emitInputSuccess', () => {
  it('emits a success result without an error field', () => {
    const socket = fakeSocket();
    emitInputSuccess(socket, 'sess-2', 'wheel');
    const [event, payload] = socket.emit.mock.calls[0];
    expect(event).toBe('preview:mouse:result');
    expect(payload).toMatchObject({ previewSessionId: 'sess-2', success: true, action: 'wheel' });
    expect(payload.error).toBeUndefined();
    expect(payload.timestamp).toMatch(ISO);
  });
});
