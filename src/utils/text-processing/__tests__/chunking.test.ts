import {
  countTokens,
  chunkText,
  extractMarkdownStructure,
  chunkMarkdown,
} from '../chunking';

describe('countTokens', () => {
  it('returns 0 for empty, whitespace, or non-string input', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('   \n  ')).toBe(0);
    expect(countTokens(null as any)).toBe(0);
    expect(countTokens(undefined as any)).toBe(0);
  });

  it('returns a positive count for real text', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });

  it('counts more tokens for longer text', () => {
    expect(countTokens('one two three four five six seven')).toBeGreaterThan(
      countTokens('one'),
    );
  });
});

describe('chunkText', () => {
  it('returns an empty array for empty or invalid input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null as any)).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('produces a single chunk for short text', () => {
    const chunks = chunkText('a short sentence');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].totalChunks).toBe(1);
    expect(chunks[0].content).toBe('a short sentence');
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('splits long text into multiple sequential chunks', () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, { chunkSize: 5, overlap: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.chunkIndex).toBe(i);
      expect(c.totalChunks).toBe(chunks.length);
      expect(c.content.length).toBeGreaterThan(0);
    });
  });

  it('falls back to defaults when given invalid chunk size / overlap', () => {
    const chunks = chunkText('some words here', { chunkSize: -5, overlap: -1 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('carries the section title into chunk metadata', () => {
    const [chunk] = chunkText('hello', { sectionTitle: 'Intro' });
    expect(chunk.metadata.sectionTitle).toBe('Intro');
  });
});

describe('extractMarkdownStructure', () => {
  it('extracts the H1 title and ## / ### sections', () => {
    const md = [
      '# Doc Title',
      '',
      '## First',
      'first body',
      '',
      '### Second',
      'second body',
    ].join('\n');
    const { title, sections } = extractMarkdownStructure(md);
    expect(title).toBe('Doc Title');
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('First');
    expect(sections[0].content).toContain('first body');
    expect(sections[1].heading).toBe('Second');
    expect(sections[1].content).toContain('second body');
  });

  it('returns an empty title and no sections for plain text', () => {
    const { title, sections } = extractMarkdownStructure('just a paragraph\nno headings');
    expect(title).toBe('');
    expect(sections).toHaveLength(0);
  });

  it('only treats the first # line as the title', () => {
    const { title } = extractMarkdownStructure('# One\n# Two');
    expect(title).toBe('One');
  });
});

describe('chunkMarkdown', () => {
  it('returns an empty array for empty or invalid content', () => {
    expect(chunkMarkdown('', 'f.md')).toEqual([]);
    expect(chunkMarkdown(null as any, 'f.md')).toEqual([]);
  });

  it('emits one chunk per small section, tagged with a parent id and text', () => {
    const md = ['# Title', '', '## Basic Usage', 'do the thing', '', '## Next Steps', 'then this'].join(
      '\n',
    );
    const chunks = chunkMarkdown(md, 'guide.md');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].parentId).toBe('basic-usage');
    expect(chunks[0].parentText).toContain('do the thing');
    expect(chunks[1].parentId).toBe('next-steps');
    chunks.forEach((c, i) => {
      expect(c.chunkIndex).toBe(i);
      expect(c.totalChunks).toBe(chunks.length);
    });
  });

  it('falls back to plain chunking when there is no markdown structure', () => {
    const chunks = chunkMarkdown('plain content with no headings at all', 'note.md');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].parentId).toBeUndefined();
  });
});
