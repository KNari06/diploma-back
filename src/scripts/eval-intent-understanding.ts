/**
 * Live intent-understanding evaluation harness.
 *
 * Feeds every case in src/test/fixtures/intent-understanding-cases.ts through
 * the REAL parseIntent (live OpenAI/Gemini + the same scope guards the chat
 * controller applies), then prints an expected / got / PASS-FAIL table and a
 * summary. Use it to answer: "does the system actually understand what the
 * user wants, and route it correctly?"
 *
 * This hits the live LLM — it costs tokens and is non-deterministic. It is a
 * MANUAL tool, NOT a CI test (lives in src/scripts/, not src/test/).
 *
 * Run:
 *   npm run eval-intent
 *   npm run eval-intent -- --surface=web_editor      # filter by surface
 *   npm run eval-intent -- --lang=ru                 # filter by language
 *   npm run eval-intent -- --only="login"            # substring match on name
 *
 * Requires OPENAI_API_KEY (and Gemini key if the classifier uses it) in env.
 */

import { parseIntent } from '@/api/chat/shared/intent-parsing';
import {
  ALL_INTENT_CASES,
  type IntentCase,
  type Surface,
} from '@/test/fixtures/intent-understanding-cases';

// parseIntent validates these as UUIDs (workspace/user/test-case scoping).
// Use throwaway-but-valid UUIDs; classification doesn't depend on real rows,
// and the RAG/enrichment lookups are best-effort + wrapped.
const EVAL_USER_ID = '00000000-0000-4000-8000-000000000001';
const EVAL_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const EVAL_TEST_CASE_ID = '00000000-0000-4000-8000-000000000003';

// ── Surface → context the controller would build ───────────────────────────
// Mirrors chat.controller.ts: tc-scope forces mode='editor' and sets the
// matching session id in context.
function contextForSurface(surface: Surface): {
  context: Record<string, unknown>;
  mode: 'lite' | 'pro' | 'editor';
  isTestCaseScope: boolean;
  testCaseId?: string;
} {
  switch (surface) {
    case 'web_editor':
      return {
        context: { previewSessionId: 'eval-preview-session' },
        mode: 'editor',
        isTestCaseScope: true,
        testCaseId: EVAL_TEST_CASE_ID,
      };
    case 'mobile_editor':
      return {
        context: { mobileEditorMode: true, mobileSessionId: 'eval-mobile-session' },
        mode: 'editor',
        isTestCaseScope: true,
        testCaseId: EVAL_TEST_CASE_ID,
      };
    case 'global':
    default:
      return { context: {}, mode: 'lite', isTestCaseScope: false };
  }
}

interface RunResult {
  c: IntentCase;
  got: string;
  ok: boolean;
  error?: string;
}

async function runCase(c: IntentCase): Promise<RunResult> {
  const { context, mode, isTestCaseScope, testCaseId } = contextForSurface(c.surface);
  try {
    const parsed = await parseIntent(
      c.input,
      context,
      undefined, // chatSessionId
      EVAL_USER_ID, // userId
      EVAL_WORKSPACE_ID, // workspace_id
      () => {}, // checkRequestTimeout (no-op)
      undefined, // abortSignal
      undefined, // functionLogger
      mode,
      isTestCaseScope,
      testCaseId,
    );
    const got = (parsed?.intent as string) ?? '(null)';
    return { c, got, ok: got === c.expectedIntent };
  } catch (err) {
    return { c, got: '(error)', ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseArgs(): { surface?: string; lang?: string; only?: string } {
  const out: { surface?: string; lang?: string; only?: string } = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(surface|lang|only)=(.+)$/);
    if (m) out[m[1] as 'surface' | 'lang' | 'only'] = m[2];
  }
  return out;
}

async function main(): Promise<void> {
  const { surface, lang, only } = parseArgs();
  const cases = ALL_INTENT_CASES.filter(
    (c) =>
      (!surface || c.surface === surface) &&
      (!lang || c.lang === lang) &&
      (!only || c.name.toLowerCase().includes(only.toLowerCase())),
  );

  if (cases.length === 0) {
    console.log('No cases match the filter.');
    return;
  }

  console.log(`\nRunning ${cases.length} intent-understanding case(s) against the LIVE classifier...\n`);

  const results: RunResult[] = [];
  for (const c of cases) {
    // Sequential — keeps LLM rate-limits + log output readable.
    const r = await runCase(c);
    results.push(r);
    const mark = r.ok ? '✅' : '❌';
    console.log(`${mark} [${c.surface}/${c.lang}] ${c.name}`);
    console.log(`    input:    "${c.input}"`);
    console.log(`    wants:    ${c.wants}`);
    console.log(`    expected: ${c.expectedIntent}${c.expectedRawIntent ? ` (raw: ${c.expectedRawIntent})` : ''}`);
    console.log(`    got:      ${r.got}${r.error ? `  [${r.error}]` : ''}`);
    if (!r.ok) console.log(`    why:      ${c.rationale}`);
    console.log('');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('───────────────────────────────────────────────');
  console.log(`TOTAL: ${results.length}   PASS: ${passed}   FAIL: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  ❌ ${r.c.surface}/${r.c.name}: expected ${r.c.expectedIntent}, got ${r.got}`);
    }
  }
  console.log('');

  // Non-zero exit on any failure so the harness is CI-pluggable if desired.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[eval-intent] fatal:', err);
  process.exit(1);
});
