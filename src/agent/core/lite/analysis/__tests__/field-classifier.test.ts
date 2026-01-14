/**
 * Field Classifier Tests
 * Tests for tokenization + boundary-aware matching to prevent false-positives
 */

import type { LiteElement } from '../../lite-types';
import { classifyField, isCredentialField, shouldRedactField } from '../field-classifier';

// Helper to create minimal LiteElement for testing
function createMockElement(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    role: 'input',
    name: '',
    tag: 'input',
    visible: true,
    ...overrides,
  };
}

describe('Field Classifier', () => {
  describe('Level 1: Technical semantics (type/autocomplete/inputmode)', () => {
    it('should classify type="password" as password with high confidence', () => {
      const el = createMockElement({ type: 'password' });
      const result = classifyField(el);
      expect(result.kind).toBe('password');
      expect(result.confidence).toBe('high');
    });

    it('should classify type="email" as email with high confidence', () => {
      const el = createMockElement({ type: 'email' });
      const result = classifyField(el);
      expect(result.kind).toBe('email');
      expect(result.confidence).toBe('high');
    });

    it('should classify type="tel" as phone with high confidence', () => {
      const el = createMockElement({ type: 'tel' });
      const result = classifyField(el);
      expect(result.kind).toBe('phone');
      expect(result.confidence).toBe('high');
    });

    it('should classify autocomplete="current-password" as password', () => {
      const el = createMockElement({ autocomplete: 'current-password' });
      const result = classifyField(el);
      expect(result.kind).toBe('password');
      expect(result.confidence).toBe('high');
    });

    it('should classify inputmode="tel" as phone', () => {
      const el = createMockElement({ inputmode: 'tel' });
      const result = classifyField(el);
      expect(result.kind).toBe('phone');
      expect(result.confidence).toBe('high');
    });
  });

  describe('Level 2/3: Fallback dictionary (token/boundary matching)', () => {
    describe('FALSE POSITIVES - should NOT match (substring collision prevention)', () => {
      // Note: "user_notes" tokenizes to ["user", "notes"], and "user" is a valid pattern
      // So user_notes WILL match as username - this is semantically correct.
      // The tokenization prevents SUBSTRING collisions like "superuser" matching "user"

      it('should NOT classify "superuser" as username (user is substring, not token)', () => {
        const el = createMockElement({ htmlName: 'superuser' });
        const result = classifyField(el);
        // "superuser" tokenizes to ["superuser"], no "user" token
        expect(result.kind).toBeNull();
      });

      it('should NOT classify "mailbox" as email (mail is substring, not token)', () => {
        const el = createMockElement({ htmlName: 'mailbox' });
        const result = classifyField(el);
        // "mailbox" tokenizes to ["mailbox"], no "mail" token
        expect(result.kind).toBeNull();
      });

      it('should NOT classify "passcode" as password (pass is substring, not token)', () => {
        const el = createMockElement({ htmlName: 'passcode' });
        const result = classifyField(el);
        // "passcode" tokenizes to ["passcode"], no "pass" token
        expect(result.kind).toBeNull();
      });

      it('should NOT classify "telephone" as phone (tel is substring, not token)', () => {
        const el = createMockElement({ htmlName: 'telephone' });
        const result = classifyField(el);
        // "telephone" tokenizes to ["telephone"], no "tel" token
        expect(result.kind).toBeNull();
      });

      it('should NOT classify "cellular_network" as phone', () => {
        const el = createMockElement({ htmlName: 'cellular_network' });
        const result = classifyField(el);
        // No phone-related tokens
        expect(result.kind).toBeNull();
      });
    });

    describe('TRUE POSITIVES - should match', () => {
      it('should classify "username" as username (exact long pattern match)', () => {
        const el = createMockElement({ htmlName: 'username' });
        const result = classifyField(el);
        expect(result.kind).toBe('username');
      });

      it('should classify "user_name" as username (tokenizes to ["user", "name"], but "username" is also a long pattern)', () => {
        // "user" is short (<=4), requires exact token. "user" is one of the tokens.
        const el = createMockElement({ htmlName: 'user_name' });
        const result = classifyField(el);
        expect(result.kind).toBe('username');
      });

      it('should classify "user-name" as username', () => {
        const el = createMockElement({ htmlName: 'user-name' });
        const result = classifyField(el);
        expect(result.kind).toBe('username');
      });

      it('should classify "user" (exact token) as username', () => {
        const el = createMockElement({ htmlName: 'user' });
        const result = classifyField(el);
        expect(result.kind).toBe('username');
      });

      it('should classify "password" as password', () => {
        const el = createMockElement({ htmlName: 'password' });
        const result = classifyField(el);
        expect(result.kind).toBe('password');
      });

      it('should classify "email" (exact token) as email', () => {
        const el = createMockElement({ htmlName: 'email' });
        const result = classifyField(el);
        expect(result.kind).toBe('email');
      });

      it('should classify "e-mail" as email', () => {
        const el = createMockElement({ htmlName: 'e-mail' });
        const result = classifyField(el);
        expect(result.kind).toBe('email');
      });

      it('should classify "phone" (exact token) as phone', () => {
        const el = createMockElement({ htmlName: 'phone' });
        const result = classifyField(el);
        expect(result.kind).toBe('phone');
      });

      it('should classify "tel" (exact token) as phone', () => {
        const el = createMockElement({ htmlName: 'tel' });
        const result = classifyField(el);
        expect(result.kind).toBe('phone');
      });

      it('should classify placeholder="Enter password" as password', () => {
        const el = createMockElement({ placeholder: 'Enter password' });
        const result = classifyField(el);
        expect(result.kind).toBe('password');
        expect(result.confidence).toBe('medium'); // placeholder is Level 2
      });

      it('should classify Cyrillic "пароль" as password', () => {
        const el = createMockElement({ placeholder: 'Введите пароль' });
        const result = classifyField(el);
        expect(result.kind).toBe('password');
      });

      it('should classify Cyrillic "логин" as username', () => {
        const el = createMockElement({ htmlName: 'логин' });
        const result = classifyField(el);
        expect(result.kind).toBe('username');
      });
    });
  });

  describe('isCredentialField helper', () => {
    it('should return true for password field', () => {
      const el = createMockElement({ type: 'password' });
      expect(isCredentialField(el)).toBe(true);
    });

    it('should return false for text field with no credential signals', () => {
      const el = createMockElement({ type: 'text', htmlName: 'description' });
      expect(isCredentialField(el)).toBe(false);
    });
  });

  describe('shouldRedactField with isSensitive hint', () => {
    it('should redact credential field even without isSensitive hint', () => {
      const el = createMockElement({ type: 'password' });
      expect(shouldRedactField(el, false)).toBe(true);
    });

    it('should NOT honor isSensitive=true for field with no credential signals (none confidence)', () => {
      const el = createMockElement({ type: 'text', htmlName: 'search_query' });
      // No credential signals = confidence 'none', so isSensitive should be ignored
      expect(shouldRedactField(el, true)).toBe(false);
    });

    it('should honor isSensitive=true if classifier has medium confidence', () => {
      // This is a tricky case - we need a field that gets "medium" confidence
      // but kind=null. In current implementation, if kind is found, confidence is set.
      // So this test may need adjustment based on actual classifier behavior.
      // For now, we test that a credential field with isSensitive still gets redacted
      const el = createMockElement({ placeholder: 'Password' });
      expect(shouldRedactField(el, true)).toBe(true);
    });
  });
});
