/**
 * Tests for find-trace-file — filename matching and most-recent selection.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  findTraceFile,
  listTraceFiles,
  sanitizeTestId,
} from '../find-trace-file';

/** Create an isolated tmp dir for each test; clean up after. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lite-analyze-test-'));
}

async function writeTraceFile(dir: string, name: string, mtimeOffsetMs = 0): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, '{"ts":"2026-04-08T12:00:00.000Z","testId":"x","eventType":"run_start","stage":"init","payload":{}}\n');
  if (mtimeOffsetMs !== 0) {
    const when = new Date(Date.now() + mtimeOffsetMs);
    await fs.utimes(p, when, when);
  }
  return p;
}

describe('sanitizeTestId', () => {
  it('keeps alphanumeric chars, underscores and dashes', () => {
    expect(sanitizeTestId('abc-123_xyz')).toBe('abc-123_xyz');
  });

  it('replaces special chars with underscores', () => {
    expect(sanitizeTestId('foo@bar.com')).toBe('foo_bar_com');
    expect(sanitizeTestId('a/b/c')).toBe('a_b_c');
    expect(sanitizeTestId('uuid-with-dots.123')).toBe('uuid-with-dots_123');
  });

  it('caps length at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(sanitizeTestId(long).length).toBe(80);
  });

  it('falls back to "unknown" for empty input', () => {
    expect(sanitizeTestId('')).toBe('unknown');
    expect(sanitizeTestId(undefined as unknown as string)).toBe('unknown');
  });
});

describe('findTraceFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = await findTraceFile('any-id', missing);
    expect(result).toBeNull();
  });

  it('returns null when no files match the testId', async () => {
    await writeTraceFile(tmpDir, '2026-04-08_12-00-00_otherTest.jsonl');
    const result = await findTraceFile('mytest', tmpDir);
    expect(result).toBeNull();
  });

  it('finds a file by exact testId substring', async () => {
    const name = '2026-04-08_12-00-00_mytest_abc.jsonl';
    await writeTraceFile(tmpDir, name);
    const result = await findTraceFile('mytest_abc', tmpDir);
    expect(result).not.toBeNull();
    expect(path.basename(result!)).toBe(name);
  });

  it('finds a file via sanitized testId (uuid with dashes)', async () => {
    // uuid is kept as-is by sanitizer (letters + digits + dashes)
    const uuid = 'abc-123-def-456';
    const name = `2026-04-08_12-00-00_${uuid}.jsonl`;
    await writeTraceFile(tmpDir, name);
    const result = await findTraceFile(uuid, tmpDir);
    expect(result).not.toBeNull();
  });

  it('finds a file via sanitized testId (special chars replaced)', async () => {
    // foo@bar.com sanitizes to foo_bar_com
    const name = '2026-04-08_12-00-00_foo_bar_com.jsonl';
    await writeTraceFile(tmpDir, name);
    const result = await findTraceFile('foo@bar.com', tmpDir);
    expect(result).not.toBeNull();
  });

  it('prefers the most recently modified file when multiple match', async () => {
    const older = '2026-04-01_10-00-00_mytest.jsonl';
    const newer = '2026-04-08_12-00-00_mytest.jsonl';
    await writeTraceFile(tmpDir, older, -3600_000); // 1h ago
    await writeTraceFile(tmpDir, newer, 0); // now
    const result = await findTraceFile('mytest', tmpDir);
    expect(result).not.toBeNull();
    expect(path.basename(result!)).toBe(newer);
  });

  it('ignores non-jsonl files', async () => {
    await fs.writeFile(path.join(tmpDir, 'mytest.txt'), 'not a trace');
    const result = await findTraceFile('mytest', tmpDir);
    expect(result).toBeNull();
  });

  it('throws on empty testId', async () => {
    await expect(findTraceFile('', tmpDir)).rejects.toThrow('testId is required');
  });

  it('finds a trace inside a subdirectory (e.g. chat_test/)', async () => {
    const subdir = path.join(tmpDir, 'chat_test');
    await fs.mkdir(subdir);
    const name = '2026-04-08_12-00-00_chat_test_sess-abc.jsonl';
    await writeTraceFile(subdir, name);
    const result = await findTraceFile('chat_test_sess-abc', tmpDir);
    expect(result).not.toBeNull();
    expect(path.basename(result!)).toBe(name);
  });

  it('prefers the most recent match across root and subdirectories', async () => {
    const subdir = path.join(tmpDir, 'chat_test');
    await fs.mkdir(subdir);
    const rootOlder = '2026-04-01_10-00-00_mytest.jsonl';
    const nestedNewer = '2026-04-08_12-00-00_mytest.jsonl';
    await writeTraceFile(tmpDir, rootOlder, -3600_000); // 1h ago
    await writeTraceFile(subdir, nestedNewer, 0); // now
    const result = await findTraceFile('mytest', tmpDir);
    expect(result).not.toBeNull();
    expect(path.basename(result!)).toBe(nestedNewer);
  });
});

describe('listTraceFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(await listTraceFiles(missing)).toEqual([]);
  });

  it('returns empty array when directory has no jsonl files', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.md'), 'nothing');
    expect(await listTraceFiles(tmpDir)).toEqual([]);
  });

  it('lists jsonl files most recent first', async () => {
    await writeTraceFile(tmpDir, 'a.jsonl', -3600_000);
    await writeTraceFile(tmpDir, 'b.jsonl', 0);
    await writeTraceFile(tmpDir, 'c.jsonl', -1800_000);
    const result = await listTraceFiles(tmpDir);
    expect(result).toHaveLength(3);
    expect(path.basename(result[0].path)).toBe('b.jsonl');
    expect(path.basename(result[1].path)).toBe('c.jsonl');
    expect(path.basename(result[2].path)).toBe('a.jsonl');
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await writeTraceFile(tmpDir, `f${i}.jsonl`, -i * 1000);
    }
    const result = await listTraceFiles(tmpDir, 3);
    expect(result).toHaveLength(3);
  });

  it('includes file size in bytes', async () => {
    await writeTraceFile(tmpDir, 'a.jsonl');
    const result = await listTraceFiles(tmpDir);
    expect(result[0].sizeBytes).toBeGreaterThan(0);
  });

  it('includes traces from subdirectories, merged and sorted by recency', async () => {
    const subdir = path.join(tmpDir, 'chat_test');
    await fs.mkdir(subdir);
    await writeTraceFile(tmpDir, 'root.jsonl', -3600_000); // 1h ago
    await writeTraceFile(subdir, 'nested.jsonl', 0); // now
    const result = await listTraceFiles(tmpDir);
    expect(result).toHaveLength(2);
    expect(path.basename(result[0].path)).toBe('nested.jsonl');
    expect(path.basename(result[1].path)).toBe('root.jsonl');
  });
});
