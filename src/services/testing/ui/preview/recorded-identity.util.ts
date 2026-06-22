import type { TargetFingerprint } from './preview.types';
import { isDynamicId } from './dynamic-id.util';
import { hasStrongIdentityContradiction, type IdentityProbe } from './step-readiness-v2.service';

// Re-export the shared comparator so cache-hit guards have a single import
// surface. The comparison logic itself (strongFields + fieldEq + normUrlLike)
// lives in step-readiness-v2 and is the SAME primitive the readiness gate uses.
export { hasStrongIdentityContradiction };

/** Strong fingerprint identifiers mirrored from `V2.identity.strongFields`
 *  (minus `elementId`, which needs the dynamic-id filter below). */
const STRONG_FP_FIELDS = ['testIdAttr', 'name', 'href', 'svgIcon', 'routerLink'] as const;

/**
 * Cheap pre-gate: does the recorded fingerprint carry any STRONG identifier
 * worth validating a cache hit against? Lets the compiled path skip the live
 * DOM probe entirely when there is nothing strong to contradict (most of the
 * cost). Dynamic element ids never count.
 */
export function recordedFingerprintHasStrongIdentity(fp?: TargetFingerprint): boolean {
  if (!fp) return false;
  if (fp.elementId && !isDynamicId(fp.elementId)) return true;
  return STRONG_FP_FIELDS.some((f) => {
    const v = (fp as Record<string, unknown>)[f];
    return typeof v === 'string' && v.length > 0;
  });
}

/** Minimal shape of a resolved element we can read identity from (subset of
 *  `InteractiveNode`). */
export interface ResolvedIdentityNode {
  id?: string | null;
  testIdAttr?: string | null;
  name?: string | null;
  href?: string | null;
  svgIcon?: string | null;
  routerLink?: string | null;
  ariaLabel?: string | null;
  labelText?: string | null;
  placeholder?: string | null;
  text?: string | null;
  role?: string | null;
  tag?: string | null;
}

const orUndef = (v: string | null | undefined): string | undefined =>
  v === null || v === '' ? undefined : v;

/**
 * Map a resolved `InteractiveNode` (an evidence-shortcut cache hit) to the
 * canonical `IdentityProbe` so it flows through the EXACT same comparator as
 * the compiled path's live `probeIdentity()`. Dynamic live ids are dropped to
 * stay symmetric with `probeIdentity` (which filters them too).
 */
export function nodeToIdentityProbe(node: ResolvedIdentityNode): IdentityProbe {
  const id = typeof node.id === 'string' && node.id && !isDynamicId(node.id) ? node.id : undefined;
  return {
    elementId: id,
    testIdAttr: orUndef(node.testIdAttr),
    name: orUndef(node.name),
    href: orUndef(node.href),
    svgIcon: orUndef(node.svgIcon),
    routerLink: orUndef(node.routerLink),
    ariaLabel: orUndef(node.ariaLabel),
    labelText: orUndef(node.labelText),
    placeholder: orUndef(node.placeholder),
    text: orUndef(node.text),
    role: orUndef(node.role),
    tag: orUndef(node.tag),
  };
}
