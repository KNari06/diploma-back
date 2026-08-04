/**
 * The live `flow_step` payload contract.
 *
 * Every rule below is a regression found by AUDITING the feed after it shipped
 * — each one had already been accepted by a green suite:
 *   1. infrastructure commands leaked in as if the agent had acted
 *   2. `mark_done` arrived with no label (its text lives in `evidence`)
 *   3. model-authored prose reached the UI un-redacted (hard invariant #10)
 */

import { buildFlowStepPayload, FEED_EXCLUDED_COMMANDS } from '../flow-step-feed';
import type { ExecutedCommand } from '../../pipeline/types';

const cmd = (name: string, args: any = {}, result: any = { success: true }): ExecutedCommand =>
  ({ command: { name, args }, result: { output: '', ...result }, durationMs: 5 }) as ExecutedCommand;

const build = (c: ExecutedCommand, over: any = {}) =>
  buildFlowStepPayload(c, { stepNumber: 1, roundNumber: 1, ...over });

const CREDS = { email: 'user@acme.com', password: 'hunter2secret' };

describe('which commands reach the user', () => {
  it.each([...FEED_EXCLUDED_COMMANDS])('drops %s — it is not an action the agent took', (name) => {
    expect(build(cmd(name))).toBeNull();
  });

  it('keeps a real action', () => {
    expect(build(cmd('click_element', { description: 'Click Checkout' }))?.action).toBe('click_element');
  });

  it('stays in sync with the step extractor, which returns null for the same set', () => {
    // If one side gains an exclusion the feed and the saved steps describe
    // different flows — keep this list identical to commandToStep's null cases.
    expect([...FEED_EXCLUDED_COMMANDS].sort()).toEqual(['observe_page', 'report_blocked', 'wait_for_page']);
  });

  it('drops a malformed command instead of emitting a nameless step', () => {
    expect(buildFlowStepPayload({} as ExecutedCommand, { stepNumber: 1, roundNumber: 1 })).toBeNull();
  });
});

describe('mark_done is labelled from `evidence`', () => {
  it('renders the evidence the way the persisted step does', () => {
    expect(build(cmd('mark_done', { evidence: 'Order placed' }))?.description).toBe('Verify: Order placed');
  });

  it('falls back to a label rather than emitting the final step blank', () => {
    expect(build(cmd('mark_done'))?.description).toBe('Verify: Goal achieved');
  });
});

describe('per-command truth', () => {
  it('reports a genuine failure with its reason', () => {
    const p = build(cmd('click_element', { description: 'Pay' }, { success: false, error: 'element not found' }));
    expect(p).toMatchObject({ success: false, error: 'element not found' });
  });

  it('omits `error` when the command succeeded', () => {
    const p = build(cmd('click_element', { description: 'Click' }));
    expect(p?.success).toBe(true);
    expect(p?.error).toBeUndefined();
  });

  it('does not invent success for a result it cannot read', () => {
    // The old feed hardcoded success:true; a MISSING result is not success.
    // Built by hand — the `cmd` helper always spreads a result object in.
    const noResult = { command: { name: 'click_element', args: {} }, durationMs: 5 } as unknown as ExecutedCommand;
    expect(buildFlowStepPayload(noResult, { stepNumber: 1, roundNumber: 1 })?.success).toBe(false);
  });
});

describe('credential redaction — every emitted string, not just `value`', () => {
  it('redacts the filled value', () => {
    const p = build(cmd('fill_field', { value: 'hunter2secret' }), { credentials: CREDS });
    expect(p?.value).not.toContain('hunter2secret');
  });

  it('redacts the model-authored description', () => {
    const p = build(cmd('fill_field', { description: 'Fill password with hunter2secret' }), { credentials: CREDS });
    expect(p?.description).not.toContain('hunter2secret');
  });

  it('redacts mark_done evidence, which routinely names the account', () => {
    const p = build(cmd('mark_done', { evidence: 'Logged in as user@acme.com' }), { credentials: CREDS });
    expect(p?.description).not.toContain('user@acme.com');
  });

  it('redacts the failure reason, which echoes the page and the locator', () => {
    const p = build(
      cmd('fill_field', {}, { success: false, error: 'Timeout waiting for [value="hunter2secret"]' }),
      { credentials: CREDS },
    );
    expect(p?.error).not.toContain('hunter2secret');
  });

  it('passes text through unchanged when the run has no credentials', () => {
    expect(build(cmd('click_element', { description: 'Click Checkout' }))?.description).toBe('Click Checkout');
  });
});

describe('shape', () => {
  it('carries stepNumber, roundNumber and pageUrl through verbatim', () => {
    const p = build(cmd('click_element'), { stepNumber: 7, roundNumber: 3, pageUrl: 'https://x/cart' });
    expect(p).toMatchObject({ stepNumber: 7, roundNumber: 3, pageUrl: 'https://x/cart' });
  });

  it('omits an empty description rather than sending a blank label', () => {
    expect(build(cmd('click_element', { description: '' }))?.description).toBeUndefined();
  });
});
