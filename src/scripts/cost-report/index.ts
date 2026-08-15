/**
 * cost-report — unit economics from the data we already collect. READ-ONLY.
 *
 * Read `README.md` beside this file before trusting a number, especially the
 * section on the 2026-06-07 → 2026-08-13 blackout: months in that window show
 * near-zero AI cost because the data is MISSING, not because it was cheap.
 */

import { supabaseAdmin } from '@/db/supabase';

/** ai_usage_log recorded nothing between these dates — see .claude/lessons/. */
const BLACKOUT_START = '2026-06-07';
const BLACKOUT_END = '2026-08-13';

/** Revenue per credit at the cheapest and dearest tiers, for comparison. */
const CREDIT_PRICE_BEST = 0.0055; // Pro $99  — 18 000 credits
const CREDIT_PRICE_WORST = 0.0345; // Small Business $1 000 — 29 000 credits

interface MonthRow {
  credits: number;
  aiCostUSD: number;
  aiCalls: number;
  deviceMs: number;
  webMs: number;
  mobileRuns: number;
}

const empty = (): MonthRow => ({
  credits: 0,
  aiCostUSD: 0,
  aiCalls: 0,
  deviceMs: 0,
  webMs: 0,
  mobileRuns: 0,
});

const month = (iso: string): string => String(iso).slice(0, 7);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Page through a table; PostgREST caps a single response at 1000 rows. */
async function fetchAll<T>(table: string, columns: string, cap = 60_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

function fmtUSD(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`;
}

export async function runCostReport(opts: { months: number; byUser: boolean }): Promise<void> {
  const [credits, usage, execs] = await Promise.all([
    fetchAll<{ amount: number; user_id: string; created_at: string }>(
      'credit_transactions',
      'amount, user_id, created_at',
    ),
    fetchAll<{ total_cost_usd: number; ai_call_count: number; user_id: string | null; created_at: string }>(
      'ai_usage_log',
      'total_cost_usd, ai_call_count, user_id, created_at',
    ),
    fetchAll<{ platform: string | null; duration_ms: number; created_at: string }>(
      'test_executions',
      'platform, duration_ms, created_at',
    ),
  ]);

  const byMonth = new Map<string, MonthRow>();
  const bump = (m: string): MonthRow => {
    if (!byMonth.has(m)) byMonth.set(m, empty());
    return byMonth.get(m)!;
  };

  for (const r of credits) {
    if (num(r.amount) >= 0) continue; // deductions only — grants are not usage
    bump(month(r.created_at)).credits += Math.abs(num(r.amount));
  }
  for (const r of usage) {
    const m = bump(month(r.created_at));
    m.aiCostUSD += num(r.total_cost_usd);
    m.aiCalls += num(r.ai_call_count);
  }
  for (const r of execs) {
    const m = bump(month(r.created_at));
    const ms = num(r.duration_ms);
    if (String(r.platform ?? '').startsWith('mobile')) {
      m.deviceMs += ms;
      m.mobileRuns += 1;
    } else if (r.platform === 'web') {
      m.webMs += ms;
    }
  }

  const months = [...byMonth.keys()].sort().reverse().slice(0, opts.months);

  console.log('\nQAIT unit economics — VARIABLE AI COST ONLY (no infra, no Stripe fees)\n');
  console.log(
    'month      credits   AI cost      $/credit   vs $0.0055   device-h   web-h   mobile runs',
  );
  console.log('-'.repeat(94));

  for (const m of months) {
    const r = byMonth.get(m)!;
    const perCredit = r.credits > 0 ? r.aiCostUSD / r.credits : 0;
    const blackout = m >= month(BLACKOUT_START) && m <= month(BLACKOUT_END);
    const verdict = perCredit === 0 ? '—' : perCredit < CREDIT_PRICE_BEST ? 'ok' : 'UNDERWATER';

    console.log(
      `${m}  ${String(Math.round(r.credits)).padStart(8)}  ${fmtUSD(r.aiCostUSD).padStart(10)}  ` +
        `${perCredit ? `$${perCredit.toFixed(6)}` : '—'.padStart(9)}  ${verdict.padStart(11)}  ` +
        `${(r.deviceMs / 3_600_000).toFixed(2).padStart(8)}  ${(r.webMs / 3_600_000).toFixed(1).padStart(6)}  ` +
        `${String(r.mobileRuns).padStart(11)}` +
        (blackout ? '   ⚠ AI COST MISSING' : ''),
    );
  }

  console.log(
    `\n⚠  Months marked AI COST MISSING fall in the ${BLACKOUT_START}..${BLACKOUT_END} blackout:\n` +
      '   ai_usage_log recorded nothing (unapplied run_id migration). Near-zero AI cost there\n' +
      '   means the data is absent, NOT that the month was cheap.\n',
  );

  console.log('Reference: 1 credit earns $0.0055 on Pro $99, $0.0345 on Small Business.');
  console.log(
    `A $/credit above ${CREDIT_PRICE_BEST} loses money on the cheapest tier; above ` +
      `${CREDIT_PRICE_WORST} loses money on every tier.\n`,
  );

  const totalDeviceH = months.reduce((a, m) => a + byMonth.get(m)!.deviceMs, 0) / 3_600_000;
  const capacityH = 730 * months.length;
  console.log(
    `Mobile utilisation over ${months.length} month(s): ${totalDeviceH.toFixed(2)} device-hours ` +
      `consumed against ~${capacityH} paid hours for ONE always-on host = ` +
      `${((totalDeviceH / capacityH) * 100).toFixed(2)}%.`,
  );
  console.log(
    'That ratio, not the per-step multiplier, is what decides whether mobile works.\n' +
      'FIXED COST IS NOT IN ANY NUMBER ABOVE — divide the monthly cloud bill by the credits\n' +
      'column to get the real cost per credit. See README.md.\n',
  );

  if (!opts.byUser) return;

  const perUser = new Map<string, { credits: number; ai: number }>();
  for (const r of credits) {
    if (num(r.amount) >= 0 || !r.user_id) continue;
    const e = perUser.get(r.user_id) ?? { credits: 0, ai: 0 };
    e.credits += Math.abs(num(r.amount));
    perUser.set(r.user_id, e);
  }
  for (const r of usage) {
    if (!r.user_id) continue;
    const e = perUser.get(r.user_id) ?? { credits: 0, ai: 0 };
    e.ai += num(r.total_cost_usd);
    perUser.set(r.user_id, e);
  }

  console.log('\nPer user (all time) — who is underwater\n');
  console.log('user_id                                credits    AI cost    $/credit');
  console.log('-'.repeat(76));
  const ranked = [...perUser.entries()]
    .filter(([, v]) => v.credits > 0)
    .sort((a, b) => b[1].ai / Math.max(b[1].credits, 1) - a[1].ai / Math.max(a[1].credits, 1))
    .slice(0, 25);
  for (const [id, v] of ranked) {
    const pc = v.ai / v.credits;
    console.log(
      `${id.padEnd(38)} ${String(Math.round(v.credits)).padStart(7)}  ${fmtUSD(v.ai).padStart(9)}  ` +
        `$${pc.toFixed(6)}${pc > CREDIT_PRICE_BEST ? '  ← above the Pro $99 rate' : ''}`,
    );
  }
  console.log();
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const monthsArg = argv.indexOf('--months');
  runCostReport({
    months: monthsArg >= 0 ? Math.max(1, parseInt(argv[monthsArg + 1] ?? '3', 10)) : 3,
    byUser: argv.includes('--by-user'),
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[cost-report]', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
