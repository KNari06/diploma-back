/**
 * #4 — Selector robustness score (authoring-time advisory).
 *
 * Pure, synchronous heuristic over the recorded fingerprint: "does this element
 * have durable anchors, or will it be fragile to replay?" Distinct from the
 * resolver's live `lint` verdict (which says whether it resolved THIS time) —
 * this is a static signal the picker can surface immediately so the author can
 * disambiguate before investing in a test.
 *
 * Advisory ONLY: never changes element resolution; the function itself is
 * side-effect-free.
 */

import type { TargetFingerprint } from './preview.types';

export type RobustnessLevel = 'strong' | 'medium' | 'weak';

/** A single named risk that lowers replay robustness. */
export type RobustnessRisk =
  | 'cross_origin'      // inside a cross-origin iframe — unreachable by DOM selectors
  | 'image_target'      // an <img> / image — no DOM identity for content inside it
  | 'icon_only'         // icon with no text/label — relies on derived icon hints
  | 'text_only'         // only visible text — drifts on i18n / SSR↔CSR
  | 'no_durable_anchor'; // nothing structural captured

export interface SelectorRobustness {
  level: RobustnessLevel;
  /** 0..1, monotonic with `level`. */
  score: number;
  risks: RobustnessRisk[];
  /** Short human-readable hint for the UI (≤120 chars). */
  hint: string;
}

/** Extra probe-derived signals not carried on TargetFingerprint. */
export interface RobustnessProbeContext {
  crossOriginIframe?: boolean;
}

function hasStrongIdentity(fp: TargetFingerprint): boolean {
  // `elementId` is already dynamic-id-filtered at probe time (see the type
  // docs), so its presence means a stable id. The rest are developer-authored.
  return Boolean(
    fp.elementId
    || fp.testIdAttr
    || (fp.name && !fp.name.startsWith('_'))
    || fp.href
    || (fp as { formControlName?: string }).formControlName
    || (fp as { routerLink?: string }).routerLink
    || fp.svgIcon,
  );
}

function hasSemanticName(fp: TargetFingerprint): boolean {
  return Boolean(fp.role && (fp.labelText || fp.ariaLabel || fp.title || fp.text));
}

function hasWeakAnchor(fp: TargetFingerprint): boolean {
  return Boolean(
    fp.labelText || fp.ariaLabel || fp.placeholder || fp.alt || fp.title || fp.text,
  );
}

/**
 * Score a picked element's replay robustness from its recorded fingerprint.
 *
 * - strong (0.9): a stable id / testId / name / href / formControlName /
 *   routerLink / svgIcon, OR role + accessible name.
 * - medium (0.6): some accessible anchor (label / placeholder / alt / title /
 *   text) but no strong identity.
 * - weak (0.3 and below): cross-origin, image-baked, icon-only, text-only, or
 *   no durable anchor at all.
 */
export function computeSelectorRobustness(
  fp: TargetFingerprint,
  ctx: RobustnessProbeContext = {},
): SelectorRobustness {
  const risks: RobustnessRisk[] = [];

  if (ctx.crossOriginIframe) risks.push('cross_origin');

  const isImage = fp.tag === 'img' || (Boolean(fp.alt) && !fp.role);
  if (isImage) risks.push('image_target');

  const hasText = Boolean(fp.text || fp.labelText || fp.ariaLabel);
  const hasIconHint = Boolean(fp.svgIcon || fp.childTestId || fp.iconLabel);
  if (!hasText && hasIconHint) risks.push('icon_only');

  const strong = hasStrongIdentity(fp);
  const semantic = hasSemanticName(fp);
  const weakAnchor = hasWeakAnchor(fp);

  if (!strong && !semantic && Boolean(fp.text) && !fp.testIdAttr && !fp.role) {
    risks.push('text_only');
  }
  if (!strong && !semantic && !weakAnchor) {
    risks.push('no_durable_anchor');
  }

  // Cross-origin is the hard ceiling: the element cannot be reached by any DOM
  // selector regardless of how rich its fingerprint looks.
  if (ctx.crossOriginIframe) {
    return {
      level: 'weak',
      score: 0.15,
      risks,
      hint: 'Inside a cross-origin frame — not reachable by selectors; replay relies on coordinates.',
    };
  }

  let level: RobustnessLevel;
  let score: number;
  let hint: string;

  if (strong) {
    level = 'strong';
    score = 0.9;
    hint = 'Stable identity captured (id / testId / name / role+name).';
  } else if (semantic) {
    level = 'strong';
    score = 0.82;
    hint = 'Role + accessible name captured — durable across restyles.';
  } else if (weakAnchor) {
    level = 'medium';
    score = 0.6;
    hint = risks.includes('icon_only')
      ? 'Icon-only target — relies on derived icon hints; consider a testid.'
      : 'Only text/label captured — may drift on i18n or re-renders.';
  } else {
    level = 'weak';
    score = 0.3;
    hint = 'No durable anchor captured — replay will lean on the LLM/vision.';
  }

  return { level, score, risks, hint };
}
