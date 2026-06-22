/**
 * Unit tests for the per-step screenshot storage helpers:
 *  - buildStepScreenshotPath (pure path shape — owns the step-screenshots/
 *    + fail/ prefix contract the artifact-retention job depends on)
 *  - uploadStepScreenshotToStorage (empty-buffer guard, error rethrow, URL)
 *  - uploadMobileStepScreenshots (base64→URL, already-URL skip, failure drop)
 */

const uploadMock = jest.fn();
const getPublicUrlMock = jest.fn();

// This module IS the storage data-access layer, so mocking @/db/supabase here
// (not a deeper service) is the correct boundary per testing.md.
jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    storage: { from: jest.fn(() => ({ upload: uploadMock, getPublicUrl: getPublicUrlMock })) },
  },
}));

import {
  buildStepScreenshotPath,
  uploadStepScreenshotToStorage,
  uploadMobileStepScreenshots,
  processAndDeferStepScreenshot,
  decodeBase64Screenshot,
} from '../step-screenshot.service';

describe('decodeBase64Screenshot', () => {
  // A 1x1 PNG and JPEG, base64-encoded, with their magic-byte prefixes.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgAB';
  const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ=';

  it('treats a bare /9j/-prefixed string as JPEG', () => {
    const { sourceExt } = decodeBase64Screenshot(JPEG_B64);
    expect(sourceExt).toBe('jpg');
  });

  it('treats a bare PNG base64 string as PNG', () => {
    const { sourceExt } = decodeBase64Screenshot(PNG_B64);
    expect(sourceExt).toBe('png');
  });

  it('strips a data: URI prefix and uses its MIME to pick the format', () => {
    const jpeg = decodeBase64Screenshot(`data:image/jpeg;base64,${JPEG_B64}`);
    const png = decodeBase64Screenshot(`data:image/png;base64,${PNG_B64}`);
    expect(jpeg.sourceExt).toBe('jpg');
    expect(png.sourceExt).toBe('png');
    // The prefix is stripped before decoding — the buffer matches the bare form.
    expect(jpeg.buffer.equals(Buffer.from(JPEG_B64, 'base64'))).toBe(true);
    expect(png.buffer.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });
});

describe('buildStepScreenshotPath', () => {
  it('places passing-step shots under step-screenshots/<testId>/', () => {
    expect(buildStepScreenshotPath('u1', 't1', 3, 'webp', false, 123)).toBe(
      'u1/step-screenshots/t1/step-3-123.webp',
    );
  });

  it('places failure-step shots under a fail/ subfolder', () => {
    expect(buildStepScreenshotPath('u1', 't1', 3, 'webp', true, 123)).toBe(
      'u1/step-screenshots/t1/fail/step-3-123.webp',
    );
  });

  it('honors the extension and never uses the screenshots/ prefix (reserved for final/bug shots)', () => {
    const p = buildStepScreenshotPath('u1', 't1', 0, 'jpg', false, 9);
    expect(p.endsWith('.jpg')).toBe(true);
    expect(p.startsWith('u1/step-screenshots/')).toBe(true);
    expect(p).not.toContain('/screenshots/');
  });
});

describe('uploadStepScreenshotToStorage', () => {
  const opts = {
    testId: 't1',
    userId: 'u1',
    stepIndex: 1,
    ext: 'webp' as const,
    contentType: 'image/webp',
    ts: 1,
  };

  beforeEach(() => {
    uploadMock.mockReset();
    getPublicUrlMock.mockReset();
  });

  it('throws without calling upload when the buffer is empty', async () => {
    await expect(uploadStepScreenshotToStorage(Buffer.alloc(0), opts)).rejects.toThrow('empty');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rethrows with the Supabase error message on upload failure', async () => {
    uploadMock.mockResolvedValue({ error: { message: 'boom' } });
    await expect(uploadStepScreenshotToStorage(Buffer.from('x'), opts)).rejects.toThrow('boom');
  });

  it('returns the public URL on success', async () => {
    uploadMock.mockResolvedValue({ error: null });
    getPublicUrlMock.mockReturnValue({ data: { publicUrl: 'https://cdn/u1/step.webp' } });
    await expect(uploadStepScreenshotToStorage(Buffer.from('x'), opts)).resolves.toBe(
      'https://cdn/u1/step.webp',
    );
  });
});

describe('processAndDeferStepScreenshot (web fire-and-forget)', () => {
  const opts = { testId: 't1', userId: 'u1', stepIndex: 2, ts: 7 };

  beforeEach(() => {
    uploadMock.mockReset();
    getPublicUrlMock.mockReset();
    getPublicUrlMock.mockReturnValue({ data: { publicUrl: 'https://cdn/u1/step-2-7.jpg' } });
  });

  it('returns the deterministic public URL without awaiting the upload', async () => {
    // Upload never resolves — a blocking impl would hang; the deferred impl must
    // still return the URL immediately.
    uploadMock.mockReturnValue(new Promise(() => {}));
    await expect(processAndDeferStepScreenshot(Buffer.from('x'), 'jpg', opts)).resolves.toBe(
      'https://cdn/u1/step-2-7.jpg',
    );
  });

  it('still returns the URL and never throws when the upload rejects', async () => {
    uploadMock.mockResolvedValue({ error: { message: 'boom' } });
    await expect(processAndDeferStepScreenshot(Buffer.from('x'), 'jpg', opts)).resolves.toBe(
      'https://cdn/u1/step-2-7.jpg',
    );
  });
});

describe('uploadMobileStepScreenshots', () => {
  const uploader = jest.fn();
  const makeStep = (over: any) => ({ stepId: 's', success: true, durationMs: 1, ...over });

  beforeEach(() => uploader.mockReset());

  it('leaves an already-uploaded URL untouched', async () => {
    const steps: any[] = [makeStep({ screenshot: 'https://cdn/x.webp' })];
    await uploadMobileStepScreenshots(steps, 't1', 'u1', uploader as any);
    expect(steps[0].screenshot).toBe('https://cdn/x.webp');
    expect(uploader).not.toHaveBeenCalled();
  });

  it('replaces a base64 PNG screenshot with the uploaded URL', async () => {
    uploader.mockResolvedValue('https://cdn/step-1.webp');
    const steps: any[] = [makeStep({ screenshot: 'data:image/png;base64,AAAA' })];
    await uploadMobileStepScreenshots(steps, 't1', 'u1', uploader as any);
    expect(uploader).toHaveBeenCalledWith(
      expect.any(Buffer),
      'png',
      expect.objectContaining({ testId: 't1', stepIndex: 1, isFailure: false }),
    );
    expect(steps[0].screenshot).toBe('https://cdn/step-1.webp');
  });

  it('detects jpeg base64 and marks a failed step', async () => {
    uploader.mockResolvedValue('https://cdn/step-1.webp');
    const steps: any[] = [makeStep({ success: false, screenshot: 'data:image/jpeg;base64,/9j/AAAA' })];
    await uploadMobileStepScreenshots(steps, 't1', 'u1', uploader as any);
    expect(uploader).toHaveBeenCalledWith(
      expect.any(Buffer),
      'jpg',
      expect.objectContaining({ isFailure: true }),
    );
  });

  it('drops the screenshot to undefined when the uploader throws — never base64, never throws', async () => {
    uploader.mockRejectedValue(new Error('upload failed'));
    const steps: any[] = [makeStep({ screenshot: 'data:image/png;base64,AAAA' })];
    await expect(uploadMobileStepScreenshots(steps, 't1', 'u1', uploader as any)).resolves.toBeUndefined();
    expect(steps[0].screenshot).toBeUndefined();
  });
});
