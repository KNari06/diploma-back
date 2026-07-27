/**
 * Unit tests for buildRunBeforeLine — the "Run Before" sentence the mobile
 * agent's OPEN TEST CASE block carries.
 *
 * Context for the assertions below: a mobile session is created with the app's
 * data cleared, so a fresh session is always logged out. Before this line
 * existed the agent could not see that a login dependency was attached, and it
 * responded to a login screen by asking the user to navigate to the logged-in
 * screen by hand — an instruction nobody can act on. The tests pin the two
 * things that make the sentence useful: it names the dependency, and it points
 * at Run instead of at manual navigation or authored login steps.
 */

import { buildRunBeforeLine } from '../prompts';

describe('buildRunBeforeLine', () => {
  it('returns an empty string when the test case has no dependencies', () => {
    expect(buildRunBeforeLine(undefined)).toBe('');
    expect(buildRunBeforeLine([])).toBe('');
  });

  it('names each dependency so the agent can refer to it by name', () => {
    const line = buildRunBeforeLine([
      { id: 'a', name: 'Auth_login_with_correct_values_beka' },
    ]);

    expect(line).toContain('Auth_login_with_correct_values_beka');
    expect(line).toContain('1 "Run Before"');
  });

  it('lists every dependency when there is more than one', () => {
    const line = buildRunBeforeLine([
      { id: 'a', name: 'Login' },
      { id: 'b', name: 'Seed data' },
    ]);

    expect(line).toContain('2 "Run Before"');
    expect(line).toContain('"Login"');
    expect(line).toContain('"Seed data"');
  });

  it('tells the agent the dependency state is absent from the observed session', () => {
    const line = buildRunBeforeLine([{ id: 'a', name: 'Login' }]);

    expect(line).toContain('same device session');
    expect(line).toMatch(/NOT present in the session you are observing/);
  });

  it('directs the agent to Run rather than manual navigation or login steps', () => {
    const line = buildRunBeforeLine([{ id: 'a', name: 'Login' }]);

    expect(line).toMatch(/press Run/);
    expect(line).toMatch(/do NOT ask the user to navigate there by hand/);
    expect(line).toMatch(/do NOT author login\s+steps/);
  });

  it('ends with a newline so it concatenates cleanly into the block', () => {
    expect(buildRunBeforeLine([{ id: 'a', name: 'Login' }]).endsWith('\n')).toBe(true);
  });
});
