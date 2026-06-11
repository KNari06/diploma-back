/**
 * Archive extractor — unpacks .zip / .tar.gz of a Python project into one
 * annotated blob, filtering junk and ordering core source before tests.
 */

import zlib from 'zlib';
import AdmZip from 'adm-zip';
import * as tarStream from 'tar-stream';
import {
  isArchive,
  extractPythonFromArchive,
  normalizeEntryPath,
} from '../archive-extractor';

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content, 'utf-8'));
  }
  return zip.toBuffer();
}

function makeTarGz(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tarStream.pack();
    for (const [path, content] of Object.entries(files)) {
      pack.entry({ name: path }, content);
    }
    pack.finalize();
    const chunks: Buffer[] = [];
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(zlib.gzipSync(Buffer.concat(chunks))));
    pack.on('error', reject);
  });
}

describe('isArchive', () => {
  test.each([
    ['app.zip', undefined, true],
    ['app.tar.gz', undefined, true],
    ['app.tgz', undefined, true],
    ['client.py', undefined, false],
    [undefined, 'application/zip', true],
    [undefined, 'application/gzip', true],
    ['notes.txt', 'text/plain', false],
  ])('isArchive(%s, %s) === %s', (name, mime, expected) => {
    expect(isArchive(name as string | undefined, mime as string | undefined)).toBe(expected);
  });
});

describe('extractPythonFromArchive — zip', () => {
  test('includes real .py, skips junk dirs, orders tests last, adds headers', async () => {
    const buf = makeZip({
      'client.py': 'import requests\ndef get_user(): return requests.get("https://x/u")',
      'tests/test_users.py': 'def test_u(): assert True',
      '__pycache__/client.cpython-311.pyc': 'BINARYJUNK',
      'node_modules/dep/mod.py': 'print("vendored")',
      'README.md': '# not python',
    });

    const r = await extractPythonFromArchive(buf, 'proj.zip');

    expect(r.includedFiles).toContain('client.py');
    expect(r.includedFiles).toContain('tests/test_users.py');
    expect(r.includedFiles).not.toContain('node_modules/dep/mod.py');
    expect(r.includedFiles.some(f => f.endsWith('.pyc'))).toBe(false);
    // core source ordered before tests
    expect(r.includedFiles.indexOf('client.py')).toBeLessThan(r.includedFiles.indexOf('tests/test_users.py'));
    // file headers present
    expect(r.combined).toContain('# === file: client.py ===');
    expect(r.fileCount).toBe(2);
  });

  // Note: high-level zip libs sanitize `../` on write, so a real slip entry can't
  // be built via addFile — we test the guard (normalizeEntryPath) directly.
  test('normalizeEntryPath rejects traversal and absolute paths', () => {
    expect(normalizeEntryPath('../evil.py')).toBeNull();
    expect(normalizeEntryPath('a/../../evil.py')).toBeNull();
    expect(normalizeEntryPath('/etc/passwd.py')).toBeNull();
    expect(normalizeEntryPath('C:/Windows/x.py')).toBeNull();
    expect(normalizeEntryPath('./api/client.py')).toBe('api/client.py');
    expect(normalizeEntryPath('api\\client.py')).toBe('api/client.py');
  });

  test('truncates when over the cap and reports skipped', async () => {
    const big = 'x'.repeat(400);
    const buf = makeZip({
      'client.py': `import requests # ${big}`,
      'tests/test_a.py': `# ${big}`,
    });
    // tiny cap forces truncation; core source kept, test dropped
    const r = await extractPythonFromArchive(buf, 'proj.zip', 500);
    expect(r.truncated).toBe(true);
    expect(r.includedFiles).toContain('client.py');
    expect(r.skipped).toContain('tests/test_a.py');
  });

  test('throws when no .py files', async () => {
    const buf = makeZip({ 'README.md': '# hi', 'data.json': '{}' });
    await expect(extractPythonFromArchive(buf, 'proj.zip')).rejects.toThrow(/No Python/);
  });
});

describe('extractPythonFromArchive — tar.gz', () => {
  test('reads gzipped tar entries', async () => {
    const buf = await makeTarGz({
      'api/config.py': 'BASE_URL = "https://x"',
      'api/http.py': 'import httpx',
      'venv/lib/junk.py': 'should be skipped',
    });
    const r = await extractPythonFromArchive(buf, 'proj.tar.gz');
    expect(r.includedFiles.sort()).toEqual(['api/config.py', 'api/http.py']);
    expect(r.combined).toContain('# === file: api/config.py ===');
  });

  test('aborts a gzip bomb instead of materializing it (tiny .gz → huge payload)', async () => {
    // ~60MB of zeros → trivially small gzip, but decompresses past the 50MB cap.
    const bomb = zlib.gzipSync(Buffer.alloc(60 * 1024 * 1024, 0));
    await expect(extractPythonFromArchive(bomb, 'bomb.tar.gz')).rejects.toThrow(/too large|decompress/i);
  });
});

describe('extractPythonFromArchive — plain .tar', () => {
  test('reads an uncompressed tar (was previously misrouted to the zip reader)', async () => {
    const gz = await makeTarGz({ 'client.py': 'import requests' });
    const tar = zlib.gunzipSync(gz); // un-gzip back to a plain .tar buffer
    const r = await extractPythonFromArchive(tar, 'proj.tar');
    expect(r.includedFiles).toEqual(['client.py']);
  });
});

describe('extractPythonFromArchive — guards', () => {
  test('skips a non-UTF8 .py file rather than emitting mojibake', async () => {
    const zip = new AdmZip();
    zip.addFile('good.py', Buffer.from('import requests', 'utf-8'));
    zip.addFile('bad.py', Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x80])); // invalid UTF-8
    const r = await extractPythonFromArchive(zip.toBuffer(), 'proj.zip');
    expect(r.includedFiles).toEqual(['good.py']);
    expect(r.includedFiles).not.toContain('bad.py');
  });
});
