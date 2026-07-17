/**
 * Unit tests for the deterministic Allure TestOps CSV parser.
 *
 * Focus is on the parsing edge cases that the previous hand-rolled parser got
 * subtly wrong and that csv-parse now handles: quoted fields containing the
 * delimiter / newlines / escaped quotes, BOM, whitespace preservation inside
 * quotes, column aliasing, and delimiter auto-detection.
 */

import { parseAllureCsv } from '../allure-csv-parser';

describe('parseAllureCsv', () => {
  it('parses a minimal semicolon-delimited export with the required name column', async () => {
    const csv = ['name;description', 'Login works;Verifies login'].join('\n');

    const { testCases, errors } = await parseAllureCsv(csv);

    expect(errors).toEqual([]);
    expect(testCases).toHaveLength(1);
    expect(testCases[0].name).toBe('Login works');
    expect(testCases[0].description).toBe('Verifies login');
  });

  it('auto-detects a comma delimiter', async () => {
    const csv = ['name,description', 'A,first', 'B,second'].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases.map((t) => t.name)).toEqual(['A', 'B']);
  });

  it('auto-detects a tab delimiter', async () => {
    const csv = ['name\tdescription', 'A\tfirst'].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases).toHaveLength(1);
    expect(testCases[0].description).toBe('first');
  });

  it('keeps a quoted field that contains the delimiter intact', async () => {
    const csv = ['name;description', 'Checkout;"buy a, b, and c"'].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases[0].description).toBe('buy a, b, and c');
  });

  it('handles a quoted multi-line field (newline inside a cell)', async () => {
    const csv = [
      'name;precondition',
      'Multi;"line one\nline two\nline three"',
    ].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    // precondition is split per line and bullet-stripped by the mapper
    expect(testCases[0].preconditions).toEqual(['line one', 'line two', 'line three']);
  });

  it('unescapes doubled double-quotes per RFC 4180', async () => {
    const csv = ['name;description', 'Quote;"she said ""hi"" loudly"'].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases[0].description).toBe('she said "hi" loudly');
  });

  it('preserves intentional interior whitespace inside a quoted field', async () => {
    const csv = ['name;description', 'Pad;"  spaced  inside  "'].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    // col() trims the outer edges only — interior double spaces survive
    expect(testCases[0].description).toBe('spaced  inside');
  });

  it('strips a UTF-8 BOM before the header', async () => {
    const csv = '﻿name;description\nWithBom;ok';

    const { testCases, errors } = await parseAllureCsv(csv);

    expect(errors).toEqual([]);
    expect(testCases[0].name).toBe('WithBom');
  });

  it('handles CRLF line endings', async () => {
    const csv = 'name;description\r\nCRLF;value\r\n';

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases[0].name).toBe('CRLF');
    expect(testCases[0].description).toBe('value');
  });

  it('maps columns by alias regardless of order or extra columns', async () => {
    const csv = [
      'Epic;Feature;Title;Severity;Tags;Owner',
      'Billing;Invoices;Create invoice;blocker;smoke,regression;qa@x.io',
    ].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    const tc = testCases[0];
    expect(tc.name).toBe('Create invoice');
    expect(tc.moduleName).toBe('Billing'); // Epic → module
    expect(tc.flowName).toBe('Invoices'); // Feature → flow
    expect(tc.priority).toBe('critical'); // blocker → critical
    expect(tc.tags).toEqual(expect.arrayContaining(['smoke', 'regression', 'owner:qa@x.io']));
  });

  it('parses bracketed [step N] scenarios into steps', async () => {
    const csv = [
      'name;scenario',
      'Flow;"[step 1] Open the page\n[step 2] Click submit"',
    ].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases[0].steps.map((s) => s.description)).toEqual([
      'Open the page',
      'Click submit',
    ]);
  });

  it('returns an error and no test cases when the name column is missing', async () => {
    const csv = ['description;status', 'no name here;Active'].join('\n');

    const { testCases, errors } = await parseAllureCsv(csv);

    expect(testCases).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/missing required "name" column/i);
  });

  it('skips rows with an empty name without aborting the whole parse', async () => {
    const csv = ['name;description', ';orphan', 'Real;kept'].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases.map((t) => t.name)).toEqual(['Real']);
  });

  it('returns empty result for blank input', async () => {
    const { testCases, errors } = await parseAllureCsv('   \n  ');

    expect(testCases).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('does not let a short data row abort the parse (relax_column_count)', async () => {
    const csv = [
      'name;description;status',
      'Short;only two cols', // missing the status column
      'Full;has all;Active',
    ].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    expect(testCases.map((t) => t.name)).toEqual(['Short', 'Full']);
  });

  it('does NOT treat prose like "Windows 10:" or "Chapter 3." as a step marker', async () => {
    // Regression: the non-bracketed step patterns must fire ONLY on leading
    // numbering (1. / 1)), not a generic "Word N:/." prefix — otherwise a
    // continuation line with a version string or heading is severed into a
    // phantom step, losing its leading text.
    const scenario = [
      '[step 1] Open the settings page',
      '\tWindows 10: verify the layout renders',   // continuation, NOT a new step
      '[step 2] Save',
    ].join('\n');
    const csv = ['name;scenario', `Layout;"${scenario.replace(/"/g, '""')}"`].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    // Exactly two real steps — "Windows 10:" did not spawn a third.
    expect(testCases[0].steps).toHaveLength(2);
    expect(testCases[0].steps.map((s) => s.description)).not.toContain('verify the layout renders');
  });

  it('does NOT read a bare "Expected number…" continuation as an expected-result delimiter', async () => {
    // Regression: only "expected result(s)" is a delimiter, not the bare word
    // "Expected" — otherwise "Expected number of rows is 50" is mis-bucketed.
    const scenario = [
      '[step 1] Load the transactions page',
      '\tExpected number of rows is 50',   // this is step context, NOT the delimiter
    ].join('\n');
    const csv = ['name;scenario', `Rows;"${scenario.replace(/"/g, '""')}"`].join('\n');

    const { testCases } = await parseAllureCsv(csv);

    // The word "Expected" is preserved (not stripped as a delimiter label).
    expect(testCases[0].steps[0].expected).toBeUndefined();
  });
});
