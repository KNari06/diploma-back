/**
 * Brief → prompt text.
 *
 * The uncertainty rules are the point of the whole `BriefField` design, so they
 * are what these tests pin:
 *   1. an `unknown` field prints NOTHING (an LLM shown "unknown" invents)
 *   2. a low-confidence field is LABELLED so the model can discount it
 *   3. `mustNeverTouch` prints even when inferred — a missed prohibition is an
 *      incident, an over-broad one costs a single flow
 */

import {
  formatBriefForCartographer,
  formatBriefForStrategist,
  formatBriefForPlanner,
  formatBriefForSentinel,
} from '../brief-format';
import { normalizeProductBrief } from '../product-brief.util';

const ORIGIN = 'https://acme.com/';

/** Build a brief through the real normalizer, so tests exercise the real shape. */
const brief = (raw: Record<string, unknown>) => normalizeProductBrief(raw, ORIGIN);

const f = (value: unknown, over: Record<string, unknown> = {}) => ({
  value,
  source: 'observed',
  confidence: 'high',
  basis: 'evidence',
  ...over,
});

describe('unknown fields print nothing', () => {
  it('returns undefined for an all-unknown brief', () => {
    const b = brief({});

    expect(formatBriefForCartographer(b)).toBeUndefined();
    expect(formatBriefForStrategist(b)).toBeUndefined();
    expect(formatBriefForPlanner(b)).toBeUndefined();
    expect(formatBriefForSentinel(b)).toBeUndefined();
  });

  it('never emits the literal word "unknown" as a value', () => {
    // An LLM shown "Roles: unknown" fills the gap with invention.
    const b = brief({ purpose: f('A shop') });

    for (const text of [
      formatBriefForCartographer(b),
      formatBriefForStrategist(b),
      formatBriefForSentinel(b),
    ]) {
      expect(text).toBeDefined();
      expect(text!.toLowerCase()).not.toContain('unknown');
    }
  });

  it('omits a section entirely rather than printing an empty list', () => {
    const b = brief({ purpose: f('A shop') });
    const text = formatBriefForCartographer(b)!;

    expect(text).not.toMatch(/ENTITIES/i);
    expect(text).not.toMatch(/ROLES/i);
  });
});

describe('low confidence is labelled', () => {
  it('marks a low-confidence purpose so the model can discount it', () => {
    const b = brief({ purpose: f('Maybe a bank', { confidence: 'low' }) });

    expect(formatBriefForCartographer(b)).toMatch(/low confidence/i);
  });

  it('does not label a high-confidence value', () => {
    const b = brief({ purpose: f('A shop') });

    expect(formatBriefForCartographer(b)).not.toMatch(/low confidence/i);
  });

  it('warns the Sentinel when the whole brief is low-confidence', () => {
    const b = brief({ purpose: f('A shop'), overallConfidence: 'low' });

    expect(formatBriefForSentinel(b)).toMatch(/weight your own observations/i);
  });
});

describe('Cartographer slice', () => {
  const b = () =>
    brief({
      purpose: f('An online shop'),
      productType: f('ecommerce'),
      entities: f(['products', 'orders']),
      uiLanguages: f(['kk']),
      mustNeverTouch: f(['delete an account'], { source: 'inferred' }),
      outOfScopePaths: f(['/blog']),
    });

  it('carries what the agent needs to name entry points well', () => {
    const text = formatBriefForCartographer(b())!;

    expect(text).toContain('An online shop');
    expect(text).toContain('ecommerce');
    expect(text).toContain('products');
  });

  it('warns off assuming English when the UI is not English', () => {
    // auth-url-patterns and the CTA regex are English-only by design.
    expect(formatBriefForCartographer(b())).toMatch(/do NOT assume English/i);
  });

  it('prints prohibitions even when they were only INFERRED', () => {
    expect(formatBriefForCartographer(b())).toMatch(/delete an account/);
  });
});

describe('Strategist slice', () => {
  const b = () =>
    brief({
      purpose: f('An online shop'),
      criticalFlows: f([
        { name: 'Guest checkout', successSignal: 'order number appears', rank: 1, source: 'inferred' },
        { name: 'Search products', rank: 2, source: 'inferred' },
      ]),
      roles: f([{ name: 'buyer', entryHint: '/login', source: 'inferred' }]),
      testAccountRole: f('buyer'),
      selfSignupAvailable: f(false),
      knownBlockers: f(['recaptcha on /login']),
    });

  it('leads with the business-critical flows, in rank order', () => {
    const text = formatBriefForStrategist(b())!;

    expect(text).toMatch(/BUSINESS-CRITICAL FLOWS/);
    expect(text.indexOf('Guest checkout')).toBeLessThan(text.indexOf('Search products'));
  });

  it('surfaces the success signal, which is what makes a flow checkable', () => {
    expect(formatBriefForStrategist(b())).toContain('order number appears');
  });

  it('marks flows that must stop before an irreversible click', () => {
    // The normalizer forces this on every inferred flow.
    expect(formatBriefForStrategist(b())).toMatch(/STOP before the final irreversible click/);
  });

  it('says a registration flow is a dead end when self-signup is off', () => {
    expect(formatBriefForStrategist(b())).toMatch(/dead end/i);
  });

  it('names the test account role so it does not plan another role\'s flows', () => {
    expect(formatBriefForStrategist(b())).toMatch(/THE TEST ACCOUNT IS: buyer/);
  });

  it('flags a marketing-only surface', () => {
    const marketing = brief({ purpose: f('x'), testedSurface: f('marketing') });
    expect(formatBriefForStrategist(marketing)).toMatch(/MARKETING site/);
  });
});

describe('Planner slice — deliberately short', () => {
  const b = () =>
    brief({
      purpose: f('An online shop for laptops. It also has a blog. And a forum.'),
      productType: f('ecommerce'),
      criticalFlows: f([
        { name: 'Guest checkout', successSignal: 'order number appears', rank: 1, source: 'inferred' },
      ]),
      dataHints: f('Use "laptop" as a known-good search term'),
      region: f('KZ (KZT, +7 phones)'),
      mustNeverTouch: f(['publish a review']),
    });

  it('gives the matching flow\'s success signal', () => {
    const text = formatBriefForPlanner(b(), 'Guest checkout')!;
    expect(text).toContain('order number appears');
  });

  it('matches a flow name loosely, since the Strategist may rename it', () => {
    const text = formatBriefForPlanner(b(), 'Guest checkout with one item')!;
    expect(text).toContain('order number appears');
  });

  it('omits the success signal when no flow matches', () => {
    const text = formatBriefForPlanner(b(), 'Change password')!;
    expect(text).not.toContain('order number appears');
  });

  it('trims the purpose to ONE sentence — the Planner needs orientation, not a briefing', () => {
    const text = formatBriefForPlanner(b())!;
    expect(text).toContain('An online shop for laptops.');
    expect(text).not.toContain('And a forum');
  });

  it('carries data hints and region, which change what it types', () => {
    const text = formatBriefForPlanner(b())!;
    expect(text).toContain('laptop');
    expect(text).toContain('KZT');
  });

  it('carries the stop-before-commit instruction for the matched flow', () => {
    expect(formatBriefForPlanner(b(), 'Guest checkout')).toMatch(/STOP before the final irreversible click/);
  });
});

describe('Sentinel slice', () => {
  it('tells it to score against the critical flows, not the entry-point count', () => {
    const b = brief({
      purpose: f('A shop'),
      criticalFlows: f([{ name: 'Checkout', rank: 1, source: 'inferred' }]),
    });

    expect(formatBriefForSentinel(b)).toMatch(/score coverage against THESE/i);
  });

  it('frames an unknown-driven gap as missing information, not a product defect', () => {
    const b = brief({
      purpose: f('A shop'),
      openQuestions: ['environmentKind — cannot tell prod from staging'],
    });

    expect(formatBriefForSentinel(b)).toMatch(/MISSING-INFORMATION gap, not a product defect/);
  });

  it('raises the bar for a regulated product', () => {
    const b = brief({ purpose: f('A bank'), riskProfile: f('regulated') });
    expect(formatBriefForSentinel(b)).toMatch(/higher bar/i);
  });

  it('says nothing about risk for a standard product', () => {
    const b = brief({ purpose: f('A shop'), riskProfile: f('standard') });
    expect(formatBriefForSentinel(b)).not.toMatch(/higher bar/i);
  });
});
