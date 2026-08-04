/**
 * `formatPageInsightContext` / `summarizeForms` — the string the Planner reads.
 *
 * Before pageInsights was wired this formatter was unreachable (the map was
 * always empty). Now that it runs, the payload matters: it used to emit
 * `forms: 2`, which tells a Planner nothing it can act on. It now emits the
 * field LABELS with `*` for required — the reason Cartographer's prompt calls
 * `forms` mandatory ("an empty forms array means the planner cannot fill the
 * form").
 *
 * `forms` arrives straight from an LLM response (`parseCartographerResponse`
 * passes `insight.forms` through with only an Array check), so the malformed
 * cases below are realistic, not paranoid.
 */

import { FlowRunner } from '../flow-runner';
import type { FormAnalysis } from '../../agents/types';

/** summarizeForms is private; this contract is what the Planner consumes. */
const summarize = (forms: unknown[], cap = 4): string =>
  (FlowRunner.prototype as unknown as {
    summarizeForms(f: unknown[], c: number): string;
  }).summarizeForms.call({}, forms, cap);

const form = (over: Partial<FormAnalysis> = {}): FormAnalysis => ({
  formRef: 'e5',
  fields: [
    { ref: 'e6', type: 'email', label: 'Email', hasValue: false, required: true },
    { ref: 'e7', type: 'password', label: 'Password', hasValue: false, required: true },
  ],
  submitButtonRef: 'e9',
  submitButtonText: 'Sign in',
  ...over,
});

describe('summarizeForms', () => {
  it('lists field labels and marks required ones with *', () => {
    expect(summarize([form()])).toBe('[Email*, Password*] → "Sign in"');
  });

  it('does not mark optional fields', () => {
    const f = form({
      fields: [
        { ref: 'e6', type: 'text', label: 'Company', hasValue: false, required: false },
        { ref: 'e7', type: 'email', label: 'Email', hasValue: false, required: true },
      ],
    });
    expect(summarize([f])).toBe('[Company, Email*] → "Sign in"');
  });

  it('names the submit control so the Planner need not guess which button commits', () => {
    expect(summarize([form({ submitButtonText: 'Place order' })])).toContain('→ "Place order"');
  });

  it('omits the arrow when the submit text is missing', () => {
    expect(summarize([form({ submitButtonText: undefined })])).toBe('[Email*, Password*]');
  });

  it('collapses long field lists rather than dumping them', () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({
      ref: `e${i}`,
      type: 'text',
      label: `Field${i}`,
      hasValue: false,
      required: false,
    }));
    const out = summarize([form({ fields, submitButtonText: undefined })]);
    expect(out).toContain('Field0');
    expect(out).toContain('Field5');
    expect(out).not.toContain('Field6');
    expect(out).toContain('+3');
  });

  it('collapses extra forms beyond the cap', () => {
    const out = summarize([form(), form(), form(), form(), form(), form()], 4);
    expect(out).toContain('+2 more form(s)');
  });

  describe('malformed LLM output', () => {
    it('falls back to the field type when the label is empty', () => {
      const f = form({
        fields: [{ ref: 'e6', type: 'email', label: '   ', hasValue: false, required: true }],
        submitButtonText: undefined,
      });
      expect(summarize([f])).toBe('[email*]');
    });

    it('survives a form with no fields array at all', () => {
      expect(summarize([{ formRef: 'e5', submitButtonText: 'Go' }])).toBe('[unknown fields] → "Go"');
    });

    it('survives a null entry in the forms list', () => {
      expect(() => summarize([null])).not.toThrow();
    });

    it('survives fields that are not objects', () => {
      expect(() => summarize([{ fields: [null, 'nope', 42] }])).not.toThrow();
    });

    it('returns an empty string for an empty list', () => {
      expect(summarize([])).toBe('');
    });
  });
});
