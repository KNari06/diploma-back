import {
  compareRecordedIdentity,
  recordedFingerprintHasStrongIdentity,
} from '../recorded-identity.util';
import type { TargetFingerprint } from '../preview.types';

describe('recordedFingerprintHasStrongIdentity', () => {
  it('returns false when fingerprint is undefined', () => {
    expect(recordedFingerprintHasStrongIdentity(undefined)).toBe(false);
  });

  it('returns false for a weak fingerprint (tag only)', () => {
    expect(recordedFingerprintHasStrongIdentity({ tag: 'button' })).toBe(false);
  });

  it('returns true when a stable testId is present', () => {
    expect(recordedFingerprintHasStrongIdentity({ tag: 'button', testIdAttr: 'submit-btn' })).toBe(true);
  });

  it('ignores a dynamic elementId but accepts a stable one', () => {
    expect(recordedFingerprintHasStrongIdentity({ elementId: ':r3:' })).toBe(false);
    expect(recordedFingerprintHasStrongIdentity({ elementId: 'login-email' })).toBe(true);
  });

  it('accepts the tag+role+text triple', () => {
    expect(recordedFingerprintHasStrongIdentity({ tag: 'a', role: 'link', text: 'Алматы' })).toBe(true);
    // text too short → not enough signal
    expect(recordedFingerprintHasStrongIdentity({ tag: 'a', role: 'link', text: 'A' })).toBe(false);
  });
});

describe('compareRecordedIdentity', () => {
  it('returns no_signal when the fingerprint is too weak to validate', () => {
    expect(compareRecordedIdentity({ tag: 'button', id: 'x' }, { tag: 'button' }, 'click')).toBe('no_signal');
  });

  it('returns match when the live testId equals the recorded one', () => {
    const fp: TargetFingerprint = { tag: 'button', testIdAttr: 'submit' };
    expect(compareRecordedIdentity({ tag: 'button', testIdAttr: 'submit' }, fp, 'click')).toBe('match');
  });

  it('returns mismatch when the live testId differs from the recorded one', () => {
    const fp: TargetFingerprint = { tag: 'button', testIdAttr: 'submit' };
    expect(compareRecordedIdentity({ tag: 'button', testIdAttr: 'cancel' }, fp, 'click')).toBe('mismatch');
  });

  it('treats a missing live value as neutral, not a contradiction', () => {
    const fp: TargetFingerprint = { testIdAttr: 'submit' };
    // node lacks testId entirely and nothing else to compare → fail-open
    expect(compareRecordedIdentity({ tag: 'button' }, fp, 'click')).toBe('no_signal');
  });

  it('returns mismatch on a contradicting href even if tag matches', () => {
    const fp: TargetFingerprint = { tag: 'a', href: '/courses/math' };
    expect(compareRecordedIdentity({ tag: 'a', href: '/courses/physics' }, fp, 'click')).toBe('mismatch');
  });

  it('ignores a dynamic recorded elementId rather than contradicting on it', () => {
    const fp: TargetFingerprint = { elementId: ':r7:', testIdAttr: 'submit' };
    // dynamic id skipped; testId matches → match
    expect(compareRecordedIdentity({ id: ':r9:', testIdAttr: 'submit' }, fp, 'click')).toBe('match');
  });

  describe('tag+role+text triple', () => {
    const fp: TargetFingerprint = { tag: 'a', role: 'link', text: 'Алматы' };

    it('matches when tag, role and text all agree (click)', () => {
      expect(compareRecordedIdentity({ tag: 'a', role: 'link', text: 'Алматы' }, fp, 'click')).toBe('match');
    });

    it('mismatches when the text differs (click)', () => {
      expect(compareRecordedIdentity({ tag: 'a', role: 'link', text: 'Астана' }, fp, 'click')).toBe('mismatch');
    });

    it('does not enforce the triple for non-click actions', () => {
      expect(compareRecordedIdentity({ tag: 'a', role: 'link', text: 'Астана' }, fp, 'type')).toBe('no_signal');
    });
  });
});
