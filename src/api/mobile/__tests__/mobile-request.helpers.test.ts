import {
  pickPlatform,
  pickPlatformOrUndefined,
  trimmedString,
  parseVersionCode,
  parseContentLength,
  requireUserId,
} from '../mobile-request.helpers';

describe('pickPlatform', () => {
  it.each(['android', 'ios', 'flutter'])('passes through the valid platform %p', (p) => {
    expect(pickPlatform(p)).toBe(p);
  });

  it('defaults to android for an unknown string', () => {
    expect(pickPlatform('windows')).toBe('android');
  });

  it('defaults to android for a non-string', () => {
    expect(pickPlatform(undefined)).toBe('android');
    expect(pickPlatform(123)).toBe('android');
  });

  it('honors a custom fallback', () => {
    expect(pickPlatform('nonsense', 'ios')).toBe('ios');
  });
});

describe('pickPlatformOrUndefined', () => {
  it('returns the valid platform', () => {
    expect(pickPlatformOrUndefined('flutter')).toBe('flutter');
  });

  it('returns undefined for an unknown string or non-string', () => {
    expect(pickPlatformOrUndefined('windows')).toBeUndefined();
    expect(pickPlatformOrUndefined(42)).toBeUndefined();
  });
});

describe('trimmedString', () => {
  it('trims surrounding whitespace', () => {
    expect(trimmedString('  hello  ')).toBe('hello');
  });

  it('returns undefined for empty / whitespace-only / non-string input', () => {
    expect(trimmedString('')).toBeUndefined();
    expect(trimmedString('   ')).toBeUndefined();
    expect(trimmedString(null)).toBeUndefined();
    expect(trimmedString(5)).toBeUndefined();
  });
});

describe('parseVersionCode', () => {
  it.each([
    [5, 5],
    [3.9, 3], // floored
    ['42', 42],
    [' 7 ', 7], // trimmed
  ])('coerces %p → %p', (raw, expected) => {
    expect(parseVersionCode(raw)).toBe(expected);
  });

  it.each([-1, NaN, Infinity, 'abc', '1.5', '', null])('rejects %p → undefined', (raw) => {
    expect(parseVersionCode(raw)).toBeUndefined();
  });
});

describe('parseContentLength', () => {
  it('returns numeric input as-is (including zero)', () => {
    expect(parseContentLength(100)).toBe(100);
    expect(parseContentLength(0)).toBe(0);
  });

  it('parses an all-digit string', () => {
    expect(parseContentLength('2048')).toBe(2048);
  });

  it('returns null for a non-digit string or non-number', () => {
    expect(parseContentLength('12kb')).toBeNull();
    expect(parseContentLength(undefined)).toBeNull();
    expect(parseContentLength(null)).toBeNull();
  });
});

describe('requireUserId', () => {
  const makeRes = () => {
    const res: any = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  it('returns the authenticated user id without touching the response', () => {
    const res = makeRes();
    const userId = requireUserId({ user: { id: 'u1' } } as any, res);
    expect(userId).toBe('u1');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('writes a 401 and returns null when there is no user', () => {
    const res = makeRes();
    const result = requireUserId({} as any, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
  });

  it('writes a 401 when the user id is falsy', () => {
    const res = makeRes();
    expect(requireUserId({ user: { id: '' } } as any, res)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
