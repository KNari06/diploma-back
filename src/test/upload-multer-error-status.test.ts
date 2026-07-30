/**
 * Regression coverage for oversized / malformed uploads returning 500.
 *
 * `errorHandler` had no `MulterError` branch, so a `LIMIT_FILE_SIZE` from any
 * multer route fell through to the terminal 500 — and because that branch
 * replaces the message with a generic 'Internal server error' when
 * `NODE_ENV === 'production'`, a user uploading a too-large file was told the
 * backend had broken rather than that their file was too big.
 *
 * `chat`, `workspace` and `playwright` catch this inside their own route
 * handlers; `preview/upload-file`, `kb/upload` and `allure-import/upload` never
 * did, so the fix lives in the shared handler and these tests go through a real
 * multer instance over real HTTP to prove the whole path — not just the branch.
 */

import express from 'express';
import multer from 'multer';
import type { AddressInfo } from 'net';
import { errorHandler } from '@/utils/core/error-handler';

const MAX_BYTES = 1024; // stand-in for the real per-route caps

/** Boot a throwaway app whose upload route mirrors the real ones. */
function startApp(upload: express.RequestHandler) {
  const app = express();
  app.post('/upload', upload, (_req, res) => {
    res.status(200).json({ success: true });
  });
  app.use(errorHandler);

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function postFile(baseUrl: string, bytes: number, field = 'file') {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array(bytes)]), 'payload.bin');
  const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('multer upload errors', () => {
  let server: ReturnType<typeof startApp>['server'];
  let baseUrl: string;

  const singleFile = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES },
  }).single('file');

  beforeEach(() => {
    ({ server, baseUrl } = startApp(singleFile));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 400 with a size-specific message when the file exceeds the limit', async () => {
    const { status, body } = await postFile(baseUrl, MAX_BYTES + 1);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('LIMIT_FILE_SIZE');
    expect(String(body.error)).toMatch(/too large/i);
  });

  it('does not report a client-side size error as an internal failure', async () => {
    const { status, body } = await postFile(baseUrl, MAX_BYTES + 1);

    // The regression: 500 + 'Internal server error' told the user the backend broke.
    expect(status).not.toBe(500);
    expect(body.code).not.toBe('INTERNAL_ERROR');
    expect(String(body.error)).not.toMatch(/internal server error/i);
  });

  it('still accepts a file within the limit', async () => {
    // `limits.fileSize` is exclusive — busboy trips as soon as the byte count
    // REACHES the limit (multipart.js: `if (fileSize === fileSizeLimit)`), so a
    // payload of exactly MAX_BYTES is already rejected. Stay one byte under.
    const { status, body } = await postFile(baseUrl, MAX_BYTES - 1);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 400 when the file arrives under an unexpected field name', async () => {
    const { status, body } = await postFile(baseUrl, 10, 'wrongField');

    expect(status).toBe(400);
    expect(body.code).toBe('LIMIT_UNEXPECTED_FILE');
    expect(String(body.error)).toMatch(/unexpected/i);
  });

  it('surfaces the production-safe message even when NODE_ENV is production', async () => {
    // The 500 fallback swaps in a generic message in production; the multer
    // branch must answer before that so the reason survives.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { status, body } = await postFile(baseUrl, MAX_BYTES + 1);
      expect(status).toBe(400);
      expect(String(body.error)).toMatch(/too large/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('returns 400 when more files are sent than the route allows', async () => {
    const { server: s2, baseUrl: url2 } = startApp(
      multer({ storage: multer.memoryStorage(), limits: { files: 1 } }).array('file'),
    );
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(4)]), 'a.bin');
      form.append('file', new Blob([new Uint8Array(4)]), 'b.bin');
      const res = await fetch(`${url2}/upload`, { method: 'POST', body: form });
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(400);
      expect(body.code).toBe('LIMIT_FILE_COUNT');
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });

  it('leaves non-multer failures on the 500 path', async () => {
    const app = express();
    app.post('/boom', (_req, _res, next) => next(new Error('genuine server fault')));
    app.use(errorHandler);
    const s3 = app.listen(0);
    const { port } = s3.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/boom`, { method: 'POST' });
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(500);
      expect(body.code).toBe('INTERNAL_ERROR');
    } finally {
      await new Promise<void>((resolve) => s3.close(() => resolve()));
    }
  });
});
