/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BACKFILL — remove consecutive duplicate steps from discovered test cases
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The extractor used to append every successful command from every pipeline
 * round with no repeat check, so an agent that clicked the same control twice
 * (first click landed on the wrong page, clicked again) had BOTH clicks saved.
 * The runtime guard is fixed; rows written before it are not.
 *
 * Usage — DRY RUN by default, nothing is written without --apply:
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/dedupe-exploration-steps.ts
 *   npx ts-node -r tsconfig-paths/register src/scripts/dedupe-exploration-steps.ts --exploration=expl-123
 *   npx ts-node -r tsconfig-paths/register src/scripts/dedupe-exploration-steps.ts --apply
 *
 * Flags:
 *   --apply             actually write (default: report only)
 *   --exploration=<id>  limit to one run (default: every exploration case)
 *   --project=<uuid>    limit to one project
 *   --limit=<n>         cap rows scanned (default 1000)
 *
 * Safety properties, in order of importance:
 *   1. Dry run is the DEFAULT. Seeing the diff is the normal path.
 *   2. The dedupe rule is imported from `duplicate-steps.ts` — the same module
 *      the runtime uses — so the backfill cannot drift from the live guard.
 *   3. Writes are per-row and best-effort: one failure is logged and the sweep
 *      continues, so a partial run never leaves a half-applied batch it then
 *      aborts on.
 *   4. Only `source='exploration'` rows are touched. Hand-authored and
 *      chat-authored tests are never rewritten.
 *   5. A row is written ONLY when at least one step is actually removed.
 */

import { supabaseAdmin } from '@/db/supabase';
import {
  dedupePersistedSteps,
  type PersistedStep,
} from '@/services/testing/exploration/duplicate-steps';

interface Args {
  apply: boolean;
  explorationId?: string;
  projectId?: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const limitRaw = Number(get('limit'));
  return {
    apply: argv.includes('--apply'),
    explorationId: get('exploration'),
    projectId: get('project'),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 1000,
  };
}

interface Row {
  id: string;
  name: string;
  exploration_id: string | null;
  steps_json: PersistedStep[] | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(
    `[DEDUPE] mode=${args.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'} ` +
      `exploration=${args.explorationId ?? 'all'} project=${args.projectId ?? 'all'} limit=${args.limit}`,
  );

  let query = supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, exploration_id, steps_json')
    .eq('source', 'exploration')
    .order('created_at', { ascending: true })
    .limit(args.limit);

  if (args.explorationId) query = query.eq('exploration_id', args.explorationId);
  if (args.projectId) query = query.eq('project_id', args.projectId);

  const { data, error } = await query;
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[DEDUPE] Failed to read test cases:', error.message);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as Row[];
  let scanned = 0;
  let affected = 0;
  let stepsRemoved = 0;
  let written = 0;
  let writeFailures = 0;

  for (const row of rows) {
    scanned++;
    const original = Array.isArray(row.steps_json) ? row.steps_json : [];
    if (original.length < 2) continue;

    const { steps, removed } = dedupePersistedSteps(original);
    if (removed === 0) continue;

    affected++;
    stepsRemoved += removed;

    // eslint-disable-next-line no-console
    console.log(
      `  ${args.apply ? 'FIX ' : 'WOULD FIX'} ${row.id}  "${row.name}"  ` +
        `${original.length} → ${steps.length} steps (−${removed})`,
    );

    if (!args.apply) continue;

    // Per-row write. A failure is reported and the sweep continues: aborting
    // mid-batch would leave an arbitrary prefix rewritten with no record of
    // where it stopped.
    const { error: updateError } = await supabaseAdmin
      .from('intent_test_cases')
      .update({ steps_json: steps })
      .eq('id', row.id);

    if (updateError) {
      writeFailures++;
      // eslint-disable-next-line no-console
      console.error(`  FAILED ${row.id}: ${updateError.message}`);
    } else {
      written++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n[DEDUPE] scanned=${scanned} affected=${affected} stepsRemoved=${stepsRemoved}` +
      (args.apply ? ` written=${written} failures=${writeFailures}` : ' (dry run — nothing written)'),
  );

  if (!args.apply && affected > 0) {
    // eslint-disable-next-line no-console
    console.log('[DEDUPE] Re-run with --apply to write these changes.');
  }
  if (writeFailures > 0) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[DEDUPE] Unexpected failure:', err);
  process.exitCode = 1;
});
