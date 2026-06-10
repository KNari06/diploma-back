/**
 * Unit tests for per-step screenshot encoding (encodeStepScreenshot).
 * Exercises the real sharp pipeline (tiny image, fast) + the resilience
 * fallback when sharp can't decode the input.
 */

// Drive format/quality deterministically instead of relying on env defaults.
let mockFormat: 'webp' | 'jpeg' = 'webp';
jest.mock('@/config/features/screenshot-capture', () => ({
  ScreenshotCaptureFeature: {
    getFormat: () => mockFormat,
    getQuality: () => 70,
  },
}));

// The module imports supabaseAdmin at load; encodeStepScreenshot never calls it.
jest.mock('@/db/supabase', () => ({ supabaseAdmin: { storage: {} } }));

import sharp from 'sharp';
import { encodeStepScreenshot } from '../step-screenshot.service';

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

function isWebp(buf: Buffer): boolean {
  // RIFF....WEBP
  return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
}

function isJpeg(buf: Buffer): boolean {
  return buf[0] === 0xff && buf[1] === 0xd8;
}

describe('encodeStepScreenshot', () => {
  it('re-encodes a PNG to WebP when format is webp', async () => {
    mockFormat = 'webp';
    const png = await tinyPng();
    const out = await encodeStepScreenshot(png, 'png');
    expect(out.ext).toBe('webp');
    expect(out.contentType).toBe('image/webp');
    expect(isWebp(out.buffer)).toBe(true);
  });

  it('re-encodes to JPEG when format is jpeg', async () => {
    mockFormat = 'jpeg';
    const png = await tinyPng();
    const out = await encodeStepScreenshot(png, 'png');
    expect(out.ext).toBe('jpg');
    expect(out.contentType).toBe('image/jpeg');
    expect(isJpeg(out.buffer)).toBe(true);
  });

  it('falls back to the raw buffer (tagged by sourceExt) when sharp cannot decode', async () => {
    mockFormat = 'webp';
    const garbage = Buffer.from('this is not an image');
    const out = await encodeStepScreenshot(garbage, 'jpg');
    // sharp throws → raw passthrough, never throws out of encodeStepScreenshot
    expect(out.buffer).toBe(garbage);
    expect(out.ext).toBe('jpg');
    expect(out.contentType).toBe('image/jpeg');
  });
});
