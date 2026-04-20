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
  // Future kinds (environment, secret, device, ...) register here as
  // their adapters ship.
}
