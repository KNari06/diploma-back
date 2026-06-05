import { IntentStepConverterService } from '../intent-step-converter.service';
import type { IntentStep, TargetFingerprint } from '../preview.types';

/**
 * Regression guard for the 2026-06 auto-heal context fix: the converter must
 * forward `recordedFingerprint` and `recordedDescription` into `intentMeta` so
 * the background-replay heal resolver gets the same strong identity the editor
 * captured. Previously these were dropped, so regression heals resolved blind
 * (description + soft bindingHints only).
 */
describe('IntentStepConverter — forwards recorded identity for auto-heal', () => {
  const fingerprint: TargetFingerprint = {
    elementId: 'login-password',
    testIdAttr: 'passwordField',
    name: 'password',
    text: 'Пароль',
  } as TargetFingerprint;

  const baseStep: IntentStep = {
    id: 'step-1',
    type: 'type',
    description: 'password field',
    recordedFingerprint: fingerprint,
    recordedDescription: 'The password input on the login form',
  } as IntentStep;

  it('puts recordedFingerprint + recordedDescription into intentMeta', () => {
    const cmd = IntentStepConverterService.convertSingleStep(baseStep, 0, 'https://example.com');
    expect(cmd.intentMeta?.recordedFingerprint).toBeDefined();
    expect(cmd.intentMeta?.recordedFingerprint?.testIdAttr).toBe('passwordField');
    expect(cmd.intentMeta?.recordedFingerprint?.elementId).toBe('login-password');
    expect(cmd.intentMeta?.recordedDescription).toBe('The password input on the login form');
  });

  it('leaves intentMeta fingerprint undefined when the step has none (no crash)', () => {
    const bare: IntentStep = { id: 's2', type: 'click', description: 'submit' } as IntentStep;
    const cmd = IntentStepConverterService.convertSingleStep(bare, 1);
    expect(cmd.intentMeta?.recordedFingerprint).toBeUndefined();
    expect(cmd.intentMeta?.recordedDescription).toBeUndefined();
    // still forwards the basics
    expect(cmd.intentMeta?.intentDescription).toBe('submit');
  });
});
