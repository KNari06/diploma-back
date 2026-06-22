import AdmZip from 'adm-zip';
import { parsePlaywrightTraceSteps } from '../trace-steps-parser';

/** Build a Playwright-trace-style ZIP buffer from newline-delimited JSON events. */
function makeTraceZip(events: unknown[], entryName = 'test.trace'): Buffer {
  const zip = new AdmZip();
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  zip.addFile(entryName, Buffer.from(body, 'utf8'));
  return zip.toBuffer();
}

describe('parsePlaywrightTraceSteps', () => {
  it('throws when the ZIP has no trace entry', () => {
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('not a trace'));
    expect(() => parsePlaywrightTraceSteps(zip.toBuffer())).toThrow('No trace file found in ZIP');
  });

  it('parses action events with incrementing step ids', () => {
    const buffer = makeTraceZip([
      { type: 'action', apiName: 'click', time: 100, params: { selector: '#btn' } },
      { type: 'action', apiName: 'fill', time: 200, params: { selector: '#in', text: 'hi' } },
    ]);
    const steps = parsePlaywrightTraceSteps(buffer);
    expect(steps).toHaveLength(2);
    expect(steps[0].stepId).toBe(1);
    expect(steps[1].stepId).toBe(2);
  });

  it('parses apiCall events as well as action events', () => {
    const buffer = makeTraceZip([
      { type: 'apiCall', method: 'goto', time: 5, params: { url: 'https://x.test' } },
    ]);
    const steps = parsePlaywrightTraceSteps(buffer);
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('goto');
    expect(steps[0].url).toBe('https://x.test');
  });

  it('extracts url, selector, and text from params', () => {
    const buffer = makeTraceZip([
      {
        type: 'action',
        apiName: 'fill',
        time: 1,
        params: { url: 'https://x.test', selector: '#email', text: 'a@b.com' },
      },
    ]);
    const [step] = parsePlaywrightTraceSteps(buffer);
    expect(step.url).toBe('https://x.test');
    expect(step.selector).toBe('#email');
    expect(step.text).toBe('a@b.com');
  });

  it('falls back through apiName -> method -> unknown for the step type', () => {
    const buffer = makeTraceZip([
      { type: 'action', method: 'check', time: 1, params: { selector: '#c' } },
      { type: 'action', time: 2, params: {} },
    ]);
    const steps = parsePlaywrightTraceSteps(buffer);
    expect(steps[0].type).toBe('check');
    expect(steps[1].type).toBe('unknown');
  });

  it('ignores events that are not actions or apiCalls', () => {
    const buffer = makeTraceZip([
      { type: 'screencast-frame', time: 1 },
      { type: 'action', apiName: 'click', time: 2, params: { selector: '#a' } },
    ]);
    expect(parsePlaywrightTraceSteps(buffer)).toHaveLength(1);
  });

  it('skips malformed JSON lines without throwing', () => {
    const zip = new AdmZip();
    const body = [
      'not json at all',
      JSON.stringify({ type: 'action', apiName: 'click', time: 1, params: { selector: '#a' } }),
    ].join('\n');
    zip.addFile('the.trace', Buffer.from(body, 'utf8'));
    const steps = parsePlaywrightTraceSteps(zip.toBuffer());
    expect(steps).toHaveLength(1);
  });

  it('generates a human-readable description per step type', () => {
    const buffer = makeTraceZip([
      { type: 'action', apiName: 'goto', time: 1, params: { url: 'https://x.test' } },
      { type: 'action', apiName: 'click', time: 2, params: { selector: '#btn' } },
      { type: 'action', apiName: 'fill', time: 3, params: { selector: '#in', text: 'hi' } },
      { type: 'action', apiName: 'select', time: 4, params: { selector: '#d', text: 'opt' } },
      { type: 'action', apiName: 'waitForSelector', time: 5, params: { selector: '#w' } },
      { type: 'action', apiName: 'screenshot', time: 6, params: {} },
    ]);
    const steps = parsePlaywrightTraceSteps(buffer);
    expect(steps[0].description).toBe('Navigate to https://x.test');
    expect(steps[1].description).toBe('Click on #btn');
    expect(steps[2].description).toBe('Fill "hi" into #in');
    expect(steps[3].description).toBe('Select "opt" in #d');
    expect(steps[4].description).toBe('Wait for #w');
    expect(steps[5].description).toBe('Take screenshot');
  });

  it('falls back to a default description for an unknown step type', () => {
    const buffer = makeTraceZip([
      { type: 'action', apiName: 'hover', time: 1, params: { selector: '#h' } },
    ]);
    const [step] = parsePlaywrightTraceSteps(buffer);
    expect(step.description).toBe('hover (#h)');
  });
});
