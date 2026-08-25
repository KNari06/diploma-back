import { findRunnerBatchFailure } from '../runner-batch-result';

describe('findRunnerBatchFailure', () => {
  it('returns null when every command succeeded', () => {
    const raw = { results: [{ success: true }, { success: true }] };
    expect(findRunnerBatchFailure(raw, ['close_app', 'launch_app'])).toBeNull();
  });

  it('returns null for data-only results that carry no success key', () => {
    // check_package answers with a bare payload; reading that as broken would
    // fail healthy batches.
    const raw = { results: [{ data: { installed: true } }] };
    expect(findRunnerBatchFailure(raw, ['check_package'])).toBeNull();
  });

  it('names the failed command when the failure is the FIRST in the batch', () => {
    const raw = { results: [{ success: false, error: 'App file not found' }] };
    expect(findRunnerBatchFailure(raw, ['install_app'])).toEqual({
      index: 0,
      command: 'install_app',
      error: 'App file not found',
    });
  });

  it('names the failed command when the failure is NOT at index 0', () => {
    // The indexing case that matters: close_app worked, launch_app did not.
    // Mislabelling here sends the next investigation at the wrong command.
    const raw = { results: [{ success: true }, { success: false, error: 'am start failed' }] };
    expect(findRunnerBatchFailure(raw, ['close_app', 'launch_app'])).toEqual({
      index: 1,
      command: 'launch_app',
      error: 'am start failed',
    });
  });

  it('substitutes a stand-in when the runner reported no error text', () => {
    const raw = { results: [{ success: false }] };
    expect(findRunnerBatchFailure(raw, ['close_app'])?.error).toMatch(/no error text/);
  });

  it('flags a command that produced no result at all', () => {
    // executeBatch breaks on the first failure, so a short array normally comes
    // WITH its marker. Short and unmarked means a command vanished — treating
    // that as success reports an app as launched when launch_app never ran.
    const raw = { results: [{ success: true }] };
    expect(findRunnerBatchFailure(raw, ['close_app', 'launch_app'])).toEqual({
      index: 1,
      command: 'launch_app',
      error: expect.stringContaining('produced none'),
    });
  });

  it('prefers the explicit failure over the short-array signal', () => {
    // Both conditions hold here (break-on-failure). The explicit runner error
    // is the more useful of the two, so it must win.
    const raw = { results: [{ success: false, error: 'pm clear did not succeed' }] };
    expect(findRunnerBatchFailure(raw, ['close_app', 'launch_app'])).toEqual({
      index: 0,
      command: 'close_app',
      error: 'pm clear did not succeed',
    });
  });

  it('treats an unreadable body as no-signal rather than failure', () => {
    for (const raw of [null, undefined, {}, { results: 'nope' }, 'string']) {
      expect(findRunnerBatchFailure(raw, ['install_app'])).toBeNull();
    }
  });

  it('falls back to an index label when the command list is shorter than results', () => {
    const raw = { results: [{ success: true }, { success: false, error: 'boom' }] };
    expect(findRunnerBatchFailure(raw, ['close_app'])?.command).toBe('command #1');
  });
});
