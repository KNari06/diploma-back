import {
  AgentHintError,
  notFoundHint,
  validationHint,
  authHint,
  buildAgentHint,
  formatAgentHint,
  shouldEnrichWithHint,
} from '../agent-hint';

describe('AgentHintError', () => {
  it('carries the suggestions it was given verbatim', () => {
    const err = new AgentHintError('boom', ['do this', 'then that'], 'GENERIC');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(err.code).toBe('GENERIC');
    expect(err.suggestions).toEqual(['do this', 'then that']);
  });

  it('falls back to category default suggestions when none are given', () => {
    const err = new AgentHintError('missing', undefined, 'NOT_FOUND');
    expect(err.suggestions.length).toBeGreaterThan(0);
    expect(err.suggestions[0]).toMatch(/verify the id/i);
  });

  it('factory helpers set the matching code and defaults', () => {
    expect(notFoundHint('nope').code).toBe('NOT_FOUND');
    expect(validationHint('bad').code).toBe('VALIDATION');
    expect(authHint('denied').code).toBe('AUTH');
    expect(validationHint('bad').suggestions[0]).toMatch(/required fields/i);
  });
});

describe('buildAgentHint', () => {
  it('maps a "not found" error to NOT_FOUND suggestions', () => {
    const hint = buildAgentHint(new Error('Test case 42 not found'));
    expect(hint.message).toBe('Test case 42 not found');
    expect(hint.suggestions[0]).toMatch(/verify the id/i);
    expect(hint.suggestions.some(s => /list the available/i.test(s))).toBe(true);
  });

  it('maps a "401 unauthorized" error to AUTH suggestions', () => {
    const hint = buildAgentHint(new Error('401 Unauthorized'));
    expect(hint.suggestions.some(s => /token is valid|permission/i.test(s))).toBe(true);
  });

  it('maps a validation error to VALIDATION suggestions', () => {
    const hint = buildAgentHint(new Error('name is required'));
    expect(hint.suggestions.some(s => /required fields/i.test(s))).toBe(true);
  });

  it('leaves an unrecognized error undecorated (no suggestions)', () => {
    const hint = buildAgentHint(new Error('something exploded'));
    expect(hint.message).toBe('something exploded');
    expect(hint.suggestions).toEqual([]);
    // formatAgentHint must return it unchanged — no "Suggestions:" header added.
    expect(formatAgentHint(hint)).toBe('something exploded');
  });

  it('passes an AgentHintError message and suggestions through verbatim', () => {
    const err = new AgentHintError('custom failure', ['step one', 'step two'], 'VALIDATION');
    const hint = buildAgentHint(err);
    expect(hint.message).toBe('custom failure');
    expect(hint.suggestions).toEqual(['step one', 'step two']);
  });

  it('handles a non-Error value without throwing', () => {
    const hint = buildAgentHint('plain string failure');
    expect(hint.message).toBe('plain string failure');
    // Unclassifiable string → conservative: no suggestions.
    expect(hint.suggestions).toEqual([]);
  });
});

describe('shouldEnrichWithHint', () => {
  it('returns false for a confirm-preview / write-guard message', () => {
    expect(
      shouldEnrichWithHint('This WRITE operation requires confirmation. Re-run with confirm=true.'),
    ).toBe(false);
  });

  it('returns false for a message that already has a Suggestions list', () => {
    expect(shouldEnrichWithHint('It broke\n\nSuggestions:\n- Check A')).toBe(false);
  });

  it('returns false for an ambiguity message that already gives guidance', () => {
    expect(
      shouldEnrichWithHint('Multiple test cases match "login" — please specify the exact name.'),
    ).toBe(false);
  });

  it('returns false for a terminal abort message', () => {
    expect(shouldEnrichWithHint('Request aborted before execution')).toBe(false);
  });

  it('returns false for an empty message', () => {
    expect(shouldEnrichWithHint('')).toBe(false);
  });

  it('returns false for an already-enumerated hint', () => {
    expect(shouldEnrichWithHint('Could not resolve. This could be (1) a typo or (2) no access.')).toBe(false);
  });

  it('returns true for a plain not-found failure', () => {
    expect(shouldEnrichWithHint('Test case not found: abc')).toBe(true);
  });

  it('returns true for a plain module-not-found failure', () => {
    expect(shouldEnrichWithHint('Module not found: 5')).toBe(true);
  });
});

describe('formatAgentHint', () => {
  it('renders the message plus a bulleted suggestions list', () => {
    const rendered = formatAgentHint({
      message: 'It broke',
      suggestions: ['Check A', 'Check B'],
    });
    expect(rendered).toBe('It broke\n\nSuggestions:\n- Check A\n- Check B');
  });

  it('renders only the message when there are no suggestions', () => {
    expect(formatAgentHint({ message: 'lonely', suggestions: [] })).toBe('lonely');
  });
});
