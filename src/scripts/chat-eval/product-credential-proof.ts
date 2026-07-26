/**
 * Rung-5 run-proof — a PRODUCTION-path saved test that replays green with the
 * credential resolved from the encrypted store.
 *
 *   npm run chat-eval:credential-proof
 *
 * (the feature is default-ON; the guard below still checks, so an environment
 * that has explicitly set CREDENTIAL_AUTHORING_ENABLED=false fails with a clear
 * message instead of a confusing refusal mid-run)
 *
 * Rung 4 proved the substrate through the EVAL path (`authorOnFixture` calls
 * `EditorIterativeAuthorService` directly). That says nothing about the product:
 * nothing in the product passed `credentialSecret`, and the draft-steps cache
 * dropped the binding, so a real user's saved login test still 401'd.
 *
 * This walks the seams a real user actually goes through:
 *
 *   createResource (real CRUD, AES-256-GCM at rest)
 *     -> startSession (real preview session on the fixture)
 *     -> handleAuthorTestIteratively (the real chat TOOL, named credential)
 *     -> DraftStepsCache (the documented trap)
 *     -> handleCreateTestCase (the real save TOOL, real DB row)
 *     -> executePlaywrightTest with the SAVED row's bindings (real replay)
 *
 * and then asserts SEMANTICS, not a green tick (see CHECKS below). Every check
 * is falsifiable: each one fails loudly with what it saw.
 *
 * Footprint on the configured Supabase: one `test_resources` row, one
 * `intent_test_cases` row, both namespaced and deleted in `finally`, plus the
 * inert `credit_transactions` rows an append-only ledger will not let us delete
 * (documented in seed-eval-credential.ts).
 *
 * Manual tool (src/scripts). Not CI. MUST process.exit() — inherited
 * Redis/BullMQ/browserPool handles keep the loop alive.
 */

import * as dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });
process.env.SCREENSHOT_EACH_STEP_ENABLED = 'false';
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'info';

import { randomUUID } from 'crypto';
import type { Server } from 'http';
import { supabaseAdmin } from '@/db/supabase';
import { executePlaywrightTest } from '@/agent/playwright/core/test-executor';
import { convertIntentStepsToCommands } from '@/services/testing/ui/preview/intent-step-converter.service';
import { getPreviewSessionService } from '@/services/testing/ui/preview/preview-session.service';
import { DraftStepsCache } from '@/services/testing/ui/preview/draft-steps-cache';
import { handleAuthorTestIteratively, handleCreateTestCase } from '@/services/skills/qa/qa-tool-handlers';
import { registerBuiltinResourceAdapters } from '@/services/test-resource';
import { CredentialAuthoringFeature } from '@/config/features/credential-authoring';
import { createResource, deleteResource } from '@/services/test-resource/test-resource.service';
import type { SkillContext } from '@/services/skills/types';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { EVAL_USER_ID } from './eval-identity';
import { cleanupEvalUserBilling } from './seed-eval-credential';

const fixtureServer = require('./fixture/server') as {
  start: (port?: number) => Promise<Server>;
  PORT: number;
  HOST: string;
};

// The fixture's demo login (fixture/server.js).
const DEMO_EMAIL = 'demo@qait.dev';
const DEMO_PASSWORD = 'password';

/** Human-readable — this is the name the "user" speaks to the agent. */
const SECRET_NAME = '__rung5_proof_login__';
const TEST_CASE_NAME = '__rung5_proof_login_test__';
const EMAIL_KEY = 'login_email';
const PASSWORD_KEY = 'login_password';

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name} — ${detail}`);
}

/**
 * Capture what the process logs during replay so redaction can be asserted on
 * real output rather than assumed. Returns a restore fn + the buffer.
 */
function captureStdout(): { buffer: string[]; restore: () => void } {
  const buffer: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const tap = (orig: typeof origOut) => ((chunk: any, ...rest: any[]): boolean => {
    try { buffer.push(typeof chunk === 'string' ? chunk : String(chunk)); } catch { /* ignore */ }
    return (orig as any)(chunk, ...rest);
  }) as typeof origOut;
  process.stdout.write = tap(origOut);
  process.stderr.write = tap(origErr);
  return {
    buffer,
    restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; },
  };
}

async function borrowProjectId(): Promise<string> {
  const { data, error } = await supabaseAdmin.from('projects').select('id').limit(1).maybeSingle();
  if (error) throw new Error(`Cannot read a project (${error.message}) — check SUPABASE_* in .env`);
  if (!data?.id) throw new Error('No rows in `projects`; intent_test_cases.project_id has a NOT NULL FK.');
  return data.id as string;
}

/**
 * FALSE-GREEN GUARD. `enrichBindingsWithDefaults` attaches a workspace-default
 * `secret` to every new test independently of this feature — so if one exists
 * for this project, the replay would resolve and go green while the cache ->
 * create() path is still dropping the binding. Refuse to run in that case.
 */
async function assertNoDefaultSecret(projectId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('workspace_resource_defaults')
    .select('resource_id')
    .eq('project_id', projectId)
    .eq('kind', 'secret');
  if (error) {
    console.log(`  ⚠️  could not check workspace_resource_defaults (${error.message}) — continuing`);
    return;
  }
  if (data && data.length > 0) {
    throw new Error(
      `Project ${projectId} has a DEFAULT secret resource. This run would go green even if the ` +
      'binding were dropped — the proof would be meaningless. Pick a project without one.',
    );
  }
}

async function main(): Promise<number> {
  // Default-ON, so this only fires where it was explicitly disabled — without
  // the guard the script would fail at the authoring step with a refusal
  // message that reads like a regression.
  if (!CredentialAuthoringFeature.isEnabled()) {
    console.error(
      '\nCREDENTIAL_AUTHORING_ENABLED is set to false in this environment, so the\n' +
      'tool will refuse to bind a saved login. Unset it (the default is on) or run:\n\n' +
      '  CREDENTIAL_AUTHORING_ENABLED=true npm run chat-eval:credential-proof\n',
    );
    return 1;
  }

  // A standalone script inherits NO boot wiring (L-0030) — the resource adapter
  // registry is empty until this call, and the failure surfaces late, at first
  // use, as "No adapter registered for resource kind 'secret'".
  registerBuiltinResourceAdapters();

  const server = await fixtureServer.start();
  const baseUrl = `http://${fixtureServer.HOST}:${fixtureServer.PORT}`;
  const sessionService = getPreviewSessionService();

  const projectId = await borrowProjectId();
  await assertNoDefaultSecret(projectId);

  const chatSessionId = `rung5-proof-${randomUUID()}`;
  let resourceId: string | undefined;
  let testCaseId: string | undefined;
  let previewSessionId: string | undefined;

  try {
    // ── 1. Store the credential through the REAL CRUD path ────────────────
    const secret = await createResource({
      userId: EVAL_USER_ID,
      projectId,
      kind: 'secret',
      name: SECRET_NAME,
      description: 'Ephemeral rung-5 proof login. Deleted after the run.',
      config: { values: { [EMAIL_KEY]: DEMO_EMAIL, [PASSWORD_KEY]: DEMO_PASSWORD } },
      // Synthetic user id + a borrowed project row (FK only) — no real caller
      // to authorize. See CreateResourceInput.skipAccessCheck.
      skipAccessCheck: true,
    });
    resourceId = secret.id;
    console.log(`\n[1] Stored credential secret "${SECRET_NAME}" (${resourceId})`);

    const { data: rawRow } = await supabaseAdmin
      .from('test_resources').select('config, sensitive').eq('id', resourceId).maybeSingle();
    const envelope = JSON.stringify((rawRow as any)?.sensitive ?? {});
    check(
      'encrypted at rest',
      !envelope.includes(DEMO_EMAIL) && envelope.includes(':'),
      `sensitive envelope is ciphertext, config=${JSON.stringify((rawRow as any)?.config ?? {})}`,
    );

    // ── 2. Author through the REAL chat tool, naming the saved login ──────
    const session = await sessionService.startSession({
      userId: EVAL_USER_ID,
      projectId,
      startUrl: `${baseUrl}/login`,
    });
    previewSessionId = session.previewSessionId;

    const ctx: SkillContext = {
      userId: EVAL_USER_ID,
      workspaceId: 'rung5-proof',
      chatSessionId,
      projectId,
      previewSessionId,
      mode: 'editor',
    };

    console.log('\n[2] Authoring via qa_author_test_iteratively (LLM — costs tokens)…');
    const authored = await handleAuthorTestIteratively({
      goal: 'log in with the saved credentials and confirm the dashboard greets the user',
      suggested_name: TEST_CASE_NAME,
      credential_secret_name: SECRET_NAME,
      confirm: true,
    }, ctx);

    if (!authored.success) {
      check('authoring succeeded', false, authored.message);
      return 1;
    }
    console.log(`    ${authored.message}`);

    // ── 3. The trap: does the binding survive the draft-steps cache? ──────
    const cached = DraftStepsCache.get(chatSessionId);
    const draftSteps = (cached?.steps ?? []) as IntentStep[];
    check(
      'binding present in the draft cache',
      cached?.resourceBindings?.[0]?.resource_id === resourceId,
      `cache bindings=${JSON.stringify(cached?.resourceBindings ?? null)}`,
    );
    const frozeCredential = draftSteps.some(
      (s) => typeof s.value === 'string' && s.value.includes('{{secrets.'),
    );
    check(
      'a credential was frozen as a placeholder',
      frozeCredential,
      `steps=${draftSteps.length}, values=${JSON.stringify(draftSteps.map((s) => s.value).filter(Boolean))}`,
    );

    // ── 4. Save through the REAL save tool (the LLM re-emits its copy) ────
    console.log('\n[3] Saving via qa_create_test_case…');
    const saved = await handleCreateTestCase({
      project_id: projectId,
      name: TEST_CASE_NAME,
      start_url: `${baseUrl}/login`,
      steps: draftSteps,
      confirm: true,
    }, ctx);
    if (!saved.success) {
      check('save succeeded', false, saved.message);
      return 1;
    }
    testCaseId = saved.data?.testCaseId as string;
    console.log(`    saved test case ${testCaseId}`);

    // ── 5. Assert the PERSISTED row, not the in-memory draft ─────────────
    const { data: row } = await supabaseAdmin
      .from('intent_test_cases')
      .select('resource_bindings, steps_json, start_url')
      .eq('id', testCaseId)
      .maybeSingle();

    const savedBindings = (row as any)?.resource_bindings ?? [];
    const secretBinding = savedBindings.find((b: any) => b.kind === 'secret');
    check(
      'binding PERSISTED on the saved test case',
      secretBinding?.resource_id === resourceId,
      `resource_bindings=${JSON.stringify(savedBindings)}`,
    );

    const stepsJson = JSON.stringify((row as any)?.steps_json ?? []);
    check(
      'saved steps carry {{secrets.*}}',
      stepsJson.includes('{{secrets.'),
      `${(((row as any)?.steps_json ?? []) as unknown[]).length} steps persisted`,
    );
    // Structural, not a log grep: the whole persisted blob (compiled locator
    // plans and fingerprints included) must contain no credential literal.
    const emailHits = stepsJson.split(DEMO_EMAIL).length - 1;
    check(
      'saved steps contain NO credential literal (incl. compiled plans)',
      emailHits === 0,
      `"${DEMO_EMAIL}" occurrences in steps_json = ${emailHits}`,
    );

    // ── 6. Replay the SAVED test in a fresh browser ───────────────────────
    console.log('\n[4] Replaying the SAVED test case…');
    const savedSteps = ((row as any)?.steps_json ?? []) as IntentStep[];
    const startUrl = ((row as any)?.start_url as string) || `${baseUrl}/login`;
    const commands = convertIntentStepsToCommands(savedSteps, startUrl);

    const cap = captureStdout();
    let replay;
    try {
      replay = await executePlaywrightTest({
        testId: randomUUID(),
        url: startUrl,
        browser: 'chrome',
        projectId,
        userId: EVAL_USER_ID,
        resourceBindings: savedBindings,
        commands,
        intelligentMode: false,
        mode: 'lite',
      });
    } finally {
      cap.restore();
    }
    const replayLog = cap.buffer.join('');

    check(
      'saved test replays GREEN',
      replay.success === true,
      `status=${replay.status ?? 'n/a'}${replay.success ? '' : ` error=${JSON.stringify(replay.errors?.[0] ?? replay.error ?? null).slice(0, 300)}`}`,
    );
    check(
      'the secret was applied from the store at replay',
      replayLog.includes('[RESOURCE_APPLIER]') && replayLog.includes('secret'),
      'looked for [RESOURCE_APPLIER] + kind secret in the run log',
    );
    check(
      'credential values are REDACTED in the run log',
      !replayLog.includes(DEMO_EMAIL) && replayLog.includes('***'),
      `"${DEMO_EMAIL}" occurrences in log = ${replayLog.split(DEMO_EMAIL).length - 1}`,
    );
    check(
      'login genuinely succeeded (reached /dashboard)',
      replayLog.includes('/dashboard'),
      'looked for a /dashboard navigation in the run log',
    );

    return checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    console.log('\n[5] Teardown…');
    if (previewSessionId) {
      await sessionService.stopSession(previewSessionId, EVAL_USER_ID).catch(() => { /* best-effort */ });
    }
    if (testCaseId) {
      const { error } = await supabaseAdmin.from('intent_test_cases').delete().eq('id', testCaseId);
      console.log(error ? `  ⚠️  test case ${testCaseId} NOT deleted: ${error.message}` : `  removed test case ${testCaseId}`);
    }
    if (resourceId) {
      const { deleted } = await deleteResource(resourceId, EVAL_USER_ID).catch(() => ({ deleted: false }));
      console.log(deleted ? `  removed secret ${resourceId}` : `  ⚠️  secret ${resourceId} NOT deleted — remove it manually`);
    }
    DraftStepsCache.delete(chatSessionId);
    await cleanupEvalUserBilling().catch(() => { /* best-effort */ });
    await new Promise<void>((res) => server.close(() => res()));
  }
}

main()
  .then((code) => {
    console.log(`\n${'─'.repeat(60)}`);
    const failed = checks.filter((c) => !c.ok);
    // Zero checks means we bailed before proving anything — reporting that as
    // PASSED would be precisely the false-green this script exists to catch.
    console.log(checks.length === 0
      ? 'RUN-PROOF DID NOT RUN — nothing was verified (see the message above)'
      : failed.length === 0
        ? `RUN-PROOF PASSED — ${checks.length}/${checks.length} checks`
        : `RUN-PROOF FAILED — ${failed.length}/${checks.length} checks failed: ${failed.map((c) => c.name).join(', ')}`);
    process.exit(code);
  })
  .catch((err) => {
    console.error('\nRUN-PROOF ERRORED:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
