# Test Analytics API

Base URL: `GET /api/v1/analytics`

All endpoints require `Authorization: Bearer <token>` header.
All endpoints require `workspaceId` query parameter.

---

## 1. Summary

`GET /api/v1/analytics/summary`

Returns top cards, status banner, and performance metrics.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspaceId | uuid | yes | Workspace ID |
| projectId | uuid | no | Filter by project |
| startDate | ISO 8601 | no | Start of date range |
| endDate | ISO 8601 | no | End of date range |

**Response:**

```json
{
  "success": true,
  "data": {
    "summary": {
      "testStepsRun": 12847,
      "totalRuns": 2436,
      "tokensSpent": 6090000,
      "errorSteps": 23,
      "flakySteps": 12,
      "passRate": 97.5
    },
    "status": {
      "state": "passing",
      "message": "All critical user flows passing",
      "lastRunAt": "2026-02-12T16:34:00.000Z",
      "nextSchedule": {
        "cronExpression": "*/5 * * * * *",
        "nextRunAt": "2026-02-12T16:35:00.000Z"
      }
    },
    "performance": {
      "avgRunTimeMs": 45000,
      "failureRate": 0.2,
      "runsPerMinute": 1.3
    }
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `summary.passRate` — percentage (0–100), one decimal
- `summary.tokensSpent` — raw token count (format as "6.09M" on frontend)
- `status.state` — `"passing"` | `"warning"` | `"failing"`
- `status.nextSchedule` — `null` if no active schedules
- `performance.avgRunTimeMs` — milliseconds (format as "45s" on frontend)
- `performance.failureRate` — percentage (0–100)
- `performance.runsPerMinute` — runs in last hour / 60

---

## 2. Results Overview

`GET /api/v1/analytics/results-overview`

Returns donut chart data.

**Query Parameters:** same as Summary.

**Response:**

```json
{
  "success": true,
  "data": {
    "passed": 1842,
    "failed": 23,
    "skipped": 64,
    "flaky": 12,
    "total": 1941,
    "percentages": {
      "passed": 94.9,
      "failed": 1.2,
      "skipped": 3.3,
      "flaky": 0.6
    }
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `flaky` — test cases that failed then passed on retry within the same run
- `percentages` — pre-calculated, one decimal precision

---

## 3. Recent Failures

`GET /api/v1/analytics/recent-failures`

Returns recent failed tests with severity classification.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspaceId | uuid | yes | Workspace ID |
| projectId | uuid | no | Filter by project |
| limit | integer | no | Max results (default: 10) |

**Response:**

```json
{
  "success": true,
  "data": {
    "failures": [
      {
        "id": "exec-uuid",
        "testCaseName": "Login with email",
        "testCaseId": "case-uuid",
        "runId": "run-uuid",
        "status": "failed",
        "errorMessage": "Timeout waiting for selector #login-btn",
        "severity": "recovered",
        "failedAt": "2026-02-12T15:34:00.000Z",
        "timeAgo": "1h ago"
      }
    ]
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `severity`:
  - `"recovered"` — test case has a later passing execution (green dot)
  - `"warn"` — medium/low priority test, still failing (orange dot)
  - `"failure"` — critical/high priority test, still failing (red dot)
- `timeAgo` — human-readable relative time from server

---

## 4. Critical Checks

`GET /api/v1/analytics/critical-checks`

Returns status of all test cases marked as `priority: "critical"`.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspaceId | uuid | yes | Workspace ID |
| projectId | uuid | no | Filter by project |

**Response:**

```json
{
  "success": true,
  "data": {
    "checks": [
      {
        "id": "case-uuid",
        "name": "Sign in",
        "status": "ok",
        "lastRunAt": "2026-02-12T16:30:00.000Z",
        "lastRunId": "run-uuid"
      },
      {
        "id": "case-uuid-2",
        "name": "Invite teammate",
        "status": "failed",
        "lastRunAt": "2026-02-12T16:28:00.000Z",
        "lastRunId": "run-uuid-2"
      }
    ]
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `status`: `"ok"` | `"failed"` | `"unknown"` (never executed)
- Only includes test cases with `priority = "critical"` and `status = "published"`
- Returns empty `checks: []` if no critical test cases defined

---

## 5. Activity Heatmap

`GET /api/v1/analytics/heatmap`

Returns daily activity counts for GitHub-style heatmap.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspaceId | uuid | yes | Workspace ID |
| metric | string | yes | `"runs"` \| `"failures"` \| `"flaky"` |
| range | string | no | `"30d"` \| `"90d"` \| `"365d"` (default: `"365d"`) |
| projectId | uuid | no | Filter by project |

**Response:**

```json
{
  "success": true,
  "data": {
    "days": [
      { "date": "2025-02-12", "count": 0, "level": 0 },
      { "date": "2025-02-13", "count": 3, "level": 1 },
      { "date": "2025-02-14", "count": 12, "level": 3 }
    ],
    "maxCount": 15,
    "totalCount": 2436
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `days` — one entry per day in the range, sorted chronologically
- `level` — intensity bucket: `0` (none), `1` (low), `2` (medium), `3` (high), `4` (max)
- Levels are calculated as quartiles of `maxCount`
- Use `level` to map to heatmap colors (e.g., level 0 = gray, level 4 = dark green)

---

## 6. Deployments

`GET /api/v1/analytics/deployments`

Returns recent git webhook deliveries (releases/pushes).

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspaceId | uuid | yes | Workspace ID |
| projectId | uuid | no | Filter by project |
| limit | integer | no | Max results (default: 5) |

**Response:**

```json
{
  "success": true,
  "data": {
    "deployments": [
      {
        "id": "delivery-uuid",
        "version": "v1.6.7",
        "eventType": "release",
        "provider": "github",
        "status": "no_tests",
        "branch": "refs/heads/main",
        "deliveredAt": "2026-02-12T15:00:00.000Z",
        "runId": null
      }
    ]
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `status`: `"passed"` | `"regression_flagged"` | `"pending"` | `"no_tests"`
- `version` — extracted from release tag name, `null` if not a release event
- Returns empty `deployments: []` if no git integration configured
- `runId` — linked regression run ID if tests were triggered, `null` otherwise

---

## 7. Time Series

`GET /api/v1/analytics/time-series`

Returns time-bucketed run counts for the performance chart.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspaceId | uuid | yes | Workspace ID |
| interval | string | yes | `"1m"` \| `"5m"` \| `"15m"` \| `"1h"` \| `"1d"` |
| projectId | uuid | no | Filter by project |
| startDate | ISO 8601 | no | Start (default: 1 hour ago) |
| endDate | ISO 8601 | no | End (default: now) |

**Response:**

```json
{
  "success": true,
  "data": {
    "points": [
      {
        "timestamp": "2026-02-12T16:00:00.000Z",
        "totalRuns": 9,
        "passedRuns": 8,
        "failedRuns": 1
      },
      {
        "timestamp": "2026-02-12T16:05:00.000Z",
        "totalRuns": 7,
        "passedRuns": 7,
        "failedRuns": 0
      }
    ],
    "interval": "5m"
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**
- `points` — sorted chronologically
- `timestamp` — bucket start time
- Use `interval` buttons (1m, 5m, 15m) to switch and re-fetch
- Adjust `startDate`/`endDate` based on selected interval window

---

## Error Responses

All endpoints return consistent error shapes:

```json
// 400 — Missing required params
{ "success": false, "error": "Bad request", "message": "workspaceId is required", "timestamp": "..." }

// 401 — Not authenticated
{ "success": false, "error": "Unauthorized", "message": "Authentication required", "timestamp": "..." }

// 403 — No workspace access
{ "success": false, "error": "Access denied", "message": "You do not have access to this workspace", "timestamp": "..." }

// 500 — Server error
{ "success": false, "error": "Internal server error", "message": "Failed to retrieve ...", "timestamp": "..." }
```

---

## Frontend Integration Example

```typescript
// Fetch all dashboard data in parallel on page load
const workspaceId = currentWorkspace.id;

const [summary, results, failures, checks, heatmap, deployments, timeSeries] =
  await Promise.all([
    api.get(`/analytics/summary?workspaceId=${workspaceId}`),
    api.get(`/analytics/results-overview?workspaceId=${workspaceId}`),
    api.get(`/analytics/recent-failures?workspaceId=${workspaceId}&limit=5`),
    api.get(`/analytics/critical-checks?workspaceId=${workspaceId}`),
    api.get(`/analytics/heatmap?workspaceId=${workspaceId}&metric=runs&range=365d`),
    api.get(`/analytics/deployments?workspaceId=${workspaceId}&limit=5`),
    api.get(`/analytics/time-series?workspaceId=${workspaceId}&interval=5m`),
  ]);
```

### Formatting Helpers

```typescript
// Tokens: 6090000 → "6.09M"
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

// Duration: 45000 → "45s"
function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60_000) return Math.round(ms / 1000) + 's';
  return Math.round(ms / 60_000) + 'm';
}
```
