/**
 * KB eval harness
 *
 * Reads data/global-kb/evals/golden.jsonl, runs each query through the
 * production retrieval pipeline (searchKB, same call chat uses), and
 * prints hit@k / MRR / recall@k, both overall and per-category.
 *
 * Usage:
 *   npm run eval-kb                    # just run
 *   npm run eval-kb -- --k=5           # override top-k
 *   npm run eval-kb -- --baseline      # compare vs baseline.json
 *   npm run eval-kb -- --save-baseline # overwrite baseline.json
 *   npm run eval-kb -- --ci            # exit non-zero on regression
 *                                      # (regression = any metric drops >= 2pp / MRR 0.02)
 *
 * Output: console report + JSON at data/global-kb/evals/last-run.json.
 *
 * Baseline workflow:
 *   1. `npm run eval-kb -- --save-baseline`  → freeze current scores
 *   2. make a change (content, chunking, retrieval)
 *   3. `npm run eval-kb -- --baseline`       → prints diff vs baseline
 *   4. in CI: `npm run eval-kb -- --baseline --ci` fails PR on regression
 */

import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Quiet noisy debug logs during eval — we only care about the final report.
// Set EVAL_VERBOSE=1 to opt back in.
if (!process.env.EVAL_VERBOSE) {
  process.env.LOG_LEVEL = 'warn';
}

import { loadGlobalKB } from '@/services/kb/localKB.service';
import { searchKB } from '@/services/kb/kb.service';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GoldenItem {
  id: string;
  query: string;
  must_cite: string[];
  /** Optional category for per-bucket metrics. Inferred from first must_cite path if absent. */
  category?: string;
}

interface QueryResult {
  id: string;
  query: string;
  category: string;
  expected: string[];
  retrieved: string[];
  /** Rank of the first expected doc in retrieved (1-based); null if missed. */
  firstHitRank: number | null;
  /** How many UNIQUE expected docs landed in the top-k retrieved set. */
  expectedFound: number;
  /** True if firstHitRank !== null && firstHitRank <= k */
  hitInK: boolean;
}

interface Metrics {
  hitAt1: number;
  hitAtK: number;
  mrr: number;
  recallAtK: number;
}

interface EvalReport {
  generatedAt: string;
  totalQueries: number;
  k: number;
  metrics: Metrics;
  byCategory: Record<string, Metrics & { count: number }>;
  /** Only in last-run.json — stripped from baseline.json to prevent drift. */
  misses?: Array<{ id: string; query: string; expected: string[]; retrieved: string[] }>;
  /** Optional metadata captured for reproducibility. */
  env?: { kbChunks: number; kbModel?: string; kbVersion?: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

function parseArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseIntArg(name: string, fallback: number, min: number, max: number): number {
  const raw = parseArgValue(name);
  if (raw === null) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.error(`❌ Invalid --${name}=${raw} (expected integer). Using default ${fallback}.`);
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

const K = parseIntArg('k', 5, 1, 100);
const SHOULD_SAVE_BASELINE = hasFlag('save-baseline');
const SHOULD_COMPARE_BASELINE = hasFlag('baseline');
const IS_CI = hasFlag('ci');

/** Regression thresholds for CI gate. A drop strictly larger than these fails CI. */
const CI_REGRESSION_THRESHOLD = {
  percentPoints: 0.02, // 2pp for hit@1, hit@k, recall@k
  mrr: 0.02,
};

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const EVALS_DIR = path.join(process.cwd(), 'data/global-kb/evals');
const GOLDEN_PATH = path.join(EVALS_DIR, 'golden.jsonl');
const LAST_RUN_PATH = path.join(EVALS_DIR, 'last-run.json');
const BASELINE_PATH = path.join(EVALS_DIR, 'baseline.json');

// ─────────────────────────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────────────────────────

function inferCategory(item: GoldenItem): string {
  if (item.category && item.category.trim()) return item.category.trim();
  const first = item.must_cite[0];
  if (!first) return 'uncategorized';
  // "en/playwright-2026/locator-handler.md" → "playwright-2026"
  const parts = first.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[1] : parts[0] || 'uncategorized';
}

async function readGolden(): Promise<GoldenItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(GOLDEN_PATH, 'utf-8');
  } catch (error) {
    throw new Error(
      `Cannot read ${GOLDEN_PATH}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const items: GoldenItem[] = [];
  const seenIds = new Set<string>();
  // Handle both LF and CRLF; skip blanks and leading BOM
  raw.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Invalid JSONL at line ${idx + 1}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as GoldenItem).id !== 'string' ||
      typeof (parsed as GoldenItem).query !== 'string' ||
      !Array.isArray((parsed as GoldenItem).must_cite) ||
      (parsed as GoldenItem).must_cite.some((c) => typeof c !== 'string' || c.length === 0)
    ) {
      throw new Error(
        `Invalid golden item at line ${idx + 1}: missing/invalid id, query, or must_cite`
      );
    }
    const item = parsed as GoldenItem;
    if (seenIds.has(item.id)) {
      throw new Error(`Duplicate golden id "${item.id}" at line ${idx + 1}`);
    }
    seenIds.add(item.id);
    items.push(item);
  });

  if (items.length === 0) {
    throw new Error(`Golden set is empty: ${GOLDEN_PATH}`);
  }

  return items;
}

async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readJSONIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval — uses the EXACT function production chat uses
// ─────────────────────────────────────────────────────────────────────────────

async function retrieveForQuery(query: string, k: number): Promise<string[]> {
  // searchKB is what context-enrichment.service.ts calls in prod. Calling it
  // here guarantees the eval measures exactly what users see — no drift.
  const result = await searchKB(query, undefined, { matchCount: k });
  return (result.chunks || [])
    .map((c) => c.source_file || c.file_name || '')
    .filter((p) => p.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

function scoreQuery(
  item: GoldenItem,
  retrievedFiles: string[],
  k: number
): QueryResult {
  const expectedSet = new Set(item.must_cite);

  // Rank of FIRST expected doc in the retrieval order (1-based). Standard MRR.
  let firstHitRank: number | null = null;
  retrievedFiles.forEach((file, idx) => {
    if (firstHitRank === null && expectedSet.has(file)) {
      firstHitRank = idx + 1;
    }
  });

  // Recall on UNIQUE files — a file appearing twice in top-k counts as one hit.
  const uniqueRetrieved = new Set(retrievedFiles);
  let expectedFound = 0;
  for (const f of item.must_cite) {
    if (uniqueRetrieved.has(f)) expectedFound++;
  }

  return {
    id: item.id,
    query: item.query,
    category: inferCategory(item),
    expected: item.must_cite,
    retrieved: retrievedFiles,
    firstHitRank,
    expectedFound,
    hitInK: firstHitRank !== null && firstHitRank <= k,
  };
}

function computeMetrics(results: QueryResult[], k: number): Metrics {
  const n = results.length;
  if (n === 0) {
    return { hitAt1: 0, hitAtK: 0, mrr: 0, recallAtK: 0 };
  }

  const hitAt1 = results.filter((r) => r.firstHitRank === 1).length / n;
  const hitAtK = results.filter((r) => r.hitInK).length / n;
  const mrr =
    results.reduce((sum, r) => sum + (r.firstHitRank ? 1 / r.firstHitRank : 0), 0) / n;

  // recall@k averaged per query so multi-expected queries contribute proportionally
  const recallAtK =
    results.reduce((sum, r) => {
      const expectedCount = Math.max(1, r.expected.length);
      return sum + r.expectedFound / expectedCount;
    }, 0) / n;

  return { hitAt1, hitAtK, mrr, recallAtK };
}

function groupByCategory(
  results: QueryResult[],
  k: number
): Record<string, Metrics & { count: number }> {
  const buckets = new Map<string, QueryResult[]>();
  for (const r of results) {
    const bucket = buckets.get(r.category) ?? [];
    bucket.push(r);
    buckets.set(r.category, bucket);
  }

  const out: Record<string, Metrics & { count: number }> = {};
  for (const [cat, arr] of buckets) {
    out[cat] = { ...computeMetrics(arr, k), count: arr.length };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number): string {
  return n.toFixed(4);
}

function fmtDelta(curr: number, base: number | undefined, asPct: boolean): string {
  if (base === undefined) return '';
  const diff = curr - base;
  if (Math.abs(diff) < (asPct ? 0.00005 : 0.00005)) return '   (=)';
  const sign = diff > 0 ? '+' : '';
  const val = asPct ? `${sign}${(diff * 100).toFixed(1)}pp` : `${sign}${diff.toFixed(4)}`;
  return `   (${val})`;
}

function printMetricsBlock(
  label: string,
  m: Metrics,
  k: number,
  base: Metrics | null,
  extra = ''
): void {
  console.log(`  ${label}${extra}`);
  console.log(`    hit@1      ${fmtPct(m.hitAt1)}${fmtDelta(m.hitAt1, base?.hitAt1, true)}`);
  console.log(`    hit@${k}      ${fmtPct(m.hitAtK)}${fmtDelta(m.hitAtK, base?.hitAtK, true)}`);
  console.log(`    MRR        ${fmtNum(m.mrr)}${fmtDelta(m.mrr, base?.mrr, false)}`);
  console.log(`    recall@${k}   ${fmtPct(m.recallAtK)}${fmtDelta(m.recallAtK, base?.recallAtK, true)}`);
}

function printReport(
  report: EvalReport,
  baseline: EvalReport | null,
  byIdDiff: { newlyPassing: string[]; newlyFailing: string[] } | null
): void {
  console.log('\n' + '═'.repeat(64));
  console.log(`KB Eval Report — ${report.generatedAt}`);
  console.log('═'.repeat(64));
  console.log(`Queries: ${report.totalQueries}   k=${report.k}   chunks: ${report.env?.kbChunks ?? '?'}`);
  if (baseline) {
    console.log(`Baseline: ${baseline.generatedAt} (${baseline.totalQueries} queries)`);
  }
  console.log('');

  console.log('Overall:');
  printMetricsBlock('', report.metrics, report.k, baseline?.metrics ?? null);

  console.log('');
  console.log('By category:');
  const cats = Object.keys(report.byCategory).sort();
  for (const cat of cats) {
    const m = report.byCategory[cat];
    const base = baseline?.byCategory?.[cat] ?? null;
    printMetricsBlock(cat, m, report.k, base, `   (${m.count} queries)`);
  }

  if (byIdDiff) {
    if (byIdDiff.newlyPassing.length > 0) {
      console.log('');
      console.log(`✅ Newly passing (${byIdDiff.newlyPassing.length}):`);
      byIdDiff.newlyPassing.forEach((id) => console.log(`   + ${id}`));
    }
    if (byIdDiff.newlyFailing.length > 0) {
      console.log('');
      console.log(`❌ Newly failing (${byIdDiff.newlyFailing.length}):`);
      byIdDiff.newlyFailing.forEach((id) => console.log(`   - ${id}`));
    }
  }

  if (report.misses && report.misses.length > 0) {
    console.log('');
    console.log(`Misses (${report.misses.length}):`);
    report.misses.slice(0, 15).forEach((m) => {
      console.log(`  [${m.id}] ${m.query}`);
      console.log(`     expected: ${m.expected.join(', ')}`);
      console.log(`     got:      ${m.retrieved.slice(0, 3).join(', ')}${m.retrieved.length > 3 ? ', …' : ''}`);
    });
    if (report.misses.length > 15) {
      console.log(`     … ${report.misses.length - 15} more (see ${LAST_RUN_PATH})`);
    }
  }

  console.log('');
}

// ─────────────────────────────────────────────────────────────────────────────
// CI regression check
// ─────────────────────────────────────────────────────────────────────────────

function detectRegression(curr: Metrics, base: Metrics): string[] {
  const problems: string[] = [];
  const { percentPoints, mrr } = CI_REGRESSION_THRESHOLD;

  if (base.hitAt1 - curr.hitAt1 > percentPoints) {
    problems.push(`hit@1 dropped ${fmtPct(base.hitAt1)} → ${fmtPct(curr.hitAt1)}`);
  }
  if (base.hitAtK - curr.hitAtK > percentPoints) {
    problems.push(`hit@k dropped ${fmtPct(base.hitAtK)} → ${fmtPct(curr.hitAtK)}`);
  }
  if (base.mrr - curr.mrr > mrr) {
    problems.push(`MRR dropped ${fmtNum(base.mrr)} → ${fmtNum(curr.mrr)}`);
  }
  if (base.recallAtK - curr.recallAtK > percentPoints) {
    problems.push(`recall@k dropped ${fmtPct(base.recallAtK)} → ${fmtPct(curr.recallAtK)}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Loading KB…');
  const kb = await loadGlobalKB();
  console.log(`  ${kb.length} chunks loaded`);
  if (kb.length === 0) {
    throw new Error('KB is empty. Run `npm run build-kb` first.');
  }

  console.log('Reading golden set…');
  const golden = await readGolden();
  console.log(`  ${golden.length} queries`);

  // Sanity: every must_cite path should exist in the KB.
  // In --save-baseline mode this is a hard error (we refuse to freeze a
  // baseline that includes queries which can never pass).
  const knownFiles = new Set(kb.map((c) => c.source_file));
  const unknownCites = new Set<string>();
  const unknownPerQuery: Array<{ id: string; paths: string[] }> = [];
  for (const item of golden) {
    const bad = item.must_cite.filter((f) => !knownFiles.has(f));
    if (bad.length > 0) {
      unknownPerQuery.push({ id: item.id, paths: bad });
      bad.forEach((f) => unknownCites.add(f));
    }
  }
  if (unknownCites.size > 0) {
    const msg = [
      'must_cite references files not in KB — these queries cannot pass:',
      ...unknownPerQuery.map((u) => `  [${u.id}] missing: ${u.paths.join(', ')}`),
    ].join('\n');
    if (SHOULD_SAVE_BASELINE) {
      throw new Error(`Refusing to save baseline with broken references.\n${msg}`);
    }
    console.warn('\n⚠️  ' + msg + '\n');
  }

  console.log(`Running retrieval (k=${K})…`);
  const results: QueryResult[] = [];
  const startedAt = Date.now();

  // Retrieval goes through searchKB which internally caches the embedding
  // call. We run sequentially to get a stable progress bar and avoid
  // overwhelming OpenAI rate limits.
  for (let i = 0; i < golden.length; i++) {
    const item = golden[i];
    try {
      const retrieved = await retrieveForQuery(item.query, K);
      results.push(scoreQuery(item, retrieved, K));
    } catch (error) {
      console.error(
        `\n⚠️  Query [${item.id}] failed: ${error instanceof Error ? error.message : String(error)}`
      );
      // Record as a total miss so the run completes with honest numbers.
      results.push(scoreQuery(item, [], K));
    }
    process.stdout.write(`\r  ${i + 1}/${golden.length}   `);
  }
  process.stdout.write('\n');

  const elapsedMs = Date.now() - startedAt;
  console.log(`  done in ${(elapsedMs / 1000).toFixed(1)}s`);

  const metrics = computeMetrics(results, K);
  const byCategory = groupByCategory(results, K);
  const misses = results
    .filter((r) => !r.hitInK)
    .map((r) => ({
      id: r.id,
      query: r.query,
      expected: r.expected,
      retrieved: r.retrieved,
    }));

  // Pull version metadata from the KB file for reproducibility
  const kbMeta = await readJSONIfExists<{ version?: string; model?: string }>(
    path.join(process.cwd(), 'data/global-kb/embeddings.json')
  );

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    totalQueries: golden.length,
    k: K,
    metrics,
    byCategory,
    misses,
    env: {
      kbChunks: kb.length,
      kbModel: kbMeta?.model,
      kbVersion: kbMeta?.version,
    },
  };

  await writeJSON(LAST_RUN_PATH, report);

  // Load baseline for comparison
  const baseline = SHOULD_COMPARE_BASELINE || IS_CI
    ? await readJSONIfExists<EvalReport>(BASELINE_PATH)
    : null;
  if ((SHOULD_COMPARE_BASELINE || IS_CI) && !baseline) {
    console.warn(`⚠️  Baseline mode requested but ${BASELINE_PATH} does not exist.`);
  }

  // Per-query pass/fail diff
  let byIdDiff: { newlyPassing: string[]; newlyFailing: string[] } | null = null;
  if (baseline) {
    // Baseline only has misses list; invert it to get "passing" ids
    const baselineMissIds = new Set((baseline.misses ?? []).map((m) => m.id));
    const currentMissIds = new Set(misses.map((m) => m.id));

    const newlyPassing: string[] = [];
    const newlyFailing: string[] = [];
    for (const r of results) {
      const wasMiss = baselineMissIds.has(r.id);
      const isMiss = currentMissIds.has(r.id);
      if (wasMiss && !isMiss) newlyPassing.push(r.id);
      if (!wasMiss && isMiss) newlyFailing.push(r.id);
    }
    byIdDiff = { newlyPassing, newlyFailing };
  }

  printReport(report, baseline, byIdDiff);

  if (SHOULD_SAVE_BASELINE) {
    // Save baseline WITH misses so future runs can compute per-query diff.
    // The same file is kept lean by dropping misses.retrieved if it bloats,
    // but for a 50-query set it's tiny.
    await writeJSON(BASELINE_PATH, report);
    console.log(`✅ Baseline saved to ${BASELINE_PATH}`);
  }

  // CI gate
  if (IS_CI) {
    if (!baseline) {
      console.error('❌ --ci requires an existing baseline.json. Run --save-baseline first.');
      process.exit(2);
    }
    const problems = detectRegression(metrics, baseline.metrics);
    if (problems.length > 0) {
      console.error('\n❌ Regression detected (exceeds CI threshold):');
      problems.forEach((p) => console.error(`   - ${p}`));
      process.exit(1);
    }
    console.log('\n✅ No regression detected (within CI thresholds).');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ eval-kb failed:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
