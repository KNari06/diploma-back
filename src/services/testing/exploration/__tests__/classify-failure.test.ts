/**
 * Which terminal status a failed exploration run carries.
 *
 * The point of the classification is that "the site blocked us" becomes
 * queryable instead of living in free-text `error_message`. So the rule that
 * matters most is the NEGATIVE one: anything we cannot positively identify
 * stays `failed`, because a confidently wrong status sends a user chasing a
 * bot wall that never existed.
 */

import { classifyExplorationFailure } from '../classify-failure';
import { EntryUnreachableError } from '@/agent/core/lite/exploration/entry-unreachable.error';

describe('classifyExplorationFailure', () => {
  it('maps a dead entry URL to `unreachable`', () => {
    const err = new EntryUnreachableError('https://acme.com', 'navigation_failed');
    expect(classifyExplorationFailure(err)).toBe('unreachable');
  });

  it.each(['rate_limited', 'site_degraded'] as const)(
    'maps %s to `blocked_by_bot` — the site works, it refuses automation',
    (reason) => {
      const err = new EntryUnreachableError('https://acme.com', reason);
      expect(classifyExplorationFailure(err)).toBe('blocked_by_bot');
    },
  );

  it('leaves an ordinary error as `failed`', () => {
    expect(classifyExplorationFailure(new Error('Cannot read property of undefined'))).toBe('failed');
  });

  it('does NOT classify on message text', () => {
    // A generic error whose prose happens to mention rate limiting must not be
    // promoted to blocked_by_bot — only the typed error carries that fact.
    expect(classifyExplorationFailure(new Error('rate limited by the site'))).toBe('failed');
    expect(classifyExplorationFailure(new Error('could not load the entry URL'))).toBe('failed');
  });

  it('never throws on a non-Error value', () => {
    for (const v of [undefined, null, 'boom', 42, {}, []]) {
      expect(classifyExplorationFailure(v)).toBe('failed');
    }
  });
});
