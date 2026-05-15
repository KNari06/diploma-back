/**
 * Phase 2.5 leak-coverage: replay-trace JSONL must never contain a
 * `secrets.*` value in plaintext, including JSON-escaped form for
 * payloads with special characters.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { ReplayTraceWriter } from '../replay-trace-writer';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replay-trace-redact-'));
}

async function flush(writer: ReplayTraceWriter): Promise<void> {
  // The writer queues fs.appendFile via promise chain; allow microtasks
  // and a tick for the kernel.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await writer.close();
}

function readAll(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('ReplayTraceWriter — redactValues', () => {
  it('does not write the raw secret value to disk', async () => {
    const dir = tmpDir();
    const w = new ReplayTraceWriter({ testId: 'leak', logsDir: dir });
    w.setRedactValues(['sk_test_LEAK_LONG_VALUE']);
    w.write({
      eventType: 'step_completed',
      step: 1,
      totalSteps: 1,
      payload: { value: 'Bearer sk_test_LEAK_LONG_VALUE', other: 'safe' },
    });
    await flush(w);
    const contents = readAll(w.getFilePath());
    expect(contents).not.toContain('sk_test_LEAK_LONG_VALUE');
    expect(contents).toContain('***');
    expect(contents).toContain('"other":"safe"');
  });

  it('redacts JSON-escaped form when the secret contains a quote', async () => {
    const dir = tmpDir();
    const w = new ReplayTraceWriter({ testId: 'leak', logsDir: dir });
    // JSON.stringify of `pwd"with"quotes` is "pwd\"with\"quotes".
    const secret = 'pwd"with"quotes';
    w.setRedactValues([secret]);
    w.write({
      eventType: 'step_completed',
      step: 1,
      totalSteps: 1,
      payload: { value: secret },
    });
    await flush(w);
    const contents = readAll(w.getFilePath());
    expect(contents).not.toContain(secret);
    // Also the escaped form should not survive verbatim.
    expect(contents).not.toContain('pwd\\"with\\"quotes');
    expect(contents).toContain('***');
  });

  it('drops too-short secrets (< 4 chars) — same threshold as redact-secrets', async () => {
    const dir = tmpDir();
    const w = new ReplayTraceWriter({ testId: 'leak', logsDir: dir });
    w.setRedactValues(['ab']); // too short, must be ignored
    w.write({
      eventType: 'step_completed',
      step: 1,
      totalSteps: 1,
      payload: { value: 'no real secret here, just letter ab in a sentence' },
    });
    await flush(w);
    const contents = readAll(w.getFilePath());
    // 'ab' is not redacted — would be a false positive on every log line.
    expect(contents).toContain('letter ab in a sentence');
  });

  it('is a no-op when setRedactValues is called with empty array', async () => {
    const dir = tmpDir();
    const w = new ReplayTraceWriter({ testId: 'leak', logsDir: dir });
    w.setRedactValues([]);
    w.write({
      eventType: 'step_completed',
      step: 1,
      totalSteps: 1,
      payload: { value: 'sk_LIVE_xxx' },
    });
    await flush(w);
    const contents = readAll(w.getFilePath());
    expect(contents).toContain('sk_LIVE_xxx');
  });

  it('long-first ordering masks longer secrets entirely when one contains another', async () => {
    const dir = tmpDir();
    const w = new ReplayTraceWriter({ testId: 'leak', logsDir: dir });
    w.setRedactValues(['abcd', 'abcdEFGH']);
    w.write({
      eventType: 'step_completed',
      step: 1,
      totalSteps: 1,
      payload: { value: 'token=abcdEFGH' },
    });
    await flush(w);
    const contents = readAll(w.getFilePath());
    expect(contents).not.toContain('abcdEFGH');
    expect(contents).not.toContain('abcd'); // either form gone
    expect(contents).toContain('***');
  });
});
