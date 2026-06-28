// Mock the service module so we don't pull in its heavy deps — we only need the
// two upload constants the mapper references for its error strings.
jest.mock('@/services/mobile/mobile-app.service', () => ({
  MAX_UPLOAD_SIZE_BYTES: 100 * 1024 * 1024, // 100 MB
  ALLOWED_UPLOAD_EXTENSIONS: ['.apk', '.aab', '.ipa'],
}));

import { sendMobileRunnerError, sendMobileAppError } from '../mobile-error-mapper';

const MB = 1024 * 1024;

/** Minimal Express Response double that records what was sent. */
function makeRes(headersSent = false) {
  const res: any = {
    headersSent,
    statusCode: undefined as number | undefined,
    body: undefined as any,
    written: [] as string[],
    ended: false,
  };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((b: any) => {
    res.body = b;
    return res;
  });
  res.write = jest.fn((s: string) => {
    res.written.push(s);
    return true;
  });
  res.end = jest.fn(() => {
    res.ended = true;
    return res;
  });
  return res;
}

describe('sendMobileRunnerError', () => {
  it('puts the real error message in `error` and defaults the status to 500', () => {
    const res = makeRes();
    sendMobileRunnerError(res, new Error('Gemini exploded'), 'Apply failed');
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false, error: 'Gemini exploded', message: 'Gemini exploded' });
  });

  it('forwards a runner statusCode (>=400) and typed code', () => {
    const res = makeRes();
    const err = Object.assign(new Error('upstream 503'), { statusCode: 503, code: 'UPSTREAM_UNAVAILABLE' });
    sendMobileRunnerError(res, err, 'fallback');
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('maps a reclaimed session to a typed 410 SESSION_EXPIRED', () => {
    const res = makeRes();
    const err = Object.assign(new Error('session not found'), { statusCode: 404 });
    sendMobileRunnerError(res, err, 'fallback');
    expect(res.statusCode).toBe(410);
    expect(res.body).toMatchObject({ code: 'SESSION_EXPIRED', error: 'Session expired' });
  });

  it('treats a non-session 404 as a normal 404', () => {
    const res = makeRes();
    const err = Object.assign(new Error('thing missing'), { statusCode: 404 });
    sendMobileRunnerError(res, err, 'fallback');
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('thing missing');
  });

  it('stringifies a non-Error throw', () => {
    const res = makeRes();
    sendMobileRunnerError(res, 'raw failure', 'fallback');
    expect(res.body.error).toBe('raw failure');
  });

  it('uses the fallback when the error has no message', () => {
    const res = makeRes();
    sendMobileRunnerError(res, new Error(''), 'Apply failed');
    expect(res.body.error).toBe('Apply failed');
  });

  it('omits the code key when the runner error has none', () => {
    const res = makeRes();
    sendMobileRunnerError(res, new Error('x'), 'fb');
    expect(res.body).not.toHaveProperty('code');
  });

  it('writes a terminal NDJSON error line when headers were already sent', () => {
    const res = makeRes(true);
    const err = Object.assign(new Error('mid-stream boom'), { code: 'STREAM_ERR' });
    sendMobileRunnerError(res, err, 'fallback');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.ended).toBe(true);
    const line = JSON.parse(res.written[0].trim());
    expect(line).toEqual({ type: 'error', error: 'mid-stream boom', code: 'STREAM_ERR' });
  });
});

describe('sendMobileAppError', () => {
  const send = (err: Record<string, unknown>) => {
    const res = makeRes();
    sendMobileAppError(res, err as any);
    return res;
  };

  it('maps project_not_found to 404', () => {
    const res = send({ kind: 'project_not_found' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain('Project not found');
  });

  it('maps invalid_filename to 400 listing the extension and allowed types', () => {
    const res = send({ kind: 'invalid_filename', ext: '.exe' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('.exe');
    expect(res.body.error).toContain('.apk, .aab, .ipa');
  });

  it('maps file_too_large (uploaded) to 413 with MB formatting', () => {
    const res = send({ kind: 'file_too_large', source: 'uploaded', sizeBytes: 150 * MB });
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toContain('150.0 MB');
    expect(res.body.error).toContain('Max: 100 MB');
  });

  it('maps file_too_large (declared) to 413 with the declared wording', () => {
    const res = send({ kind: 'file_too_large', source: 'declared', sizeBytes: 120.5 * MB });
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toContain('Maximum size is 100MB');
    expect(res.body.error).toContain('declared 120.5MB');
  });

  it('maps invalid_storage_path to 400', () => {
    expect(send({ kind: 'invalid_storage_path' }).statusCode).toBe(400);
  });

  it('maps object_missing to 404', () => {
    expect(send({ kind: 'object_missing' }).statusCode).toBe(404);
  });

  it('maps object_empty to 400', () => {
    expect(send({ kind: 'object_empty' }).statusCode).toBe(400);
  });

  it('maps package_name_required to 400', () => {
    const res = send({ kind: 'package_name_required' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('packageName is required');
  });

  it('maps build_record_failed (duplicate commit, 23505) to 409', () => {
    const res = send({ kind: 'build_record_failed', code: '23505' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain('already exists');
  });

  it('maps build_record_failed (non-duplicate db error) to 500 with the real reason', () => {
    const res = send({ kind: 'build_record_failed', code: '42703', message: 'column missing' });
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain('column missing');
  });

  it('maps app_not_uploaded to 404', () => {
    expect(send({ kind: 'app_not_uploaded' }).statusCode).toBe(404);
  });

  it('treats no_app_to_delete as an idempotent 200 with a platform-aware message', () => {
    const withPlatform = send({ kind: 'no_app_to_delete', platform: 'android' });
    expect(withPlatform.statusCode).toBeUndefined(); // res.json() called directly, no status()
    expect(withPlatform.body).toEqual({ success: true, message: 'No android app to delete' });

    const noPlatform = send({ kind: 'no_app_to_delete' });
    expect(noPlatform.body.message).toBe('No app to delete');
  });
});
