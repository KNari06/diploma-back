/**
 * Label + fixture extraction gaps (raw-results ZIP path).
 *
 * Covers three fidelity fixes verified against the allure-java schema:
 *   1. Fixture sub-steps → preconditions (a "Login" before-fixture with nested
 *      steps was importing as the single line "Login").
 *   2. BDD composite tags → severity / owner / links (Cucumber `KEY=value` and
 *      behave/JS `key:value`), instead of opaque tags.
 *   3. The Allure ID label (`AS_ID`) → an `allure_id:<n>` tag.
 */

import { extractLabels, flattenFixtureToPreconditions } from '../allure-mapper';
import type { AllureLabel, AllureStep } from '../allure-import.types';

const L = (name: string, value: string): AllureLabel => ({ name, value });

describe('flattenFixtureToPreconditions — fixture sub-steps', () => {
  it('keeps nested fixture leaf steps, not just the fixture name', () => {
    const fixture: AllureStep = {
      name: 'Login as admin',
      steps: [
        { name: 'Open login page' },
        { name: 'Enter credentials' },
        { name: 'Click submit' },
      ],
    };
    expect(flattenFixtureToPreconditions(fixture)).toEqual([
      'Login as admin',
      'Open login page',
      'Enter credentials',
      'Click submit',
    ]);
  });

  it('drops generic hook names (beforeEach/setUp) but keeps real sub-steps', () => {
    const fixture: AllureStep = {
      name: 'beforeEach',
      steps: [{ name: 'Seed test user' }],
    };
    expect(flattenFixtureToPreconditions(fixture)).toEqual(['Seed test user']);
  });

  it('handles a flat fixture with no sub-steps', () => {
    expect(flattenFixtureToPreconditions({ name: 'Given a clean DB' })).toEqual([
      'Given a clean DB',
    ]);
  });

  it('recurses nested fixture groups and de-duplicates', () => {
    const fixture: AllureStep = {
      name: 'Prepare account',
      steps: [
        { name: 'Auth', steps: [{ name: 'Get token' }, { name: 'Get token' }] },
      ],
    };
    // "Prepare account" is a real precondition → kept; "Auth" is a grouping
    // step so we descend to its leaf "Get token"; the duplicate collapses.
    expect(flattenFixtureToPreconditions(fixture)).toEqual(['Prepare account', 'Get token']);
  });

  it('drops a bare generic "Setup"/"Teardown" fixture name', () => {
    expect(flattenFixtureToPreconditions({ name: 'Setup', steps: [{ name: 'Load config' }] }))
      .toEqual(['Load config']);
  });
});

describe('extractLabels — BDD composite tags', () => {
  it('parses JVM KEY=value composites into severity/owner/links', () => {
    const out = extractLabels([
      L('tag', 'SEVERITY=critical'),
      L('tag', 'OWNER=jdoe'),
      L('tag', 'ISSUE=JIRA-123'),
      L('tag', 'smoke'),
    ]);
    expect(out.priority).toBe('critical');          // SEVERITY=critical
    expect(out.tags).toContain('owner:jdoe');        // OWNER=
    expect(out.tags).toContain('link:JIRA-123');     // ISSUE=
    expect(out.tags).toContain('smoke');             // plain tag survives
    expect(out.tags).not.toContain('SEVERITY=critical'); // consumed, not opaque
  });

  it('parses behave/JS key:value composites', () => {
    const out = extractLabels([
      L('tag', 'severity:blocker'),
      L('tag', 'owner:team-a'),
      L('tag', 'regression'),
    ]);
    expect(out.priority).toBe('critical');           // blocker → critical
    expect(out.tags).toContain('owner:team-a');
    expect(out.tags).toContain('regression');
  });

  it('keeps a URL value intact (only the first separator splits)', () => {
    const out = extractLabels([L('tag', 'LINK=https://jira.example.com/browse/X-1')]);
    expect(out.tags).toContain('link:https://jira.example.com/browse/X-1');
  });

  it('keeps an unknown composite as a plain tag rather than dropping it', () => {
    const out = extractLabels([L('tag', 'CUSTOM=value')]);
    expect(out.tags).toContain('CUSTOM=value');
  });

  it('a native severity label still takes precedence over hierarchy', () => {
    const out = extractLabels([L('severity', 'minor')]);
    expect(out.priority).toBe('low');
  });
});

describe('extractLabels — Allure ID (AS_ID)', () => {
  it('extracts AS_ID as an allure_id tag', () => {
    const out = extractLabels([L('AS_ID', '743')]);
    expect(out.tags).toContain('allure_id:743');
  });

  it('accepts ALLURE_ID / allure_id spellings too', () => {
    expect(extractLabels([L('ALLURE_ID', '10')]).tags).toContain('allure_id:10');
    expect(extractLabels([L('allure_id', '20')]).tags).toContain('allure_id:20');
  });
});
