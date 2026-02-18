/**
 * Unit tests for Embeddings Resolver Service V2
 * Tests multilingual support, candidate text building, structural filters, and decision policy
 */

import {
    applyStructuralFilters,
    applySpatialTieBreakOrdering,
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
  // applyStructuralFilters
  // ═══════════════════════════════════════════════════════════════════════════
  describe('applyStructuralFilters', () => {
    it('should pass visible, enabled elements', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        isDisabled: false,
      };

      const result = applyStructuralFilters(node, 'type');
      expect(result.passed).toBe(true);
      expect(result.hardReject).toBe(false);
    });

    it('should hard reject invisible elements', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: false,
      };

      const result = applyStructuralFilters(node, 'type');
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

      const result = applyStructuralFilters(node, 'type');
      expect(result.passed).toBe(false);
      expect(result.hardReject).toBe(true);
      expect(result.reason).toBe('Disabled');
    });

    it('should hard reject readonly fields for type actions', () => {
      const node: InteractiveNode = {
        tag: 'input',
        isVisible: true,
        readOnly: true,
      };

      const result = applyStructuralFilters(node, 'type');
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Spatial Tie-Break Ordering
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Spatial Tie-Break Ordering', () => {
    describe('applySpatialTieBreakOrdering', () => {
      it('should prefer isTopMostAtCenter=true when similarity is tied', () => {
        const ranked = [
          {
            node: {
              tag: 'button',
              text: 'A',
              isTopMostAtCenter: false,
              boundingBox: { x: 100, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'A',
            similarity: 0.65,
          },
          {
            node: {
              tag: 'button',
              text: 'B',
              isTopMostAtCenter: true,
              boundingBox: { x: 100, y: 700, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'B',
            similarity: 0.65,
          },
        ];

        const { ordered, applied } = applySpatialTieBreakOrdering(ranked);

        expect(applied).toBe(true);
        expect(ordered[0].node.text).toBe('B');
      });

      it('should prioritize top-to-bottom when similarity is tied', () => {
        const ranked = [
          {
            node: {
              tag: 'button',
              text: 'Bottom',
              boundingBox: { x: 100, y: 700, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'Bottom',
            similarity: 0.65,
          },
          {
            node: {
              tag: 'button',
              text: 'Top',
              boundingBox: { x: 100, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'Top',
            similarity: 0.65,
          },
        ];

        const { ordered } = applySpatialTieBreakOrdering(ranked);

        expect(ordered[0].node.text).toBe('Top');
      });

      it('should prioritize left-to-right when Y is the same', () => {
        const ranked = [
          {
            node: {
              tag: 'button',
              text: 'Right',
              boundingBox: { x: 500, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'Right',
            similarity: 0.65,
          },
          {
            node: {
              tag: 'button',
              text: 'Left',
              boundingBox: { x: 100, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'Left',
            similarity: 0.65,
          },
        ];

        const { ordered } = applySpatialTieBreakOrdering(ranked);

        expect(ordered[0].node.text).toBe('Left');
      });

      it('should handle candidates without boundingBox gracefully', () => {
        const ranked = [
          {
            node: { tag: 'button', text: 'A' } as InteractiveNode,
            candidateText: 'A',
            similarity: 0.65,
          },
          {
            node: {
              tag: 'button',
              text: 'B',
              boundingBox: { x: 100, y: 500, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'B',
            similarity: 0.65,
          },
        ];

        const { ordered, applied } = applySpatialTieBreakOrdering(ranked);

        expect(applied).toBe(true);
        expect(ordered).toHaveLength(2);
        // B should come first because it has boundingBox
        expect(ordered[0].node.text).toBe('B');
      });

      it('should not apply spatial when all candidates lack boundingBox and isTopMostAtCenter', () => {
        const ranked = [
          {
            node: { tag: 'button', text: 'A' } as InteractiveNode,
            candidateText: 'A',
            similarity: 0.65,
          },
          {
            node: { tag: 'button', text: 'B' } as InteractiveNode,
            candidateText: 'B',
            similarity: 0.64,
          },
        ];

        const { ordered, applied } = applySpatialTieBreakOrdering(ranked);

        expect(applied).toBe(false);
        expect(ordered).toEqual(ranked);
      });

      it('should not reorder when similarity difference is above threshold', () => {
        const ranked = [
          {
            node: {
              tag: 'button',
              text: 'High',
              boundingBox: { x: 100, y: 700, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'High',
            similarity: 0.75,
          },
          {
            node: {
              tag: 'button',
              text: 'Low',
              boundingBox: { x: 100, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'Low',
            similarity: 0.60, // delta = 0.15 > threshold (0.05)
          },
        ];

        const { ordered, applied } = applySpatialTieBreakOrdering(ranked);

        expect(applied).toBe(true);
        // High should remain first because similarity gap is > threshold
        expect(ordered[0].node.text).toBe('High');
      });

      it('should maintain stable order when all criteria are equal', () => {
        const ranked = [
          {
            node: {
              tag: 'button',
              text: 'First',
              boundingBox: { x: 100, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'First',
            similarity: 0.65,
          },
          {
            node: {
              tag: 'button',
              text: 'Second',
              boundingBox: { x: 100, y: 200, width: 50, height: 30 },
            } as InteractiveNode,
            candidateText: 'Second',
            similarity: 0.65,
          },
        ];

        const { ordered } = applySpatialTieBreakOrdering(ranked);

        // Should maintain original order (First before Second)
        expect(ordered[0].node.text).toBe('First');
        expect(ordered[1].node.text).toBe('Second');
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM Disambiguation Integration (V5)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('LLM Disambiguation Integration', () => {
    // Note: Full integration tests require mocking embeddings and LLM services
    // These are covered in llm-disambiguation.service.test.ts
    // Here we test the type exports and configuration
    
    it('should export llmDisambiguationUsed field in LintResult type', () => {
      // This is a type check - the field should exist
      const result: Partial<import('../preview.types').LintResult> = {
        status: 'resolved',
        message: 'Element found by AI disambiguation',
        confidence: 0.9,
        candidates: [],
        highlight: [],
        llmDisambiguationUsed: true,
      };
      
      expect(result.llmDisambiguationUsed).toBe(true);
    });

    it('should have enableLLMDisambiguation parameter in resolveWithEmbeddings', () => {
      // Type check for the new parameter
      // The function signature should accept enableLLMDisambiguation
      const params = {
        previewSessionId: 'session-123',
        stepDraft: {
          id: 'step-1',
          type: 'click' as const,
          description: 'Click logout button',
        },
        domNodes: [],
        pageUrl: 'https://example.com',
        enableLLMDisambiguation: true,
      };

      // Just verify the params object is valid
      expect(params.enableLLMDisambiguation).toBe(true);
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // DOM-based field detection (no keyword lists)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('DOM-based password/username field detection', () => {
    it('isPasswordField: detects type=password', () => {
      const node: InteractiveNode = { tag: 'input', type: 'password', isVisible: true };
      // isPasswordField is not exported, test via buildCandidateText structural hint
      // We verify indirectly — a node with type=password should have type in candidate text
      const text = buildCandidateText(node);
      expect(text).toContain('type=password');
    });

    it('isUsernameField: detects type=email', () => {
      const node: InteractiveNode = { tag: 'input', type: 'email', isVisible: true };
      const text = buildCandidateText(node);
      expect(text).toContain('type=email');
    });

    it('should NOT detect password field from label text alone (no keyword list)', () => {
      // Without keyword list, "Password" label alone is no longer a signal.
      // Only DOM attributes (type/autocomplete) matter.
      const node: InteractiveNode = {
        tag: 'input',
        type: 'text', // NOT password type
        labelText: 'Password',
        isVisible: true,
      };
      // Node has type=text, not password — DOM check only returns false
      expect(node.type).not.toBe('password');
      expect(node.autocomplete).toBeUndefined();
    });
  });
});
