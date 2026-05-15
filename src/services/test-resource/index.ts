/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Test Resource module — public entry
 *
 * `registerBuiltinResourceAdapters()` must be called exactly once at app
 * boot (see src/index.ts) to wire every shipped adapter into the registry.
 * Delaying to boot (instead of top-level side-effect imports) keeps unit
 * tests that need a fresh registry easy to write.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { registerResourceAdapter } from './adapter-registry';
import { authAdapter } from './adapters/auth.adapter';
import { environmentAdapter } from './adapters/environment.adapter';
import { secretAdapter } from './adapters/secret.adapter';
import { dataFixtureAdapter } from './adapters/data_fixture.adapter';
import { scenarioSetupAdapter } from './adapters/scenario_setup.adapter';

export { registerResourceAdapter, getResourceAdapter, requireResourceAdapter, listRegisteredKinds } from './adapter-registry';
export * as TestResourceService from './test-resource.service';
export * from './types';
export { applyBindingsToContext, teardownAppliedResources } from './resource-applier';
export type { BindingInput, AppliedBinding, ApplyResult } from './resource-applier';
export { ResourceStepCompilerService } from './resource-step-compiler.service';
export type {
  CompileResult,
  CompiledResourceStep,
  AppliedBindingSnapshot,
  SkippedBindingSnapshot,
} from './resource-step-compiler.service';
export {
  checkAndHealIfNeeded,
  looksLikeAuthLoss,
  NavigationStatusTracker,
} from './resource-supervisor';
export type { RecipeExecutor, SupervisorConfig } from './resource-supervisor';
export { withResourceMutex } from './resource-mutex';

export function registerBuiltinResourceAdapters(): void {
  registerResourceAdapter(authAdapter);
  registerResourceAdapter(environmentAdapter);
  registerResourceAdapter(secretAdapter);
  registerResourceAdapter(dataFixtureAdapter);
  registerResourceAdapter(scenarioSetupAdapter);
  // Future kinds (device, network, oauth_token, ...) register here as their
  // adapters ship.
}
