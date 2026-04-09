# Admin Dashboard: Cost per Client/Team — Implementation Plan

> **Status:** Plan only — no code committed yet. Implement at your own pace.
> **Owner:** Backend team.
> **Last updated:** 2026-04-09.

---

## TL;DR

Add one admin endpoint `GET /api/v1/admin/ai-usage/workspaces` that returns
aggregated AI spend per workspace (= client/team). All the underlying data
is **already being collected** in `ai_usage_log`. We just need a cross-workspace
query path, an admin role check, and an endpoint.

**Effort:** ~2–3 hours for the minimum viable endpoint. +1h for daily trend.
+2h for spike alerts.

---

## Context You Need Before Starting

### Terminology in this codebase
- **Workspace** = the thing you call "project" (= client/team). Table: `workspaces`.
- **Project** (inside a workspace) = a folder of tests. Table: `projects`. **This is NOT what you want.** If someone on the team says "project", confirm which one they mean.
- **Test** = one test run. Table: `tests`. Linked via `project_id` (the inner project, not the workspace).
- **`intelligent_test_sessions.cost_usd`** — **fake** (`iterations * 0.001`). Do not trust it.
- **`ai_usage_log.total_cost_usd`** — **the only source of truth** for real LLM spend.

### What already works (no code changes needed)
| Component | Where | Status |
|---|---|---|
| `ai_usage_log` table | `supabase-migrations/features/ai-usage-log.sql` | ✅ exists, indexed on `workspace_id` + `created_at` |
| Auto-record tokens/cost on every LLM call | `src/services/ai/core/openai.service.ts:263-271` + `AIUsageTracker.record()` | ✅ works |
| Query service | `src/services/ai/tracking/ai-usage-query.service.ts` | ✅ has per-workspace methods |
| Per-workspace endpoints | `src/api/workspace/workspace.routes.ts:484-659` | ✅ 4 endpoints |

**Smoke test before you start any work:** open Supabase SQL editor and run

```sql
SELECT COUNT(*), SUM(total_cost_usd), MAX(created_at)
FROM ai_usage_log
WHERE created_at >= NOW() - INTERVAL '7 days';
```

If `count > 0` and `MAX(created_at)` is recent — tracking is alive, data is accumulating, proceed. If empty — something upstream is broken; fix that first.

### What's missing (this plan fills it)
- ❌ No endpoint to list **all workspaces at once**. Existing ones require `:id` and check that the user is a member.
- ❌ No admin role check — all current endpoints are workspace-scoped.
- ❌ No frontend admin page consuming it (verify with frontend team).
- ❌ **Verify non-OpenAI providers also log through the tracker**. OpenAI does. Anthropic, Gemini — check `AIUsageTracker.record` call sites before trusting totals.

---

## Stage 1 — Cross-workspace admin endpoint (**required**, ~2h)

**Goal:** one endpoint `/api/v1/admin/ai-usage/workspaces` that returns a list of every workspace with its cost over a period. This is the primary data source for the admin dashboard table.

### 1.1. SQL migration — 1 function

**New file:** `supabase-migrations/features/admin-workspace-usage.sql`

Using a Postgres function keeps the aggregation logic in the DB (faster, safer, no complex JS query builder).

```sql
-- Aggregate AI usage per workspace within a date range.
-- Returns one row per workspace (including workspaces with zero spend).
CREATE OR REPLACE FUNCTION admin_workspace_usage_summary(
  start_date TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days',
  end_date TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  workspace_id UUID,
  workspace_name TEXT,
  workspace_created_at TIMESTAMPTZ,
  total_input_tokens BIGINT,
  total_output_tokens BIGINT,
  total_tokens BIGINT,
  total_cost_usd NUMERIC,
  ai_call_count BIGINT,
  test_count BIGINT,
  operation_breakdown JSONB,
  last_activity_at TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  WITH workspace_totals AS (
    SELECT
      w.id AS workspace_id,
      w.name AS workspace_name,
      w.created_at AS workspace_created_at,
      COALESCE(SUM(aul.total_input_tokens), 0)::BIGINT AS total_input_tokens,
      COALESCE(SUM(aul.total_output_tokens), 0)::BIGINT AS total_output_tokens,
      COALESCE(SUM(aul.total_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(aul.total_cost_usd), 0)::NUMERIC AS total_cost_usd,
      COALESCE(SUM(aul.ai_call_count), 0)::BIGINT AS ai_call_count,
      COUNT(DISTINCT aul.test_id) FILTER (WHERE aul.test_id IS NOT NULL)::BIGINT AS test_count,
      MAX(aul.created_at) AS last_activity_at
    FROM workspaces w
    LEFT JOIN ai_usage_log aul
      ON aul.workspace_id = w.id
      AND aul.created_at >= start_date
      AND aul.created_at <= end_date
    GROUP BY w.id, w.name, w.created_at
  ),
  workspace_breakdowns AS (
    SELECT
      aul.workspace_id,
      jsonb_object_agg(
        aul.operation_type,
        jsonb_build_object(
          'calls', COUNT(*),
          'cost_usd', SUM(aul.total_cost_usd),
          'tokens', SUM(aul.total_tokens)
        )
      ) AS operation_breakdown
    FROM ai_usage_log aul
    WHERE aul.created_at >= start_date
      AND aul.created_at <= end_date
      AND aul.operation_type IS NOT NULL
    GROUP BY aul.workspace_id
  )
  SELECT
    wt.workspace_id,
    wt.workspace_name,
    wt.workspace_created_at,
    wt.total_input_tokens,
    wt.total_output_tokens,
    wt.total_tokens,
    wt.total_cost_usd,
    wt.ai_call_count,
    wt.test_count,
    COALESCE(wb.operation_breakdown, '{}'::jsonb) AS operation_breakdown,
    wt.last_activity_at
  FROM workspace_totals wt
  LEFT JOIN workspace_breakdowns wb ON wb.workspace_id = wt.workspace_id
  ORDER BY wt.total_cost_usd DESC NULLS LAST;
$$;

-- Grant to service_role only. Admin endpoint enforces auth separately.
GRANT EXECUTE ON FUNCTION admin_workspace_usage_summary TO service_role;
```

**Why two CTEs instead of LATERAL JOIN:** a LATERAL JOIN mixes aggregations and can double-count totals. Two separate CTEs (one for totals, one for breakdown) is simpler and guaranteed correct.

**Manual test in Supabase SQL editor after applying:**
```sql
-- Default (last 30 days)
SELECT * FROM admin_workspace_usage_summary() LIMIT 5;

-- Custom range
SELECT * FROM admin_workspace_usage_summary(
  '2026-04-01'::timestamptz,
  '2026-04-09'::timestamptz
);

-- Sanity: total_cost_usd from the function must match a direct query
SELECT
  (SELECT total_cost_usd
   FROM admin_workspace_usage_summary()
   WHERE workspace_id = 'YOUR-WORKSPACE-UUID') AS from_function,
  (SELECT SUM(total_cost_usd)
   FROM ai_usage_log
   WHERE workspace_id = 'YOUR-WORKSPACE-UUID'
     AND created_at >= NOW() - INTERVAL '30 days') AS from_direct_query;
-- Both columns should be equal.
```

### 1.2. Service method

**Edit:** `src/services/ai/tracking/ai-usage-query.service.ts`

Add the new interface at the top of the file (near other exports):

```ts
export interface WorkspaceUsageSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceCreatedAt: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  aiCallCount: number;
  testCount: number;
  operationBreakdown: Record<
    string,
    { calls: number; cost_usd: number; tokens: number }
  >;
  lastActivityAt: string | null;
}
```

Add the method to the existing class:

```ts
/**
 * Admin-only: aggregate AI usage across ALL workspaces.
 * Used by the admin dashboard to show cost per client/team.
 *
 * Caller MUST enforce admin role — this method returns cross-workspace data
 * and intentionally bypasses per-workspace auth checks.
 *
 * @param options.startDate   default: 30 days ago
 * @param options.endDate     default: now
 * @param options.limit       cap returned workspaces (default: 100, max: 500)
 * @param options.minCostUsd  hide workspaces below this spend (default: 0)
 */
async getAllWorkspacesUsageSummary(
  options: {
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    minCostUsd?: number;
  } = {},
): Promise<WorkspaceUsageSummary[]> {
  const startDate =
    options.startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = options.endDate ?? new Date();
  const limit = Math.min(options.limit ?? 100, 500);
  const minCostUsd = options.minCostUsd ?? 0;

  const { data, error } = await supabaseAdmin.rpc(
    'admin_workspace_usage_summary',
    {
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
    },
  );

  if (error) {
    logger.error('[AIUsageQueryService] admin summary RPC failed', { error });
    throw new Error(`Failed to load admin workspace usage: ${error.message}`);
  }

  return (data || [])
    .filter((row: any) => Number(row.total_cost_usd) >= minCostUsd)
    .slice(0, limit)
    .map((row: any) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name ?? '(unnamed)',
      workspaceCreatedAt: row.workspace_created_at,
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalTokens: Number(row.total_tokens),
      // Postgres NUMERIC comes back as string from PostgREST — Number() handles it
      totalCostUsd: Number(row.total_cost_usd),
      aiCallCount: Number(row.ai_call_count),
      testCount: Number(row.test_count),
      operationBreakdown: row.operation_breakdown ?? {},
      lastActivityAt: row.last_activity_at,
    }));
}
```

### 1.3. Admin middleware

**Verify first:** does `requireAdmin` already exist?

```bash
grep -rn "requireAdmin\|isAdmin\|role.*admin" src/middleware/ src/api/admin/ 2>&1 | head -10
grep -n "role" supabase-migrations/supabase-schema.sql | grep -i user
```

**Three scenarios:**

#### Scenario A — `users.role` column already exists
Easiest. Use it in a thin middleware:

**New file:** `src/middleware/require-admin.ts`
```ts
import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '@/config/database/supabase';
import { logger } from '@/utils/core/logger';

/**
 * Admin-only middleware. Must run AFTER requireAuth (which sets req.userId).
 * Blocks anyone whose users.role != 'admin'.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = (req as any).userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .single();

    if (error || !data) {
      logger.warn('[requireAdmin] user lookup failed', { userId, error });
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    if (data.role !== 'admin') {
      logger.warn('[requireAdmin] non-admin access attempt', {
        userId,
        role: data.role,
      });
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    next();
  } catch (err) {
    logger.error('[requireAdmin] unexpected error', { userId, error: err });
    res.status(500).json({ error: 'Internal error' });
  }
}
```

#### Scenario B — no role column, no middleware
Use env-based allowlist. No DB migration, kill-switch via env, restart worker = apply changes.

**New file:** `src/middleware/require-admin.ts`
```ts
import type { Request, Response, NextFunction } from 'express';

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = (req as any).userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (ADMIN_USER_IDS.length === 0) {
    res.status(500).json({
      error: 'Admin feature not configured. Set ADMIN_USER_IDS in env.',
    });
    return;
  }
  if (!ADMIN_USER_IDS.includes(userId)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
```

And add to `.env.example`:
```
# Comma-separated UUIDs of users with admin access (for /api/v1/admin/*)
ADMIN_USER_IDS=
```

#### Scenario C — Supabase Auth JWT claims
If you use `user_metadata.role` in Supabase Auth, fetch via `supabase.auth.admin.getUserById(userId)` instead of the DB `users` table. Otherwise identical to Scenario A.

**Recommendation:** Scenario B if unsure. Fewest moving parts, explicit list in env, trivial to revoke.

### 1.4. Controller

**New file:** `src/api/admin/admin-usage.controller.ts`

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { aiUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
import { logger } from '@/utils/core/logger';

// Reject malformed query params early with a clear error.
const querySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  minCostUsd: z.coerce.number().min(0).optional(),
});

/**
 * GET /api/v1/admin/ai-usage/workspaces
 *
 * Admin-only cross-workspace AI usage summary.
 *
 * Query params:
 *   startDate    ISO timestamp (default: 30 days ago)
 *   endDate      ISO timestamp (default: now)
 *   limit        max workspaces to return (default: 100, max: 500)
 *   minCostUsd   hide workspaces below this spend (default: 0)
 */
export async function getAllWorkspacesUsage(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid query parameters',
      details: parsed.error.issues,
    });
    return;
  }

  try {
    const summaries = await aiUsageQueryService.getAllWorkspacesUsageSummary({
      startDate: parsed.data.startDate
        ? new Date(parsed.data.startDate)
        : undefined,
      endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      limit: parsed.data.limit,
      minCostUsd: parsed.data.minCostUsd,
    });

    // Pre-compute dashboard header totals so the frontend doesn't duplicate the work.
    const totals = summaries.reduce(
      (acc, w) => ({
        totalCostUsd: acc.totalCostUsd + w.totalCostUsd,
        totalTokens: acc.totalTokens + w.totalTokens,
        totalCalls: acc.totalCalls + w.aiCallCount,
        totalTests: acc.totalTests + w.testCount,
        activeWorkspaces:
          acc.activeWorkspaces + (w.totalCostUsd > 0 ? 1 : 0),
      }),
      {
        totalCostUsd: 0,
        totalTokens: 0,
        totalCalls: 0,
        totalTests: 0,
        activeWorkspaces: 0,
      },
    );

    res.json({
      period: {
        startDate:
          parsed.data.startDate ??
          new Date(Date.now() - 30 * 86400000).toISOString(),
        endDate: parsed.data.endDate ?? new Date().toISOString(),
      },
      totals,
      workspaces: summaries,
    });
  } catch (err) {
    logger.error('[admin-usage] Failed to fetch workspaces usage', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
}
```

### 1.5. Route registration

**New file:** `src/api/admin/admin.routes.ts`

```ts
import { Router } from 'express';
import { requireAuth } from '@/middleware/require-auth'; // or your equivalent
import { requireAdmin } from '@/middleware/require-admin';
import { getAllWorkspacesUsage } from './admin-usage.controller';

const router = Router();

/**
 * @openapi
 * /api/v1/admin/ai-usage/workspaces:
 *   get:
 *     summary: Aggregate AI usage across all workspaces (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500 }
 *       - in: query
 *         name: minCostUsd
 *         schema: { type: number, minimum: 0 }
 *     responses:
 *       200: { description: Per-workspace usage summary }
 *       401: { description: Unauthorized }
 *       403: { description: Admin access required }
 */
router.get(
  '/ai-usage/workspaces',
  requireAuth,
  requireAdmin,
  getAllWorkspacesUsage,
);

export default router;
```

**Register in main app** — find where existing routes are mounted:

```bash
grep -n "router.use\|app.use.*api" src/app.ts src/index.ts 2>&1 | head -10
```

Add:
```ts
import adminRoutes from '@/api/admin/admin.routes';
// ...
app.use('/api/v1/admin', adminRoutes);
```

### 1.6. Verification steps

```bash
# 1. Apply migration
psql "$DATABASE_URL" -f supabase-migrations/features/admin-workspace-usage.sql

# 2. Type-check
npm run type-check

# 3. Start dev server
npm run dev

# 4. Call endpoint
curl -s -H "Authorization: Bearer <admin-jwt>" \
  http://localhost:3000/api/v1/admin/ai-usage/workspaces | jq
```

**Expected response:**
```json
{
  "period": {
    "startDate": "2026-03-10T12:00:00.000Z",
    "endDate": "2026-04-09T12:00:00.000Z"
  },
  "totals": {
    "totalCostUsd": 12.34,
    "totalTokens": 1540000,
    "totalCalls": 820,
    "totalTests": 45,
    "activeWorkspaces": 7
  },
  "workspaces": [
    {
      "workspaceId": "abc-123",
      "workspaceName": "Acme Corp",
      "workspaceCreatedAt": "2025-10-01T00:00:00.000Z",
      "totalInputTokens": 750000,
      "totalOutputTokens": 50000,
      "totalTokens": 800000,
      "totalCostUsd": 5.67,
      "aiCallCount": 420,
      "testCount": 28,
      "operationBreakdown": {
        "lite-test": { "calls": 18, "cost_usd": 3.2, "tokens": 500000 },
        "pro-test": { "calls": 5, "cost_usd": 2.1, "tokens": 250000 },
        "chat": { "calls": 395, "cost_usd": 0.37, "tokens": 50000 }
      },
      "lastActivityAt": "2026-04-09T10:12:34.000Z"
    }
  ]
}
```

### 1.7. Unit test (controller only; service is covered by smoke test)

**New file:** `src/api/admin/__tests__/admin-usage.controller.test.ts`

```ts
import type { Request, Response } from 'express';
import { getAllWorkspacesUsage } from '../admin-usage.controller';
import { aiUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';

jest.mock('@/services/ai/tracking/ai-usage-query.service', () => ({
  aiUsageQueryService: {
    getAllWorkspacesUsageSummary: jest.fn(),
  },
}));

function mockRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

describe('getAllWorkspacesUsage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 for invalid startDate', async () => {
    const req = { query: { startDate: 'not-a-date' } } as unknown as Request;
    const res = mockRes();
    await getAllWorkspacesUsage(req, res);
    expect((res as any).status).toHaveBeenCalledWith(400);
  });

  it('returns summaries + totals', async () => {
    (
      aiUsageQueryService.getAllWorkspacesUsageSummary as jest.Mock
    ).mockResolvedValue([
      {
        workspaceId: 'w1',
        workspaceName: 'A',
        workspaceCreatedAt: '2025-01-01',
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        totalCostUsd: 1.5,
        aiCallCount: 10,
        testCount: 3,
        operationBreakdown: {},
        lastActivityAt: '2026-04-09T00:00:00Z',
      },
      {
        workspaceId: 'w2',
        workspaceName: 'B',
        workspaceCreatedAt: '2025-01-01',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        aiCallCount: 0,
        testCount: 0,
        operationBreakdown: {},
        lastActivityAt: null,
      },
    ]);

    const req = { query: {} } as unknown as Request;
    const res = mockRes();
    await getAllWorkspacesUsage(req, res);

    const payload = (res as any).json.mock.calls[0][0];
    expect(payload.totals).toEqual({
      totalCostUsd: 1.5,
      totalTokens: 150,
      totalCalls: 10,
      totalTests: 3,
      activeWorkspaces: 1, // only w1 has > 0 cost
    });
    expect(payload.workspaces).toHaveLength(2);
  });

  it('returns 500 on service error', async () => {
    (
      aiUsageQueryService.getAllWorkspacesUsageSummary as jest.Mock
    ).mockRejectedValue(new Error('db down'));
    const req = { query: {} } as unknown as Request;
    const res = mockRes();
    await getAllWorkspacesUsage(req, res);
    expect((res as any).status).toHaveBeenCalledWith(500);
  });
});
```

---

## Stage 2 — Daily trend per workspace (**optional**, ~1h)

**Goal:** chart "how much did this client spend each day over the last 30 days". Useful for detecting growth / runaway tests.

### 2.1. SQL function

Append to `admin-workspace-usage.sql`:

```sql
CREATE OR REPLACE FUNCTION admin_workspace_daily_usage(
  target_workspace_id UUID,
  days_back INTEGER DEFAULT 30
)
RETURNS TABLE (
  day DATE,
  total_tokens BIGINT,
  total_cost_usd NUMERIC,
  ai_call_count BIGINT,
  test_count BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT
    DATE(created_at) AS day,
    SUM(total_tokens)::BIGINT,
    SUM(total_cost_usd)::NUMERIC,
    SUM(ai_call_count)::BIGINT,
    COUNT(DISTINCT test_id) FILTER (WHERE test_id IS NOT NULL)::BIGINT
  FROM ai_usage_log
  WHERE workspace_id = target_workspace_id
    AND created_at >= NOW() - (days_back || ' days')::INTERVAL
  GROUP BY DATE(created_at)
  ORDER BY day ASC;
$$;

GRANT EXECUTE ON FUNCTION admin_workspace_daily_usage TO service_role;
```

### 2.2. Service method

```ts
async getWorkspaceDailyUsage(
  workspaceId: string,
  daysBack: number = 30,
): Promise<
  Array<{
    day: string;
    totalTokens: number;
    totalCostUsd: number;
    aiCallCount: number;
    testCount: number;
  }>
> {
  const { data, error } = await supabaseAdmin.rpc(
    'admin_workspace_daily_usage',
    { target_workspace_id: workspaceId, days_back: daysBack },
  );
  if (error) {
    throw new Error(`Failed to load daily usage: ${error.message}`);
  }
  return (data || []).map((row: any) => ({
    day: row.day,
    totalTokens: Number(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    aiCallCount: Number(row.ai_call_count),
    testCount: Number(row.test_count),
  }));
}
```

### 2.3. Endpoint

```ts
// src/api/admin/admin.routes.ts
import { getWorkspaceDailyUsage } from './admin-usage.controller';

router.get(
  '/ai-usage/workspaces/:workspaceId/daily',
  requireAuth,
  requireAdmin,
  getWorkspaceDailyUsage,
);
```

Controller pulls `workspaceId` from `req.params`, `daysBack` from `req.query` (validate 1–365). Returns `[{ day, totalCostUsd, ... }]` ready for a chart library.

---

## Stage 3 — Cost spike alerts (**optional**, ~2h)

**Goal:** Telegram alert when a workspace suddenly spends more than usual. Protects against runaway tests / bugs that generate 10x LLM calls.

### 3.1. Cron job

**New file:** `src/jobs/admin-cost-alert.job.ts`

```ts
import { aiUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
import { sendTelegramMessage } from '@/services/integrations/telegram.service';
import { logger } from '@/utils/core/logger';

// Tune these after one week of observation.
const COST_SPIKE_THRESHOLD_USD = 10.0;   // alert if > $10 in last hour
const SPIKE_RATIO = 5;                    // AND > 5x 24h baseline
const COMPARISON_WINDOW_HOURS = 1;
const BASELINE_WINDOW_HOURS = 24;

/**
 * Runs hourly. Detects workspaces whose spend in the last hour is
 * significantly above their 24h baseline.
 */
export async function checkCostSpikes(): Promise<void> {
  const now = new Date();
  const hourAgo = new Date(
    now.getTime() - COMPARISON_WINDOW_HOURS * 3600 * 1000,
  );
  const dayAgo = new Date(
    now.getTime() - BASELINE_WINDOW_HOURS * 3600 * 1000,
  );

  try {
    const recent = await aiUsageQueryService.getAllWorkspacesUsageSummary({
      startDate: hourAgo,
      endDate: now,
      minCostUsd: COST_SPIKE_THRESHOLD_USD,
    });
    if (recent.length === 0) return;

    const baseline = await aiUsageQueryService.getAllWorkspacesUsageSummary({
      startDate: dayAgo,
      endDate: hourAgo,
    });
    const baselineMap = new Map(
      baseline.map((w) => [
        w.workspaceId,
        w.totalCostUsd / BASELINE_WINDOW_HOURS,
      ]),
    );

    const alerts: string[] = [];
    for (const w of recent) {
      const avgHourlyBaseline = baselineMap.get(w.workspaceId) ?? 0;
      const ratio =
        avgHourlyBaseline > 0 ? w.totalCostUsd / avgHourlyBaseline : Infinity;

      if (w.totalCostUsd >= COST_SPIKE_THRESHOLD_USD && ratio >= SPIKE_RATIO) {
        alerts.push(
          `⚠️ Cost spike: ${w.workspaceName} spent $${w.totalCostUsd.toFixed(2)} ` +
            `in the last hour (${ratio.toFixed(1)}× baseline). ` +
            `${w.aiCallCount} LLM calls, ${w.testCount} tests.`,
        );
      }
    }

    if (alerts.length > 0) {
      await sendTelegramMessage(alerts.join('\n'));
      logger.warn('[cost-alert] Spikes detected', { count: alerts.length });
    }
  } catch (err) {
    logger.error('[cost-alert] Check failed', { error: err });
  }
}
```

### 3.2. Register in scheduler

Find the scheduler:
```bash
grep -rn "cron\|schedule" src/scheduler/ 2>&1 | head -10
```

Register:
```ts
import { checkCostSpikes } from '@/jobs/admin-cost-alert.job';

// every hour at minute 5 to avoid :00 thundering herd
cron.schedule('5 * * * *', checkCostSpikes);
```

---

## Frontend work (out of scope for backend, but worth listing)

Once Stage 1 is live, the frontend needs:

1. **Admin page route** (e.g. `/admin/usage`)
2. **Guard** — redirect non-admins away
3. **Data fetch** — `GET /api/v1/admin/ai-usage/workspaces?startDate=...&endDate=...`
4. **Header** — show `totals` (big numbers): total $, total tokens, active workspaces
5. **Table** — one row per workspace: name, $, tokens, calls, tests, last activity, operation breakdown (expandable)
6. **Period picker** — 7d / 30d / custom range
7. **Sort** — by cost desc (default), by tokens, by last activity
8. **Search** — filter by workspace name

If the team already has admin infra (e.g. a `/admin` section or a Retool dashboard), this is a single-page addition. If not, scope it separately.

---

## Checklist

### Stage 1 — required
- [ ] **1.1** Verify data: `SELECT COUNT(*), SUM(total_cost_usd) FROM ai_usage_log WHERE created_at >= NOW() - INTERVAL '7 days'`
- [ ] **1.2** Write `supabase-migrations/features/admin-workspace-usage.sql`
- [ ] **1.3** Apply migration
- [ ] **1.4** Manual SQL test: `SELECT * FROM admin_workspace_usage_summary() LIMIT 5`
- [ ] **1.5** Sanity check: function total matches direct query for one workspace
- [ ] **1.6** Add `WorkspaceUsageSummary` type to service file
- [ ] **1.7** Add `getAllWorkspacesUsageSummary()` method
- [ ] **1.8** Check if `users.role` exists OR pick env-based allowlist (Scenario B)
- [ ] **1.9** Write `src/middleware/require-admin.ts`
- [ ] **1.10** Write `src/api/admin/admin-usage.controller.ts`
- [ ] **1.11** Write `src/api/admin/admin.routes.ts`
- [ ] **1.12** Register routes in main app (`app.use('/api/v1/admin', adminRoutes)`)
- [ ] **1.13** `npm run type-check` clean
- [ ] **1.14** Write controller unit tests
- [ ] **1.15** `npm test -- admin-usage` passes
- [ ] **1.16** Smoke test with curl
- [ ] **1.17** Frontend: build admin page consuming the endpoint

### Stage 2 — optional
- [ ] **2.1** Add daily SQL function
- [ ] **2.2** Add `getWorkspaceDailyUsage` service method
- [ ] **2.3** Add daily endpoint
- [ ] **2.4** Frontend: line chart per workspace

### Stage 3 — optional
- [ ] **3.1** Write `checkCostSpikes` job
- [ ] **3.2** Register in scheduler (hourly)
- [ ] **3.3** Local test Telegram integration
- [ ] **3.4** Deploy and tune thresholds after one week of observation

---

## Time estimates

| Stage | Time | Value |
|---|---|---|
| Stage 1 (main endpoint + admin middleware) | **2–3h** | ★★★★★ — the whole point |
| Stage 2 (daily trend) | +1h | ★★★ — nice for charts |
| Stage 3 (alerts) | +2h | ★★★★ — runaway protection |

**Minimum to ship = Stage 1.** You get a full billing admin view without Stages 2 or 3.

---

## Critical warnings

### ⚠️ 1. Verify `users.role` BEFORE starting
If there's no role column and no existing admin middleware — Stage 1 won't work. Check:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'users';
```
Fallback: env-based `ADMIN_USER_IDS` (Scenario B above).

### ⚠️ 2. `SECURITY DEFINER` on SQL functions
The functions use `SECURITY DEFINER` intentionally — they bypass RLS and read all workspaces. Security invariants:
- **`GRANT EXECUTE` only to `service_role`**. Never to `authenticated` or `anon`.
- **The endpoint MUST enforce `requireAdmin`** — otherwise any authenticated user can call the endpoint and get cross-workspace data.
- **Never `GRANT EXECUTE TO authenticated`** under any circumstance.

### ⚠️ 3. Data is NOT real-time
`AIUsageTracker` writes to `ai_usage_log` **after** a test session finishes (not per LLM call). So:
- Tests currently running don't appear in aggregates.
- Tests finished 1–2 minutes ago are already there.

This is fine for billing (hourly/daily/monthly), **not** for "what's happening right now".

### ⚠️ 4. Fire-and-forget writes can drop data
`ai-usage-tracker.ts:156-161` does `.catch((err) => {...})` — on error the DB write is **silently dropped**, the test still completes. That's by design (don't fail tests on tracker bugs), but it means:
- Pod restart during `flushToDatabase` → lost data
- Supabase down 5 minutes → all tests finished in that window lose tracking

For real billing you'd want a Redis retry queue + BullMQ flush job. Out of scope for Stage 1, but **know this limit** before quoting customers.

### ⚠️ 5. Verify non-OpenAI providers log through the tracker
```bash
grep -rn "AIUsageTracker.record\|AIUsageTracker\.record" src/services/ai/ 2>&1
```
If only OpenAI service calls `AIUsageTracker.record`, then Anthropic/Gemini calls **are not tracked** and your totals are incomplete. Fix before trusting numbers for billing.

### ⚠️ 6. Postgres NUMERIC comes back as string
`NUMERIC(10, 6)` returns as a JS string from PostgREST. Always wrap in `Number()` before math. The service method already does this — don't strip it.

### ⚠️ 7. Testing the CTE version vs LATERAL
I chose two CTEs instead of a `LATERAL JOIN` in the SQL function. Reason: the LATERAL version can double-count totals if you forget how PostgreSQL propagates aggregations through the join. Two CTEs (totals + breakdown) joined at the end is obviously correct and explicit. If performance ever becomes an issue (100+ workspaces, 10M rows), revisit.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `function admin_workspace_usage_summary does not exist` | Migration not applied | `psql -f admin-workspace-usage.sql` |
| `403 Forbidden` on endpoint | `requireAdmin` doesn't match your user | Check `users.role` or `ADMIN_USER_IDS` env |
| `operation_breakdown` is `{}` | No data in period | Try a longer range (`startDate=...`) |
| `Number(row.total_cost_usd)` is `NaN` | Row is null / missing | Check LEFT JOIN logic — should return 0, not null |
| Endpoint is slow (>2s) | Missing indexes | Verify `idx_ai_usage_log_workspace_date` exists |
| Totals don't match Supabase billing page | Non-OpenAI providers not tracked | See warning #5 |

---

## What to do after Stage 1 is live

1. **Sanity-check against Supabase billing** for the same period — numbers should roughly align (±10% provider overhead).
2. **Find the top 3 workspaces** — Pareto (one taking 80%) is normal; one taking 95% means investigate.
3. **Compare operation types** — if `chat` costs more than `lite-test`, the chat routing may be inefficient.
4. **Enable hybrid executor** on 1–2 workspaces → watch their cost for a week vs baseline. This is the feedback loop for optimizing lite mode.

This admin view + hybrid executor together give you a real feedback loop for cost optimization.

---

## Files touched (Stage 1)

| File | New? | LOC estimate |
|---|---|---|
| `supabase-migrations/features/admin-workspace-usage.sql` | new | ~80 |
| `src/services/ai/tracking/ai-usage-query.service.ts` | edit | +~60 |
| `src/middleware/require-admin.ts` | new | ~40 |
| `src/api/admin/admin-usage.controller.ts` | new | ~80 |
| `src/api/admin/admin.routes.ts` | new | ~40 |
| `src/app.ts` (or `index.ts`) | edit | +~3 |
| `src/api/admin/__tests__/admin-usage.controller.test.ts` | new | ~80 |
| `.env.example` (if Scenario B) | edit | +~3 |

**Total:** ~385 LOC new + ~66 LOC edits. No runtime changes to `LiteEngine` or `openai.service.ts`.

---

**End of plan.** Implement at your pace, verify each checklist item, don't skip the manual SQL sanity check in step 1.5 — it's the cheapest way to catch aggregation bugs.
