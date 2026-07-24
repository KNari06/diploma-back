/**
 * Executor prompt — create-vs-update scope resolution.
 *
 * Guards the duplicate-creation bug (CLAUDE.md Hard invariant #16c): when the
 * chat is bound to one existing test case, "save/update" must edit THAT case
 * (qa_update_test_case_steps), never spawn a duplicate (qa_create_test_case).
 * The behavior lives entirely in the prompt's TEST-CASE SCOPE block, so it is
 * asserted here at the prompt-builder boundary.
 */

import { buildExecutorPrompt } from '../executor-prompt';

const TC_ID = '11111111-2222-3333-4444-555555555555';

describe('buildExecutorPrompt — test-case scope (edit in place)', () => {
  it('directs save/update to qa_update_test_case_steps with the bound test case id', () => {
    const prompt = buildExecutorPrompt(undefined, 'proj-1', 'editor', undefined, undefined, TC_ID, 'Login Flow');
    expect(prompt).toContain('TEST-CASE SCOPE');
    expect(prompt).toContain('qa_update_test_case_steps');
    expect(prompt).toContain(`test_case_id="${TC_ID}"`);
  });

  it('forbids qa_create_test_case as a "save" and names the duplicate risk', () => {
    const prompt = buildExecutorPrompt(undefined, 'proj-1', 'editor', undefined, undefined, TC_ID);
    expect(prompt).toMatch(/Do NOT call qa_create_test_case/i);
    expect(prompt).toMatch(/duplicate/i);
  });

  it('interpolates the test case name and id into the scope label', () => {
    const prompt = buildExecutorPrompt(undefined, undefined, 'editor', undefined, undefined, TC_ID, 'Checkout Flow');
    expect(prompt).toContain(`"Checkout Flow" (id ${TC_ID})`);
  });

  it('uses an id-only label and no "undefined" when no name is given', () => {
    const prompt = buildExecutorPrompt(undefined, undefined, 'editor', undefined, undefined, TC_ID);
    expect(prompt).toContain(`id ${TC_ID}`);
    expect(prompt).not.toContain('"undefined"');
  });
});

describe('buildExecutorPrompt — grounding (never fabricate input values)', () => {
  it('forbids fabricated credential literals and offers ask-or-placeholder in editor mode', () => {
    const prompt = buildExecutorPrompt(undefined, 'proj-1', 'editor');
    expect(prompt).toContain('GROUNDING');
    // Names the concrete fabricated literals the agent must NOT emit.
    expect(prompt).toMatch(/valid\.email@example\.com|test@example\.com|password123/);
    // Both sanctioned moves are present: ask the user, or use a {{placeholder}}.
    // The placeholder MUST use the secrets.* namespace — the only one
    // resolvePlaceholders + redaction recognise (a made-up namespace never
    // resolves and is never masked). Guard against reintroducing that.
    expect(prompt).toMatch(/\{\{secrets\.[^}]*login[^}]*\}\}/i);
    expect(prompt).not.toMatch(/\{\{login\./);
    expect(prompt).toMatch(/ASK/);
    // Steers away from the uncapturable live-authoring tool for missing creds.
    expect(prompt).toContain('qa_author_test_iteratively');
  });
});

describe('buildExecutorPrompt — global scope (no bound test case)', () => {
  it('omits the TEST-CASE SCOPE block and its anti-duplicate directive when no testCaseId is present', () => {
    const prompt = buildExecutorPrompt(undefined, 'proj-1', 'editor');
    expect(prompt).not.toContain('TEST-CASE SCOPE');
    // The generic "don't create until save" rule still lives in EDITOR MODE; it's
    // the duplicate-specific directive that must be absent outside test-case scope.
    expect(prompt).not.toMatch(/duplicate/i);
  });

  it('leaves creating a new test case unconstrained in global chat', () => {
    const prompt = buildExecutorPrompt(undefined, 'proj-1', 'lite');
    expect(prompt).not.toContain('TEST-CASE SCOPE');
  });
});
