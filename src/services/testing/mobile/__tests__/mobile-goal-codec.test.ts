/**
 * Unit tests for the mobile `goal`-column codec — the single writer/reader
 * convention for `{ appPackage, startActivity }` stashed inline until a
 * dedicated column exists. A round-trip guarantee is the whole point.
 */

import { encodeMobileGoal, decodeMobileGoal } from '../mobile-goal-codec';

describe('encodeMobileGoal', () => {
  it('serialises both fields', () => {
    const goal = encodeMobileGoal({ appPackage: 'kz.kolesa', startActivity: '.Main' });
    expect(JSON.parse(goal!)).toEqual({ appPackage: 'kz.kolesa', startActivity: '.Main' });
  });

  it('returns undefined when nothing to store (so callers can spread conditionally)', () => {
    expect(encodeMobileGoal({})).toBeUndefined();
    expect(encodeMobileGoal({ appPackage: '  ', startActivity: '' })).toBeUndefined();
  });

  it('nulls the absent field but keeps the present one', () => {
    expect(JSON.parse(encodeMobileGoal({ appPackage: 'com.app' })!)).toEqual({
      appPackage: 'com.app',
      startActivity: null,
    });
  });
});

describe('decodeMobileGoal', () => {
  it('round-trips with encode', () => {
    const goal = encodeMobileGoal({ appPackage: 'kz.kolesa', startActivity: '.Main' });
    expect(decodeMobileGoal(goal!)).toEqual({ appPackage: 'kz.kolesa', startActivity: '.Main' });
  });

  it('drops null / empty fields on decode', () => {
    const goal = encodeMobileGoal({ appPackage: 'com.app' }); // startActivity → null
    expect(decodeMobileGoal(goal!)).toEqual({ appPackage: 'com.app' });
  });

  it('returns {} for null/undefined', () => {
    expect(decodeMobileGoal(null)).toEqual({});
    expect(decodeMobileGoal(undefined)).toEqual({});
  });

  it('returns {} for free-text (web) goals — never throws', () => {
    expect(decodeMobileGoal('Verify the checkout flow works')).toEqual({});
  });

  it('returns {} for malformed JSON', () => {
    expect(decodeMobileGoal('{"appPackage":')).toEqual({});
  });

  it('ignores non-string field values', () => {
    expect(decodeMobileGoal(JSON.stringify({ appPackage: 123, startActivity: false }))).toEqual({});
  });
});
