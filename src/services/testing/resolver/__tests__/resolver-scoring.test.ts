import {
  combinedScore,
  computeNameSimilarity,
  computeUrlScore,
  scoreReason,
  SCORING_WEIGHTS,
} from '../resolver-scoring';

describe('computeNameSimilarity', () => {
  it('returns 0 when either side is empty', () => {
    expect(computeNameSimilarity('', 'login test')).toBe(0);
    expect(computeNameSimilarity('login', '')).toBe(0);
  });

  it('is case- and punctuation-insensitive', () => {
    const a = computeNameSimilarity('Login Test', 'login test');
    expect(a).toBeGreaterThan(0.9);
    const b = computeNameSimilarity('login, test!', 'login test');
    expect(b).toBeGreaterThan(0.9);
  });

  it('scores partial token overlap between 0 and 1', () => {
    const score = computeNameSimilarity('payment checkout', 'checkout flow');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('ignores single-character noise tokens', () => {
    // "a" is filtered (len <= 1), so only "login" counts on each side → identical.
    expect(computeNameSimilarity('a login', 'login a')).toBeGreaterThan(0.9);
  });

  it('handles unicode (Cyrillic) tokens', () => {
    expect(computeNameSimilarity('тест оплаты', 'оплата тест')).toBeGreaterThan(0);
  });
});

describe('computeUrlScore', () => {
  it('returns 0 for empty or invalid URLs', () => {
    expect(computeUrlScore('', 'https://x.com')).toBe(0);
    expect(computeUrlScore('not a url', 'also not')).toBe(0);
  });

  it('scores same page highest', () => {
    const s = computeUrlScore('https://app.com/login', 'https://app.com/login');
    expect(s).toBeCloseTo(0.75);
  });

  it('boosts same-domain auth paths above generic same-domain', () => {
    const auth = computeUrlScore('https://app.com/home', 'https://app.com/login');
    const generic = computeUrlScore('https://app.com/home', 'https://app.com/dashboard');
    expect(auth).toBeGreaterThan(generic);
    expect(generic).toBeCloseTo(0.35);
  });

  it('returns 0 across different domains', () => {
    expect(computeUrlScore('https://a.com/x', 'https://b.com/x')).toBe(0);
  });
});

describe('combinedScore', () => {
  it('applies the shared weights and clamps negative embedding sim', () => {
    expect(combinedScore(1, 1, 1)).toBeCloseTo(1);
    expect(combinedScore(0, 0, 0)).toBe(0);
    // negative embedding clamps to 0, so only name+url contribute
    expect(combinedScore(-0.5, 1, 0)).toBeCloseTo(SCORING_WEIGHTS.name);
  });

  it('weights embedding most heavily', () => {
    const embedOnly = combinedScore(1, 0, 0);
    const nameOnly = combinedScore(0, 1, 0);
    expect(embedOnly).toBeGreaterThan(nameOnly);
    expect(embedOnly).toBeCloseTo(SCORING_WEIGHTS.embedding);
  });
});

describe('scoreReason', () => {
  it('lists only components above their thresholds', () => {
    expect(scoreReason(0.8, 0.6, 0.3)).toContain('embed=0.80');
    expect(scoreReason(0.8, 0.6, 0.3)).toContain('name=0.60');
    expect(scoreReason(0.8, 0.6, 0.3)).toContain('url=0.30');
  });

  it('falls back to a low-similarity label when nothing clears thresholds', () => {
    expect(scoreReason(0.1, 0.1, 0)).toBe('low similarity');
  });
});
