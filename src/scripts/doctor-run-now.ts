/**
 * Run the Regression Doctor job in-process against a real run.
 *
 * The same handler the worker executes, so this exercises the whole path
 * including the DB write — unlike `doctor-dryrun.ts`, which stops before
 * persistence. Used to verify the analysis end-to-end without driving the UI.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/doctor-run-now.ts <runId>
 */

import { RegressionDoctorJobHandler } from '@/jobs/regression-doctor.job';
import { supabaseAdmin } from '@/db/supabase';

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error('usage: doctor-run-now.ts <runId>');

  const { data: run } = await supabaseAdmin
    .from('regression_runs')
    .select('id, project_id, user_id, status')
    .eq('id', runId)
    .maybeSingle();

  if (!run) throw new Error(`run ${runId} not found`);
  console.log(`\n=== RUN ${runId} (${run.status}) ===`);

  const result = await RegressionDoctorJobHandler.process({
    id: 'manual',
    data: { runId, projectId: run.project_id, userId: run.user_id },
  } as never);

  console.log('\n=== JOB RESULT ===', JSON.stringify(result));

  const { data: findings } = await supabaseAdmin
    .from('regression_doctor_findings')
    .select('id, verdict, confidence, step_index, proposed_patch, diagnosis, evidence')
    .eq('run_id', runId);

  console.log(`\n=== PERSISTED FINDINGS: ${findings?.length ?? 0} ===`);
  for (const f of findings ?? []) {
    const ev = (f as { evidence?: Record<string, unknown> }).evidence ?? {};
    console.log(`\n  ${f.verdict} @ ${f.confidence} — step ${f.step_index} of "${ev.test_case_name}"`);
    console.log(`  step:      ${ev.step_type} — ${ev.step_description}`);
    console.log(`  diagnosis: ${f.diagnosis}`);
    console.log(`  patch:     ${f.proposed_patch ? JSON.stringify(f.proposed_patch) : 'none'}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n=== FAILED ===');
    console.error(err);
    process.exit(1);
  });
