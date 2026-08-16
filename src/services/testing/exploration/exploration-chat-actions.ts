/**
 * Inline chat-message actions for a finished exploration.
 *
 * Lives in its own module (not in the job) purely so it is testable: importing
 * `exploration-run.job.ts` pulls in BullMQ + Playwright and hangs a unit test.
 */

/**
 * Build the inline buttons attached to the completion chat message.
 *
 * These are the ONLY durable route back to a finished run. The results panel —
 * and with it "Run all tests" / "Add to regression" — lives inside the
 * right-hand split; once the user closes it, every path back disappears. The
 * chat bubble did carry `explorationId` in its metadata, but nothing rendered
 * it, and the Explorations dropdown is not discoverable from the conversation.
 * So a user who closed the panel concluded the run was lost, when the test
 * cases had been saved as drafts all along.
 *
 * Rendered by the universal QuickActions framework straight from PERSISTED
 * metadata, so they survive a reload and a re-opened session — unlike the
 * panel, which is component state.
 */
export function buildExplorationChatActions(
  explorationId: string,
  savedCount: number,
): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [
    {
      id: 'open-exploration-results',
      kind: 'navigate',
      label: 'Open results',
      icon: 'eye',
      variant: 'primary',
      // Deep link — `/explorations/:id` hydrates the run over REST, so it still
      // works long after this run's sockets are gone. Offered even for a
      // zero-case run: the user should be able to see WHY it found nothing
      // rather than be left with a dead message.
      url: `/explorations/${explorationId}`,
    },
  ];

  if (savedCount > 0) {
    actions.push({
      id: 'view-exploration-test-cases',
      kind: 'navigate',
      label: `View ${savedCount} saved test case(s)`,
      icon: 'file-text',
      variant: 'secondary',
      // `/repository` is the test-case repository screen (the "test-suits"
      // tab). Verified against App.jsx — there is NO `/test-suites` route, and
      // Home.jsx already sends users here to find a saved case in the tree.
      url: '/repository',
    });
  }

  return actions;
}
