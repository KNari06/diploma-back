/**
 * Eval-harness CLI runner: `npx tsx src/services/testing/api/flow/eval/run-eval.ts`
 *
 * Scores every fixture and prints a scorecard table. This is the manual, at-a-
 * glance baseline for the current pipeline's DAG quality — extend it to feed a
 * real built `{ spec, dag }` through `scoreDag` once we wire live pipeline output.
 */

import { scoreDag, securityMapFromSpec, formatScorecard } from './metrics';
import { FIXTURES } from './fixtures';

function main(): void {
  const scores = FIXTURES.map(fx =>
    scoreDag({
      name: fx.name,
      nodes: fx.nodes,
      executionOrder: fx.executionOrder,
      securityByEndpoint: securityMapFromSpec(fx.spec),
      providedVars: fx.providedVars,
    }),
  );
  // eslint-disable-next-line no-console
  console.log(formatScorecard(scores));
  const failed = scores.filter(s => !s.passed).length;
  // eslint-disable-next-line no-console
  console.log(`\n${scores.length - failed}/${scores.length} pass hard invariants.`);
}

main();
