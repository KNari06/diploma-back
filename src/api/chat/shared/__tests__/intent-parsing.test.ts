/**
 * Unit tests for intent-parsing.ts pure functions
 */

import { buildIntentMessage } from '../intent-parsing';
import { IntentResult } from '@/types';

describe('intent-parsing', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // buildIntentMessage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('buildIntentMessage', () => {
    it('should return default message for null input', () => {
      const result = buildIntentMessage(null);
      expect(result).toBe('🤔 Understanding your request...');
    });

    it('should return default message for undefined input', () => {
      const result = buildIntentMessage(undefined);
      expect(result).toBe('🤔 Understanding your request...');
    });

    // API test intent
    describe('api_test intent', () => {
      it('should return message with method and URL when both provided', () => {
        const intent: IntentResult = {
          intent: 'api_test',
          apiMethod: 'GET',
          apiUrl: 'https://api.example.com/users',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🔍 Got it! Testing GET https://api.example.com/users');
      });

      it('should include urgency emoji for high urgency', () => {
        const intent: IntentResult = {
          intent: 'api_test',
          apiMethod: 'POST',
          apiUrl: '/api/users',
          urgency: 'high',
        };

        const result = buildIntentMessage(intent);
        expect(result).toContain('⚡');
        expect(result).toContain('POST /api/users');
      });

      it('should return message with just URL when method not provided', () => {
        const intent: IntentResult = {
          intent: 'api_test',
          apiUrl: 'https://api.example.com/users',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🔍 Got it! Testing API endpoint https://api.example.com/users');
      });

      it('should return generic message when no URL or method', () => {
        const intent: IntentResult = {
          intent: 'api_test',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🔍 Got it! You want to test an API endpoint');
      });
    });

    // Platform test intent
    describe('platform_test intent', () => {
      it('should return message with page, scope, and target', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
          page: 'https://example.com',
          scope: 'form',
          target: 'login form',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🌐 Got it! Testing login form on https://example.com');
      });

      it('should include urgency emoji for high urgency', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
          page: 'https://example.com',
          scope: 'form',
          target: 'login form',
          urgency: 'high',
        };

        const result = buildIntentMessage(intent);
        expect(result).toContain('⚡');
      });

      it('should return message with page and scope only', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
          page: 'https://example.com',
          scope: 'full',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🌐 Got it! Testing full on https://example.com');
      });

      it('should return message with scope and target only', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
          scope: 'element',
          target: 'Buy button',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🌐 Got it! Testing Buy button (element)');
      });

      it('should return message with page only', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
          page: 'https://example.com',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🌐 Got it! Testing website https://example.com');
      });

      it('should return generic message when no specifics', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('🌐 Got it! You want to test a website');
      });
    });

    // Clarification intent
    describe('needs_clarification intent', () => {
      it('should return GPT-generated question when available', () => {
        const intent: IntentResult = {
          intent: 'needs_clarification',
          clarificationQuestion: 'Are you trying to test a login form or API?',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('❓ Are you trying to test a login form or API?');
      });

      it('should return default clarification message when question is empty', () => {
        const intent: IntentResult = {
          intent: 'needs_clarification',
          clarificationQuestion: '   ',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('❓ I need a bit more information to help you better');
      });

      it('should return default clarification message when no question', () => {
        const intent: IntentResult = {
          intent: 'needs_clarification',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('❓ I need a bit more information to help you better');
      });
    });

    // General chat intent
    describe('general_chat intent', () => {
      it('should return general chat message', () => {
        const intent: IntentResult = {
          intent: 'general_chat',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('💬 Got it! Let me help you with that');
      });
    });

    // Unknown/default intent
    describe('unknown intent', () => {
      it('should return default message for unknown intent', () => {
        const intent: IntentResult = {
          intent: 'some_unknown_intent',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('✅ Intent understood!');
      });
    });

    // Edge cases
    describe('edge cases', () => {
      it('should handle empty string intent', () => {
        const intent: IntentResult = {
          intent: '',
        };

        const result = buildIntentMessage(intent);
        expect(result).toBe('✅ Intent understood!');
      });

      it('should handle very long URL gracefully', () => {
        const longUrl = 'https://api.example.com/' + 'a'.repeat(500);
        const intent: IntentResult = {
          intent: 'api_test',
          apiMethod: 'GET',
          apiUrl: longUrl,
        };

        const result = buildIntentMessage(intent);
        expect(result).toContain('GET');
        expect(result).toContain('api.example.com');
      });

      it('should handle special characters in target', () => {
        const intent: IntentResult = {
          intent: 'platform_test',
          scope: 'element',
          target: 'Button with <special> & "chars"',
        };

        const result = buildIntentMessage(intent);
        expect(result).toContain('Button with <special>');
      });
    });
  });
});
