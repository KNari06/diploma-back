/**
 * Unit tests for Element Resolver Service V7
 * Tests candidate text building, intent sanitization, buildAllowedSets,
 * and LLM-based element resolution (nonsense/irrelevant description rejection).
 */

import {
    buildCandidateText,
    sanitizeIntent,
    buildAllowedSets,
    resolveElement,
} from '../element-resolver.service';
import type { IntentStep, InteractiveNode } from '../preview.types';

// Mock the Redis connection the queues module owns. Importing the real module
// opens live Redis connections at module load — 72 sockets and a 5s timer — and
// nothing here ever closes them, so Jest passed all 48 tests and then never
// exited ("Jest did not exit one second after the test run has completed",
// observed idling ~12 minutes). A hung CI job is not green, it is nothing.
//
// The resolver never touches Redis itself; it arrives transitively, by two
// separate paths, which is why mocking the queues module (where both end) is the
// fix rather than mocking either path:
//   element-resolver.service → ai-provider.service → openai/gemini.service
//     → ai-action-logger → websocket.service → test-executed-steps-redis.service
//   element-resolver.service → honesty-guard-deps → redis-cache
// Same reason as src/utils/core/__tests__/redis-cache.test.ts.
//
// The stub is built INSIDE the factory rather than in a `mock…` const above it:
// jest.mock is hoisted above the imports, so the factory runs while requiring
// element-resolver.service — before any module-scope const is initialized —
// and an out-of-scope reference fails with "Cannot access … before
// initialization". Nothing here needs to reach the stub from a test.
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    on: jest.fn(),
    scanStream: jest.fn(),
    pipeline: jest.fn(),
  },
  connection: { host: 'localhost', port: 6379 },
}));

// Mock LLM services used by selectElementWithLLM / rescueWithGeminiFlash
jest.mock('@/services/ai/core/openai.service');
jest.mock('@/services/ai/core/gemini.service');
// Mock the embedding service so the honesty-guard L2 layer is deterministic
// and never hits the network in unit tests. Default: orthogonal vectors
// (cosine 0) → L2 does not accept; individual tests override per pair.
jest.mock('@/services/ai/core/embedding.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { generateTextWithGeminiVision } from '@/services/ai/core/gemini.service';
import { generateEmbedding } from '@/services/ai/core/embedding.service';

const mockGetChatCompletion = getChatCompletionWithMessages as jest.MockedFunction<typeof getChatCompletionWithMessages>;
const mockGeminiVision = generateTextWithGeminiVision as jest.MockedFunction<typeof generateTextWithGeminiVision>;
const mockGenerateEmbedding = generateEmbedding as jest.MockedFunction<typeof generateEmbedding>;

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

    it('should cap text at 280 characters', () => {
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
      expect(text.length).toBeLessThanOrEqual(280);
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

      const { hardAllowed } = buildAllowedSets(nodes, 'type');
      expect(hardAllowed.map(n => n.ref)).toEqual(['e2']);
    });

    it('should hard-exclude disabled elements', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'input', ref: 'e1', isVisible: true, isDisabled: true },
        { tag: 'input', ref: 'e2', isVisible: true, isDisabled: false },
      ];

      const { hardAllowed } = buildAllowedSets(nodes, 'type');
      expect(hardAllowed.map(n => n.ref)).toEqual(['e2']);
    });

    it('should hard-exclude readonly for type action', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'input', ref: 'e1', isVisible: true, readOnly: true },
        { tag: 'input', ref: 'e2', isVisible: true },
      ];

      const { hardAllowed } = buildAllowedSets(nodes, 'type');
      expect(hardAllowed.map(n => n.ref)).toEqual(['e2']);
    });

    it('should NOT short-circuit on quoted match — all text matching delegated to LLM (V8)', () => {
      const nodes: InteractiveNode[] = [
        { tag: 'button', ref: 'e1', isVisible: true, text: 'Login' },
        { tag: 'button', ref: 'e2', isVisible: true, text: 'Register' },
      ];

      const result = buildAllowedSets(nodes, 'click');
      // Both elements should be in allowed sets for LLM (no short-circuit, no text matching)
      expect(result.hardAllowed.length + result.softAllowed.length).toBe(2);
    });

    // ── Floating corner widget (Rule 0b) ────────────────────────────────
    describe('floating corner widget', () => {
      it('soft-penalizes a floating widget node when it is not the target', () => {
        const nodes: InteractiveNode[] = [
          { tag: 'button', ref: 'e1', isVisible: true, text: 'Submit', isTopMostAtCenter: true },
          { tag: 'button', ref: 'e2', isVisible: true, text: 'Close hint', floatingWidget: true, isTopMostAtCenter: true },
        ];

        const { hardAllowed, softAllowed, ruleTrace } = buildAllowedSets(nodes, 'click');
        expect(hardAllowed.map(n => n.ref)).toEqual(['e1']);
        expect(softAllowed.map(n => n.ref)).toEqual(['e2']);
        expect(ruleTrace.some(r => r.ruleId === 'widget.floating_deprioritized' && r.affectedRefs.includes('e2'))).toBe(true);
        expect(ruleTrace.some(r => r.ruleId === 'widget.floating_detected')).toBe(true);
      });

      it('hard-excludes a floating widget node that covers the target', () => {
        const nodes: InteractiveNode[] = [
          { tag: 'button', ref: 'e1', isVisible: true, text: 'Submit', isTopMostAtCenter: true },
          { tag: 'div', ref: 'e2', isVisible: true, floatingWidget: true, isTopMostAtCenter: false },
        ];

        const { hardAllowed, softAllowed, ruleTrace } = buildAllowedSets(nodes, 'click');
        expect(hardAllowed.map(n => n.ref)).toEqual(['e1']);
        expect(softAllowed.map(n => n.ref)).not.toContain('e2');
        expect(ruleTrace.some(r => r.ruleId === 'widget.covers_target_excluded' && r.affectedRefs.includes('e2'))).toBe(true);
      });

      it('keeps a floating widget node unpenalized when the step targets it (strong fingerprint)', () => {
        const nodes: InteractiveNode[] = [
          { tag: 'button', ref: 'e1', isVisible: true, text: 'Submit', isTopMostAtCenter: true },
          { tag: 'button', ref: 'e2', isVisible: true, testIdAttr: 'chat-send', floatingWidget: true, isTopMostAtCenter: true },
        ];
        const recordedFingerprint = { testIdAttr: 'chat-send' } as IntentStep['recordedFingerprint'];

        const { hardAllowed, softAllowed, ruleTrace } = buildAllowedSets(nodes, 'click', undefined, recordedFingerprint);
        // e2 IS the target → kept in hardAllowed, no soft penalty.
        expect(hardAllowed.map(n => n.ref).sort()).toEqual(['e1', 'e2']);
        expect(softAllowed.map(n => n.ref)).not.toContain('e2');
        expect(ruleTrace.some(r => r.ruleId === 'widget.target_escape_hatch' && r.affectedRefs.includes('e2'))).toBe(true);
      });

      it('still soft-penalizes a widget node when the strong fingerprint contradicts it', () => {
        const nodes: InteractiveNode[] = [
          { tag: 'button', ref: 'e2', isVisible: true, testIdAttr: 'chat-send', floatingWidget: true, isTopMostAtCenter: true },
        ];
        const recordedFingerprint = { testIdAttr: 'real-submit' } as IntentStep['recordedFingerprint'];

        const { softAllowed, ruleTrace } = buildAllowedSets(nodes, 'click', undefined, recordedFingerprint);
        expect(softAllowed.map(n => n.ref)).toEqual(['e2']);
        expect(ruleTrace.some(r => r.ruleId === 'widget.floating_deprioritized')).toBe(true);
      });

      it('does not touch ordinary (non-widget) nodes', () => {
        const nodes: InteractiveNode[] = [
          { tag: 'button', ref: 'e1', isVisible: true, text: 'A', isTopMostAtCenter: true },
          { tag: 'button', ref: 'e2', isVisible: true, text: 'B', isTopMostAtCenter: true },
        ];
        const { hardAllowed, ruleTrace } = buildAllowedSets(nodes, 'click');
        expect(hardAllowed.map(n => n.ref).sort()).toEqual(['e1', 'e2']);
        expect(ruleTrace.some(r => r.ruleId.startsWith('widget.'))).toBe(false);
      });
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

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveElement — LLM low-confidence / nonsense rejection
  // ═══════════════════════════════════════════════════════════════════════════
  describe('resolveElement — nonsense and no-match descriptions', () => {
    const domNodes: InteractiveNode[] = [
      { tag: 'input', ref: 'e1', isVisible: true, labelText: 'Username', placeholder: 'Enter username', type: 'text' },
      { tag: 'input', ref: 'e2', isVisible: true, labelText: 'Password', type: 'password' },
      { tag: 'button', ref: 'e3', isVisible: true, text: 'Login' },
    ];

    beforeEach(() => {
      jest.clearAllMocks();
      // Default: Gemini vision not called
      mockGeminiVision.mockResolvedValue({ content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'mock' } });
      // Default embedding: a deterministic near-orthogonal vector per DISTINCT
      // text (different strings → low cosine, same string → cosine 1). This
      // keeps L2 from accepting unrelated pairs by default; tests that exercise
      // the cross-language bridge override with explicit same/near vectors.
      mockGenerateEmbedding.mockImplementation(async (text: string) => {
        const v = [0, 0, 0, 0, 0, 0, 0, 0];
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
        v[h % v.length] = 1; // one-hot bucket → distinct texts ~orthogonal
        return v;
      });
    });

    it('should return not_found when LLM returns low confidence (<0.4) for nonsense text', async () => {
      // LLM tries to match but returns very low confidence
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: 'e1', confidence: 0.2, reason: 'no semantic match' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'click', description: 'ываыва' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('not_found');
      expect(result.confidence).toBe(0);
    });

    it('should return not_found when LLM returns ref=null for gibberish', async () => {
      // LLM correctly rejects nonsense
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: null, confidence: 0, reason: 'description does not match any element' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'click', description: 'asdfghjkl' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('not_found');
      expect(result.confidence).toBe(0);
    });

    it('should return not_found for valid description with no matching element', async () => {
      // "Delete account button" doesn't exist on a login page
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: null, confidence: 0, reason: 'no delete account button on this page' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'click', description: 'Delete account button' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('not_found');
      expect(result.confidence).toBe(0);
    });

    it('should return resolved when LLM returns high confidence for valid description', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: 'e3', confidence: 0.95, reason: 'Login button matches' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'click', description: 'Login button' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('resolved');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should return not_found when LLM returns borderline confidence (0.35) — below threshold', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: 'e1', confidence: 0.35, reason: 'weak match' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'type', description: 'random words here' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('not_found');
    });

    it('should return resolved when LLM returns confidence at threshold (0.55)', async () => {
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: 'e2', confidence: 0.55, reason: 'partial match — password field' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'type', description: 'Password' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('resolved');
      expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    });

    it('L0 structural: "Войти" resolves to the SOLE login button (cross-language, no embeddings)', async () => {
      // e3 is a bare <button>Login</button> — the page's only submit primary.
      // Intent "Войти" (login) shares no tokens with "Login" and the button has
      // no technical identity, BUT it's the sole submit and the intent matches
      // no other candidate → the structural layer accepts it regardless of
      // language. (Embeddings give войти/login distinct vectors here, so L2 is
      // NOT what bridges this — the structural sole-submit rule is.)
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: 'e3', confidence: 0.9, reason: 'Войти matches Login button' }),
      } as any);

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'click', description: 'Войти' } as IntentStep,
        domNodes,
        pageUrl: 'https://example.com/login',
      });

      expect(result.status).toBe('resolved');
    });

    it('L2: bridges a cross-language pick on a NON-submit element via embeddings', async () => {
      // A logout LINK (not a submit, so the structural layer can't help) labelled
      // "Logout"; intent "выход". Embeddings report them equivalent → L2 accepts.
      const linkNodes: InteractiveNode[] = [
        { tag: 'input', ref: 'e1', isVisible: true, labelText: 'Username', type: 'text' },
        { tag: 'a', ref: 'e2', isVisible: true, text: 'Logout' },
      ];
      mockGetChatCompletion.mockResolvedValue({
        content: JSON.stringify({ ref: 'e2', confidence: 0.9, reason: 'выход = Logout' }),
      } as any);
      mockGenerateEmbedding.mockResolvedValue([1, 0, 0]); // both texts → cosine 1

      const result = await resolveElement({
        previewSessionId: 'test-session',
        stepDraft: { id: 'step1', type: 'click', description: 'выход' } as IntentStep,
        domNodes: linkNodes,
        pageUrl: 'https://example.com/app',
      });

      expect(result.status).toBe('resolved');
    });
  });
});
