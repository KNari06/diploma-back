import {
  recordedFingerprintHasStrongIdentity,
  nodeToIdentityProbe,
  hasStrongIdentityContradiction,
} from '../recorded-identity.util';
import type { TargetFingerprint } from '../preview.types';

describe('recordedFingerprintHasStrongIdentity', () => {
  it('returns false when fingerprint is undefined', () => {
    expect(recordedFingerprintHasStrongIdentity(undefined)).toBe(false);
  });

  it('returns false for a weak fingerprint (tag/role/text only)', () => {
    expect(recordedFingerprintHasStrongIdentity({ tag: 'a', role: 'link', text: 'Алматы' })).toBe(false);
  });

  it('returns true when a stable strong identifier is present', () => {
    expect(recordedFingerprintHasStrongIdentity({ testIdAttr: 'submit' })).toBe(true);
    expect(recordedFingerprintHasStrongIdentity({ href: '/courses/math' })).toBe(true);
    expect(recordedFingerprintHasStrongIdentity({ name: 'email' })).toBe(true);
  });

  it('ignores a dynamic elementId but accepts a stable one', () => {
    expect(recordedFingerprintHasStrongIdentity({ elementId: ':r3:' })).toBe(false);
    expect(recordedFingerprintHasStrongIdentity({ elementId: 'login-email' })).toBe(true);
  });
});

describe('nodeToIdentityProbe', () => {
  it('maps node fields and id -> elementId', () => {
    const probe = nodeToIdentityProbe({ id: 'x', testIdAttr: 't', href: '/a', name: 'n', tag: 'a' });
    expect(probe.elementId).toBe('x');
    expect(probe.testIdAttr).toBe('t');
    expect(probe.href).toBe('/a');
    expect(probe.name).toBe('n');
  });

  it('drops a dynamic live id (symmetric with probeIdentity)', () => {
    expect(nodeToIdentityProbe({ id: ':r9:' }).elementId).toBeUndefined();
  });

  it('normalizes empty strings to undefined', () => {
    const probe = nodeToIdentityProbe({ testIdAttr: '', text: '' });
    expect(probe.testIdAttr).toBeUndefined();
    expect(probe.text).toBeUndefined();
  });
});

describe('hasStrongIdentityContradiction (via nodeToIdentityProbe)', () => {
  const contradicts = (node: Parameters<typeof nodeToIdentityProbe>[0], fp: TargetFingerprint) =>
    hasStrongIdentityContradiction(nodeToIdentityProbe(node), fp);

  it('returns false when no probe is supplied', () => {
    expect(hasStrongIdentityContradiction(null, { testIdAttr: 'submit' })).toBe(false);
  });

  it('returns true when a strong testId differs', () => {
    expect(contradicts({ testIdAttr: 'cancel' }, { testIdAttr: 'submit' })).toBe(true);
  });

  it('returns false when the strong testId matches', () => {
    expect(contradicts({ testIdAttr: 'submit' }, { testIdAttr: 'submit' })).toBe(false);
  });

  it('treats a missing live value as neutral, not a contradiction', () => {
    expect(contradicts({ tag: 'button' }, { testIdAttr: 'submit' })).toBe(false);
  });

  // 🔴3: recorder stores the relative href attribute; the live probe reads the
  // absolute IDL .href. normUrlLike drops the origin so the same target matches.
  it('does NOT flag relative-recorded vs absolute-live href for the same target', () => {
    expect(contradicts({ href: 'https://site.com/courses/math' }, { href: '/courses/math' })).toBe(false);
  });

  it('flags a genuinely different href', () => {
    expect(contradicts({ href: 'https://site.com/courses/physics' }, { href: '/courses/math' })).toBe(true);
  });

  it('tolerates a trailing-slash-only href difference', () => {
    expect(contradicts({ href: 'https://site.com/dir/' }, { href: '/dir' })).toBe(false);
  });

  // 🔴4: text is a WEAK field — its drift must never cause a hard reject when a
  // strong identifier still matches.
  it('does not contradict on text drift when a strong id still matches', () => {
    expect(contradicts({ testIdAttr: 'submit', text: 'Астана' }, { testIdAttr: 'submit', text: 'Алматы' })).toBe(false);
  });

  it('drops a dynamic live id so it cannot contradict a stable recorded id', () => {
    expect(contradicts({ id: ':r9:' }, { elementId: 'login-email' })).toBe(false);
  });
});
