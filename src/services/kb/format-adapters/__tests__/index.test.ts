// ingestFile routes a file to a structured adapter or the generic chunker.
// We mock the I/O boundaries (fs, fileParser, chunking) but use the REAL
// openapi/postman adapters so routing + fallback are exercised authentically.
jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
jest.mock('@/utils/parsing/fileParser', () => ({
  isValidFileType: jest.fn(),
  getFileSizeMB: jest.fn(),
  parseFile: jest.fn(),
}));
jest.mock('@/utils/text-processing/chunking', () => ({
  chunkMarkdown: jest.fn(),
  chunkText: jest.fn(),
}));

import { promises as fs } from 'fs';
import { ingestFile } from '../index';
import { isValidFileType, getFileSizeMB, parseFile } from '@/utils/parsing/fileParser';
import { chunkMarkdown, chunkText } from '@/utils/text-processing/chunking';
import { openApiAdapter } from '../openapi.adapter';

const readFileMock = fs.readFile as unknown as jest.Mock;
const isValidMock = isValidFileType as jest.Mock;
const sizeMock = getFileSizeMB as jest.Mock;
const parseFileMock = parseFile as jest.Mock;
const chunkMarkdownMock = chunkMarkdown as jest.Mock;
const chunkTextMock = chunkText as jest.Mock;

const genericChunk = (over: Record<string, unknown> = {}) => ({
  content: 'chunk text',
  chunkIndex: 0,
  totalChunks: 1,
  tokenCount: 5,
  parentId: undefined,
  parentText: undefined,
  metadata: { sectionTitle: 'Intro' },
  ...over,
});

beforeEach(() => {
  isValidMock.mockReturnValue(true);
  sizeMock.mockResolvedValue(1);
  readFileMock.mockResolvedValue('');
  parseFileMock.mockResolvedValue({ content: 'parsed body', metadata: { fileType: 'txt', wordCount: 2, pageCount: 1 } });
  chunkTextMock.mockReturnValue([genericChunk()]);
  chunkMarkdownMock.mockReturnValue([genericChunk()]);
});

const OPENAPI = JSON.stringify({ openapi: '3.0.0', info: { title: 'API' }, paths: { '/ping': { get: { summary: 'Ping' } } } });
const POSTMAN = JSON.stringify({
  info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{ name: 'Get', request: { method: 'get', url: '/a' } }],
});

describe('ingestFile — validation', () => {
  it('throws on an empty filePath', async () => {
    await expect(ingestFile('', 'a.json')).rejects.toThrow('Invalid filePath');
  });
  it('throws on an empty originalName', async () => {
    await expect(ingestFile('/tmp/a', '')).rejects.toThrow('Invalid originalName');
  });
  it('throws on an unsupported file type', async () => {
    isValidMock.mockReturnValue(false);
    await expect(ingestFile('/tmp/a.exe', 'a.exe')).rejects.toThrow('Invalid file type');
  });
  it('throws when the file exceeds the size cap', async () => {
    sizeMock.mockResolvedValue(25);
    await expect(ingestFile('/tmp/a.json', 'a.json', 10)).rejects.toThrow('File too large');
  });
});

describe('ingestFile — structured adapters', () => {
  it('routes an OpenAPI file through the openapi adapter', async () => {
    readFileMock.mockResolvedValue(OPENAPI);
    const res = await ingestFile('/tmp/spec.json', 'spec.json');
    expect(res.format).toBe('openapi');
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.stats.fileType).toBe('openapi');
    expect(res.chunks[0].metadata).toMatchObject({ format: 'openapi', chunkIndex: 0 });
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it('routes a Postman collection through the postman adapter', async () => {
    readFileMock.mockResolvedValue(POSTMAN);
    const res = await ingestFile('/tmp/col.json', 'col.json');
    expect(res.format).toBe('postman');
  });

  it('adds chunkIndex/totalChunks/tokenCount to each structured chunk', async () => {
    readFileMock.mockResolvedValue(OPENAPI);
    const res = await ingestFile('/tmp/spec.json', 'spec.json');
    const meta = res.chunks[0].metadata;
    expect(meta.totalChunks).toBe(res.chunks.length);
    expect(typeof meta.tokenCount).toBe('number');
    expect(res.stats.totalTokens).toBeGreaterThan(0);
  });

  it('falls back to generic when a matched adapter produces no chunks', async () => {
    // Valid OpenAPI marker but no paths/components → extract yields 0 chunks.
    readFileMock.mockResolvedValue(JSON.stringify({ openapi: '3.0.0' }));
    const res = await ingestFile('/tmp/empty.json', 'empty.json');
    expect(res.format).toBe('generic');
    expect(parseFileMock).toHaveBeenCalled();
  });

  it('falls back to generic when a matched adapter throws', async () => {
    readFileMock.mockResolvedValue(OPENAPI);
    const spy = jest.spyOn(openApiAdapter, 'extract').mockImplementationOnce(() => {
      throw new Error('adapter blew up');
    });
    const res = await ingestFile('/tmp/spec.json', 'spec.json');
    expect(res.format).toBe('generic');
    expect(parseFileMock).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ingestFile — text-like read errors', () => {
  it('throws when a text-like file is empty', async () => {
    readFileMock.mockResolvedValue('   ');
    await expect(ingestFile('/tmp/a.json', 'a.json')).rejects.toThrow('File is empty');
  });

  it('wraps a read failure', async () => {
    readFileMock.mockRejectedValue(new Error('EACCES'));
    await expect(ingestFile('/tmp/a.json', 'a.json')).rejects.toThrow('Failed to read file: EACCES');
  });
});

describe('ingestFile — generic fallback', () => {
  it('uses the generic chunker for a non-text-like file (pdf) and never reads it directly', async () => {
    const res = await ingestFile('/tmp/doc.pdf', 'doc.pdf');
    expect(res.format).toBe('generic');
    expect(readFileMock).not.toHaveBeenCalled(); // PDFs skip the structured/text path
    expect(chunkTextMock).toHaveBeenCalled();
    expect(res.summary).toContain('txt · 1 chunks · 2 words');
  });

  it('uses the markdown chunker when the parsed file type is markdown', async () => {
    // .md is text-like, so it is read first; plain markdown matches no
    // structured adapter and falls through to the generic parser.
    readFileMock.mockResolvedValue('# Title\n\nsome prose');
    parseFileMock.mockResolvedValue({ content: '# Title', metadata: { fileType: 'markdown', wordCount: 1, pageCount: 1 } });
    await ingestFile('/tmp/doc.md', 'doc.md');
    expect(chunkMarkdownMock).toHaveBeenCalled();
    expect(chunkTextMock).not.toHaveBeenCalled();
  });

  it('falls through to generic for a text-like file no structured adapter recognizes', async () => {
    readFileMock.mockResolvedValue('just plain notes, nothing structured');
    const res = await ingestFile('/tmp/notes.txt', 'notes.txt');
    expect(res.format).toBe('generic');
  });

  it('throws when parsed content is empty', async () => {
    parseFileMock.mockResolvedValue({ content: '   ', metadata: { fileType: 'txt', wordCount: 0 } });
    await expect(ingestFile('/tmp/doc.pdf', 'doc.pdf')).rejects.toThrow('File content is empty after parsing');
  });

  it('throws when the chunker yields no chunks', async () => {
    chunkTextMock.mockReturnValue([]);
    await expect(ingestFile('/tmp/doc.pdf', 'doc.pdf')).rejects.toThrow('No content to process');
  });
});
