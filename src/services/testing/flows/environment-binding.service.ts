/**
 * Resolve the explicit environment binding for a newly created web test.
 *
 * The Create-test dialog (web) makes the user pick a saved environment
 * (Settings → Environments). We bind that environment resource to the initial
 * test case so its `env.<KEY>` variables resolve on every run — not just its
 * BASE_URL. This lives in a service (not the controller) so the ownership +
 * kind + project checks are unit-testable and the route stays thin.
 *
 * Scoping mirrors the dialog: the dropdown lists the user's own environments
 * (list is user + project scoped), so a user-scoped `getResource` resolves
 * exactly what was offered. A resource that is missing, of the wrong kind, or
 * belongs to another project is rejected so the caller can 400 rather than
 * silently drop the user's choice.
 */
import { getResource, type ResourceBinding } from '@/services/test-resource/test-resource.service';

export type EnvironmentBindingResult =
  | { ok: true; binding: ResourceBinding }
  | { ok: false; reason: 'not_found' | 'wrong_kind' | 'wrong_project' };

export async function resolveEnvironmentBinding(params: {
  userId: string;
  projectId: string;
  environmentResourceId: string;
}): Promise<EnvironmentBindingResult> {
  const env = await getResource(params.environmentResourceId, params.userId);
  if (!env) return { ok: false, reason: 'not_found' };
  if (env.kind !== 'environment') return { ok: false, reason: 'wrong_kind' };
  if (env.projectId !== params.projectId) return { ok: false, reason: 'wrong_project' };
  return { ok: true, binding: { kind: 'environment', resource_id: params.environmentResourceId } };
}
