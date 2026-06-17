import { buildTelegramMessage } from '../telegram-notify';

describe('buildTelegramMessage', () => {
  const base = {
    icon: '✅',
    title: 'Run completed',
    ctaLabel: 'View report',
    ctaUrl: 'https://app.qait.dev/runs/abc',
  };

  it('escapes & in the CTA href so Telegram HTML parsing does not 400', () => {
    const out = buildTelegramMessage({
      ...base,
      ctaUrl: 'https://app.qait.dev/runs/abc?token=x&y=1&z=2',
    });
    // Raw "&" inside href breaks Telegram's HTML parser → must be entity-encoded.
    expect(out).toContain('href="https://app.qait.dev/runs/abc?token=x&amp;y=1&amp;z=2"');
    expect(out).not.toMatch(/href="[^"]*[^p]&[^a]/); // no bare & in the href
  });

  it('escapes <, >, & in title and field values', () => {
    const out = buildTelegramMessage({
      ...base,
      title: 'Run <b>failed</b> & stopped',
      fields: [{ label: 'URL', value: 'https://x.com?a=1&b=2' }],
    });
    expect(out).toContain('Run &lt;b&gt;failed&lt;/b&gt; &amp; stopped');
    expect(out).toContain('https://x.com?a=1&amp;b=2');
  });

  it('keeps the allowed <b> and <a> tags from the builder itself intact', () => {
    const out = buildTelegramMessage(base);
    expect(out).toContain('<b>Run completed</b>');
    expect(out).toContain('<a href="https://app.qait.dev/runs/abc">View report</a>');
  });
});
