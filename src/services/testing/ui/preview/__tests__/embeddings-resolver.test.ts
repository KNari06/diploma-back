/**
 * Unit tests for Embeddings Resolver Service V2
 * Tests multilingual support, candidate text building, structural filters, and decision policy
 */

import {
    applyStructuralFilters,
    buildCandidateText,
    sanitizeIntent,
} from '../embeddings-resolver.service';
import type { IntentStep, InteractiveNode } from '../preview.types';

describe('EmbeddingsResolverService', () => {
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
        type: 'fill',
        description: 'fill username field',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('fill username field');
    });

    it('should redact value from description', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'fill',
        description: 'fill username with secretpassword123',
        value: 'secretpassword123',
      };

      const result = sanitizeIntent(step);
      expect(result).toContain('[VALUE]');
      expect(result).not.toContain('secretpassword123');
    });

    it('should handle case-insensitive value redaction', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'fill',
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
        type: 'fill',
        description: longDescription,
      };

      const result = sanitizeIntent(step);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('should trim whitespace', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'fill',
        description: '  fill username field  ',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('fill username field');
    });

    it('should handle empty description', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'fill',
        description: '',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('');
    });

    // Multilingual intent tests
    it('should preserve Russian intent', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'fill',
        description: 'введите логин пользователя',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('введите логин пользователя');
    });

    it('should preserve Kazakh intent', () => {
      const step: IntentStep = {
        id: 'step1',
        type: 'fill',
        description: 'құпия сөзді енгізіңіз',
      };

      const result = sanitizeIntent(step);
      expect(result).toBe('құпия сөзді енгізіңіз');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // applyStructuralFilters
  // ═══════════════════════════════════════════════════════════════════════════
  describe('applyStructuralFilters', () => {
    it('should pass visible, enabled elements', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        isDisabled: false,
      };

      const result = applyStructuralFilters(node, 'fill');
      expect(result.passed).toBe(true);
      expect(result.hardReject).toBe(false);
    });

    it('should hard reject invisible elements', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: false,
      };

      const result = applyStructuralFilters(node, 'fill');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
      expect(result.reason).toBe('Not visible');
    });

    it('should hard reject disabled elements', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        isDisabled: true,
      };

      const result = applyStructuralFilters(node, 'fill');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
      expect(result.reason).toBe('Disabled');
    });

    it('should hard reject readonly fields for fill actions', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        readOnly: true,
      };

      const result = applyStructuralFilters(node, 'fill');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
      expect(result.reason).toBe('Readonly field');
    });

    it('should allow readonly fields for click actions', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        readOnly: true,
      };

      const result = applyStructuralFilters(node, 'click');
      expect(result.passed).toBe(true);
    });

    it('should hard reject already checked elements for check action', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        checked: true,
      };

      const result = applyStructuralFilters(node, 'check');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
      expect(result.reason).toContain('Already');
    });

    it('should hard reject already unchecked elements for uncheck action', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        checked: false,
      };

      const result = applyStructuralFilters(node, 'uncheck');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
    });

    it('should hard reject already open elements for open action', () => {
      const node: InteractiveNode = {
        tag: 'button',
        isVisible: true,
        ariaExpanded: true,
      };

      const result = applyStructuralFilters(node, 'open');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
    });

    it('should hard reject already closed elements for close action', () => {
      const node: InteractiveNode = {
        tag: 'button',
        isVisible: true,
        ariaExpanded: false,
      };

      const result = applyStructuralFilters(node, 'close');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
    });

    it('should soft-flag elements covered by overlay', () => {
      const node: InteractiveNode = {
        tag: 'button',
        isVisible: true,
        isTopMostAtCenter: false,
      };

      const result = applyStructuralFilters(node, 'click');
      expect(result.passed).toBe(true);
      expect(result.hardReject).toBe(false);
      expect(result.reason).toBe('Covered by overlay');
    });

    it('should pass elements that are topmost', () => {
      const node: InteractiveNode = {
        tag: 'button',
        isVisible: true,
        isTopMostAtCenter: true,
      };

      const result = applyStructuralFilters(node, 'click');
      expect(result.passed).toBe(true);
      expect(result.reason).toBeUndefined();
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
});
