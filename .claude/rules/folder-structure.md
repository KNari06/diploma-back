# Folder Structure Contract

When creating a new file, put it in the right subfolder. Don't drop files into the root of these directories.

For navigation maps (which file does what) — see [CLAUDE.md](../../CLAUDE.md). This file is just the placement contract.

## Hard rules

- **Never put `.ts` files in the root of** `src/`, `src/agent/`, `src/services/`, `src/websocket/`, `src/utils/`, `src/config/`. Exceptions: `index.ts` (barrel), top-level service entry points (`src/agent/core/lite/lite-engine.ts` is fine — it's already in a subfolder).
- **Match imports to the new structure.** `@/services/ai/core/openai.service` not `@/services/ai/openai.service`. The flat layouts shown in old `.cursor/rules/folder-structure.mdc` are obsolete.

## Where new files go

### `src/agent/`
Multi-agent test orchestration.
- New LiteEngine pieces → `src/agent/core/lite/`
- New cognitive agent → `src/agent/core/lite/agents/`
- New Pipeline v2 piece (Planner/Executor/Reviewer) → `src/agent/core/lite/pipeline/`
- New Exploration v2 piece → `src/agent/core/lite/exploration/`
- New Playwright integration → `src/agent/playwright/<core|setup|execution|artifacts|utils>/`
- New utility → `src/agent/utils/<ai|analysis|context|selectors|visualization>/`

### `src/services/`
Domain services.
- AI / LLM clients & helpers → `src/services/ai/<core|intent|helpers|embeddings|analysis|cost|memory|tracking|logging|summarization>/`
- Editor / Preview / Recording / Replay → `src/services/testing/ui/preview/`
- Other testing (regression, plans, results, executions, fixtures, exploration) → `src/services/testing/<area>/`
- Test resources (auth/login adapters, future kinds) → `src/services/test-resource/<adapters|runtime>/`
- Knowledge base → `src/services/kb/`
- Skills registry → `src/services/skills/<qa|kb|memory|hooks|integrations>/`
- Mobile → `src/services/mobile/`
- 3rd-party integrations (Jira/Stripe/Telegram/Allure/Git) → `src/services/integrations/`
- Auth / chat / core business logic → respective top-level folder under `src/services/`

### `src/api/`
One folder per domain. Each folder typically has `<domain>.route.ts` + `<domain>.controller.ts` + sometimes a `<domain>.service.ts`.
- New REST domain → new folder `src/api/<domain>/`
- Wire into `src/index.ts`

### `src/websocket/`
- New event handler → `src/websocket/handlers/<name>.handler.ts`
- Preview events all live in `preview.handler.ts` — don't fork them
- New middleware → `src/websocket/middleware/`
- New types → `src/websocket/types/`

### `src/jobs/`
Flat layout. One file per job: `src/jobs/<name>.job.ts`. Register in `src/worker/index.ts`.

### `src/ai/prompts/`
Flat layout. One file per prompt-family: `intent-and-chat-prompts.ts`, `api-flow-prompts.ts`, etc.

### `src/utils/`
Cross-domain only. If a util is used by exactly one feature, put it next to that feature.
- `src/utils/core/` — logger, error handler
- `src/utils/validation/`, `src/utils/parsing/`, `src/utils/text-processing/`, `src/utils/helpers/`, `src/utils/monitoring/`, `src/utils/notifications/`, `src/utils/security/`, `src/utils/graph/`

### `src/config/`
- Env vars → `src/config/environment/env.ts`
- Queues / Redis → `src/config/infrastructure/`
- API/Swagger → `src/config/api/`
- AI model config → `src/config/ai/`
- Feature flags → `src/config/features/`
- Test limits → `src/config/testing/`

### `src/middleware/`, `src/db/`, `src/types/`, `src/scheduler/`, `src/scripts/`, `src/test/`, `src/worker/`
Flat. Add files at the level you find them.

## When moving a file

1. Update all imports — `rg "from .*<old-path>" src/`
2. Update dynamic imports — `rg "import\\(.*<old-path>" src/`
3. Update barrel `index.ts` if affected
4. Run `npm run type-check`
5. If the file was mentioned by name in any `CLAUDE.md` — update or remove that reference

## Pre-commit sanity

```bash
# No stray files in roots that should be folder-only
find src/agent -maxdepth 1 -name "*.ts" -not -name "index.ts"
find src/services -maxdepth 1 -name "*.ts"
find src/websocket -maxdepth 1 -name "*.ts" -not -name "index.ts"
find src/utils -maxdepth 1 -name "*.ts"
find src/config -maxdepth 1 -name "*.ts"

npm run type-check
```
