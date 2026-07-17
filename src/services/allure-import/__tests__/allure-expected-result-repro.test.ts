/**
 * Regression for nested "Expected result" handling (real case #13 / #3446).
 *
 * A 6-step scenario where steps 5 and 6 each have nested "Expected result"
 * sub-blocks. Before the fix, parseScenario glued the expected lines into the
 * step description and truncated the whole blob at 120 chars — dropping later
 * assertions and orphaning them from their step. Now expected results are kept
 * in a separate, untruncated `expected[]` field linked to their owning step.
 */

import { parseAllureCsv } from '../allure-csv-parser';

// Scenario as Allure TestOps exports it: numbered steps, with the expected
// results indented under their owning step. We model two indentation styles
// because real exports vary (tab vs spaces vs bracketed).
const SCENARIO_TAB_INDENTED = [
  '[step 1] Log in with KZ account',
  '[step 2] Start personal data verification',
  '[step 3] Enter IIN',
  '[step 4] Complete verification via SMS flow',
  '[step 5] Return to Profile page after success screen',
  '\tExpected result: IN_PROGRESS status is not shown for KZ users',
  '\tExpected result: Only CREATED, VERIFIED, REJECTED statuses are used',
  '[step 6] Track status changes',
  '\tExpected result: "Under review" status never appears',
  '\tExpected result: Operator review logic is not used in KZ flow',
  '\tExpected result: UI is not mixed with other countries logic',
].join('\n');

const SCENARIO_SPACE_INDENTED = SCENARIO_TAB_INDENTED.replace(/\t/g, '    ');

function buildCsv(scenario: string): string {
  // csv-parse needs the multi-line scenario quoted.
  const esc = scenario.replace(/"/g, '""');
  return ['name;scenario', `KZ no IN_PROGRESS;"${esc}"`].join('\n');
}

describe('REPRO: nested Expected result under a step (TestOps case #13)', () => {
  it('TAB-indented: expected results land in expected[] linked to their step, untruncated', async () => {
    const { testCases } = await parseAllureCsv(buildCsv(SCENARIO_TAB_INDENTED));
    const steps = testCases[0].steps;

    // 6 action steps (one per [step N]) — expected results are NOT separate steps.
    expect(steps).toHaveLength(6);

    // Action descriptions stay clean (no expected text glued in).
    const step5 = steps[4];
    expect(step5.description).toBe('Return to Profile page after success screen');
    expect(step5.description).not.toMatch(/Expected result/);

    // Step 5's two expected results are linked, in order, untruncated.
    expect(step5.expected).toEqual([
      'IN_PROGRESS status is not shown for KZ users',
      'Only CREATED, VERIFIED, REJECTED statuses are used',
    ]);

    // Step 6's THREE expected results all survive (the 3rd used to be dropped
    // by the 120-char truncation).
    expect(steps[5].expected).toEqual([
      '"Under review" status never appears',
      'Operator review logic is not used in KZ flow',
      'UI is not mixed with other countries logic',
    ]);

    // Steps without expected results don't carry the field.
    expect(steps[0].expected).toBeUndefined();
  });

  it('SPACE-indented: same outcome (indentation style does not matter)', async () => {
    const { testCases } = await parseAllureCsv(buildCsv(SCENARIO_SPACE_INDENTED));
    const steps = testCases[0].steps;

    expect(steps).toHaveLength(6);
    expect(steps[4].expected).toEqual([
      'IN_PROGRESS status is not shown for KZ users',
      'Only CREATED, VERIFIED, REJECTED statuses are used',
    ]);
    expect(steps[5].expected).toHaveLength(3);
  });

  it('"Expected result:" label on its own line, value(s) on following lines', async () => {
    const scenario = [
      '[step 1] Do the thing',
      '\tExpected result:',
      '\tThe thing is done',
      '\tNo error appears',
    ].join('\n');
    const { testCases } = await parseAllureCsv(buildCsv(scenario));
    const steps = testCases[0].steps;

    expect(steps).toHaveLength(1);
    expect(steps[0].description).toBe('Do the thing');
    expect(steps[0].expected).toEqual(['The thing is done', 'No error appears']);
  });

  it('MULTILINGUAL: German [Schritt N] + "Erwartetes Ergebnis" parses like EN', async () => {
    // Previously the hardcoded EN/RU/KZ regexes would treat the German
    // expected-result line as another step, collapsing the split. Now the
    // multilingual label registry recognises it.
    const scenario = [
      '[Schritt 1] Anmeldeseite öffnen',
      '[Schritt 2] Zugangsdaten eingeben und absenden',
      '\tErwartetes Ergebnis: Das Dashboard wird angezeigt',
      '\tErwartetes Ergebnis: Kein Fehler erscheint',
    ].join('\n');
    const { testCases } = await parseAllureCsv(buildCsv(scenario));
    const steps = testCases[0].steps;

    expect(steps).toHaveLength(2);
    expect(steps[1].description).toBe('Zugangsdaten eingeben und absenden');
    expect(steps[1].description).not.toMatch(/Erwartetes/);
    expect(steps[1].expected).toEqual([
      'Das Dashboard wird angezeigt',
      'Kein Fehler erscheint',
    ]);
  });

  it('MULTILINGUAL: [attachment N] in another language is NOT read as a step', async () => {
    const scenario = [
      '[Schritt 1] Etwas tun',
      '\t[Anhang 1.1] screenshot.png',
      '[Schritt 2] Etwas anderes tun',
    ].join('\n');
    const { testCases } = await parseAllureCsv(buildCsv(scenario));
    // Two steps — the [Anhang 1.1] line is an attachment, not a third step.
    expect(testCases[0].steps).toHaveLength(2);
  });
});
