# Wrong-Element Click Debugging

Class of bug: Apply All / replay clicks the wrong element, often the most prominent CTA next to the real target. Found on hub.atk.pro (Element Plus icon toolbar) April 2026, but the pattern is universal.

## Diagnostic order (CRITICAL — do this BEFORE assuming LLM is at fault)

When a step lands on the wrong element, run through these in order. Each step takes 30 seconds. Don't skip.

### 1. Open `preview_run_*.jsonl` for the failing run

```bash
ls -lt /Users/yerassylospanov/Desktop/qai-backend/test_logs/*preview_run* | head -3
```

Find the failing step's `step_start` and `step_result` events.

### 2. Check `step_start` — was identity recorded?

```json
{"eventType":"step_start","payload":{
  "hasRecordedFingerprint": true,
  "recordedId": "layout-header-setting",   // ← present?
  "recordedTestId": ...,
  "recordedTag": "svg"
}}
```

- `hasRecordedFingerprint: false` or `recordedId: undefined` → recorder didn't capture identity. Bug is in `recording-capture.service.ts` PROBE_AT_POINT_FN. NOT a resolver bug.
- All present → recording is fine, move on.

### 3. Check `step_result.resolverPath`

```json
{"eventType":"step_result","payload":{
  "resolverPath": "llm",         // ← which path?
  "fingerprintMatch": "mismatch",
  "chosenLabel": "Mouse sleeps abnormally, click me!"
}}
```

- `identity_id` / `identity_testid` → fast-path fired. If `fingerprintMatch=mismatch` here, snapshot-collector is feeding the wrong nodes (rare).
- `llm` / `vision` → fast-path missed. Critical: WHY did it miss?
- `evidence_shortcut` / `compiled` → cached match path; check evidence cache.

### 4. Find `[ELEMENT_RESOLVER] identity fast-path diag` in server stdout

This is the single most important diagnostic. It prints:

```
{
  recordedId: "layout-header-setting",
  liveIdsSample: ["el-id-225-3"],   // ← what's actually on the page
  liveIdsCount: 1,
  idMatch: false                     // ← THE answer
}
```

- `idMatch: false` AND `liveIdsCount` low → snapshot-collector doesn't see the recorded element. **Fix the collector, NOT the LLM.** This was the root cause on hub.atk.pro.
- `idMatch: true` but fast-path didn't hit → uniqueness gate failed (≥2 elements with same id). Check if page has duplicates.

### 5. Only AFTER steps 1-4 ruled out, look at LLM behaviour

If snapshot has the element AND fast-path was bypassed correctly AND LLM still picked wrong → then it's an LLM/prompt issue. Check rules 16-18 in `LLM_SELECT_APPLY_PROMPT`.

## Common root causes (ranked by frequency from real incidents)

1. **snapshot-collector filter excludes the target element.** SVG/icon/role-less custom components fail Tier-1 (`INTERACTIVE_CHILDREN_SELECTOR` only has button/a/input/[role=...]/[tabindex]). They fall to Tier-2 cursor:pointer, which until April 2026 required text. Icons have no text. Fixed by widening Tier-2 to accept `text || stableId || testId || svg/i/img/path` + 5×5 size gate at `snapshot-collector.ts` ~line 1021.

2. **`node.id` / `node.testIdAttr` not exposed.** These fields existed on the `InteractiveNode` interface but weren't filled by the collector. Identity fast-path, `compareToRecordedFingerprint`, locator-plan id-strategy, and the LLM prompt's `id: ...` line were all silently no-ops. Fixed by adding the fields to `elements.push({...})` with the same framework-id filter the recorder uses.

3. **Symmetry break between recorder and collector.** Recorder probes via cursor:pointer walk-up; if the collector uses different criteria, the recorded element is invisible to the resolver. Always check both sides use the same generated-id regex (`el-id-`, `radix-`, `:rN:`, `mui-`, `headlessui-`, UUID).

4. **Server cache stale.** `nodemon` doesn't always re-transpile when ts-node has cached. After major changes:
   ```bash
   rm -rf node_modules/.cache
   lsof -ti:3000 | xargs kill -9 2>/dev/null
   npm run dev
   ```
   First sign of stale server: new diag logs / new trace fields don't appear. If you added a `logger.info('[NEW_TAG]')` and it's missing — restart.

5. **LLM grabbing loudest CTA.** Real but #5, not #1. Symptom: `chosenLabel: "Submit" / "Click me!" / "Get started"` next to the real target. Defenses: rules 16-18 in apply prompt, fake-success guard at `preview-step-apply.ts` blocks `mismatch + weak-signal` (focus/none/newtab) post-click.

## Layered defenses (don't disable any of these without understanding which class of bug they catch)

| Layer | File | Catches |
|---|---|---|
| Identity fast-path | `element-resolver.service.ts` | id/testId match before LLM. Free, deterministic. |
| Fake-success guard | `preview-step-apply.service.ts` | Post-click: `mismatch + weak signal + has ground truth` → fail not pass. |
| LLM rules 16-18 | `element-resolver.service.ts` (apply + heal), `rescueWithGeminiFlash`, `self-healing.service.ts` | Slug intents, adjacency≠function, no loudest-CTA fallback. ALL 4 resolvers must have these. |
| Wrapper→icon descent | `recording-capture.service.ts` PROBE_AT_POINT_FN | Recorder edge case: click at sub-pixel border lands on wrapper instead of svg child. |
| `resolverPath` trace | `preview.types.ts`, `preview-run.service.ts` | Diagnosis at-a-glance for next bug. |

## Universality check before claiming a fix is universal

When fixing a wrong-element bug, ask:
- Does this only fix Element Plus, or any framework with icon buttons?
- Is the regex/filter byte-identical with the recorder side?
- Does it widen the candidate set or narrow it?
- Does it have a min-size / layout-container guard so it doesn't catch the whole page?

If any answer is site-specific, re-think before committing.

## Anti-patterns from past incidents

- ❌ "Just tweak the LLM prompt" without checking if the target is in the candidate list. The prompt cannot pick what it doesn't see.
- ❌ Adding new node fields (id, testId, etc.) to the type interface without populating them in the collector. Silent no-op repo-wide.
- ❌ Treating `clickEffectSignal: 'newtab'` as automatic success. Popup to unrelated domain is the canonical fake-success symptom.
- ❌ Claiming a fix worked without re-running and checking `resolverPath` in the new trace. The user nodemon-cache-bit me 3 times in one session.

## Memory

Full incident log: `/Users/yerassylospanov/.claude/projects/-Users-yerassylospanov-Desktop-qai-backend/memory/april_28_2026_wrong_element_root_cause.md`
