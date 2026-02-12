# Regression Plans API

Base URL: `/api/v1/regression-plans`

All endpoints require `Authorization: Bearer <token>` header.

---

## 1. List Plans (with stats)

`GET /api/v1/regression-plans?projectId=<uuid>`

Returns all regression plans for a project, enriched with scope, latest run info, and health status. This is the main endpoint for the **Regression Tests list page**.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| projectId | uuid | yes | Project ID |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "a1b2c3d4-...",
      "projectId": "bc2a3df3-...",
      "userId": "user_123",
      "name": "Core User Flows",
      "description": "Critical user journey tests",
      "isDefault": true,
      "tags": ["Core"],
      "createdAt": "2026-02-10T10:00:00.000Z",
      "updatedAt": "2026-02-12T16:00:00.000Z",
      "scope": {
        "testCount": 24,
        "flowCount": 8
      },
      "lastRun": {
        "runId": "run-uuid-...",
        "status": "completed",
        "startedAt": "2026-02-12T16:22:00.000Z",
        "completedAt": "2026-02-12T16:34:00.000Z",
        "durationMs": 720000
      },
      "health": {
        "state": "passing",
        "passRate": 98.5,
        "passed": 23,
        "failed": 0,
        "flaky": 2,
        "total": 24
      }
    }
  ],
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Field notes:**

| Field | Description | Frontend hint |
|-------|-------------|---------------|
| `tags` | Array of strings: `"Core"`, `"Release"`, `"Smoke"`, `"Custom"`, etc. | Render as badge/chip |
| `scope.testCount` | Total test cases in the plan | Display as "24 tests" |
| `scope.flowCount` | Total distinct flows in the plan | Display as "8 flows" |
| `lastRun` | `null` if the plan has never been run | Show "Never run" |
| `lastRun.status` | `"running"` \| `"completed"` \| `"failed"` \| `"cancelled"` | — |
| `lastRun.startedAt` | ISO 8601 timestamp | Format as "Last run 5 mins ago" |
| `lastRun.durationMs` | Milliseconds, `null` if still running | Format as "12m", "45s", etc. |
| `health.state` | `"passing"` \| `"warning"` \| `"failing"` \| `"unknown"` | Green / Orange / Red / Gray badge |
| `health.passRate` | Percentage (0–100), one decimal | Display as "98.5%" |
| `health.flaky` | Count of test cases with mixed pass/fail in last run | Display as "2 flaky" |
| `health.passed` / `failed` / `total` | Absolute counts from last run | — |

**State logic:**
- `"unknown"` — plan has never been run, or last run has no executions
- `"passing"` — no failures in last run
- `"warning"` — has failures but passRate >= 90%
- `"failing"` — has failures and passRate < 90%

---

## 2. Get Plan by ID (with items)

`GET /api/v1/regression-plans/:id`

Returns a single plan with its item list (what's included in the plan).

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-...",
    "projectId": "bc2a3df3-...",
    "userId": "user_123",
    "name": "Core User Flows",
    "description": "Critical user journey tests",
    "isDefault": true,
    "tags": ["Core"],
    "createdAt": "2026-02-10T10:00:00.000Z",
    "updatedAt": "2026-02-12T16:00:00.000Z",
    "items": [
      {
        "id": "item-uuid-...",
        "planId": "a1b2c3d4-...",
        "itemType": "module",
        "moduleId": "mod-uuid-...",
        "orderIndex": 0,
        "parametersOverride": {},
        "createdAt": "2026-02-10T10:00:00.000Z"
      },
      {
        "id": "item-uuid-2-...",
        "planId": "a1b2c3d4-...",
        "itemType": "flow",
        "flowId": "flow-uuid-...",
        "orderIndex": 1,
        "parametersOverride": {},
        "createdAt": "2026-02-10T10:00:00.000Z"
      },
      {
        "id": "item-uuid-3-...",
        "planId": "a1b2c3d4-...",
        "itemType": "test_case",
        "testCaseId": "tc-uuid-...",
        "testCaseType": "ui",
        "orderIndex": 2,
        "parametersOverride": { "email": "test@example.com" },
        "createdAt": "2026-02-10T10:00:00.000Z"
      }
    ]
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

**Item types:**

| itemType | Set field | Description |
|----------|-----------|-------------|
| `"module"` | `moduleId` | Includes all flows and test cases under the module |
| `"flow"` | `flowId` | Includes all test cases under the flow |
| `"test_case"` | `testCaseId` + `testCaseType` | Single test case (`"ui"` or `"api"`) |

---

## 3. Create Plan

`POST /api/v1/regression-plans`

**Request Body:**

```json
{
  "projectId": "bc2a3df3-...",
  "name": "Smoke Tests",
  "description": "Quick smoke tests for deploys",
  "isDefault": false,
  "tags": ["Smoke"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| projectId | uuid | yes | Project ID |
| name | string | yes | Plan name |
| description | string | no | Plan description |
| isDefault | boolean | no | Set as default plan (unsets previous default) |
| tags | string[] | no | Tags for filtering (e.g. `["Core", "Release"]`) |

**Response:** Same shape as a single plan object (without `items`, `scope`, `lastRun`, `health`).

---

## 4. Update Plan

`PATCH /api/v1/regression-plans/:id`

**Request Body (all fields optional):**

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "isDefault": true,
  "tags": ["Core", "Release"]
}
```

**Response:** Updated plan object.

---

## 5. Delete Plan

`DELETE /api/v1/regression-plans/:id`

**Response:**

```json
{
  "success": true,
  "message": "Plan deleted",
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

## 6. Add Item to Plan

`POST /api/v1/regression-plans/:id/items`

**Request Body:**

```json
{
  "itemType": "module",
  "moduleId": "mod-uuid-..."
}
```

**Variants:**

```jsonc
// Add a module (all its flows + test cases)
{ "itemType": "module", "moduleId": "..." }

// Add a flow (all its test cases)
{ "itemType": "flow", "flowId": "..." }

// Add a single test case
{ "itemType": "test_case", "testCaseId": "...", "testCaseType": "ui" }

// With parameter overrides
{ "itemType": "test_case", "testCaseId": "...", "testCaseType": "ui", "parametersOverride": { "email": "test@qa.com" } }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| itemType | string | yes | `"module"` \| `"flow"` \| `"test_case"` |
| moduleId | uuid | if module | Module ID |
| flowId | uuid | if flow | Flow ID |
| testCaseId | uuid | if test_case | Test case ID |
| testCaseType | string | if test_case | `"ui"` \| `"api"` |
| parametersOverride | object | no | Override parameters for this item |

**Response:** Created item object.

---

## 7. Remove Item from Plan

`DELETE /api/v1/regression-plans/:id/items/:itemId`

**Response:**

```json
{
  "success": true,
  "message": "Item removed",
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

## 8. Expand Plan

`GET /api/v1/regression-plans/:id/expand`

Resolves all plan items (modules, flows, test cases) into a flat list of individual test cases. Useful for previewing what will run.

**Response:**

```json
{
  "success": true,
  "data": {
    "testCases": [
      {
        "testCaseId": "tc-uuid-1",
        "testType": "ui",
        "moduleId": "mod-uuid-...",
        "flowId": "flow-uuid-...",
        "name": "Login with valid credentials"
      },
      {
        "testCaseId": "tc-uuid-2",
        "testType": "api",
        "moduleId": "mod-uuid-...",
        "flowId": "flow-uuid-...",
        "name": "GET /users returns 200"
      }
    ],
    "totalCount": 24
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

---

# Regression Execution API

Base URL: `/api/v1/regression`

Endpoints for running tests and viewing run history.

---

## 9. Run a Plan

`POST /api/v1/regression/run-plan`

Executes all test cases in a regression plan.

**Request Body:**

```json
{
  "planId": "a1b2c3d4-...",
  "parameters": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| planId | uuid | yes | Plan ID to run |
| parameters | object | no | Global parameter overrides |

**Response:**

```json
{
  "success": true,
  "data": {
    "runId": "run-uuid-...",
    "totalTests": 24,
    "executionIds": ["exec-1", "exec-2", "..."]
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

## 10. Run a Single Test Case

`POST /api/v1/regression/run`

**Request Body:**

```json
{
  "savedTestCaseId": "tc-uuid-...",
  "trigger": "manual",
  "parameters": { "email": "test@qa.com" }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| savedTestCaseId | uuid | yes | Test case ID to run |
| trigger | string | no | `"manual"` (default) or `"chat"` |
| parameters | object | no | Parameter values for parameterized tests |

---

## 11. Run a Module

`POST /api/v1/regression/run-module`

Runs all test cases under a module.

**Request Body:**

```json
{
  "moduleId": "mod-uuid-...",
  "parameters": {}
}
```

---

## 12. Run a Flow

`POST /api/v1/regression/run-flow`

Runs all test cases under a flow.

**Request Body:**

```json
{
  "flowId": "flow-uuid-...",
  "parameters": {}
}
```

---

## 13. Run by Tag

`POST /api/v1/regression/run-by-tag`

Runs all test cases matching a tag across a project.

**Request Body:**

```json
{
  "projectId": "bc2a3df3-...",
  "tag": "smoke"
}
```

---

## 14. Run by Priority

`POST /api/v1/regression/run-by-priority`

Runs all test cases matching a priority level.

**Request Body:**

```json
{
  "projectId": "bc2a3df3-...",
  "priority": "critical"
}
```

| priority | Values |
|----------|--------|
| priority | `"critical"` \| `"high"` \| `"medium"` \| `"low"` |

---

## 15. List Runs

`GET /api/v1/regression/runs?projectId=<uuid>`

Returns run history for a project (most recent first).

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| projectId | uuid | yes | Project ID |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "run-uuid-...",
      "project_id": "bc2a3df3-...",
      "plan_id": "plan-uuid-...",
      "status": "completed",
      "trigger": "manual",
      "summary": {
        "total": 24,
        "ui_started": 20,
        "api_passed": 4
      },
      "started_at": "2026-02-12T16:22:00.000Z",
      "completed_at": "2026-02-12T16:34:00.000Z"
    }
  ],
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

## 16. Get Run Stats

`GET /api/v1/regression/runs/:runId/stats`

Returns execution statistics for a specific run.

**Response:**

```json
{
  "success": true,
  "data": {
    "total": 24,
    "passed": 22,
    "failed": 1,
    "skipped": 0,
    "pending": 0,
    "running": 1,
    "cancelled": 0,
    "passRate": 95.7
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

## 17. Save Test as Regression Case

`POST /api/v1/regression/save`

Converts a completed test execution into a reusable regression test case.

**Request Body:**

```json
{
  "sourceTestId": "test-uuid-...",
  "name": "Login flow - happy path",
  "description": "Verifies standard login with valid credentials",
  "kind": "standalone"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| sourceTestId | uuid | yes | ID of the completed test to save |
| name | string | yes | Name for the saved test case |
| description | string | no | Description |
| kind | string | no | `"standalone"` (default) or `"regression_member"` |

---

## 18. List Saved Test Cases

`GET /api/v1/regression/saved-test-cases?projectId=<uuid>`

Returns all saved test case definitions for a project.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| projectId | uuid | yes | Project ID |

---

## 19. Get Test Case Commands

`GET /api/v1/regression/test-cases/:id/commands`

Returns commands and parameters schema for a test case (used by shared steps picker).

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "tc-uuid-...",
    "name": "Login flow",
    "commands": [...],
    "parametersSchema": { "email": "string", "password": "string" }
  },
  "timestamp": "2026-02-12T16:34:12.000Z"
}
```

---

## Quick Reference: Frontend → API Mapping

Based on the Regression Tests list page UI:

| UI Element | API Source |
|------------|-----------|
| Plan name | `GET /regression-plans` → `data[].name` |
| Tag badge (Core, Release...) | `data[].tags[0]` |
| "24 tests · 8 flows" | `data[].scope.testCount` / `data[].scope.flowCount` |
| "Last run 5 mins ago" | `data[].lastRun.startedAt` (relative time) |
| "12m" duration | `data[].lastRun.durationMs` (format ms → human) |
| Passing / Failing badge | `data[].health.state` |
| "98.5%" coverage | `data[].health.passRate` |
| "2 flaky" | `data[].health.flaky` |
| **Run** button | `POST /regression/run-plan` with `{ planId }` |
| **Edit** button | `GET /regression-plans/:id` → edit → `PATCH /regression-plans/:id` |
| **Analytics** button | `GET /analytics/summary?projectId=...` (see ANALYTICS_API.md) |
| Search regressions | Client-side filter on `name` |
| Tag filter | Client-side filter on `tags` |
| Pagination | Not server-side — all plans returned (typically < 50) |
