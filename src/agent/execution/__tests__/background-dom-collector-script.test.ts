import vm from 'vm';
import { __buildExtractScriptForTest } from '../background-dom-collector';

/**
 * Regression guard for the 2026-06 incident: a TypeScript return-type
 * annotation leaked into the browser-evaluated template string in
 * `buildExtractScript`, making the WHOLE script unparseable in the page
 * ("Unexpected token ')'"). The legacy evaluate path then collected 0 nodes
 * on every background replay. These tests compile the generated script as
 * plain JS (same as the browser would) so any future TS leak fails CI here.
 */
describe('buildExtractScript — generated script is valid browser JS', () => {
  it('parses as plain JavaScript (no TypeScript syntax leaked)', () => {
    const script = __buildExtractScriptForTest(400);
    // new vm.Script compiles with the V8 parser — same grammar the browser
    // uses inside page.evaluate. Throws SyntaxError on any TS-only construct.
    expect(() => new vm.Script(script, { filename: 'extract.js' })).not.toThrow();
  });

  it('contains no obvious TypeScript type annotations', () => {
    const script = __buildExtractScriptForTest(400);
    // Type-return arrows, `as` casts, and generic call syntax are the common
    // leaks. Keep this cheap and specific to avoid false positives on strings.
    expect(script).not.toMatch(/\)\s*:\s*(string|number|boolean|void|any|unknown)\s*(\||=>)/);
    expect(script).not.toMatch(/\bas\s+(string|number|const|HTMLElement|Element)\b/);
  });

  it('is stable across maxNodes values (still valid JS)', () => {
    for (const n of [1, 50, 400]) {
      expect(() => new vm.Script(__buildExtractScriptForTest(n))).not.toThrow();
    }
  });
});
