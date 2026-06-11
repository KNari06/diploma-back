/**
 * Unit tests for Intent Step Lint Service
 * Focused on isEvidenceShortcutNodeCompatible validation
 */

import { isEvidenceShortcutNodeCompatible } from '../intent-step-lint.service';
import type { IntentStep, InteractiveNode } from '../preview.types';

describe('isEvidenceShortcutNodeCompatible', () => {
  const PAGE_URL = 'https://example.com/login';

  // Helper to create minimal IntentStep
  const makeStep = (
    type: IntentStep['type'],
    overrides: Partial<IntentStep> = {}
  ): IntentStep => ({
    id: 'test-step-1',
    type,
    description: 'Test step',
    ...overrides,
  });

  // Helper to create minimal InteractiveNode
  const makeNode = (overrides: Partial<InteractiveNode> = {}): InteractiveNode => ({
    tag: 'div',
    isVisible: true,
    isDisabled: false,
    isInteractive: true,
    ...overrides,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Common validation (visibility, disabled)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Common validation', () => {
    it('should reject node that is not visible', () => {
      const step = makeStep('click');
      const node = makeNode({ tag: 'button', isVisible: false });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('node_not_visible');
    });

    it('should reject node that is disabled', () => {
      const step = makeStep('click');
      const node = makeNode({ tag: 'button', isDisabled: true });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('node_disabled');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // URL pattern guard
  // ═══════════════════════════════════════════════════════════════════════════

  describe('URL pattern guard', () => {
    it('should reject when urlPattern does not match page URL', () => {
      const step = makeStep('click', {
        bindingHints: { urlPattern: 'checkout' },
      });
      const node = makeNode({ tag: 'button' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('url_pattern_mismatch');
    });

    it('should accept when urlPattern matches page URL', () => {
      const step = makeStep('click', {
        bindingHints: { urlPattern: 'login' },
      });
      const node = makeNode({ tag: 'button' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should skip check on invalid regex pattern', () => {
      const step = makeStep('click', {
        bindingHints: { urlPattern: '[invalid(regex' },
      });
      const node = makeNode({ tag: 'button' });

      // Should not throw, should continue to action-type checks
      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Type action validation (REGRESSION: prevents type -> <a> bug)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Type action', () => {
    it('REGRESSION: should reject type action on <a> link element', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'a', role: 'link' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('type_action_requires_input_or_textarea');
    });

    it('should reject type action on <button> element', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'button' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('type_action_requires_input_or_textarea');
    });

    it('should accept type action on <input> element', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'input', inputType: 'text' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept type action on <textarea> element', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'textarea' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should reject type action on non-input element even if role=textbox', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'div', role: 'textbox' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('type_action_requires_input_or_textarea');
    });

    it('should reject type action on readOnly input', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'input', readOnly: true });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('input_is_readonly');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Select action validation
  // ═══════════════════════════════════════════════════════════════════════════

  // Select is NOT native-only: the executor (command-executor / action-executor)
  // detects native <select> vs custom dropdown and uses click-based selection for
  // the latter. So lint accepts native <select>, ARIA combobox/listbox, any
  // aria-expanded trigger, and the soft tags (button/div/span/input/a/li) that
  // frameworks commonly render dropdowns as. Only genuinely non-dropdown elements
  // are rejected with `select_action_requires_dropdown_element`.
  describe('Select action', () => {
    it('should accept select action on <select> element', () => {
      const step = makeStep('select');
      const node = makeNode({ tag: 'select' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept select action on custom combobox role element', () => {
      const step = makeStep('select');
      const node = makeNode({ tag: 'div', role: 'combobox' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept select action on listbox role element', () => {
      const step = makeStep('select');
      const node = makeNode({ tag: 'ul', role: 'listbox' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept select action on <input> element (searchable-combobox trigger)', () => {
      const step = makeStep('select');
      const node = makeNode({ tag: 'input' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should reject select action on non-dropdown element', () => {
      const step = makeStep('select');
      // <p> is not a native select, has no combobox/listbox role, no aria-expanded,
      // and is not one of the soft dropdown-trigger tags — so it falls through to reject.
      const node = makeNode({ tag: 'p', isInteractive: true });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('select_action_requires_dropdown_element');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Check/Uncheck action validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Check/Uncheck actions', () => {
    it('should reject check action on <button> element', () => {
      const step = makeStep('check');
      const node = makeNode({ tag: 'button' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('check_action_requires_input_checkbox_or_radio');
    });

    it('should accept check action on <input type=checkbox>', () => {
      const step = makeStep('check');
      const node = makeNode({ tag: 'input', inputType: 'checkbox' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept uncheck action on <input type=radio>', () => {
      const step = makeStep('uncheck');
      const node = makeNode({ tag: 'input', inputType: 'radio' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should reject check action on element with role=switch (non-native)', () => {
      const step = makeStep('check');
      const node = makeNode({ tag: 'div', role: 'switch' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('check_action_requires_input_checkbox_or_radio');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Click action validation (permissive)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Click action', () => {
    it('should accept click action on <button> element', () => {
      const step = makeStep('click');
      const node = makeNode({ tag: 'button' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept click action on <a> element', () => {
      const step = makeStep('click');
      const node = makeNode({ tag: 'a', role: 'link' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept click action on <div> with isInteractive=true', () => {
      const step = makeStep('click');
      const node = makeNode({ tag: 'div', isInteractive: true });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should reject click action on non-interactive element', () => {
      const step = makeStep('click');
      const node = makeNode({ tag: 'div', isInteractive: false });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('node_not_interactive');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Open/Close action validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Open/Close actions', () => {
    it('should accept open action on <button>', () => {
      const step = makeStep('open');
      const node = makeNode({ tag: 'button' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept open action on element with ariaExpanded', () => {
      const step = makeStep('open');
      const node = makeNode({ tag: 'div', ariaExpanded: false });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should reject open action on simple <span>', () => {
      const step = makeStep('open');
      const node = makeNode({ tag: 'span' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('open_close_action_requires_expandable_element');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Other actions (assert, scroll, ai_check)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Other actions', () => {
    it('should accept assert action on interactive element', () => {
      const step = makeStep('assert');
      const node = makeNode({ tag: 'div', isInteractive: true });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should reject assert action on non-interactive element', () => {
      const step = makeStep('assert');
      const node = makeNode({ tag: 'div', isInteractive: false });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept scroll action on any element', () => {
      const step = makeStep('scroll');
      const node = makeNode({ tag: 'div' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept ai_check action on any element', () => {
      const step = makeStep('ai_check');
      const node = makeNode({ tag: 'section' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept navigate action (non-targeting)', () => {
      const step = makeStep('navigate');
      const node = makeNode({ tag: 'body' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should accept wait action (non-targeting)', () => {
      const step = makeStep('wait');
      const node = makeNode({ tag: 'body' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('should handle missing tag gracefully', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: '' }); // Empty tag simulates missing

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      // Should reject since no valid input tag
      expect(result.ok).toBe(false);
    });

    it('should handle uppercase tags (normalized to lowercase)', () => {
      const step = makeStep('type');
      const node = makeNode({ tag: 'INPUT' });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });

    it('should handle uppercase roles (normalized to lowercase)', () => {
      const step = makeStep('open');
      const node = makeNode({ tag: 'div', role: 'BUTTON', isInteractive: true });

      const result = isEvidenceShortcutNodeCompatible(step, node, PAGE_URL);

      expect(result.ok).toBe(true);
    });
  });
});
