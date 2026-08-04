/**
 * Phase 0 question planning + answer folding.
 *
 * PRODUCT DECISION (user): **max 3 questions, and only when genuinely needed.**
 * So the tests below are mostly about RESTRAINT — what must NOT be asked — plus
 * the safety rules that survive a user's answer.
 */

import { planBriefQuestions, applyBriefAnswers, MAX_BRIEF_QUESTIONS } from '../brief-questions';
import { normalizeProductBrief } from '../product-brief.util';

const ORIGIN = 'https://acme.com/';
const brief = (raw: Record<string, unknown>) => normalizeProductBrief(raw, ORIGIN);

const f = (value: unknown, over: Record<string, unknown> = {}) => ({
  value,
  source: 'observed',
  confidence: 'high',
  basis: 'evidence',
  ...over,
});

/** A brief with everything confidently known — the "ask nothing" baseline. */
const confidentBrief = () =>
  brief({
    purpose: f('A shop'),
    environmentKind: f('staging'),
    criticalFlows: f([{ name: 'Checkout', rank: 1, source: 'observed', confidence: 'high' }]),
    mustNeverTouch: f(['delete an account']),
    roles: f([{ name: 'buyer', source: 'observed' }]),
    testAccountRole: f('buyer'),
  });

describe('restraint — zero questions is the target outcome', () => {
  it('asks nothing when the evidence already answered everything', () => {
    expect(planBriefQuestions(confidentBrief())).toEqual([]);
  });

  it('never asks more than the cap', () => {
    // Everything unknown → far more than 3 candidates qualify.
    const empty = brief({ paymentProvider: f('stripe') });
    expect(planBriefQuestions(empty).length).toBeLessThanOrEqual(MAX_BRIEF_QUESTIONS);
  });

  it('never re-asks a field the user already answered', () => {
    const answered = brief({
      criticalFlows: f([{ name: 'Checkout', rank: 1, source: 'user' }], { source: 'user' }),
      mustNeverTouch: f(['delete'], { source: 'user' }),
      environmentKind: f('staging', { source: 'user' }),
    });

    const keys = planBriefQuestions(answered).map((q) => q.key);
    expect(keys).not.toContain('criticalFlows');
    expect(keys).not.toContain('mustNeverTouch');
  });

  it('does not ask which role the account has when there is only one role', () => {
    const single = brief({
      purpose: f('A shop'),
      roles: f([{ name: 'buyer', source: 'observed' }]),
    });

    expect(planBriefQuestions(single).map((q) => q.key)).not.toContain('testAccountRole');
  });

  it('asks about the account role once several roles exist', () => {
    const multi = brief({
      purpose: f('A marketplace'),
      roles: f([
        { name: 'buyer', source: 'observed' },
        { name: 'seller', source: 'observed' },
      ]),
    });

    const q = planBriefQuestions(multi).find((x) => x.key === 'testAccountRole');
    expect(q).toBeDefined();
    expect(q!.options).toEqual(expect.arrayContaining(['buyer', 'seller', 'Not sure']));
  });
});

describe('safety pre-empt', () => {
  it('asks about environment FIRST when money is involved', () => {
    const risky = brief({
      purpose: f('A shop'),
      paymentProvider: f('stripe'),
      criticalFlows: f([{ name: 'Checkout', rank: 1, source: 'inferred' }]),
    });

    const questions = planBriefQuestions(risky);
    expect(questions[0].key).toBe('environmentKind');
    expect(questions[0].options).toEqual(expect.arrayContaining(['Not sure — be conservative']));
  });

  it('does not spend a slot on environment when nothing is irreversible', () => {
    const harmless = brief({
      purpose: f('A blog'),
      criticalFlows: f([{ name: 'Read an article', rank: 1, source: 'user' }], { source: 'user' }),
    });

    expect(planBriefQuestions(harmless).map((q) => q.key)).not.toContain('environmentKind');
  });
});

describe('applyBriefAnswers — a user answer becomes evidence', () => {
  it('records every question in the ask log, answered or not', () => {
    const result = applyBriefAnswers(brief({ purpose: f('x') }), [
      { key: 'criticalFlows', answer: 'Checkout' },
      { key: 'mustNeverTouch', answer: null },
    ]);

    expect(result.askLog).toEqual([
      { key: 'criticalFlows', answered: true },
      { key: 'mustNeverTouch', answered: false },
    ]);
  });

  it('leaves the derived value untouched when the user skipped', () => {
    const before = brief({ criticalFlows: f([{ name: 'Derived', rank: 1, source: 'inferred' }]) });
    const after = applyBriefAnswers(before, [{ key: 'criticalFlows', answer: null }]);

    expect(after.criticalFlows.value[0].name).toBe('Derived');
    expect(after.criticalFlows.source).not.toBe('user');
  });

  describe('environment answer settles BOTH environment and payment policy', () => {
    it('sandbox grants payment permission', () => {
      const r = applyBriefAnswers(brief({}), [
        { key: 'environmentKind', answer: 'Staging/sandbox — completing payments is fine' },
      ]);

      expect(r.environmentKind.value).toBe('staging');
      expect(r.paymentPolicy.value).toBe('allowed_sandbox');
      // Only a USER may grant this — that is what makes it acceptable.
      expect(r.paymentPolicy.source).toBe('user');
    });

    it('production with stop-before-confirm', () => {
      const r = applyBriefAnswers(brief({}), [
        { key: 'environmentKind', answer: 'Production — stop before the final confirm' },
      ]);

      expect(r.environmentKind.value).toBe('production');
      expect(r.paymentPolicy.value).toBe('stop_before_commit');
    });

    it('production forbids payments outright', () => {
      const r = applyBriefAnswers(brief({}), [
        { key: 'environmentKind', answer: 'Production — never complete payments' },
      ]);

      expect(r.paymentPolicy.value).toBe('never');
    });

    it('"not sure" changes nothing — the defaults are already conservative', () => {
      const r = applyBriefAnswers(brief({}), [
        { key: 'environmentKind', answer: 'Not sure — be conservative' },
      ]);

      expect(r.environmentKind.value).toBe('unknown');
      expect(r.paymentPolicy.value).toBe('never');
    });
  });

  it('parses a free-text critical-flow list into ranked flows', () => {
    const r = applyBriefAnswers(brief({}), [
      { key: 'criticalFlows', answer: '1. Sign up; 2. Create a project; 3. Invite a teammate' },
    ]);

    expect(r.criticalFlows.value.map((x) => x.name)).toEqual([
      'Sign up',
      'Create a project',
      'Invite a teammate',
    ]);
    expect(r.criticalFlows.source).toBe('user');
  });

  it('naming a flow is NOT permission to complete it', () => {
    // Only the environment/payment answer grants that; listing a flow must not.
    const r = applyBriefAnswers(brief({}), [{ key: 'criticalFlows', answer: 'Checkout' }]);

    expect(r.criticalFlows.value[0].stopBeforeCommit).toBe(true);
  });

  it('treats "none" for never-touch as no prohibitions, not a literal entry', () => {
    const r = applyBriefAnswers(brief({}), [{ key: 'mustNeverTouch', answer: 'none' }]);

    expect(r.mustNeverTouch.value).not.toContain('none');
  });

  it('parses a real never-touch list', () => {
    const r = applyBriefAnswers(brief({}), [
      { key: 'mustNeverTouch', answer: 'email real customers; publish a listing' },
    ]);

    expect(r.mustNeverTouch.value).toEqual(['email real customers', 'publish a listing']);
    expect(r.mustNeverTouch.source).toBe('user');
  });

  it('ignores "not sure" for the account role', () => {
    const r = applyBriefAnswers(brief({}), [{ key: 'testAccountRole', answer: 'Not sure' }]);
    expect(r.testAccountRole.source).not.toBe('user');
  });

  it('clears an answered item from openQuestions', () => {
    const before = brief({ purpose: f('x'), openQuestions: ['environmentKind — cannot tell'] });
    const after = applyBriefAnswers(before, [
      { key: 'environmentKind', answer: 'Production — never complete payments' },
    ]);

    expect(after.openQuestions).toEqual([]);
  });

  it('does not mutate the input brief', () => {
    const before = brief({ purpose: f('x') });
    const snapshot = JSON.stringify(before);

    applyBriefAnswers(before, [{ key: 'criticalFlows', answer: 'Checkout' }]);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
