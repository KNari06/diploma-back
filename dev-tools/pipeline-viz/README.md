# Editor pipeline visualizer

Live, auto-updating method-by-method graph of the editor lint / apply / run hot path
(snapshot → dom-analysis → lint → locator-plan → resolver → step-apply → run + session, recording).

Standalone, zero-dependency on the app — just static files served by `scripts/pipeline-viz/serve.js`.
Graph shape comes from `scripts/pipeline-viz/build-graph.ts` (ts-morph static analysis of the
9 hot-path source files). Re-runs on file change. UI auto-reloads via SSE when the JSON updates.

## Quick start

```bash
# one-shot build
npm run viz:build

# serve UI on http://localhost:4321
npm run viz:serve

# rebuild on change (run alongside viz:serve in another terminal)
npm run viz:watch
```

`npm run viz:build` writes `dev-tools/pipeline-viz/pipeline-graph.json`.
`npm run viz:serve` serves the folder + a `/events` SSE channel that fires `graph-updated`
when the JSON file changes on disk. The UI reloads the graph in place — no full page refresh.

## Files

| File | Purpose |
|---|---|
| `scripts/pipeline-viz/build-graph.ts` | ts-morph analyzer. Walks 9 hot-path files, extracts class methods + key exported functions, resolves cross-file calls, writes `pipeline-graph.json`. |
| `scripts/pipeline-viz/serve.js` | Static server (port 4321) + SSE bridge for graph reloads + `/trace` POST endpoint that re-broadcasts runtime spans to connected clients. |
| `dev-tools/pipeline-viz/index.html` | UI shell. |
| `dev-tools/pipeline-viz/style.css` | Layer color palette, dark theme. |
| `dev-tools/pipeline-viz/app.js` | Cytoscape.js + dagre layout. Two modes: collapsed (per-service) and expanded (per-method). |
| `dev-tools/pipeline-viz/pipeline-graph.json` | Generated. Don't edit. |

## Source files analyzed

Defined in `SOURCES` in `build-graph.ts`. Add a layer here if you want a new service
included.

```
snapshot       src/agent/core/lite/collectors/snapshot-collector.ts
dom-analysis   src/services/testing/ui/preview/dom-analysis-extractor.service.ts
lint           src/services/testing/ui/preview/intent-step-lint.service.ts
locator-plan   src/services/testing/ui/preview/locator-plan-builder.service.ts
resolver       src/services/testing/ui/preview/element-resolver.service.ts
step-apply     src/services/testing/ui/preview/preview-step-apply.service.ts
run            src/services/testing/ui/preview/preview-run.service.ts
session        src/services/testing/ui/preview/preview-session.service.ts
recording      src/services/testing/ui/preview/recording-capture.service.ts
```

## UI

- **Collapsed view (default)**: one rounded box per service, edges aggregated. Click a service to expand.
- **Expanded view**: services become parent groups; methods are inner nodes. Toggle cross-service / intra-service edges.
- **WS emits**: methods that emit a `preview:*` socket event have a purple border.
- **Hubs**: services with high out-degree (`SnapshotCollector`, `ElementResolver`, `PreviewStepApplyService`, `PreviewRunService`) have an orange highlight.
- **Search**: filters method nodes (auto-expands).
- **Side panel**: file:line, signature, async flag, calls in/out, WS emits.

## Runtime overlay (optional)

`src/utils/monitoring/pipeline-tracer.ts` exposes `traced(name, fn)`. When `PIPELINE_TRACE=1` is set,
spans are POSTed to `http://localhost:4321/trace`; `serve.js` re-broadcasts them as SSE `trace`
events; `app.js` pulses the matching node.

To wire a hub method:

```ts
import { traced } from '@/utils/monitoring/pipeline-tracer';

const result = await traced('PreviewStepApplyService.applyStep', async () => {
  // ... existing body ...
});
```

Zero overhead when disabled (env var unset). Add wrappers only at the call sites you care about
— e.g. `applyStep`, `runStepsOnPreview`, `resolveElement`, `SnapshotCollector.collect`.

## How auto-update works

```
file edit  →  ts-morph rebuild (viz:watch)  →  pipeline-graph.json write
                                                     ↓
                                             fs.watch(dev-tools/pipeline-viz)
                                                     ↓
                                             SSE broadcast "graph-updated"
                                                     ↓
                                             app.js re-fetches JSON, re-renders
```

No bundler, no React, no build step for the UI. Edit `app.js` → reload tab.

## Stats

Last run: see `pipeline-graph.json#stats`. Typical: 9 services, ~170 methods,
~210 edges (internal + cross-service), 0 unresolved (anything ambiguous lands in `unresolved`).
