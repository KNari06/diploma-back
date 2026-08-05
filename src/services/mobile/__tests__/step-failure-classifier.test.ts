import { classifyMobileFailure, deriveMobileHeal } from '../step-failure-classifier';

describe('classifyMobileFailure', () => {
  it('returns no reason for a step that did not fail', () => {
    expect(classifyMobileFailure({ error: undefined })).toBeUndefined();
  });

  it('maps the runner structured classification to a failure reason', () => {
    expect(
      classifyMobileFailure({
        error: 'boom',
        errorClassification: { type: 'element_not_found', confidence: 0.9, summary: '' },
      }),
    ).toBe('element_not_found');
  });

  it('reports a screen that moved on as a missing element', () => {
    expect(
      classifyMobileFailure({
        error: 'boom',
        errorClassification: { type: 'ui_change', confidence: 0.8, summary: '' },
      }),
    ).toBe('element_not_found');
  });

  it('reports an unresponsive app as a timeout', () => {
    expect(
      classifyMobileFailure({
        error: 'boom',
        errorClassification: { type: 'anr', confidence: 0.9, summary: '' },
      }),
    ).toBe('timeout');
  });

  it('prefers the structured classification over wording in the message', () => {
    // The message says "timed out" but the evidence says the element was gone.
    expect(
      classifyMobileFailure({
        error: 'Request timed out while looking for the button',
        errorClassification: { type: 'element_not_found', confidence: 0.9, summary: '' },
      }),
    ).toBe('element_not_found');
  });

  it('falls back to the resolver verdict when nothing was classified', () => {
    expect(classifyMobileFailure({ error: 'boom', resolvedVia: 'unresolved' })).toBe(
      'element_not_found',
    );
  });

  it('reports a resolve the runner refused to trust as a blocked heal', () => {
    expect(classifyMobileFailure({ error: 'boom', resolvedVia: 'low_confidence' })).toBe(
      'heal_blocked',
    );
  });

  it('reads a timeout out of the message only when there is nothing better', () => {
    expect(
      classifyMobileFailure({ error: 'Request timed out after 30000ms: POST /batch' }),
    ).toBe('timeout');
  });

  it('returns unknown for a classification it does not recognise', () => {
    expect(
      classifyMobileFailure({
        error: 'boom',
        errorClassification: { type: 'something_new', confidence: 0.5, summary: '' },
      }),
    ).toBe('unknown');
  });


  it('prefers a structured cause over the assertion step type', () => {
    // An ai_check that died because the app crashed is not an assertion
    // failure. Observed live: a connection_lost failure on an ai_check was
    // persisted as assertion_failed when this check ran first.
    expect(
      classifyMobileFailure(
        { error: 'connection_lost detected, relaunch succeeded, but retry failed',
          errorClassification: { type: 'app_crash', confidence: 0.9, summary: '' } },
        'ai_check',
      ),
    ).not.toBe('assertion_failed');
    expect(
      classifyMobileFailure(
        { error: 'boom', errorClassification: { type: 'anr', confidence: 0.9, summary: '' } },
        'ai_check',
      ),
    ).toBe('timeout');
  });

  it('reports a failed assertion step as an assertion failure', () => {
    // A confidently-failed ai_check carries no structured errorClassification,
    // so without the step type this persisted as the useless 'unknown'.
    expect(
      classifyMobileFailure({ error: 'The screen displays a login form, not a shop' }, 'ai_check'),
    ).toBe('assertion_failed');
    expect(classifyMobileFailure({ error: 'nope' }, 'assert_visible')).toBe('assertion_failed');
  });

  it('does not treat a non-assertion step type as an assertion failure', () => {
    expect(classifyMobileFailure({ error: 'boom', resolvedVia: 'unresolved' }, 'tap')).toBe(
      'element_not_found',
    );
  });

  it('does not resolve a reason off Object.prototype', () => {
    expect(
      classifyMobileFailure({
        error: 'boom',
        errorClassification: { type: 'constructor', confidence: 0.5, summary: '' },
      }),
    ).toBe('unknown');
  });
});

describe('deriveMobileHeal', () => {
  const priorStep = { bindingHints: { label: 'Sign in' } };

  /**
   * Captured verbatim from a live Flutter run (emulator-5554, 2026-08-04): the
   * same authored step, hinted `label: 'Sign in'`, run against a build where the
   * button had been relabelled to "Continue".
   *
   * The shape is the point of this fixture. `enrichedHints` carries NO label —
   * only a role — so the new label has to come off the freshly-built compiled
   * plan. An earlier implementation read `enrichedHints.label`, passed its
   * idealised unit tests, and would have reported this real heal as "not healed".
   */
  const liveRelabelResult = {
    success: true as const,
    enrichedHints: { role: 'FilledButton' },
    compiledPlan: {
      version: 1 as const,
      platform: 'flutter' as const,
      compiledAt: '2026-08-04T15:52:05.222Z',
      strategies: [
        { kind: 'creation_location', value: 'login_screen.dart:152:23' },
        {
          kind: 'contains_descendants',
          self: { role: 'FilledButton' },
          descendants: [{ text: 'Continue' }],
        },
      ],
      fingerprint: { role: 'FilledButton', siblingCount: 7 },
    },
  };

  it('reports the heal for a real relabel, reading the new label off the compiled plan', () => {
    const heal = deriveMobileHeal(priorStep, liveRelabelResult);

    expect(heal.healed).toBe(true);
    expect(heal.healedFrom).toBe('Sign in');
    expect(heal.healedTo).toBe('Continue');
    expect(heal.healWhatChanged).toContain('Continue');
  });

  it('reports no heal when the step failed', () => {
    expect(deriveMobileHeal(priorStep, { ...liveRelabelResult, success: false }).healed).toBe(
      false,
    );
  });

  it('reports no heal when the cheap text finder answered', () => {
    // The baseline case, verified live: resolvedVia 'flutter_finder_first'
    // returns neither enrichedHints nor a compiled plan.
    expect(deriveMobileHeal(priorStep, { success: true }).healed).toBe(false);
  });

  it('reports no heal on a step that had never resolved before', () => {
    // A first resolve is legitimately an LLM resolve, not a repair.
    expect(
      deriveMobileHeal({ bindingHints: undefined }, liveRelabelResult).healed,
    ).toBe(false);
  });

  it('reports no heal when the element still answers to the recorded label', () => {
    const unchanged = {
      ...liveRelabelResult,
      compiledPlan: {
        ...liveRelabelResult.compiledPlan,
        strategies: [{ kind: 'contains_descendants', descendants: [{ text: 'Sign in' }] }],
      },
    };

    expect(deriveMobileHeal(priorStep, unchanged).healed).toBe(false);
  });

  it('reports no heal when the new label cannot be named', () => {
    // Precision over recall: a wrong heal badge sends someone to review a step
    // that nothing happened to.
    expect(
      deriveMobileHeal(priorStep, { success: true, enrichedHints: { role: 'FilledButton' } })
        .healed,
    ).toBe(false);
  });

  it('prefers the plan fingerprint label when the builder provides one', () => {
    const withFingerprint = {
      ...liveRelabelResult,
      compiledPlan: {
        ...liveRelabelResult.compiledPlan,
        fingerprint: { role: 'FilledButton', label: 'Proceed' },
      },
    };

    expect(deriveMobileHeal(priorStep, withFingerprint).healedTo).toBe('Proceed');
  });

  it('survives a strategy shape it does not recognise', () => {
    const odd = {
      ...liveRelabelResult,
      compiledPlan: {
        ...liveRelabelResult.compiledPlan,
        strategies: [{ kind: 'future_thing', descendants: 'not-an-array' }],
      },
    };

    expect(deriveMobileHeal(priorStep, odd as never).healed).toBe(false);
  });


  it('anchors the "before" on the step\'s persisted compiled plan, not bindingHints', () => {
    // Verified live: the editor persists `compiled` and leaves `bindingHints`
    // null, so a heal must be derivable from the plan alone.
    const anchored = {
      bindingHints: undefined,
      compiled: {
        version: 1 as const,
        platform: 'flutter' as const,
        compiledAt: '2026-08-04T00:00:00.000Z',
        strategies: [{ kind: 'contains_descendants', descendants: [{ text: 'Sign in' }] }],
        fingerprint: { role: 'FilledButton' },
      },
    };

    const heal = deriveMobileHeal(anchored, liveRelabelResult);
    expect(heal.healed).toBe(true);
    expect(heal.healedFrom).toBe('Sign in');
    expect(heal.healedTo).toBe('Continue');
  });

  it('reports no heal when the anchored plan still names the same element', () => {
    const anchored = {
      bindingHints: undefined,
      compiled: {
        version: 1 as const,
        platform: 'flutter' as const,
        compiledAt: '2026-08-04T00:00:00.000Z',
        strategies: [{ kind: 'contains_descendants', descendants: [{ text: 'Continue' }] }],
        fingerprint: { role: 'FilledButton' },
      },
    };

    expect(deriveMobileHeal(anchored, liveRelabelResult).healed).toBe(false);
  });

  it('reports no heal when the resolver fell back to an ancestor', () => {
    // Observed live: with the CTA deleted the resolver matched the whole
    // LoginScreen (1440x3036), tapped it, reported success, and the app never
    // moved. Badging that as a recovery is worse than staying silent.
    const anchoredToControl = {
      bindingHints: undefined,
      compiled: {
        version: 1 as const,
        platform: 'flutter' as const,
        compiledAt: '2026-08-04T00:00:00.000Z',
        strategies: [{ kind: 'contains_descendants', descendants: [{ text: 'Sign in' }] }],
        fingerprint: { role: 'Text', boundsSize: { width: 1272, height: 168 } },
      },
    };
    const resolvedToScreen = {
      success: true as const,
      enrichedHints: { role: 'LoginScreen' },
      compiledPlan: {
        version: 1 as const,
        platform: 'flutter' as const,
        compiledAt: '2026-08-04T00:00:00.000Z',
        strategies: [{ kind: 'contains_descendants', descendants: [{ text: 'Welcome back' }] }],
        fingerprint: { role: 'LoginScreen', boundsSize: { width: 1440, height: 3036 } },
      },
    };

    expect(deriveMobileHeal(anchoredToControl, resolvedToScreen).healed).toBe(false);
  });

  it('still reports a heal when the element stayed about the same size', () => {
    const anchored = {
      bindingHints: undefined,
      compiled: {
        version: 1 as const,
        platform: 'flutter' as const,
        compiledAt: '2026-08-04T00:00:00.000Z',
        strategies: [{ kind: 'contains_descendants', descendants: [{ text: 'Sign in' }] }],
        fingerprint: { role: 'Text', boundsSize: { width: 1272, height: 168 } },
      },
    };
    const relabelled = {
      ...liveRelabelResult,
      compiledPlan: {
        ...liveRelabelResult.compiledPlan,
        fingerprint: { role: 'FilledButton', boundsSize: { width: 1272, height: 168 } },
      },
    };

    expect(deriveMobileHeal(anchored, relabelled).healedTo).toBe('Continue');
  });

  it('does not suppress a heal when bounds are unknown', () => {
    // Missing bounds means we do not know; an unknown must not veto a real heal.
    expect(deriveMobileHeal({ bindingHints: { label: 'Sign in' } }, liveRelabelResult).healed)
      .toBe(true);
  });

  it('ignores a whitespace-only recorded label', () => {
    expect(
      deriveMobileHeal({ bindingHints: { label: '   ' } }, liveRelabelResult).healed,
    ).toBe(false);
  });
});
