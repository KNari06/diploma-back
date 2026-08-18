/**
 * Read-only dry run of the Regression Doctor against a real finished run.
 *
 * Runs collection + analysis + patch application in memory and prints what
 * WOULD be persisted. Writes nothing: no finding row, no steps_json update.
 * Used to verify the pipeline against real data while the schema migration is
 * still unapplied.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/doctor-dryrun.ts <runId>
 */

import { collectFailedSteps } from '@/services/regression-doctor/failed-step-collector';
import { analyzeFailedStep } from '@/services/regression-doctor/step-fix-agent';
import { applyStepPatch } from '@/services/regression-doctor/patch-applier';

async function main() {
  const runId = process.argv[2];
  if (!runId) throw new Error('usage: doctor-dryrun.ts <runId>');

  console.log(`\n=== COLLECT (run ${runId}) ===`);
  const { evidence, skipped } = await collectFailedSteps(runId);
  console.log(`evidence: ${evidence.length}, skipped: ${skipped.length}`);
  for (const s of skipped) {
    console.log(`  skip ${s.testId.slice(0, 8)} → ${s.reason}${s.detail ? ` (${s.detail})` : ''}`);
  }

  for (const e of evidence) {
    console.log(`\n=== EVIDENCE: ${e.testCaseName} ===`);
    console.log(`  platform      ${e.platform}`);
    console.log(`  step          #${e.stepIndex} ${e.step.type} — ${e.step.description}`);
    console.log(`  stepId        ${e.stepId}`);
    console.log(`  bindingHints  ${JSON.stringify(e.step.bindingHints ?? null)}`);
    console.log(`  compiled?     ${Boolean((e.step as { compiled?: unknown }).compiled)}`);
    console.log(`  failedReason  ${e.failedReason ?? '—'}`);
    console.log(`  explanation   ${e.failureExplanation ?? '—'}`);
    console.log(`  failShot      ${e.failScreenshotUrl ? 'yes' : 'no'}`);
    console.log(`  priorShot     ${e.priorScreenshotUrl ? 'yes' : 'no'}`);
    console.log(`  context       [${e.precedingSteps.map((s) => s.type).join(', ')}] → ? → ${e.followingStep?.type ?? '(end)'}`);

    console.log(`\n--- ANALYZE ---`);
    const verdict = await analyzeFailedStep({ evidence: e, kbChunks: [] });
    console.log(`  verdict     ${verdict.verdict}  (confidence ${verdict.confidence})`);
    console.log(`  diagnosis   ${verdict.diagnosis}`);
    console.log(`  patch       ${verdict.patch ? JSON.stringify(verdict.patch, null, 2) : 'none'}`);

    if (verdict.patch) {
      console.log(`\n--- DRY APPLY (in memory) ---`);
      const before = [e.step];
      try {
        const out = applyStepPatch(
          [...e.precedingSteps, e.step, ...(e.followingStep ? [e.followingStep] : [])],
          e.stepId,
          verdict.patch,
        );
        console.log(`  ${out.description}`);
        const patched = out.steps.find((s) => s.id === e.stepId) ?? out.steps[e.precedingSteps.length];
        console.log(`  before: ${JSON.stringify({ description: before[0].description, bindingHints: before[0].bindingHints, compiled: Boolean((before[0] as { compiled?: unknown }).compiled) })}`);
        console.log(`  after:  ${JSON.stringify({ description: patched.description, bindingHints: patched.bindingHints, compiled: Boolean((patched as { compiled?: unknown }).compiled) })}`);
      } catch (err) {
        console.log(`  patch rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log('\n=== DONE (nothing was written) ===');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
