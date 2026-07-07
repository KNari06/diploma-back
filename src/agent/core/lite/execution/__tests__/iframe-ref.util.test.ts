import {
  parseIframeRefIndex,
  frameMatchesSource,
  resolveIframeFrame,
  VALID_REF_RE,
  type FrameLike,
} from '../iframe-ref.util';

function fakeFrame(opts: { name?: string; url?: string; detached?: boolean }): FrameLike {
  return {
    name: () => opts.name ?? '',
    url: () => opts.url ?? '',
    isDetached: () => opts.detached ?? false,
  };
}

function fakePage(frames: FrameLike[], mainIndex = 0) {
  return {
    frames: () => frames,
    mainFrame: () => frames[mainIndex],
  };
}

describe('parseIframeRefIndex', () => {
  it('extracts the frame index from an iframe ref', () => {
    expect(parseIframeRefIndex('ifr2_5')).toBe(2);
    expect(parseIframeRefIndex('ifr0_0')).toBe(0);
    expect(parseIframeRefIndex('ifr13_7')).toBe(13);
  });

  it('returns null for a main-page ref or junk', () => {
    expect(parseIframeRefIndex('e5')).toBeNull();
    expect(parseIframeRefIndex('s3')).toBeNull(); // shadow ref
    expect(parseIframeRefIndex(undefined)).toBeNull();
    expect(parseIframeRefIndex('iframe2_5')).toBeNull(); // wrong prefix
  });
});

describe('VALID_REF_RE (validateCommand gate — must accept iframe refs)', () => {
  it('accepts light-DOM, shadow, and iframe refs', () => {
    expect(VALID_REF_RE.test('e5')).toBe(true);
    expect(VALID_REF_RE.test('s3')).toBe(true);
    expect(VALID_REF_RE.test('ifr2_5')).toBe(true); // regression: iframe refs must pass
    expect(VALID_REF_RE.test('ifr0_0')).toBe(true);
  });

  it('rejects the old frame-local form and malformed refs', () => {
    expect(VALID_REF_RE.test('f3')).toBe(false); // pre-fix iframe ref shape — gone
    expect(VALID_REF_RE.test('ifr2')).toBe(false);
    expect(VALID_REF_RE.test('ifr2_')).toBe(false);
    expect(VALID_REF_RE.test('e')).toBe(false);
    expect(VALID_REF_RE.test('x1')).toBe(false);
  });
});

describe('frameMatchesSource', () => {
  it('matches by frame name', () => {
    expect(frameMatchesSource(fakeFrame({ name: 'checkout' }), 'checkout')).toBe(true);
  });

  it('matches by url pathname tail (the collector key)', () => {
    const f = fakeFrame({ url: 'https://pay.example.com/embed/checkout-widget' });
    // collector stores `new URL(url).pathname.slice(-30)`
    const source = '/embed/checkout-widget'.slice(-30);
    expect(frameMatchesSource(f, source)).toBe(true);
  });

  it('returns false on no match / unparseable url', () => {
    expect(frameMatchesSource(fakeFrame({ name: 'a', url: 'not a url' }), 'b')).toBe(false);
  });
});

describe('resolveIframeFrame', () => {
  const main = fakeFrame({ name: '', url: 'https://app.example.com/' });

  it('returns null for a main-page ref (no iframe prefix)', () => {
    const page = fakePage([main, fakeFrame({ name: 'f1' })]);
    expect(resolveIframeFrame(page, 'e7', undefined)).toBeNull();
  });

  it('resolves by positional index when it matches the recorded source', () => {
    const frame = fakeFrame({ name: 'paywidget' });
    const page = fakePage([main, frame]); // frame is at index 1
    expect(resolveIframeFrame(page, 'ifr1_3', 'paywidget')).toBe(frame);
  });

  it('resolves by index even without a recorded source (best-effort)', () => {
    const frame = fakeFrame({ name: 'anything' });
    const page = fakePage([main, frame]);
    expect(resolveIframeFrame(page, 'ifr1_0', undefined)).toBe(frame);
  });

  it('falls back to source match when the index drifted', () => {
    const wrong = fakeFrame({ name: 'wrong' });
    const right = fakeFrame({ name: 'paywidget' });
    // ref says index 1, but paywidget is now at index 2
    const page = fakePage([main, wrong, right]);
    expect(resolveIframeFrame(page, 'ifr1_3', 'paywidget')).toBe(right);
  });

  it('never returns the main frame', () => {
    const page = fakePage([main]);
    expect(resolveIframeFrame(page, 'ifr0_0', undefined)).toBeNull();
  });

  it('skips a detached frame at the index and has no source fallback → null', () => {
    const detached = fakeFrame({ name: 'gone', detached: true });
    const page = fakePage([main, detached]);
    expect(resolveIframeFrame(page, 'ifr1_0', undefined)).toBeNull();
  });

  it('returns null when nothing matches (out-of-range index, no source)', () => {
    const page = fakePage([main]);
    expect(resolveIframeFrame(page, 'ifr9_0', undefined)).toBeNull();
  });
});
