/**
 * The completion chat message must carry a way BACK to the run.
 *
 * Regression: the results panel (with "Run all tests" / "Add to regression")
 * lives in the right-hand split. Closing it removed every route back — the
 * chat bubble held `explorationId` in metadata that nothing rendered — so
 * users believed the discovered tests were lost. They had been saved as
 * drafts the whole time.
 */

import { buildExplorationChatActions } from '../exploration-chat-actions';

describe('exploration completion — chat actions', () => {
  it('always offers a route back to the results, even when nothing was saved', () => {
    // A zero-case run still needs an exit: the user should be able to see WHY
    // it produced nothing rather than be left with a dead message.
    const actions = buildExplorationChatActions('expl-1', 0);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'navigate',
      url: '/explorations/expl-1',
    });
  });

  it('links to the deep route, not to something panel-scoped', () => {
    // `/explorations/:id` hydrates over REST, so it survives a reload and
    // works after the run's sockets are gone.
    const [open] = buildExplorationChatActions('expl-abc-123', 5);
    expect(open.url).toBe('/explorations/expl-abc-123');
  });

  it('adds a link to the saved cases, naming how many there are', () => {
    const actions = buildExplorationChatActions('expl-1', 34);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({
      kind: 'navigate',
      // `/test-suites` does NOT exist in App.jsx — pointing there would 404.
      url: '/repository',
    });
    expect(actions[1].label).toContain('34');
  });

  it('uses only whitelisted QuickActions icons', () => {
    // QuickActions.jsx resolves icons from a fixed ICON_MAP and silently drops
    // an unknown name, so a typo degrades the button instead of failing loudly.
    const allowed = new Set(['eye', 'file-text', 'play', 'plus', 'external-link']);
    for (const a of buildExplorationChatActions('expl-1', 3)) {
      expect(allowed.has(a.icon as string)).toBe(true);
    }
  });

  it('gives every action a stable unique id', () => {
    // The dispatcher tracks in-flight + one-shot state per (messageId, actionId);
    // duplicate or missing ids would collide across buttons.
    const actions = buildExplorationChatActions('expl-1', 2);
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('marks every action as a navigate kind the dispatcher understands', () => {
    // 'navigate' needs no endpoint whitelist (unlike 'api'), just a url —
    // which is why it is the right kind for a link back into the SPA.
    for (const a of buildExplorationChatActions('expl-1', 1)) {
      expect(a.kind).toBe('navigate');
      expect(typeof a.url).toBe('string');
      expect((a.url as string).startsWith('/')).toBe(true);
    }
  });
});
