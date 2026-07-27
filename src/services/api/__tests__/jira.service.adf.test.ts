import { adfToPlainText } from '../jira.service';

describe('adfToPlainText', () => {
  it('returns a plain string unchanged', () => {
    expect(adfToPlainText('hello world')).toBe('hello world');
  });

  it('extracts paragraphs and text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce:' }] }],
    };
    expect(adfToPlainText(doc)).toContain('Steps to reproduce:');
  });

  it('renders bullet lists as "- " items (previously dropped)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open /login' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Enter bad password' }] }] },
          ],
        },
      ],
    };
    const out = adfToPlainText(doc);
    expect(out).toContain('- Open /login');
    expect(out).toContain('- Enter bad password');
  });

  it('renders table cells joined by " | "', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Field' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toContain('Field | Value');
  });

  it('extracts code block text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'GET /api/checkout 500' }] }],
    };
    expect(adfToPlainText(doc)).toContain('GET /api/checkout 500');
  });

  it('surfaces an inline link href (where a testable URL often hides)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ', marks: [] },
            { type: 'text', text: 'the page', marks: [{ type: 'link', attrs: { href: 'https://app.example.com/checkout' } }] },
          ],
        },
      ],
    };
    expect(adfToPlainText(doc)).toContain('https://app.example.com/checkout');
  });

  it('truncates output to maxChars', () => {
    const long = 'x'.repeat(500);
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: long }] }] };
    const out = adfToPlainText(doc, 100);
    expect(out.length).toBeLessThanOrEqual(101); // 100 + ellipsis
  });

  it('returns empty string for null/undefined', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
  });
});
