import type { TargetFingerprint } from './preview.types';
import { isDynamicId } from './dynamic-id.util';

/**
 * Subset of `InteractiveNode` (or any resolved-element descriptor) carrying the
 * attributes the identity fast-path compares. Both the live snapshot collector
 * and the recorder populate these symmetrically, so a comparison here agrees
 * byte-for-byte with `element-resolver`'s identity fast-path.
 */
export interface IdentityBearingNode {
  tag?: string;
  role?: string;
  text?: string;
  id?: string | null;
  testIdAttr?: string | null;
  href?: string | null;
  name?: string | null;
  alt?: string | null;
  svgIcon?: string | null;
  customElementTag?: string | null;
}

/**
 * Does the recorded fingerprint carry a strong-enough identity signal to
 * validate a cache hit against? Mirrors the element-resolver identity
 * fast-path's "usable attribute" set (six stable attributes + the
 * tag+role+text triple). When this is false the caller MUST fail-open — there
 * is no ground truth to compare a cache hit against (e.g. manual-add steps
 * before their first successful run synthesises a fingerprint).
 */
export function recordedFingerprintHasStrongIdentity(fp?: TargetFingerprint): boolean {
  if (!fp) return false;
  if (fp.elementId && !isDynamicId(fp.elementId)) return true;
  if (fp.testIdAttr) return true;
  if (fp.href) return true;
  if (fp.name) return true;
  if (fp.alt) return true;
  if (fp.svgIcon) return true;
  if (fp.customElementTag) return true;
  // tag + role + text triple — the click-class identity channel that powers
  // resolution on CSS-Modules / styled-components pages with no stable attrs.
  if (fp.tag && fp.role && fp.text && fp.text.trim().length >= 2) return true;
  return false;
}

export type IdentityVerdict = 'match' | 'mismatch' | 'no_signal';

const CLICK_CLASS_ACTIONS = new Set(['click', 'hover', 'select']);

/**
 * Compare a resolved element against the ORIGINAL recorded fingerprint, using
 * the same attribute set as `element-resolver`'s identity fast-path. Returns:
 *
 *   'match'     — node positively matches a recorded stable attribute or the
 *                 tag+role+text triple → the cache hit is the recorded element.
 *   'mismatch'  — node CONTRADICTS a recorded stable attribute (different
 *                 non-empty value) or the recorded triple's text → the cache
 *                 resolved a DIFFERENT element than a fresh resolution would.
 *   'no_signal' — fingerprint too weak, or the node carries no comparable
 *                 value → caller should fail-open (accept the cache hit).
 *
 * A missing/empty live value is treated as neutral, never a contradiction: the
 * page may simply have dropped a non-identifying attribute. Only a *different
 * non-empty* value is evidence of the wrong element.
 */
export function compareRecordedIdentity(
  node: IdentityBearingNode,
  fp: TargetFingerprint | undefined,
  actionType: string,
): IdentityVerdict {
  if (!recordedFingerprintHasStrongIdentity(fp)) return 'no_signal';
  const f = fp as TargetFingerprint;

  const checks: Array<{ want?: string; got?: string | null; skipDynamic?: boolean }> = [
    { want: f.elementId, got: node.id, skipDynamic: true },
    { want: f.testIdAttr, got: node.testIdAttr },
    { want: f.href, got: node.href },
    { want: f.svgIcon, got: node.svgIcon },
    { want: f.customElementTag, got: node.customElementTag },
    { want: f.name, got: node.name },
    { want: f.alt, got: node.alt },
  ];

  let sawContradiction = false;
  for (const c of checks) {
    if (!c.want) continue;
    if (c.skipDynamic && isDynamicId(c.want)) continue;
    if (c.got == null || c.got === '') continue; // node lacks it → neutral
    if (c.got === c.want) return 'match'; // strong positive — recorded element
    sawContradiction = true; // different non-empty value → wrong element
  }

  // tag + role + text triple. Only for click-class actions (type uses the
  // placeholder/name channel) and only when the recorder captured all three.
  const recTag = (f.tag || '').toLowerCase();
  const recRole = (f.role || '').toLowerCase();
  const recText = (f.text || '').trim();
  if (
    CLICK_CLASS_ACTIONS.has(actionType)
    && recTag
    && recRole
    && recText.length >= 2
  ) {
    const nTag = (node.tag || '').toLowerCase();
    const nRole = (node.role || '').toLowerCase();
    const nText = (node.text || '').trim();
    if (nTag && nRole && nText) {
      if (nTag === recTag && nRole === recRole && nText === recText) return 'match';
      // Text equality is the discriminating signal; tag/role alone are too
      // weak to call a contradiction (many buttons share tag+role).
      if (nText !== recText) sawContradiction = true;
    }
  }

  return sawContradiction ? 'mismatch' : 'no_signal';
}
