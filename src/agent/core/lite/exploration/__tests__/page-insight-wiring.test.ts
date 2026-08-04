/**
 * `bb.pageInsights` write path.
 *
 * The bug this locks down: the map had THREE readers (Strategist, Sentinel, and
 * the Planner via FlowRunner's `pageInsightContext`) and ZERO writers on a fresh
 * run — the only assignment was the checkpoint-resume path. `SurveyAgent` never
 * received the blackboard, so it could not write even in principle, and
 * Cartographer's `forms` / `dataEntities` / `interactiveAreas` were computed per
 * page and thrown away. `git log -S "pageInsights.set"` finds nothing: it was
 * never implemented, not a regression.
 *
 * These tests assert the contract the three consumers depend on:
 *   1. an insight is stored for each surveyed page,
 *   2. under the TREE's node id (`page-N`), not Cartographer's timestamp id,
 *   3. never for a page that was deduped away (no node id to key on),
 *   4. and a sink that throws cannot break the survey.
 */

import { SurveyAgent } from '../survey-agent';
import type { CartographerInsight } from '../agents/agent-types';

type Sink = (pageId: string, insight: CartographerInsight) => void;

/** Reach the private members this contract is expressed in. */
const asInternals = (agent: SurveyAgent) =>
  agent as unknown as {
    lastPageInsight: CartographerInsight | null;
    publishPageInsight(pageId: string): void;
  };

function makeAgent(): SurveyAgent {
  // The publish path touches no page/browser state, so the collaborators can be
  // empty objects — constructing a real Page/BudgetTracker here would test
  // Playwright, not this contract.
  return new SurveyAgent({} as any, { entryUrl: 'https://acme.com/' } as any, {} as any, {} as any);
}

const insight = (over: Partial<CartographerInsight> = {}): CartographerInsight => ({
  // Cartographer stamps `page-${Date.now()}` — deliberately NOT the tree id, to
  // prove the re-stamp happens.
  pageId: 'page-1700000000000',
  pageType: 'checkout',
  forms: [{ formRef: 'e5', fields: [], submitButtonRef: 'e9' }] as any,
  interactiveAreas: ['cart summary'],
  dataEntities: ['orders'],
  stateIndicators: ['cart has 2 items'],
  complexity: 'moderate',
  relatedPages: ['/cart'],
  ...over,
});

describe('SurveyAgent → bb.pageInsights wiring', () => {
  it('stores the insight under the tree node id, not Cartographer\'s own pageId', () => {
    const stored = new Map<string, CartographerInsight>();
    const agent = makeAgent();
    agent.setPageInsightSink((id, i) => stored.set(id, i));

    asInternals(agent).lastPageInsight = insight();
    asInternals(agent).publishPageInsight('page-3');

    // Keyed by the tree id — FlowRunner resolves url → node.id → this key.
    expect(stored.has('page-3')).toBe(true);
    expect(stored.has('page-1700000000000')).toBe(false);
    // And the stamped field agrees with the key, so the two can't drift.
    expect(stored.get('page-3')!.pageId).toBe('page-3');
  });

  it('preserves the payload the three consumers actually read', () => {
    const stored = new Map<string, CartographerInsight>();
    const agent = makeAgent();
    agent.setPageInsightSink((id, i) => stored.set(id, i));

    asInternals(agent).lastPageInsight = insight();
    asInternals(agent).publishPageInsight('page-0');

    const got = stored.get('page-0')!;
    // forms drives the Planner's form-filling; the Cartographer prompt calls it
    // mandatory precisely because an empty array means it cannot fill the form.
    expect(got.forms).toHaveLength(1);
    expect(got.dataEntities).toEqual(['orders']);
    expect(got.interactiveAreas).toEqual(['cart summary']);
    expect(got.pageType).toBe('checkout');
  });

  it('clears the pending insight so it cannot leak onto the next page', () => {
    const stored = new Map<string, CartographerInsight>();
    const agent = makeAgent();
    agent.setPageInsightSink((id, i) => stored.set(id, i));

    asInternals(agent).lastPageInsight = insight({ pageType: 'first' });
    asInternals(agent).publishPageInsight('page-0');

    // Second page: Cartographer returned nothing (parse failure / fallback).
    asInternals(agent).publishPageInsight('page-1');

    expect(stored.has('page-0')).toBe(true);
    expect(stored.has('page-1')).toBe(false);
    expect(stored.size).toBe(1);
  });

  it('writes nothing when there is no insight to publish', () => {
    const sink = jest.fn();
    const agent = makeAgent();
    agent.setPageInsightSink(sink);

    asInternals(agent).publishPageInsight('page-0');

    expect(sink).not.toHaveBeenCalled();
  });

  it('is a no-op when no sink is wired (survey must still work standalone)', () => {
    const agent = makeAgent();
    asInternals(agent).lastPageInsight = insight();

    expect(() => asInternals(agent).publishPageInsight('page-0')).not.toThrow();
  });

  it('swallows a throwing sink — an insight is never worth failing a survey for', () => {
    const agent = makeAgent();
    agent.setPageInsightSink(() => {
      throw new Error('blackboard exploded');
    });
    asInternals(agent).lastPageInsight = insight();

    expect(() => asInternals(agent).publishPageInsight('page-0')).not.toThrow();
  });

  it('the sink the engine wires populates a Map the consumers can read', () => {
    // Mirrors exploration-engine: bb.pageInsights.set(pageId, insight).
    const bbPageInsights = new Map<string, CartographerInsight>();
    const sink: Sink = (pageId, i) => bbPageInsights.set(pageId, i);

    const agent = makeAgent();
    agent.setPageInsightSink(sink);
    asInternals(agent).lastPageInsight = insight();
    asInternals(agent).publishPageInsight('page-7');

    // getPageInsightsArray(bb) — what Strategist and Sentinel receive.
    expect(Array.from(bbPageInsights.values())).toHaveLength(1);
    // FlowRunner's lookup: pageInsights.get(node.id).
    expect(bbPageInsights.get('page-7')).toBeDefined();
  });
});
