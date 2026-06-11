/**
 * Unit tests for composeStepDescription — the helper that builds the
 * human-readable step text persisted to the run report. Regression guard for
 * the bug where steps showed only the bare verb ("goto", "click") because the
 * old `elementDescription || action` chain never had elementDescription set.
 */
import { composeStepDescription } from '@/agent/playwright/core/step-description';

describe('composeStepDescription', () => {
  it('prefers elementDescription when present', () => {
    const cmd = { intentMeta: { elementDescription: 'the Sign in button' }, selector: '#x' };
    expect(composeStepDescription(cmd, 'click')).toBe('the Sign in button');
  });

  it('falls back to intentMeta.intentDescription', () => {
    const cmd = { intentMeta: { intentDescription: 'Click the Sign in button' } };
    expect(composeStepDescription(cmd, 'click')).toBe('Click the Sign in button');
  });

  it('falls back to command.description', () => {
    const cmd = { description: 'Navigate to https://app.example.com' };
    expect(composeStepDescription(cmd, 'goto')).toBe('Navigate to https://app.example.com');
  });

  it('composes verb + url when no description exists', () => {
    const cmd = { url: 'https://app.example.com/login' };
    expect(composeStepDescription(cmd, 'goto')).toBe('goto https://app.example.com/login');
  });

  it('composes verb + selector for an undescribed click', () => {
    const cmd = { selector: '#submit' };
    expect(composeStepDescription(cmd, 'click')).toBe('click #submit');
  });

  it('composes verb + value for an undescribed type', () => {
    const cmd = { value: 'test@example.com' };
    expect(composeStepDescription(cmd, 'type')).toBe('type test@example.com');
  });

  it('returns the bare action when there is no description and no target', () => {
    expect(composeStepDescription({}, 'waitFor')).toBe('waitFor');
    expect(composeStepDescription(null, 'aiCheck')).toBe('aiCheck');
  });

  it('ignores whitespace-only descriptions', () => {
    const cmd = { intentMeta: { intentDescription: '   ' }, selector: '#x' };
    expect(composeStepDescription(cmd, 'click')).toBe('click #x');
  });
});
