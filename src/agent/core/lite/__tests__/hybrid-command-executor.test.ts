/**
 * PR-Hybrid: Tests for CommandExecutor interceptor helpers.
 *
 * Covers the two pure-function entry points used by the hybrid executor:
 *   - REF_BASED_COMMANDS: the allow-list for SafetyInterceptor invocation
 *   - buildPrelimCommand: converts tool-call args to a preliminary AICommand
 *
 * These tests prevent two classes of silent regression:
 *   1. Drift between REF_BASED_COMMANDS and the actual switch/case dispatch
 *      in CommandExecutor.execute() — if a new command is added to the
 *      dispatch but not to the set, it bypasses SafetyInterceptor.
 *   2. Shape errors in preliminary AICommand construction — wrong field
 *      names, wrong action types, or missing `ref` propagation.
 */

import {
  REF_BASED_COMMANDS,
  buildPrelimCommand,
} from '../pipeline/command-executor';
import type { CommandName } from '../pipeline/types';

describe('REF_BASED_COMMANDS', () => {
  it('includes all ref-carrying commands', () => {
    const expected: CommandName[] = [
      'click_element',
      'fill_field',
      'select_option',
      'hover_element',
      'scroll_to_element',
      'toggle_element',
      'set_range',
      'select_date',
      'clear_field',
    ];
    for (const cmd of expected) {
      expect(REF_BASED_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it('excludes terminal commands (must never be blocked by interceptor)', () => {
    expect(REF_BASED_COMMANDS.has('mark_done')).toBe(false);
    expect(REF_BASED_COMMANDS.has('report_blocked')).toBe(false);
  });

  it('excludes meta commands that have no ref', () => {
    expect(REF_BASED_COMMANDS.has('observe_page')).toBe(false);
    expect(REF_BASED_COMMANDS.has('navigate_to')).toBe(false);
    expect(REF_BASED_COMMANDS.has('press_key')).toBe(false);
    expect(REF_BASED_COMMANDS.has('scroll_page')).toBe(false);
    expect(REF_BASED_COMMANDS.has('wait_for_page')).toBe(false);
  });
});

describe('buildPrelimCommand', () => {
  describe('returns null when args lack a ref', () => {
    it('null for click_element without ref', () => {
      expect(buildPrelimCommand('click_element', {})).toBeNull();
    });

    it('null for fill_field without ref', () => {
      expect(buildPrelimCommand('fill_field', { value: 'hello' })).toBeNull();
    });
  });

  describe('returns null for non-ref commands', () => {
    it('null for observe_page', () => {
      expect(buildPrelimCommand('observe_page', { ref: 'e0' })).toBeNull();
    });

    it('null for navigate_to', () => {
      expect(
        buildPrelimCommand('navigate_to', { url: 'https://example.com' }),
      ).toBeNull();
    });

    it('null for mark_done', () => {
      expect(buildPrelimCommand('mark_done', { reason: 'done' })).toBeNull();
    });

    it('null for report_blocked', () => {
      expect(
        buildPrelimCommand('report_blocked', { reason: 'blocked' }),
      ).toBeNull();
    });

    it('null for press_key', () => {
      expect(buildPrelimCommand('press_key', { key: 'Enter' })).toBeNull();
    });
  });

  describe('click_element', () => {
    it('builds click command with ref', () => {
      const cmd = buildPrelimCommand('click_element', { ref: 'e5' });
      expect(cmd).toEqual({ action: 'click', ref: 'e5' });
    });
  });

  describe('fill_field', () => {
    it('builds fill command with value when non-sensitive', () => {
      const cmd = buildPrelimCommand('fill_field', {
        ref: 'e3',
        value: 'user@example.com',
      });
      expect(cmd).toEqual({
        action: 'fill',
        ref: 'e3',
        value: 'user@example.com',
        isSensitive: false,
      });
    });

    it('scrubs value to placeholder when is_sensitive=true (PR-Hybrid fix 6)', () => {
      // Security invariant: the real credential must NEVER propagate to
      // the preliminary command. This prevents accidental credential leaks
      // via SafetyInterceptor logs, trace events, or insights. The real
      // credential is injected later by overrideCredentialFillValue in
      // the command handler.
      const cmd = buildPrelimCommand('fill_field', {
        ref: 'e4',
        value: 'hunter2',
        is_sensitive: true,
      });
      expect(cmd).toEqual({
        action: 'fill',
        ref: 'e4',
        value: '[SENSITIVE]',
        isSensitive: true,
      });
      // Critical: original value must NOT appear in the preliminary command
      expect(cmd?.value).not.toBe('hunter2');
      expect(cmd?.value).not.toContain('hunter');
    });

    it('preserves value when is_sensitive is explicitly false', () => {
      const cmd = buildPrelimCommand('fill_field', {
        ref: 'e4',
        value: 'plaintext',
        is_sensitive: false,
      });
      expect(cmd?.value).toBe('plaintext');
    });

    it('treats missing is_sensitive as non-sensitive (value preserved for PII check)', () => {
      // Important: Policy 4 (PII leak detection) in SafetyInterceptor runs
      // regex against value to catch SSN/credit-card patterns when the LLM
      // forgot to mark a field as sensitive. Value MUST propagate here.
      const cmd = buildPrelimCommand('fill_field', {
        ref: 'e4',
        value: '4111-1111-1111-1111',
      });
      expect(cmd?.value).toBe('4111-1111-1111-1111');
      expect(cmd?.isSensitive).toBe(false);
    });

    it('defaults missing value to empty string for non-sensitive', () => {
      const cmd = buildPrelimCommand('fill_field', { ref: 'e5' });
      expect(cmd?.value).toBe('');
      expect(cmd?.isSensitive).toBe(false);
    });

    it('still uses placeholder for sensitive even if value is missing', () => {
      const cmd = buildPrelimCommand('fill_field', {
        ref: 'e5',
        is_sensitive: true,
      });
      expect(cmd?.value).toBe('[SENSITIVE]');
    });
  });

  describe('select_option', () => {
    it('builds select command with value', () => {
      const cmd = buildPrelimCommand('select_option', {
        ref: 'e1',
        value: 'US',
      });
      expect(cmd).toEqual({ action: 'select', ref: 'e1', value: 'US' });
    });
  });

  describe('hover_element', () => {
    it('builds hover command', () => {
      const cmd = buildPrelimCommand('hover_element', { ref: 'e7' });
      expect(cmd).toEqual({ action: 'hover', ref: 'e7' });
    });
  });

  describe('scroll_to_element', () => {
    it('builds scroll command with targetRef set to ref', () => {
      const cmd = buildPrelimCommand('scroll_to_element', { ref: 'e9' });
      expect(cmd).toEqual({ action: 'scroll', ref: 'e9', targetRef: 'e9' });
    });
  });

  describe('toggle_element', () => {
    it('builds toggle command', () => {
      const cmd = buildPrelimCommand('toggle_element', { ref: 'e2' });
      expect(cmd).toEqual({ action: 'toggle', ref: 'e2' });
    });
  });

  describe('set_range', () => {
    it('builds setRange command with stringified value', () => {
      const cmd = buildPrelimCommand('set_range', { ref: 'e6', value: 50 });
      expect(cmd).toEqual({ action: 'setRange', ref: 'e6', value: '50' });
    });
  });

  describe('select_date', () => {
    it('builds selectDate command with stringified value', () => {
      const cmd = buildPrelimCommand('select_date', {
        ref: 'e8',
        value: '2026-04-08',
      });
      expect(cmd).toEqual({
        action: 'selectDate',
        ref: 'e8',
        value: '2026-04-08',
      });
    });
  });

  describe('clear_field', () => {
    it('builds clear command', () => {
      const cmd = buildPrelimCommand('clear_field', { ref: 'e10' });
      expect(cmd).toEqual({ action: 'clear', ref: 'e10' });
    });
  });

  describe('contract consistency', () => {
    it('every REF_BASED_COMMANDS entry produces a non-null command when given a ref', () => {
      for (const name of REF_BASED_COMMANDS) {
        const cmd = buildPrelimCommand(name, {
          ref: 'e0',
          value: 'test',
          is_sensitive: false,
        });
        expect(cmd).not.toBeNull();
        expect(cmd?.ref).toBe('e0');
      }
    });
  });
});
