/**
 * Entry-URL navigation contract.
 *
 * The behaviour under test is the fix for the worst honesty/billing bug in
 * exploration: `survey()` used to `return this.tree` (empty) when it could not
 * load the entry URL. The engine turned that into
 * `status:'completed', reason:'no_entry_points'` and the job charged 10 credits —
 * so a typo'd domain looked exactly like "your site has no testable flows".
 *
 * It must now THROW `EntryUnreachableError`, which routes into the job's catch
 * (failRun + status:'failed' + rethrow BEFORE the credit deduction).
 */

import { SurveyAgent } from '../survey-agent';
import { EntryUnreachableError } from '../entry-unreachable.error';
import { BudgetTracker } from '../budget-tracker';
import { RateLimiter } from '../rate-limiter';
import { DEFAULT_EXPLORATION_BUDGET, type ExplorationConfig } from '../types';

/** A Playwright Page stub with only what the entry navigation touches. */
function makePage(overrides: Partial<Record<string, any>> = {}) {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('https://acme.com/'),
    title: jest.fn().mockResolvedValue('Acme'),
    evaluate: jest.fn().mockResolvedValue(null),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeConfig(entryUrl = 'https://acme.com/'): ExplorationConfig {
  return {
    entryUrl,
    explorationId: 'expl-test',
    projectId: 'proj-1',
    userId: 'user-1',
    budget: { ...DEFAULT_EXPLORATION_BUDGET, maxSurveyPages: 1 },
  } as ExplorationConfig;
}

function makeDeps() {
  const budget = new BudgetTracker({ ...DEFAULT_EXPLORATION_BUDGET });
  const rateLimiter = new RateLimiter(undefined, budget);
  return { budget, rateLimiter };
}

describe('SurveyAgent entry navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The retry backoff really sleeps (1.5s + 3s), which made each failure-path
    // test take ~4.5s of wall clock. Run timers eagerly instead — we assert on
    // attempt COUNT, not on elapsed time.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => jest.restoreAllMocks());

  it('throws EntryUnreachableError when the entry URL never loads', async () => {
    const page = makePage({
      goto: jest.fn().mockRejectedValue(
        Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), { code: 'ENOTFOUND' }),
      ),
    });
    const { budget, rateLimiter } = makeDeps();
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    await expect(agent.survey()).rejects.toThrow(EntryUnreachableError);
  });

  it('carries the entry URL and a navigation_failed reason on the error', async () => {
    const page = makePage({
      goto: jest.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED')),
    });
    const { budget, rateLimiter } = makeDeps();
    const agent = new SurveyAgent(page, makeConfig('https://dead.example.com/'), budget, rateLimiter);

    await expect(agent.survey()).rejects.toMatchObject({
      name: 'EntryUnreachableError',
      entryUrl: 'https://dead.example.com/',
      reason: 'navigation_failed',
    });
  });

  // These two drive the private navigation step directly rather than `survey()`:
  // once navigation SUCCEEDS, survey() continues into the full BFS (snapshots,
  // Cartographer, LLM calls), which a stub page cannot satisfy and which would
  // make the test hang. The navigation contract is what's under test here.
  const navigate = (agent: SurveyAgent) =>
    (agent as unknown as { navigateToEntryUrl(): Promise<void> }).navigateToEntryUrl();

  it('retries a transient failure and succeeds — the cold-start case', async () => {
    // Previously ONLY a 429 got a retry, so an app that needed a second attempt
    // (Render/Heroku spin-up) was a guaranteed zero-result run.
    const goto = jest
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
      .mockResolvedValue(undefined);
    const page = makePage({ goto });
    const { budget, rateLimiter } = makeDeps();
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    await expect(navigate(agent)).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt cap rather than retrying forever', async () => {
    const goto = jest.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    const page = makePage({ goto });
    const { budget, rateLimiter } = makeDeps();
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    await expect(navigate(agent)).rejects.toThrow(EntryUnreachableError);
    expect(goto).toHaveBeenCalledTimes(3);
  });

  it('does NOT promote a landed origin that is SSRF-blocked', async () => {
    // A site redirecting to a private address would otherwise get that origin
    // promoted to in-scope and BFS-crawled inside the browser — past the
    // preflight, which the worker never runs.
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const page = makePage({ url: jest.fn().mockReturnValue('http://10.0.0.5/internal') });
      const { budget, rateLimiter } = makeDeps();
      const agent = new SurveyAgent(page, makeConfig('https://acme.com/'), budget, rateLimiter);

      await navigate(agent);

      const sameOrigin = (agent as unknown as { isSameOrigin(u: string): boolean }).isSameOrigin.bind(agent);
      expect(sameOrigin('http://10.0.0.5/other')).toBe(false);
      // The configured origin still works, so the survey degrades rather than dies.
      expect(sameOrigin('https://acme.com/pricing')).toBe(true);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('stops retrying when the remaining budget cannot fund exploration', async () => {
    // 3 x 30s nav + backoff is 94.5s — 79% of the `quick` preset's 120s. A flat
    // retry policy turns a recoverable blip into a guaranteed zero-flow run.
    const goto = jest.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    const page = makePage({ goto });
    const { budget, rateLimiter } = makeDeps();
    jest.spyOn(budget, 'remainingTimeMs').mockReturnValue(5_000);
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    await expect(navigate(agent)).rejects.toThrow(EntryUnreachableError);
    // Gave up after the first failure instead of burning the whole clock.
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('clamps a single attempt to the remaining budget', async () => {
    const goto = jest.fn().mockResolvedValue(undefined);
    const page = makePage({ goto });
    const { budget, rateLimiter } = makeDeps();
    jest.spyOn(budget, 'remainingTimeMs').mockReturnValue(4_000);
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    await navigate(agent);

    expect(goto).toHaveBeenCalledWith('https://acme.com/', expect.objectContaining({ timeout: 4_000 }));
  });

  it('records the landed origin so an off-origin redirect stays in scope', async () => {
    // acme.com -> acme.io. isSameOrigin must accept the redirect target,
    // otherwise every link on the site we landed on is dropped as off-origin
    // and the survey yields one page and zero flows.
    const page = makePage({ url: jest.fn().mockReturnValue('https://acme.io/welcome') });
    const { budget, rateLimiter } = makeDeps();
    const agent = new SurveyAgent(page, makeConfig('https://acme.com/'), budget, rateLimiter);

    await navigate(agent);

    const sameOrigin = (agent as unknown as { isSameOrigin(u: string): boolean }).isSameOrigin.bind(agent);
    expect(sameOrigin('https://acme.io/pricing')).toBe(true);
    expect(sameOrigin('https://acme.com/pricing')).toBe(true);
    expect(sameOrigin('https://evil.example.com/')).toBe(false);
  });

  it('throws site_degraded when the rate limiter refuses a navigation slot', async () => {
    const page = makePage();
    const { budget, rateLimiter } = makeDeps();
    jest.spyOn(rateLimiter, 'acquireSlot').mockResolvedValue(false);
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    await expect(agent.survey()).rejects.toMatchObject({ reason: 'site_degraded' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('does NOT return an empty tree on failure (the old masking behaviour)', async () => {
    const page = makePage({ goto: jest.fn().mockRejectedValue(new Error('boom')) });
    const { budget, rateLimiter } = makeDeps();
    const agent = new SurveyAgent(page, makeConfig(), budget, rateLimiter);

    let resolved = false;
    await agent.survey().then(
      () => {
        resolved = true;
      },
      () => {
        /* expected */
      },
    );

    expect(resolved).toBe(false);
  });
});
