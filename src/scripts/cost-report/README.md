# cost-report — unit economics from the data we already collect

```bash
npm run cost-report              # last 3 full months
npm run cost-report -- --months 6
npm run cost-report -- --by-user
```

Read-only. Runs `SELECT`s against the live database (there is only one Supabase
project, so that is prod) and writes nothing.

## What it answers

The question the whole cost-attribution effort exists for: **do we make money
on a credit?** It joins the three tables that each hold one piece:

| Source | Contributes |
|---|---|
| `credit_transactions` | credits billed (revenue side) |
| `ai_usage_log` | real cache-discounted LLM cost, per session |
| `test_executions` | device/browser time held, by platform |

and prints, per month:

- **variable AI cost per credit** — must sit below the credit price
  ($0.0055/credit on Pro $99 → $0.0345 on Small Business) or we lose money on
  every unit sold, at any volume;
- **device-hours consumed** vs the capacity paid for, i.e. utilisation;
- the same split per user with `--by-user`, which is what identifies an account
  that is underwater.

## What it deliberately does NOT do

**It does not include fixed capacity** — VMs, AWS Macs, Container Apps, Front
Door, storage, egress, Log Analytics, Stripe fees. Those are not in any table we
own, and at current volume they dominate: mobile ran at **~0.3% utilisation** in
July 2026 (2.06 device-hours against 730 paid). A "cost per credit" that ignores
them is the *floor*, not the answer.

Divide the monthly cloud bill by the credits figure this prints to get the real
number. Until Cost Management Reader is granted on Azure and the GCP project
hosting the cells is identified, that bill is not machine-readable — see Gap B
in `.claude/plans/20260813-cost-attribution-instrumentation.md`.

## Caveats it prints for you

- `ai_usage_log` recorded **nothing between 2026-06-07 and the `run_id` migration
  on 2026-08-13** (an unapplied migration; see `.claude/lessons/`). Any month in
  that window shows near-zero AI cost because the data is missing, **not**
  because it was cheap. The script flags such months rather than letting you
  read them as real.
- Mobile-runner LLM cost is only derived server-side from
  `758bb9b8` onward; earlier mobile rows carry `cost_usd = null`.
- `credit_transactions.cost_usd` is **not** used — 97% of its rows are a
  hardcoded `0`. Cost comes from `ai_usage_log`.
