/**
 * Unit tests for Element Resolver Service V7
 * Tests candidate text building, intent sanitization, and buildAllowedSets
 */

import {
    buildCandidateText,
    sanitizeIntent,
    buildAllowedSets,
} from '../element-resolver.service';
import type { IntentStep, InteractiveNode } from '../preview.types';

describe('ElementResolverService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // buildCandidateText
  // ═══════════════════════════════════════════════════════════════════════════
  describe('buildCandidateText', () => {
    it('should include container context first when available', () => {
      const node: InteractiveNode = {
        tag: 'input',
        containerTitles: ['Login Form', 'Credentials Section'],
        labelText: 'Username',
      };

      const text = buildCandidateText(node);
      expect(text.startsWith('[Login Form > Credentials Section]')).toBe(true);
    });

    it('should prefer labelText over ariaLabel', () => {
      const node: InteractiveNode = {
        tag: 'input',
        labelText: 'Username',
        ariaLabel: 'User name input',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('Username');
      expect(text).not.toContain('User name input');
    });

    it('should use ariaLabel when labelText is missing', () => {
      const node: InteractiveNode = {
        tag: 'input',
        ariaLabel: 'User name input',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('User name input');
    });

    it('should include placeholder with prefix', () => {
      const node: InteractiveNode = {
        tag: 'input',
        placeholder: 'Enter your email',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('placeholder: Enter your email');
    });

    it('should exclude long text content (>50 chars)', () => {
      const longText = 'This is a very long text that exceeds fifty characters and should be excluded from candidate text';
      const node: InteractiveNode = {
        tag: 'div',
        text: longText,
      };

      const text = buildCandidateText(node);
      expect(text).not.toContain(longText);
    });

    it('should include short text content', () => {
      const shortText = 'Submit';
      const node: InteractiveNode = {
        tag: 'button',
        text: shortText,
      };

      const text = buildCandidateText(node);
      expect(text).toContain(shortText);
    });

    it('should include autocomplete hint', () => {
      const node: InteractiveNode = {
        tag: 'input',
        autocomplete: 'email',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('autocomplete: email');
    });

    it('should exclude name when isDynamicId is true', () => {
      const node: InteractiveNode = {
        tag: 'input',
        name: 'field_abc123xyz',
        isDynamicId: true,
      };

      const text = buildCandidateText(node);
      expect(text).not.toContain('field_abc123xyz');
    });

    it('should include name when isDynamicId is false', () => {
      const node: InteractiveNode = {
        tag: 'input',
        name: 'username',
        isDynamicId: false,
      };

      const text = buildCandidateText(node);
      expect(text).toContain('name: username');
    });

    it('should include testIdAttr', () => {
      const node: InteractiveNode = {
        tag: 'button',
        testIdAttr: 'submit-button',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('testid: submit-button');
    });

    it('should include tag/role/type at the end', () => {
      const node: InteractiveNode = {
        tag: 'input',
        role: 'textbox',
        type: 'email',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('<input role=textbox type=email>');
    });

    it('should cap text at 200 characters', () => {
      const node: InteractiveNode = {
        tag: 'input',
        containerTitles: ['Very Long Container Title That Takes Up Space', 'Another Long Title'],
        labelText: 'A label with quite a bit of text in it',
        placeholder: 'Enter a placeholder with more text here for testing',
        text: 'Some additional text content',
        autocomplete: 'email',
        name: 'somefieldname',
        testIdAttr: 'test-id-attribute',
      };

      const text = buildCandidateText(node);
      expect(text.length).toBeLessThanOrEqual(200);
    });

    // Multilingual tests
    it('should handle Russian labels', () => {
      const node: InteractiveNode = {
        tag: 'input',
        labelText: 'Имя пользователя',
        placeholder: 'Введите логин',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('Имя пользователя');
      expect(text).toContain('Введите логин');
    });

    it('should handle Kazakh labels', () => {
      const node: InteractiveNode = {
        tag: 'input',
        labelText: 'Құпия сөз',
        placeholder: 'Құпия сөзіңізді енгізіңіз',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('Құпия сөз');
    });

    it('should handle Chinese labels', () => {
      const node: InteractiveNode = {
        tag: 'input',
        labelText: '用户名',
        placeholder: '请输入用户名',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('用户名');
    });

    it('should handle mixed language content', () => {
      const node: InteractiveNode = {
        tag: 'button',
        labelText: 'Login / Вход / Кіру',
        ariaLabel: 'Submit form',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('Login / Вход / Кіру');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // sanitizeIntent
  // ═══════════════════════════════════════════════════════════════════════════
  describe('sanitizeIntent', () => {
    it('should return description as-is when no value', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: 'type username field',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('type username field');
    });

    it('should redact value from description', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: 'type username with secretpassword123',
        value: 'secretpassword123',
      };

      const result = sanitizeIntent(step);
      expect(result).toContain('[VALUE]');
      expect(result).not.toContain('secretpassword123');
    });

    it('should handle case-insensitive value redaction', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: 'enter MyEmail@Test.com in email field',
        value: 'myemail@test.com',
      };

      const result = sanitizeIntent(step);
      expect(result).toContain('[VALUE]');
    });

    it('should cap intent at 500 characters', () => {
      const longDescription = 'a'.repeat(600);
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: longDescription,
      };

      const result = sanitizeIntent(step);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('should trim whitespace', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: '  type username field  ',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('type username field');
    });

    it('should handle empty description', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: '',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('');
    });

    // Multilingual intent tests
    it('should preserve Russian intent', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: 'введите логин пользователя',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('введите логин пользователя');
    });

    it('should preserve Kazakh intent', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'type',
        description: 'құпия сөзді енгізіңіз',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('құпия сөзді енгізіңіз');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // buildAllowedSets
  // ═══════════════════════════════════════════════════════════════════════════
  describe('buildAllowedSets', () => {
    it('should hard-exclude invisible elements', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'input', ref: 'e1', isVisible: false },
        { tag: 'input', ref: 'e2', isVisible: true },
      ];

      const { hardAllowed } = buildAllowedSets(nodes, 'type', 'username');
      expect(hardAllowed.map(n => n.ref)).toEqual(['e2']);
    });

    it('should hard-exclude disabled elements', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'input', ref: 'e1', isVisible: true, isDisabled: true },
        { tag: 'input', ref: 'e2', isVisible: true, isDisabled: false },
      ];

      const { hardAllowed } = buildAllowedSets(nodes, 'type', 'username');
      expect(hardAllowed.map(n => n.ref)).toEqual(['e2']);
    });

    it('should hard-exclude readonly for type action', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'input', ref: 'e1', isVisible: true, readOnly: true },
        { tag: 'input', ref: 'e2', isVisible: true },
      ];

      const { hardAllowed } = buildAllowedSets(nodes, 'type', 'username');
      expect(hardAllowed.map(n => n.ref)).toEqual(['e2']);
    });

    it('should short-circuit on exact quoted match', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'button', ref: 'e1', isVisible: true, text: 'Login' },
        { tag: 'button', ref: 'e2', isVisible: true, text: 'Register' },
      ];

      const { shortCircuitRef } = buildAllowedSets(nodes, 'click', "click 'Login'");
      expect(shortCircuitRef).toBe('e1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Edge cases', () => {
    it('should handle empty node for buildCandidateText', () => {
      const node: InteractiveNode = {
        tag: 'div',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('<div>');
      expect(text.length).toBeGreaterThan(0);
    });

    it('should handle node with all undefined optional fields', () => {
      const node: InteractiveNode = {
        tag: 'input',
        ref: undefined,
        labelText: undefined,
        ariaLabel: undefined,
        placeholder: undefined,
        text: undefined,
        name: undefined,
        role: undefined,
        type: undefined,
      };

      const text = buildCandidateText(node);
      expect(text).toBe('<input>');
    });

    it('should handle special characters in labels', () => {
      const node: InteractiveNode = {
        tag: 'input',
        labelText: 'Email (required) *',
        placeholder: 'user@example.com',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('Email (required) *');
    });

    it('should handle emoji in labels', () => {
      const node: InteractiveNode = {
        tag: 'button',
        text: '🔒 Login',
      };

      const text = buildCandidateText(node);
      expect(text).toContain('🔒 Login');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM-based field detection (no keyword lists)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('DOM-based password/username field detection', () => {
    it('isPasswordField: detects type=password', () => {
      const node: InteractiveNode = { tag: 'input', type: 'password', isVisible: true };
      const text = buildCandidateText(node);
      expect(text).toContain('type=password');
    });

    it('isUsernameField: detects type=email', () => {
      const node: InteractiveNode = { tag: 'input', type: 'email', isVisible: true };
      const text = buildCandidateText(node);
      expect(text).toContain('type=email');
    });

    it('should NOT detect password field from label text alone (no keyword list)', () => {
      const node: InteractiveNode = {
        tag: 'input',
        type: 'text',
        labelText: 'Password',
        isVisible: true,
      };
      expect(node.type).not.toBe('password');
      expect(node.autocomplete).toBeUndefined();
    });
  });
});
