/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Resource Step Compiler — Mobile path (Option A)
 *
 * Web applies resources via Playwright adapters. Mobile has no Playwright
 * and no adapter registry on the runner side, so we take a different path:
 * compile each binding into a sequence of setup IntentSteps that the
 * runner already knows how to execute. The runner doesn't need any change.
 *
 * Compilation rules (one per kind):
 *   - auth          → expand resource.recipe (already IntentStep[]) verbatim
 *   - environment   → one 'store' step per config key
 *   - secret        → one 'store' step per sensitive key (prefixed _secret_…)
 *   - variables     → one 'store' step per config key
 *   - oauth_token   → 'store' step for the token sensitive field
 *   - network       → 'network' step from config preset / latency / bw / loss
 *   - file          → 'upload' step (runner-side path seeded via uploadFilePath)
 *   - device        → 'geolocation' step when lat/lng set, else skipped
 *   - data_fixture  → 'store' per entry under `fixtures.<KEY>` scratchpad
 *                     name; values are plaintext (no encryption for slice 1).
 *   - scenario_setup → NOT expanded here; the bundle's children must be
 *                     bound explicitly (same as web today).
 *
 * Secrets travel as plaintext inside step.value. TLS on the wire + redaction
 * hooks in the runner's scratchpad logger are the defense layers. Storing
 * secrets under a `_secret_`-prefixed key is the signal the runner uses
 * to decide whether to log the value at debug level.
 *
 * Not handled here (intentionally, owned by caller):
 *   - snapshot persistence (mobile-test-run.job.ts writes to test_executions)
 *   - parameter substitution (regression-run.service.ts runs applyParameters
 *     on stitched main steps; compiled resource steps are pre-substituted by
 *     definition — the values ARE the resource, not placeholders)
 *   - stitchPhases interaction (compiled steps are prepended AFTER stitch;
 *     they carry `phase: 'setup'` so reports group them alongside the
 *     case's own setup_steps, if any)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import { v4 as uuidv4 } from 'uuid';
import { loadDecrypted, isFresh } from './test-resource.service';
import type { ResourceBinding } from './test-resource.service';
import type {
  DecryptedResource,
  ResourceKind,
  ResourceStatus,
} from './types';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { expandScenarioSetupRecursively } from './runtime/scenario-setup-expander';

// ═══════════════════════════════════════════════════════════════════════════
// Output types — mirror ApplyResult shape so snapshot writers are uniform
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Non-sensitive snapshot entry. Matches the shape written by the web path
 * into `test_executions.executed_resources` so the downstream reader
 * (UI, analytics) doesn't care which platform produced it.
 */
export interface AppliedBindingSnapshot {
  binding: { kind: ResourceKind; resource_id: string; required: boolean };
  name: string;
  kind: ResourceKind;
  status_at_start: ResourceStatus;
  captured_at: string | null;
  healed_during_run: boolean;
  /** Populated when compilation produced zero useful steps but no error. */
  apply_error?: string;
}

export interface SkippedBindingSnapshot {
  binding: { kind: string; resource_id: string; required: boolean };
  reason: string;
}

export interface CompileResult {
  /**
   * Runner-shape IntentSteps to prepend before the case's own setup.
   * Each step carries `phase: 'setup'` and `isAutoInjected: true` so the
   * report layer renders them separately from user-authored steps.
   */
  steps: CompiledResourceStep[];
  /** Bindings whose resource was applied — for snapshot writeback. */
  applied: AppliedBindingSnapshot[];
  /** Bindings that were soft-skipped (not required). */
  skipped: SkippedBindingSnapshot[];
}

/**
 * Runner-shape step. We deliberately produce the MOBILE-side shape (not the
 * web IntentStep) because compiled resource steps may use mobile-only action
 * types (`network`, `geolocation`, `upload`) that don't exist in the web
 * IntentActionType union. Caller prepends these directly onto
 * `MobileTestJobData.intentSteps` — no cast / normalisation needed.
 */
export interface CompiledResourceStep {
  id: string;
  type: string; // MobileIntentActionType — kept wide to avoid a second cast boundary
  description: string;
  value?: string;
  isAutoInjected: true;
  phase: 'setup';
  options?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Key prefixes — must stay in sync with the runner's redaction policy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Secrets get this prefix so runner log code can match `startsWith` and
 * redact. Not cryptographic — a signal, not a mechanism.
 */
const SECRET_KEY_PREFIX = '_secret_';

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export class ResourceStepCompilerService {
  /**
   * Compile bindings into mobile setup steps.
   *
   * Behaviour mirrors `applyBindingsToContext` where it matters:
   *   - Topological order: secret / env / variables first, then device /
   *     network, then auth / oauth_token, then file. Matches the web order.
   *   - `required: true` + resource missing / broken / platform mismatch
   *     → throws. Dispatch is aborted by caller (the test must NOT run
   *     without its required login).
   *   - `required: false` → added to `skipped`, compilation continues.
   *   - Platform mismatch (e.g. scope.platform='web' on a mobile run)
   *     is a soft skip even for `required: true` bindings whose required
   *     semantics are "apply on web". We log loudly and fail-fast only
   *     for clearly-compatible-but-broken resources.
   */
  static async compileForMobile(params: {
    bindings: ResourceBinding[];
    userId: string;
    projectId: string;
    platform: MobilePlatform;
  }): Promise<CompileResult> {
    const { bindings, userId, platform } = params;
    const applied: AppliedBindingSnapshot[] = [];
    const skipped: SkippedBindingSnapshot[] = [];
    const steps: CompiledResourceStep[] = [];

    if (!bindings || bindings.length === 0) {
      return { steps, applied, skipped };
    }

    // Same topological order the web applier uses, so behaviour is
    // comparable when a customer migrates a web test to mobile.
    const ordered = [...bindings].sort((a, b) => rank(a.kind) - rank(b.kind));

    for (const binding of ordered) {
      const required = binding.required === true;

      // Load + decrypt. `loadDecrypted` returns a flat plaintext view —
      // the same shape the web adapter receives. We deliberately don't
      // go through `ensureFresh` / heal on the mobile path: heal for
      // mobile auth would need a recipe replay on the device which is
      // supervisor work we haven't built yet. For now, a stale resource
      // fails the same way a web heal without `healHook` would fail.
      const resource = await loadDecrypted(binding.resource_id, userId).catch(
        (err) => {
          logger.warn(
            '[RESOURCE_STEP_COMPILER] loadDecrypted threw — treating as missing',
            { resourceId: binding.resource_id, error: errMsg(err) },
          );
          return null;
        },
      );

      if (!resource) {
        const reason = 'resource not found';
        if (required) {
          throw new Error(
            `Required ${binding.kind} binding ${binding.resource_id} not found`,
          );
        }
        skipped.push({ binding: normaliseBinding(binding, required), reason });
        continue;
      }

      if (resource.status === 'broken') {
        const reason = `resource marked broken: ${resource.name}`;
        if (required) throw new Error(reason);
        skipped.push({ binding: normaliseBinding(binding, required), reason });
        continue;
      }

      // Staleness: TTL past or adapter says not fresh, but status still
      // 'active' (e.g. nothing has run isFresh on this row yet). On web
      // we would heal via the supervisor; mobile has no heal path today
      // (see module header). We make the stale state VISIBLE:
      //
      //   - `required: true`  → abort. A stale login running "as if
      //                          fresh" would burn emulator time
      //                          producing a misleading error.
      //   - `required: false` → loud warn + continue. We annotate the
      //                          applied snapshot with `stale_at_start`
      //                          so the report shows it.
      const fresh = isFresh(resource);
      let staleAtStart = false;
      if (!fresh) {
        const reason =
          `resource "${resource.name}" is stale (refreshMethod=${resource.refreshMethod}) ` +
          `and mobile has no heal path — re-record or set refresh_method='manual'`;
        if (required) {
          throw new Error(reason);
        }
        logger.warn('[RESOURCE_STEP_COMPILER] Applying stale resource (non-required)', {
          resourceId: resource.id,
          name: resource.name,
          kind: resource.kind,
          refreshMethod: resource.refreshMethod,
          expiresAt: resource.expiresAt?.toISOString(),
        });
        staleAtStart = true;
      }

      // Platform-compatibility gate. An auth resource captured on web
      // (cookies + localStorage) means nothing on a native mobile app,
      // and blindly running its recipe on the device would produce
      // garbage. We require an explicit 'android' / 'ios' scope, OR no
      // platform set at all (legacy / cross-platform resources).
      const scopePlatform = resource.scope?.platform;
      if (scopePlatform && !isPlatformCompatible(scopePlatform, platform)) {
        const reason =
          `scope.platform=${scopePlatform} is not compatible with run platform=${platform}`;
        // Even `required: true` is a soft skip here — the binding is a
        // configuration error the user can fix; killing the run helps
        // nobody. Logging is loud enough for the operator to notice.
        logger.warn('[RESOURCE_STEP_COMPILER] Platform mismatch — skipping', {
          resourceId: resource.id,
          kind: resource.kind,
          scopePlatform,
          runPlatform: platform,
          required,
        });
        skipped.push({ binding: normaliseBinding(binding, required), reason });
        continue;
      }

      // Compile. Each helper returns 0..N steps; empty means "nothing
      // to do for this kind/payload" (legitimate — e.g. an env resource
      // with no config keys). We still snapshot the binding so the
      // report shows it was considered.
      let compiledSteps: CompiledResourceStep[] = [];
      let compileErr: string | undefined;
      try {
        // scenario_setup needs async pre-expansion (nested `use_setup`
        // references walk the DB). We mutate a SHALLOW COPY of the
        // resource so the downstream sync `compileByKind` sees a flat
        // `config.steps` array. The original DB row is untouched —
        // mutating the loadDecrypted result would silently propagate
        // resolved steps into the adapter's apply() call too.
        let resourceForCompile = resource;
        if (resource.kind === 'scenario_setup') {
          const flatSteps = await expandScenarioSetupRecursively(
            resource,
            userId,
            new Set<string>(),
            0,
          );
          resourceForCompile = {
            ...resource,
            config: { ...resource.config, steps: flatSteps },
          };
        }
        compiledSteps = compileByKind(resourceForCompile);
      } catch (err) {
        compileErr = errMsg(err);
        logger.error('[RESOURCE_STEP_COMPILER] Compile failed', {
          resourceId: resource.id,
          kind: resource.kind,
          error: compileErr,
        });
        if (required) {
          throw new Error(
            `Required ${resource.kind} "${resource.name}" failed to compile: ${compileErr}`,
          );
        }
      }

      steps.push(...compiledSteps);
      applied.push({
        binding: {
          kind: resource.kind,
          resource_id: resource.id,
          required,
        },
        name: resource.name,
        kind: resource.kind,
        // If staleness was detected, surface it in status_at_start so
        // the report can show a stale-but-applied indicator even if the
        // DB row still says 'active'. Status is the higher-signal field
        // in the UI today — keep it truthful to what the run saw.
        status_at_start: staleAtStart ? 'stale' : resource.status,
        // Mirror the web applier's fudge: we don't store captured_at
        // separately, so we reconstruct from expires_at - ttl.
        captured_at: resource.expiresAt
          ? new Date(
              resource.expiresAt.getTime() -
                (resource.ttlSeconds ?? 0) * 1000,
            ).toISOString()
          : null,
        healed_during_run: false,
        apply_error: compileErr,
      });
    }

    logger.info('[RESOURCE_STEP_COMPILER] Compiled', {
      bindings: bindings.length,
      steps: steps.length,
      applied: applied.length,
      skipped: skipped.length,
    });

    return { steps, applied, skipped };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internals — per-kind compilation
// ═══════════════════════════════════════════════════════════════════════════

function compileByKind(
  resource: DecryptedResource,
): CompiledResourceStep[] {
  switch (resource.kind) {
    case 'auth':
      return compileAuth(resource);
    case 'environment':
      return compileKeyValue(resource, { sensitive: false, prefix: '' });
    case 'secret':
      return compileKeyValue(resource, {
        sensitive: true,
        prefix: SECRET_KEY_PREFIX,
      });
    case 'variables':
      return compileKeyValue(resource, { sensitive: false, prefix: '' });
    case 'oauth_token':
      return compileOAuthToken(resource);
    case 'network':
      return compileNetwork(resource);
    case 'file':
      return compileFile(resource);
    case 'device':
      return compileDevice(resource);
    case 'data_fixture':
      // Plaintext data map — emit one `store` per entry under a
      // `fixtures.<KEY>` scratchpad name so steps written as
      // `${fixtures.EMAIL}` resolve at dispatch time. See
      // compileDataFixture for the unwrap (`config.data` envelope).
      return compileDataFixture(resource);
    case 'scenario_setup':
      // Reusable IntentStep prologue. `compileScenarioSetup` is called
      // BEFORE this switch by `compileForMobile` so nested `use_setup`
      // references are already expanded and persisted on the resource
      // copy we receive here. By the time we land in this branch the
      // resource.config.steps is a flat array of plain steps ready to
      // render. See `expandScenarioSetupRecursively` for the unwrap.
      return compileScenarioSetup(resource);
    default:
      // Future kinds: fail loud so we notice when schema adds something
      // we haven't mapped.
      throw new Error(`Unsupported resource kind on mobile: ${resource.kind}`);
  }
}

/**
 * Auth: seed credentials into the scratchpad, then replay the stored
 * recipe. The recipe is an IntentStep[] authored once and reused across
 * many runs — placeholders like `${user_email}` / `${user_password}` /
 * `${totp_secret}` reference scratchpad keys that DO NOT exist until we
 * create them. Without this seed the recipe's `type ${user_email}` step
 * would literally type the text `${user_email}` (or fail locator-side
 * if the step is structured differently).
 *
 * Therefore we emit, in order:
 *   1. `store` steps for every NON-sensitive config key (e.g. `username`,
 *      `account_alias`) under their plain key names.
 *   2. `store` steps for every sensitive field (password, totp secret,
 *      etc.), prefixed with `_secret_` so the runner's logger can
 *      redact them once log-scrubbing lands. Keys are duplicated under
 *      BOTH `${key}` AND `${_secret_key}` — recipes authored before
 *      this patch use the bare `${password}` form; new recipes can
 *      opt into `${_secret_password}` if authors want the prefix to
 *      signal "don't log".
 *   3. Recipe steps verbatim, tagged as auto-injected setup.
 *
 * If the resource has no recipe (e.g. a web-style storageState-only
 * profile was bound to a mobile case), only the store steps are emitted
 * and a warning is logged — storing cookies on a native device is a
 * no-op but the seeded env vars still help subsequent manual auth.
 */
function compileAuth(resource: DecryptedResource): CompiledResourceStep[] {
  const steps: CompiledResourceStep[] = [];

  // (1) Non-sensitive config → bare scratchpad keys.
  const config = (resource.config ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(config)) {
    const str = serialiseForStore(value);
    if (str === null) continue;
    steps.push(makeStoreStep(key, str, `auth:${resource.name}:config:${key}`));
  }

  // (2) Sensitive fields → BOTH bare `${key}` AND `${_secret_key}`.
  // The dual emit is deliberate: we can't retroactively rewrite every
  // existing recipe to use the new prefix form. The bare key stays for
  // compatibility; the prefixed form is there so redaction-aware
  // recipes (and log scrubbers) can match on `_secret_*`.
  const sensitive = (resource.sensitive ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(sensitive)) {
    const str = serialiseForStore(value);
    if (str === null) continue;
    steps.push(makeStoreStep(key, str, `auth:${resource.name}:secret:${key}`));
    steps.push(
      makeStoreStep(
        `${SECRET_KEY_PREFIX}${key}`,
        str,
        `auth:${resource.name}:secret-alias:${key}`,
      ),
    );
  }

  // (3) Recipe.
  const recipe = Array.isArray(resource.recipe) ? resource.recipe : [];
  if (recipe.length === 0) {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] auth resource has empty recipe — only credential store steps emitted',
      {
        resourceId: resource.id,
        name: resource.name,
        storeStepsEmitted: steps.length,
      },
    );
    return steps;
  }

  recipe.forEach((raw, index) => {
    steps.push(normaliseRecipeStep(raw, resource, index));
  });
  return steps;
}

/**
 * Normalise a recipe entry into a mobile runner step. Recipes were
 * authored via the same editor that writes main steps, so the shape is
 * almost right already — we just force `phase: 'setup'`, set a stable
 * fresh id (recipes may be shared across runs — original ids can't),
 * and drop web-only fields that the mobile runner doesn't understand.
 */
function normaliseRecipeStep(
  raw: unknown,
  resource: DecryptedResource,
  index: number,
): CompiledResourceStep {
  const step = (raw ?? {}) as Record<string, unknown>;
  const type = String(step.type ?? 'click');
  const description = String(
    step.description ?? `auth:${resource.name}:${index}`,
  );

  const compiled: CompiledResourceStep = {
    id: uuidv4(),
    type,
    description,
    isAutoInjected: true,
    phase: 'setup',
  };

  if (typeof step.value === 'string') compiled.value = step.value;

  if (step.options && typeof step.options === 'object') {
    compiled.options = { ...(step.options as Record<string, unknown>) };
  }

  return compiled;
}

/**
 * Emit one 'store' meta-step per config key. Runner's scratchpad picks
 * them up and resolves `${KEY}` placeholders in subsequent steps.
 *
 * `store` semantics (runner: scratchpad.set(description, value)):
 *   - step.description → scratchpad key
 *   - step.value       → string value
 *
 * Non-string values are JSON.stringify'd so typed config (numbers, URLs,
 * booleans) survives. Users write `${BASE_URL}` / `${FEATURE_X}` in
 * their main step values; runner resolves at dispatch time.
 */
function compileKeyValue(
  resource: DecryptedResource,
  opts: { sensitive: boolean; prefix: string },
): CompiledResourceStep[] {
  const payload = opts.sensitive ? resource.sensitive : resource.config;

  if (!payload || typeof payload !== 'object') return [];

  const steps: CompiledResourceStep[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const str = serialiseForStore(value);
    if (str === null) continue;
    const scratchpadKey = `${opts.prefix}${key}`;
    steps.push(
      makeStoreStep(scratchpadKey, str, `${resource.kind}:${resource.name}:${key}`),
    );
  }
  return steps;
}

/**
 * Data fixture: plaintext key/value map under `config.data`. Emit one
 * `store` per entry under a `fixtures.<KEY>` scratchpad name so steps
 * referencing `${fixtures.EMAIL}` resolve at dispatch time.
 *
 * The wrapper unwrap (`config.data`) is the difference from
 * `compileKeyValue` — fixture, environment, and secret all have a
 * single envelope key in their `config`/`sensitive` payload, but only
 * fixture is compiled correctly here today. Mobile env/secret support
 * is tracked separately.
 */
function compileDataFixture(resource: DecryptedResource): CompiledResourceStep[] {
  const config = (resource.config ?? {}) as Record<string, unknown>;
  const data = config.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] data_fixture has no usable config.data — emitting nothing',
      { resourceId: resource.id, name: resource.name },
    );
    return [];
  }

  const steps: CompiledResourceStep[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const str = serialiseForStore(value);
    if (str === null) continue;
    steps.push(
      makeStoreStep(`fixtures.${key}`, str, `data_fixture:${resource.name}:${key}`),
    );
  }
  return steps;
}

/**
 * Scenario setup: pre-recorded sequence of IntentSteps that puts the app
 * into a known state before the test body runs. The resource arrives here
 * with `use_setup` references ALREADY expanded by
 * `expandScenarioSetupRecursively` (async pre-pass) — this function
 * therefore only emits the steps verbatim, tagging them as setup-phase.
 *
 * We deliberately mirror `normaliseRecipeStep` so a single normalisation
 * contract governs every IntentStep injected into the runner.
 */
function compileScenarioSetup(
  resource: DecryptedResource,
): CompiledResourceStep[] {
  const config = (resource.config ?? {}) as Record<string, unknown>;
  const rawSteps = config.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] scenario_setup has no steps after expansion — emitting nothing',
      { resourceId: resource.id, name: resource.name },
    );
    return [];
  }

  return rawSteps.map((raw, index) =>
    normaliseRecipeStep(raw, resource, index),
  );
}

/**
 * OAuth token is a single sensitive field — emit one store step under a
 * predictable key so test authors can reference `${oauth_<resourceName>}`
 * or a user-chosen alias in config.tokenAlias.
 *
 * Preferred shape:
 *   sensitive: { access_token: "..." [, refresh_token: "..."] }
 *   config:    { tokenAlias?: "my_gh_token" }
 */
function compileOAuthToken(
  resource: DecryptedResource,
): CompiledResourceStep[] {
  const sensitive = (resource.sensitive ?? {}) as Record<string, unknown>;
  const config = (resource.config ?? {}) as Record<string, unknown>;
  const token = sensitive.access_token ?? sensitive.token;
  if (!token || typeof token !== 'string') {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] oauth_token resource has no access_token string — skipping',
      { resourceId: resource.id },
    );
    return [];
  }
  const alias =
    typeof config.tokenAlias === 'string' && config.tokenAlias.trim().length > 0
      ? config.tokenAlias.trim()
      : `oauth_${slug(resource.name)}`;
  return [
    {
      id: uuidv4(),
      type: 'store',
      description: `${SECRET_KEY_PREFIX}${alias}`,
      value: token,
      isAutoInjected: true,
      phase: 'setup',
    },
  ];
}

/**
 * Network: translate to the runner's `network` action. Config can specify
 * a named preset (2g/3g/4g/5g/wifi/offline) or arbitrary latency / bandwidth
 * / packet loss. Runner handles both via IntentStepOptions.networkPreset /
 * networkLatencyMs / networkBandwidthKbps / networkPacketLossPercent.
 */
function compileNetwork(
  resource: DecryptedResource,
): CompiledResourceStep[] {
  const config = (resource.config ?? {}) as Record<string, unknown>;
  const preset = config.preset;
  const latency = config.latencyMs;
  const bandwidth = config.bandwidthKbps;
  const packetLoss = config.packetLossPercent;

  const options: Record<string, unknown> = {};
  if (
    typeof preset === 'string' &&
    ['2g', '3g', '4g', '5g', 'wifi', 'offline'].includes(preset)
  ) {
    options.networkPreset = preset;
  }
  if (typeof latency === 'number' && latency >= 0) {
    options.networkLatencyMs = latency;
  }
  if (typeof bandwidth === 'number' && bandwidth > 0) {
    options.networkBandwidthKbps = bandwidth;
  }
  if (
    typeof packetLoss === 'number' &&
    packetLoss >= 0 &&
    packetLoss <= 100
  ) {
    options.networkPacketLossPercent = packetLoss;
  }

  if (Object.keys(options).length === 0) {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] network resource has no usable config — skipping',
      { resourceId: resource.id },
    );
    return [];
  }

  return [
    {
      id: uuidv4(),
      type: 'network',
      description: `apply network profile: ${resource.name}`,
      isAutoInjected: true,
      phase: 'setup',
      options,
    },
  ];
}

/**
 * File: translate to an upload step. Runner's `upload` action takes an
 * on-device path (pushed separately via POST /upload/file). We assume the
 * file has been pre-staged to the runner's filesystem at a path recorded
 * in config.runnerPath — the upload flow is a caller responsibility.
 *
 * For now we skip when no runnerPath is set. A future improvement could
 * POST to the runner's /upload endpoint here and record the returned path,
 * but that needs a runner client handle we don't have in this service.
 */
function compileFile(resource: DecryptedResource): CompiledResourceStep[] {
  const config = (resource.config ?? {}) as Record<string, unknown>;
  const runnerPath = config.runnerPath;
  if (typeof runnerPath !== 'string' || runnerPath.trim().length === 0) {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] file resource has no runnerPath — skipping',
      { resourceId: resource.id },
    );
    return [];
  }
  return [
    {
      id: uuidv4(),
      type: 'upload',
      description: `stage file: ${resource.name}`,
      isAutoInjected: true,
      phase: 'setup',
      options: { uploadFilePath: runnerPath },
    },
  ];
}

/**
 * Device on mobile is limited: viewport / userAgent are irrelevant on a
 * real device, and orientation / locale need dedicated primitives we
 * haven't all wired up. Geolocation works today via the runner's
 * `geolocation` action — compile that when coords are present, skip
 * otherwise.
 */
function compileDevice(resource: DecryptedResource): CompiledResourceStep[] {
  const config = (resource.config ?? {}) as Record<string, unknown>;
  const lat = config.latitude;
  const lng = config.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    logger.warn(
      '[RESOURCE_STEP_COMPILER] device resource lacks latitude/longitude — skipping (other device fields not supported on mobile)',
      { resourceId: resource.id },
    );
    return [];
  }
  const options: Record<string, unknown> = {
    geolocationAction: 'set',
    geolocationLatitude: lat,
    geolocationLongitude: lng,
  };
  if (typeof config.altitude === 'number') {
    options.geolocationAltitude = config.altitude;
  }
  return [
    {
      id: uuidv4(),
      type: 'geolocation',
      description: `set mock location: ${resource.name}`,
      isAutoInjected: true,
      phase: 'setup',
      options,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function rank(kind: string): number {
  if (kind === 'secret' || kind === 'environment' || kind === 'variables') {
    return 0;
  }
  if (kind === 'device' || kind === 'network') return 1;
  if (kind === 'auth' || kind === 'oauth_token') return 2;
  if (kind === 'data_fixture' || kind === 'file') return 3;
  if (kind === 'scenario_setup') return 4;
  return 5;
}

/**
 * A resource whose scope says 'android' is compatible with 'android' and
 * 'flutter' (the runner maps Flutter onto Android today). An 'ios' scope
 * is compatible only with 'ios'. Resources with no scope.platform are
 * treated as platform-agnostic — the caller is responsible for curating.
 */
function isPlatformCompatible(
  scopePlatform: string,
  runPlatform: MobilePlatform,
): boolean {
  if (scopePlatform === 'android') {
    return runPlatform === 'android' || runPlatform === 'flutter';
  }
  if (scopePlatform === 'ios') return runPlatform === 'ios';
  // 'web' or anything else — not a mobile-friendly scope.
  return false;
}

function normaliseBinding(
  b: ResourceBinding,
  required: boolean,
): { kind: string; resource_id: string; required: boolean } {
  return { kind: b.kind, resource_id: b.resource_id, required };
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'resource';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn an arbitrary config/sensitive value into a scratchpad-friendly
 * string. Returns `null` for values we DELIBERATELY don't want to
 * store (null / undefined / empty string). Other primitives pass
 * through as-is; objects + arrays are JSON-encoded.
 *
 * Idempotency note: `loadDecrypted` tries JSON.parse on decrypted
 * envelope fields and hands us objects when the envelope held JSON.
 * Re-serialising those via `JSON.stringify` round-trips cleanly —
 * plain strings (email, token) stay as strings untouched.
 */
function serialiseForStore(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  try {
    const str = JSON.stringify(value);
    // `JSON.stringify(undefined)` → undefined; also guard empty object
    // which would silently store `{}` — not useful in a scratchpad.
    if (!str || str === '{}' || str === '[]') return null;
    return str;
  } catch {
    return null;
  }
}

/**
 * Build a `store` meta-step. Description is used by the runner as the
 * scratchpad KEY (see qait-mobile-runner/src/api/routes/run.routes.ts:191).
 * A separate `source` label is embedded via a sentinel options field so
 * future debug tooling can trace a scratchpad value back to the resource
 * that produced it WITHOUT parsing free-form description strings.
 */
function makeStoreStep(
  key: string,
  value: string,
  source: string,
): CompiledResourceStep {
  return {
    id: uuidv4(),
    type: 'store',
    // Runner uses `description` as the scratchpad key — keep it to JUST
    // the key, nothing else.
    description: key,
    value,
    isAutoInjected: true,
    phase: 'setup',
    options: {
      // Ignored by the runner today (it only consumes known option keys),
      // but persisted in the report timeline so operators can see
      // "this scratchpad value came from auth:Admin Login". Keep it
      // under a `resourceSource` key so nobody accidentally matches on
      // the runner's step option union.
      resourceSource: source,
    },
  };
}
