## Mobile app execution via qait-mobile-runner

This document describes how mobile app upload, installation, and test execution now work end‑to‑end between `qai-backend` and the `qait-mobile-runner` microservice, and what changes were made.

### High-level flow

1. **Upload app at project level**
   - Endpoint: `POST /api/v1/mobile/projects/:projectId/app`
   - Controller: `src/api/mobile/mobile.controller.ts::uploadMobileApp`
   - Storage service: `src/services/storage/mobile-app-storage.service.ts::MobileAppStorageService.uploadApp`
   - Data:
     - APK/IPA is stored in Supabase Storage under `mobile-apps/{workspaceId}/{projectId}/{platform}/{filename}`.
     - Metadata is persisted into `projects.settings.mobileApp` as:
       - `platform`: `'android' | 'ios'`
       - `packageName?`: optional Android package name / iOS bundle ID
       - `storagePath`: Supabase Storage key
       - `publicUrl`: public URL
       - `originalName`, `fileSize`, `uploadedAt`.
   - Frontend UI:
     - `apps/web/src/components/Home/MobileSettings.jsx` uses `mobileService.getApp` / `uploadApp` / `deleteApp` to manage this metadata.

2. **Run a mobile test from chat**
   - Entry point: `src/api/chat/mobile_test/handler.ts::handleMobileTest`.
   - Steps:
     1. Feature flag + health check using `MOBILE_RUNNER_ENABLED` and `getMobileRunnerClient().isHealthy()`.
     2. Credit check via `CreditCostTrackerService`.
     3. Redis lock to prevent concurrent mobile starts per chat session.
     4. Extract intent:
        - `platform`: `parsedIntent.mobilePlatform || 'android'`
        - `intentSteps`: `parsedIntent.intentSteps` (array of `MobileIntentStep`)
        - `appPackage`: **now resolved as**:
          - `parsedIntent.appPackage` (explicit from intent), **or**
          - `project.settings.mobileApp.packageName` (project-level default) if present.
     5. Resolve project and project-level mobile app metadata:
        - Lookup project by `projectId = parsedIntent.projectId || workspace_id`.
        - If `project.settings.mobileApp.storagePath` exists:
          - `appStoragePath = mobileApp.storagePath`
          - `appOriginalName = mobileApp.originalName`
          - `projectAppPackage = mobileApp.packageName`
        - The final `appPackage` used for the test is `parsedIntent.appPackage || projectAppPackage`.
     6. Create a `tests` row via `dbAdminService.createTest` with:
        - `url`: `appPackage || "mobile://<platform>"` (for traceability).
        - `options`: `{ mode: 'lite', platform, appPackage }`.
     7. Optionally save test↔chat mapping via `TestChatMappingService`.
     8. Queue a `MobileTestJobData` job on `mobileTestRunQueue` with:
        - `appStoragePath`, `appOriginalName`, and the resolved `appPackage`.
        - `runnerUrl = env.MOBILE_RUNNER_URL`, `runnerApiKey = env.MOBILE_RUNNER_API_KEY`.

3. **Run a mobile test from CI/CD**
   - Entry point: `src/api/mobile/ci.controller.ts::triggerCiRun`.
   - App resolution:
     - If `appUrl` is provided:
       - Downloads binary, enforces size limit, validates extension.
       - Deletes previous `project.settings.mobileApp` binary if present.
       - Uploads new file via `MobileAppStorageService.uploadApp`, then updates `project.settings.mobileApp`.
       - Sets `appStoragePath`, `appOriginalName`, and **now** also `appPackage = metadata.packageName`.
     - If `appUrl` is not provided:
       - Uses existing `project.settings.mobileApp` if present:
         - `appStoragePath`, `appOriginalName`, `appPackage = mobileApp.packageName`.
   - Test cases:
     - Expands `savedTestCaseIds` / `planId` / all project test cases into mobile `MobileIntentStep[]` via helper functions (`fetchTestCaseSteps`, `fetchAllProjectTestCases`, `expandPlanToMobileTestCases`).
   - For each test case:
     - Creates a `tests` row with:
       - `url: "mobile://<platform>"`.
       - `options`: `{ mode: 'lite', platform, trigger: 'ci', ciRunId, appPackage }`.
     - Enqueues a `MobileTestJobData` with:
       - `appStoragePath`, `appOriginalName`, `appPackage`.

4. **Worker job: create session, install app, run steps**
   - Entry point: `src/jobs/mobile-test-run.job.ts::MobileTestRunJobHandler.process`.
   - Session management:
     - Attempts to reuse a warmed session via `claimWarmedSession(projectId, userId)` if available and platform matches.
     - Otherwise calls `client.createSession(platform)` on `qait-mobile-runner` to cold-start a new emulator/simulator session.
   - **New install + launch behavior**:
     - If `appStoragePath` is present:
       - Emits progress `currentStep: "Installing app on <platform>..."`.
       - If **no** `appPackage` is resolved:
         - Logs a warning and **skips installation**, but continues with the test steps.
       - If `appPackage` exists:
         1. Downloads APK/IPA from Supabase Storage using `MobileAppStorageService.downloadApp(appStoragePath)`.
         2. Uploads binary to the runner via `MobileRunnerClient.uploadApp`, which POSTs to `/upload/apk` and returns a local `path` on the runner host.
         3. Calls the new low-level batch command helper:
            - `MobileRunnerClient.executeBatchCommands(sessionId, [...])` which POSTs to `/api/commands/:sessionId/batch` with an array of MobileCommand objects.
         4. The batch currently sends two commands:
            - `install_app`:
              - `type: 'install_app'`
              - `params: { apkPath: uploadResult.path, reinstall: true }`
            - `launch_app`:
              - `type: 'launch_app'`
              - `params: { packageName: appPackage, clearData: true }`
         5. Logs that the app was installed and launched.
   - Step execution:
     - Calls `client.runSteps(sessionId, intentSteps, { screenshotEachStep: true })`.
     - Emits per-step WebSocket progress via `webSocketService.emitTestStepCompleted`.
   - Results:
     - Calculates pass/fail, updates test status via `updateTestStatus`.
     - Creates a `test_results` row via `dbAdminService.createTestResult`.
     - Queues AI analysis via `QueueManager.addAIAnalysisJob`.
     - Emits completion events and updates CI run status if applicable.
   - Cleanup:
     - Always attempts to destroy the session via `client.destroySession(sessionId)` in `finally`.

5. **Mobile runner commands**
   - HTTP API:
     - `POST /api/commands/:sessionId` — single MobileCommand.
     - `POST /api/commands/:sessionId/batch` — batch of MobileCommand objects.
     - Both are validated by `src/api/schemas/command.schema.ts::mobileCommandSchema`.
   - The new backend helper:
     - `src/services/mobile/mobile-runner-client.ts::executeBatchCommands(sessionId, commands)`:
       - Thin wrapper over `/api/commands/:sessionId/batch`.
       - Typed as `unknown[]` to avoid tight coupling to the runner’s internal union type; callers are responsible for matching the zod schema.
   - Command types already implemented by runner:
     - `install_app` for installing an APK/IPA on the current session’s device.
     - `launch_app` for launching the specified package/bundle ID and updating session metadata (`packageName` or `bundleId`).

### Frontend behavior

The frontend already supports:

- Project-level mobile app management via `MobileSettings.jsx`:
  - Upload, view (including `packageName`), and delete apps at the project level.
- Mobile flow creation in `TestSuites.jsx`:
  - A dedicated **App Package** field (`newFlowAppPackage`) is stored as `settings.appPackage` for each mobile flow.
- Mobile preview streaming via `useMobilePreviewStream.js`:
  - Uses `runnerSocketUrl` and `sessionId` from `POST /api/v1/mobile/sessions/warmup` to open a dedicated Socket.IO connection to the runner and receive `preview:video:frame` events.

With the backend changes described above:

- If a project has a mobile app uploaded and `packageName` set, chat-initiated and CI-initiated mobile tests will:
  - Automatically use that `packageName` as the default `appPackage` (unless explicitly overridden by the intent).
  - Install and launch the uploaded binary on the emulator/simulator before executing steps.

### Notes and limitations

- **ESLint**: The backend uses ESLint v9, but currently does not ship an `eslint.config.*` file, so `npm run lint` will report a configuration error until a new-style config is added. No new lint violations were introduced by the changes above.
- **Tests**:
  - `npm test` passes after a small fix in `token-calculator.service.test.ts`:
    - Replaced a `// @ts-expect-error` directive with a type assertion (`'unknown-model' as any`) to satisfy TypeScript’s expectations while still testing the invalid model fallback path.
- **Mobile app installation**:
  - Requires that `appPackage` (Android package name or iOS bundle ID) is known.
  - If `appStoragePath` is present but `appPackage` is missing, the worker will log a warning and skip installation, but still execute test steps. In practice you should always set `packageName` when uploading the app (or configure it on the flow) for reliable behavior.

