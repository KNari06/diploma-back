# Frontend Instructions: Wire Step 3 (Automation) to Backend

## Target File

```
apps/web/src/components/Home/CreateRegressionDialog.jsx
```

## Problem

Step 3 UI exists with all state variables (`automationEnabled`, `gitTriggers`, `scheduleType`, `environment`, `browser`, `notifications`, etc.) but `handleCreate()` (line 264) only sends:

```js
{ projectId, name, description, tags, isDefault }
```

The backend now accepts two additional fields: `automationConfig` and `notificationsEnabled`.

---

## Changes Required

### 1. Add `gitBranch` state variable

**Location:** Line 73, after the `gitTriggers` state declaration.

```js
const [gitBranch, setGitBranch] = useState("main");
```

### 2. Add two builder helper functions

**Location:** Before `handleCreate()` (around line 263).

```js
/**
 * Convert schedule UI state → backend PlanScheduleConfig
 */
const buildScheduleConfig = () => {
  // "every6h" maps directly to a cron expression
  if (scheduleType === "every6h") {
    return {
      enabled: true,
      days: ["*"],
      time: "00:00",
      timezone,
      customCron: "0 */6 * * *",
    };
  }

  if (scheduleType === "custom") {
    return {
      enabled: true,
      days: ["*"],
      time: "00:00",
      timezone,
      customCron: cronExpression.trim(),
    };
  }

  // Preset mappings
  const presets = {
    nightly:  { days: ["*"], time: "02:00" },
    weekdays: { days: ["monday","tuesday","wednesday","thursday","friday"], time: "09:00" },
  };

  const preset = presets[scheduleType] || presets.nightly;
  return {
    enabled: true,
    days: preset.days,
    time: preset.time,
    timezone,
  };
};

/**
 * Convert git trigger checkboxes → backend PlanGitTriggersConfig
 */
const buildGitTriggersConfig = () => {
  const triggerTypes = [];
  if (gitTriggers.onMergeToMain)    triggerTypes.push("merge_to_main");
  if (gitTriggers.onPrOpened)       triggerTypes.push("pr_opened");
  if (gitTriggers.onReleaseBranch)  triggerTypes.push("release");

  return {
    enabled: triggerTypes.length > 0,
    triggerTypes,
    branch: gitBranch.trim() || "main",
  };
};
```

### 3. Update `handleCreate()` payload

**Location:** Lines 274-281 — replace the payload construction block.

**Before:**
```js
const payload = {
  projectId,
  name: name.trim(),
  description: description.trim() || undefined,
  tags: tags.length > 0 ? tags : ["custom"],
  isDefault: false,
};
```

**After:**
```js
// Build automation config from Step 3 state
const automationConfig = automationEnabled ? {
  schedule: buildScheduleConfig(),
  gitTriggers: buildGitTriggersConfig(),
  runtime: {
    environment,
    browser,
  },
} : undefined;

// Notifications enabled if at least one checkbox is on
const notificationsEnabled = notifications.firstFailure
  || notifications.completion
  || notifications.flakySpike;

const payload = {
  projectId,
  name: name.trim(),
  description: description.trim() || undefined,
  tags: tags.length > 0 ? tags : ["custom"],
  isDefault: false,
  automationConfig,
  notificationsEnabled,
};
```

### 4. Add branch input field to Step 3 UI

**Location:** After the three git trigger checkboxes (after line 813, inside the `pl-5` div).

```jsx
{/* Branch target */}
<div className="mt-2">
  <Label htmlFor="git-branch" className="text-[11px]">
    Target branch
  </Label>
  <Input
    id="git-branch"
    placeholder="main"
    value={gitBranch}
    onChange={(e) => setGitBranch(e.target.value)}
    className="text-[12px] mt-1"
  />
  <div className="text-[10px] text-muted-foreground mt-1">
    Only trigger when merging/pushing to this branch
  </div>
</div>
```

### 5. Update `handleReset()`

**Location:** Line 347 area — add the new `gitBranch` reset alongside the existing git resets.

```js
setGitBranch("main");
```

---

## No Changes Needed

| File | Reason |
|------|--------|
| `regressionsService.js` | `createPlan(payload)` already does `JSON.stringify(payload)` — new fields are sent automatically |
| `regressionsService.template.js` | Template/reference file only |
| Backend API | Already accepts `automationConfig` and `notificationsEnabled` in POST and PATCH |

---

## Backend `automationConfig` JSONB Shape (Reference)

This is the shape the backend expects. The frontend builders above produce this exact structure.

```jsonc
{
  "schedule": {
    "enabled": true,
    "days": ["monday","wednesday","friday"],  // or ["*"] for every day
    "time": "02:00",                          // HH:MM
    "timezone": "UTC",
    "customCron": "0 */6 * * *"               // optional — used when present, bypasses days/time parsing
  },
  "gitTriggers": {
    "enabled": true,
    "triggerTypes": ["merge_to_main", "pr_opened", "release"],
    "branch": "main"
  },
  "runtime": {
    "environment": "staging",                 // "staging" | "production" | "development"
    "browser": "chrome"                       // "chrome" | "firefox" | "safari" | "edge"
  }
}
```

---

## How the Branch Field Works End-to-End

1. **User** types a branch name (e.g. `main`, `develop`) in the new "Target branch" input
2. **Frontend** sends it as `automationConfig.gitTriggers.branch` in the create/update payload
3. **Backend** stores it in the plan's `automation_config` JSONB column
4. **On webhook fire:** `git-webhook.job.ts` reads `plan.automation_config.gitTriggers.branch` and passes it to `shouldTrigger()` as `allowedBranches`
5. **`shouldTrigger()`** checks if the webhook's target branch matches — if not, the run is skipped with reason `branch_not_allowed`
6. **Default fallback:** If no branch is set, the backend defaults to `["main", "master"]`

---

## `customCron` Backend Support

Already implemented. `syncSchedule()` uses `scheduleConfig.customCron || this.buildCronExpression(scheduleConfig)`. The `every6h` and `custom` schedule types bypass day/time parsing and use the raw cron expression directly.

---

## Risk Signals Section

The three "Risk Signals" checkboxes (`afterFlakySpike`, `afterFailedDeploy`, `afterApiChange`) are **UI-only** for now. The backend does not process them. Leave them in the UI as-is — they are not sent in the payload and can be wired up in a future iteration.

---

## Edit Plan Dialog

When building an "Edit Regression Plan" dialog, use the same `buildScheduleConfig()` / `buildGitTriggersConfig()` helpers and send `automationConfig` + `notificationsEnabled` in the PATCH payload via:

```js
regressionsService.updatePlan(planId, {
  automationConfig,
  notificationsEnabled,
});
```

To populate the form from an existing plan, reverse-map the `plan.automationConfig` back into state:

```js
// Pre-populate from existing plan
if (plan.automationConfig) {
  setAutomationEnabled(true);

  const { schedule, gitTriggers, runtime } = plan.automationConfig;

  // Schedule
  if (schedule?.customCron) {
    if (schedule.customCron === "0 */6 * * *") {
      setScheduleType("every6h");
    } else {
      setScheduleType("custom");
      setCronExpression(schedule.customCron);
    }
  } else if (schedule?.days?.length === 5) {
    setScheduleType("weekdays");
  } else {
    setScheduleType("nightly");
  }
  if (schedule?.timezone) setTimezone(schedule.timezone);

  // Git triggers
  if (gitTriggers) {
    setGitTriggers({
      onMergeToMain: gitTriggers.triggerTypes?.includes("merge_to_main") ?? false,
      onPrOpened: gitTriggers.triggerTypes?.includes("pr_opened") ?? false,
      onReleaseBranch: gitTriggers.triggerTypes?.includes("release") ?? false,
    });
    setGitBranch(gitTriggers.branch || "main");
  }

  // Runtime
  if (runtime?.environment) setEnvironment(runtime.environment);
  if (runtime?.browser) setBrowser(runtime.browser);
} else {
  setAutomationEnabled(false);
}

setNotifications({
  firstFailure: plan.notificationsEnabled ?? true,
  completion: false,
  flakySpike: plan.notificationsEnabled ?? true,
});
```
