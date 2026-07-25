# Test Resources

> Polymorphic table + adapter registry for **anything reusable across many tests**: logins, environments, secrets, future data fixtures, files, network mocks, scenario setups. One DB shape, one wire format, N adapters.
>
> Touch this folder when adding a new resource kind, changing the lifecycle of an existing one, or wiring per-run runtime variables (`runVariables`).

**Parent map:** [project root CLAUDE.md](../../../CLAUDE.md)

---

## Why this exists

Pre-Phase-1 design had a single `auth_profiles` table for logins. By April 2026 we knew at least 9 other classes of "reusable thing" would land — duplicating the CRUD/encryption/TTL/heal/defaults plumbing per kind would explode into 10 parallel mini-services. Solution: **one polymorphic `test_resources` table discriminated by `kind`** + an **adapter registry** that maps each kind to its own validate/apply/heal/capture logic.

Tests bind to resources via a single `intent_test_cases.resource_bindings` JSONB array (one entry per kind), not N foreign keys.

---

## File map

| File | Purpose | Key exports |
|---|---|---|
| [types.ts](types.ts) | Contract surface — `ResourceKind`, `ResourceAdapter`, `ApplyContext`, `DecryptedResource`, `ResourceSummary`. **No DB / Playwright imports.** | `ResourceKind`, `ResourceAdapter` |
| [test-resource.service.ts](test-resource.service.ts) | Generic CRUD + encryption + lifecycle + defaults. Never imports adapters by concrete type — only via registry. | `createResource`, `updateResource` (with **`mergeValues` mode** for per-key envelope merge), `getResource` (**populates `decryptedKeyNames` for `secret`**), `findByDomain`, `loadDecrypted`, `captureState`, `enrichBindingsWithDefaults`, `setDefaultResource` |
| [adapter-registry.ts](adapter-registry.ts) | `Map<ResourceKind, ResourceAdapter>` + register/get/require. | `registerResourceAdapter`, `requireResourceAdapter` |
| [index.ts](index.ts) | Barrel + `registerBuiltinResourceAdapters()` (sole boot wiring). | `registerBuiltinResourceAdapters` |
| [resource-applier.ts](resource-applier.ts) | Topologically-ordered apply for a list of bindings. Calls `ensureFresh` → adapter `apply()` → snapshot. | `applyBindingsToContext`, `teardownAppliedResources` |
| [resource-supervisor.ts](resource-supervisor.ts) | Mid-run heal trigger — listens for 401/403 + DOM password-input, replays login recipe, captures fresh state. | `checkAndHealIfNeeded`, `NavigationStatusTracker` |
| [resource-mutex.ts](resource-mutex.ts) | In-memory `withResourceMutex(resourceId, fn)` — coordinate concurrent heals on the same resource. | `withResourceMutex` |
| [resource-step-compiler.service.ts](resource-step-compiler.service.ts) | Mobile path only: compile bindings into IntentStep prologue (no Playwright there). | `ResourceStepCompilerService` |
| [runtime/recipe-executor.ts](runtime/recipe-executor.ts) | Wraps `CommandExecutor` to replay an auth recipe inside the live browser context. Used by the heal hook. | `createCommandExecutorRecipeRunner` |
| [runtime/recipe-redaction.ts](runtime/recipe-redaction.ts) | `_secret_*` placeholder regex + redaction helper. **Single source of truth** for the recipe-side secret namespace. | `redactRecipeForResource`, `interpolateRecipeSecrets`, `SECRET_PLACEHOLDER_GLOBAL_RE` |
| [adapters/auth.adapter.ts](adapters/auth.adapter.ts) | Login resource — Playwright `storageState` injection, recipe replay for heal, capture from preview "save login" flow. | `authAdapter` |
| [adapters/environment.adapter.ts](adapters/environment.adapter.ts) | Public configuration map — exposes `env.<KEY>` in `runVariables`. No secrets, no TTL, no teardown. | `environmentAdapter` |
| [adapters/secret.adapter.ts](adapters/secret.adapter.ts) | Encrypted credential map — exposes `secrets.<KEY>` in `runVariables`. **All values live in one `values` envelope key.** | `secretAdapter` |

---

## Hot flow — apply at run start

```
test starts
 → applyBindingsToContext({ userId, projectId, page, context, bindings })
 → topological sort: secret/env/variables → device/network → auth/oauth → fixture/file → scenario_setup
 → for each binding:
     ensureFresh(resourceId)   ← under per-resource mutex
       loadDecrypted → adapter.isFresh? → adapter.heal? (if stale + ui_recipe) → adapter.apply
     push to applied[]         ← snapshot for teardown
     populate runVariables map
 → return { applied, skipped, runVariables, resources }

test executes steps
 → command-executor uses runVariables for {{...}} interpolation
 → secrets are redacted in every log/trace/WS sink (Phase 2.5)

test ends
 → teardownAppliedResources(applied)  ← reverse rank order
```

---

## Adding a new resource kind — checklist

1. **TS union** — add the kind name to `ResourceKind` in [types.ts](types.ts:17-27).
2. **DB CHECK constraint** — add to BOTH `test_resources.kind` AND `workspace_resource_defaults.kind` in a new migration. (Drift between TS and DB is a bug — see types.ts:14-15.)
3. **Adapter** — implement `ResourceAdapter<TConfig, TSensitive>` in `adapters/<kind>.adapter.ts`. Pattern:
   - `validate({ config })` — instant feedback on bad shape; reject reserved-prefix key names.
   - `sensitiveFields()` — STATIC list of `config` keys to encrypt. For "envelope-wrapped" maps (secret-style), return the wrapper key (`['values']`).
   - `apply(ctx, resource)` — write `<prefix>.<KEY>` into `ctx.runVariables`. Idempotent. Read anything you declared in `sensitiveFields()` from **`resource.sensitive`**, not `config` (invariant #9), and **throw** rather than return when there is nothing to apply (invariant #10).
   - `isFresh()` — `() => true` for static config; lifecycle-aware otherwise.
4. **Registration** — add to `registerBuiltinResourceAdapters()` in [index.ts](index.ts).
5. **Topological rank** — add to `rank()` in [resource-applier.ts:118](resource-applier.ts) AND `rank()` in [resource-step-compiler.service.ts:667](resource-step-compiler.service.ts).
6. **Mobile compiler** — add a `case 'mykind':` to `compileByKind` in [resource-step-compiler.service.ts:312](resource-step-compiler.service.ts) OR explicitly skip with a warning.
7. **Defaults** — `enrichBindingsWithDefaults` walks a hardcoded kind list at [test-resource.service.ts:1030-1041](test-resource.service.ts) — add yours.
8. **Preview live-apply** — if the kind should be applicable during live editing (most are), add it to `PREVIEW_APPLY_KINDS` in [websocket/handlers/preview.handler.ts](../../../websocket/handlers/preview.handler.ts).
9. **Frontend type union** — `apps/web/src/services/testResourceService.js` JSDoc `ResourceKind`.
10. **i18n** — `testResources.<kind>.*` namespace in en/ru/kk.

---

## Invariants (must hold)

1. **`runVariables` is the single handoff** between adapters and step-time interpolation. Adapters write `<prefix>.<NAME>` keys; the unified `resolvePlaceholders` reads them. Don't introduce a parallel channel.
2. **Sensitive fields never round-trip back to the UI in plaintext.** `ResourceSummary.sensitiveKeys` carries NAMES only. `getResource` populates `decryptedKeyNames` for `secret` (names of inner keys, no values). Anything else is a leak.
3. **DB persistence stores the ORIGINAL `{{...}}` placeholder, not the resolved value.** `preview-run.service.ts:preserveOriginalStep` rewinds `appliedStep` before writing to `intent_steps`. Otherwise re-runs see a stale literal.
4. **Every emit / log / persist of an interpolated step body must redact `secrets.*` values.** Sinks already wired: command-executor log, replay-trace JSONL (`ReplayTraceWriter.setRedactValues`), editor-trace JSONL (provider in `EditorTraceService.getOrCreate`), `intent-resolve-audit`, `preview:step:apply:result`, `preview:run:step` (×3), `runtimeMeta` in `emitTestStepCompleted`. New sinks need explicit redaction — see `redact-secrets.ts` and `redact-step.ts`.
5. **Reserved key prefixes** (`env.`, `secrets.`, `fixtures.`, `email.`) cannot be used as user-supplied resource key names. Each adapter validates this client-side AND server-side. Don't let a new adapter skip the check.
6. **Adapters never touch DB.** Lifecycle columns (`status`, `captured_at`, `expires_at`, `heal_count`) are written ONLY by `test-resource.service.ts`. Adapters return shapes; the service persists.
7. **`mergeValues: true` only applies to envelope-wrapped value maps** (currently `secret.values`). It's opt-in per request, not a global flag. The default replace-whole-config semantic is preserved.
8. **Snapshot-staleness contract.** `command-executor.setRunVariables` and `replayTrace.setRedactValues` capture the secret-value list ONCE per run. Mid-run resource refresh (heal hook applying a freshened `secret`) does NOT propagate to the cached redaction list. If you add mid-run reapply, refresh both explicitly. Pinned in `redact-snapshot-staleness.test.ts`.
9. **An adapter reads its encrypted payload from `resource.sensitive`, NEVER from `config`.** `loadDecrypted` returns the decrypted envelope under `sensitive` and leaves `config` as the row's plaintext half — it does **not** merge them. Any key listed in `sensitiveFields()` has been moved out of `config` by `splitSensitive` on every write path, so reading `config.<key>` at runtime gets `undefined`. `auth` gets this right (`resource.sensitive.storageState`); `secret` did not, and `apply()` was a silent no-op for months — **`{{secrets.X}}` never resolved on the runtime path**, which also meant `collectSecretValues` returned `[]` and every redactor was a no-op. Unit tests did not catch it because they built the resource with `config:{values}, sensitive:{}` — the same wrong assumption as the code. **Test an adapter against the shape `loadDecrypted` actually returns.**
10. **An adapter's `apply()` fails CLOSED.** `applyBindingsToContext` only escalates a binding to an error when `apply()` **throws**; returning early marks the binding `applied` while nothing was injected. That is precisely how #9 hid. If there is nothing to apply, throw — the applier downgrades a non-required binding to `skipped` on its own.
11. **Auth detector v3 is score-based, not boolean.** Six suppression layers + two-positive-trigger minimum. Hostname-scoped 401 cache. Multistep memory keyed on registrable domain. `__qai_origin_host__` set on every main-frame nav (decoupled from emit). Don't regress to v1's "any signal fires" pattern. See [src/services/testing/ui/preview/auth-detector.ts](../testing/ui/preview/auth-detector.ts).

---

## Tests

`__tests__/` next door:
- `environment.adapter.test.ts` — validate + apply + idempotency (13 cases)
- `secret.adapter.test.ts` — envelope semantics, validation, redaction interaction (15 cases)

Plus cross-cutting tests in [src/utils/interpolation/__tests__/](../../utils/interpolation/__tests__/):
- `resolve-placeholders.test.ts` (15)
- `redact-secrets.test.ts` (15)
- `redact-step.test.ts` (7)
- `redact-snapshot-staleness.test.ts` (2)

And sink-level tests:
- `editor-trace-redact.test.ts` (4)
- `replay-trace-writer-redact.test.ts` (5)
- `intent-resolve-audit-redact.test.ts` (5)

Run a single one:
```bash
npx jest --testPathPattern="secret.adapter" --no-coverage
```

---

## Recent baselines

- **Phase 1 (May 2026)** — Unified `resolvePlaceholders` + `environment` adapter shipped. Three legacy interpolation regex sites collapsed into one helper. `runVariables` plumbed through preview session via `contextRunVariables`.
- **Phase 2 (May 2026)** — `secret` adapter (encrypted-at-rest, exposes `secrets.<KEY>`) + `redactSecrets` helper. Hot-path log redaction in command-executor.
- **Phase 2.5 (May 2026)** — Closed all known leak channels: editor-trace, replay-trace, intent-resolve-audit, `preview:step:apply:result`, `preview:run:step` (×3), `runtimeMeta` in `emitTestStepCompleted`, `finalError`. DB persistence now stores original placeholders. `resetSession` clears `contextRunVariables`. Snapshot-staleness contract pinned by tests.
- **Phase 3 Slice 1+2 (May 2026)** — Settings UI for environments + secrets. Inline picker on Run button (login + env in one dropdown). Backend: `getResource` returns `decryptedKeyNames` for `secret`; `updateResource` supports `mergeValues: true` for partial value-map updates so name/description edits don't wipe secrets. Client-side validation parity (KEY_RE / reserved-prefix / max length).

---

## Common pitfalls

- **`secret.sensitiveKeys` is `['values']`, NOT a list of secret names.** The adapter wraps everything in one envelope key. Use `decryptedKeyNames` (single-resource fetch only) for the inner names.
- **Adding a new field to `ResourceSummary` without populating it in `toSummary()`** = silent no-op. Mirror the field in [test-resource.service.ts:181-205](test-resource.service.ts).
- **Forgetting to add the kind to `enrichBindingsWithDefaults`** means workspace defaults silently won't apply to new tests — they'll just not get the binding. No error, no warning.
- **Skipping `withResourceMutex` on a heal path** lets two concurrent runs replay the login recipe simultaneously, race the captureState, lose half the state.
- **Returning sensitive values from `getResource`.** Plaintext leak via API. Only `decryptedKeyNames` (names) is allowed.
