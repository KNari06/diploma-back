/**
 * Intent → Resolved Element audit log.
 *
 * Single sink shared by:
 *   - preview-step-apply.service (apply-time success / fake-success rejects)
 *   - intent-step-lint.service   (lint-time resolve, including needs_clarification / not_found)
 *
 * One JSON line per call, written to logs/intent_resolve.log. Fire-and-forget,
 * never throws to caller. Each line carries:
 *   - intent: full IntentStep snapshot (description + bindingHints +
 *             recordedFingerprint + evidence + compiled). Captures EVERY
 *             field the resolver could have used.
 *   - chosen: full live node snapshot from the resolver candidate
 *             (every InteractiveNode field: identity, text, aria-state,
 *             icons, structural, visibility, visual). Null for not_found
 *             and lint paths that didn't pick a candidate.
 *   - resolverPath / fingerprintMatch / clickEffectSignal / outcome /
 *     rejectReason / topSimilarity / candidatesCount / etc.
 *
 * Intentionally noisy — bisecting "description→element" regressions is the
 * whole point. Rotate the file out-of-band when it gets too big.
 *
 * Common queries:
 *   rg "MAT-SMART" logs/intent_resolve.log              # by user description
 *   rg '"outcome":"reject"' logs/intent_resolve.log     # all rejections
 *   rg '"fingerprintMatch":"mismatch"' logs/...         # identity drift
 *   rg '"resolverPath":"llm"' logs/intent_resolve.log   # LLM-decided steps
 *   rg '"phase":"lint"' logs/intent_resolve.log         # lint-only entries
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InteractiveNode, IntentStep, LintCandidate, LintResult } from './preview.types';

function buildIntentSnapshot(stepDraft: IntentStep): Record<string, unknown> {
  return {
    id: stepDraft.id,
    type: stepDraft.type,
    description: stepDraft.description,
    value: stepDraft.value,
    assertionText: stepDraft.assertionText,
    options: stepDraft.options,
    bindingHints: stepDraft.bindingHints,
    recordedFingerprint: stepDraft.recordedFingerprint,
    evidence: stepDraft.evidence,
    compiled: stepDraft.compiled
      ? {
          locatorPlanCount: stepDraft.compiled.locatorPlan?.length,
          locatorPlanFirst: stepDraft.compiled.locatorPlan?.[0],
          action: stepDraft.compiled.action,
          preconditions: stepDraft.compiled.preconditions,
          postconditions: stepDraft.compiled.postconditions,
          context: stepDraft.compiled.context,
          targetFingerprint: stepDraft.compiled.targetFingerprint,
          meta: stepDraft.compiled.meta,
        }
      : null,
    expectedOutcome: stepDraft.expectedOutcome,
    isAutoInjected: stepDraft.isAutoInjected,
    tabIndex: stepDraft.tabIndex,
    phase: stepDraft.phase,
  };
}

function buildNodeSnapshot(node: InteractiveNode | undefined | null): Record<string, unknown> | null {
  if (!node) return null;
  return {
    // identity
    tag: node.tag,
    role: node.role,
    id: node.id,
    isDynamicId: node.isDynamicId,
    testIdAttr: node.testIdAttr,
    name: node.name,
    // text-ish
    text: node.text,
    labelText: node.labelText,
    ariaLabel: node.ariaLabel,
    placeholder: node.placeholder,
    title: node.title,
    alt: (node as any).alt,
    // input
    type: node.type,
    inputType: node.inputType,
    autocomplete: node.autocomplete,
    required: node.required,
    readOnly: node.readOnly,
    invalid: node.invalid,
    hasValue: node.hasValue,
    checked: node.checked,
    // aria state
    ariaExpanded: node.ariaExpanded,
    ariaPressed: node.ariaPressed,
    ariaSelected: node.ariaSelected,
    ariaChecked: node.ariaChecked,
    ariaCurrent: node.ariaCurrent,
    ariaValueNow: node.ariaValueNow,
    ariaValueText: node.ariaValueText,
    ariaHasPopup: node.ariaHasPopup,
    // Radix/shadcn data-state — diagnostic visibility on resolver decisions
    // for headless-React stacks. Without this in the audit log, "wrong-element"
    // post-mortems on Radix sites can't tell apart 'state changed since
    // recording' from 'wrong element picked'.
    dataState: node.dataState,
    ariaActiveDescendant: node.ariaActiveDescendant,
    // icons / framework
    isIconButton: node.isIconButton,
    iconLabel: node.iconLabel,
    svgIcon: node.svgIcon,
    customElementTag: node.customElementTag,
    frameworkClickable: node.frameworkClickable,
    // structural
    containerRef: node.containerRef,
    containerTitles: node.containerTitles,
    nearestLandmark: node.nearestLandmark,
    parentRefChain: node.parentRefChain,
    nearText: node.nearText,
    nearestRowText: node.nearestRowText,
    siblingIndex: node.siblingIndex,
    dataValue: node.dataValue,
    dataRowKey: node.dataRowKey,
    childTestId: node.childTestId,
    rowClickable: node.rowClickable,
    arrowDir: node.arrowDir,
    // bootstrap markers
    bsToggle: node.bsToggle,
    bsTarget: node.bsTarget,
    // visibility / overlay
    isVisible: node.isVisible,
    isInteractive: node.isInteractive,
    isDisabled: node.isDisabled,
    disabled: node.disabled,
    isTopMostAtCenter: node.isTopMostAtCenter,
    isInsideActiveModal: node.isInsideActiveModal,
    // visual
    backgroundColor: (node as any).backgroundColor,
    // misc
    tabIndex: node.tabIndex,
    isContentEditable: node.isContentEditable,
    hasOnclick: node.hasOnclick,
    href: (node as any).href,
    cssClass: (node as any).cssClass,
    vueScopeId: (node as any).vueScopeId,
    ancestorSummary: (node as any).ancestorSummary,
    boundingBox: node.boundingBox,
  };
}

export function buildChosenSnapshot(
  candidate: { ref?: string; confidence?: number; boundingBox?: unknown; node?: InteractiveNode } | null | undefined,
): Record<string, unknown> | null {
  if (!candidate) return null;
  return {
    ref: candidate.ref,
    confidence: candidate.confidence,
    boundingBox: candidate.boundingBox ?? candidate.node?.boundingBox,
    node: buildNodeSnapshot(candidate.node),
  };
}

/**
 * Append one JSON line. fs operations are wrapped in try/catch and
 * appendFile is fire-and-forget — diagnostics never break replay.
 */
function appendAuditLine(payload: Record<string, unknown>): void {
  try {
    const auditPath = path.join(process.cwd(), 'logs', 'intent_resolve.log');
    const dir = path.dirname(auditPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), ...payload }) + '\n';
    fs.appendFile(auditPath, line, () => { /* fire-and-forget */ });
  } catch { /* never throw from diagnostics */ }
}

/**
 * Apply-time entry: full intent + chosen + click-effect outcome.
 * `phase: 'apply'` — so analysis can split lint vs apply easily.
 */
export function logIntentResolveApply(entry: {
  stepDraft: IntentStep;
  candidate: { ref?: string; confidence?: number; boundingBox?: unknown; node?: InteractiveNode } | null | undefined;
  resolverPath?: string;
  fingerprintMatch?: string;
  clickEffectSignal?: string;
  outcome: 'pass' | 'reject' | 'fail';
  rejectReason?: string;
  url?: string;
  pageTitle?: string;
  attempts?: number;
  durationMs?: number;
  resolverDegraded?: boolean;
  topSimilarity?: number;
  candidatesCount?: number;
}): void {
  appendAuditLine({
    phase: 'apply',
    stepId: entry.stepDraft.id,
    stepType: entry.stepDraft.type,
    outcome: entry.outcome,
    rejectReason: entry.rejectReason,
    resolverPath: entry.resolverPath,
    fingerprintMatch: entry.fingerprintMatch,
    clickEffectSignal: entry.clickEffectSignal,
    url: entry.url,
    pageTitle: entry.pageTitle,
    attempts: entry.attempts,
    durationMs: entry.durationMs,
    resolverDegraded: entry.resolverDegraded,
    topSimilarity: entry.topSimilarity,
    candidatesCount: entry.candidatesCount,
    intent: buildIntentSnapshot(entry.stepDraft),
    chosen: buildChosenSnapshot(entry.candidate),
  });
}

/**
 * Lint-time entry: full intent + lint result snapshot.
 *
 * Captures the resolver's verdict BEFORE any click — so we can see why the
 * UI showed "needs_clarification with 3 alternatives" or "not_found" without
 * needing to re-run the test. When `result.status === 'resolved'` and the
 * top candidate is non-null, `chosen` reflects what apply WOULD click.
 *
 * `phase: 'lint'`.
 */
export function logIntentResolveLint(entry: {
  stepDraft: IntentStep;
  result: LintResult;
  url?: string;
  pageTitle?: string;
  durationMs?: number;
  trigger?: 'find_button' | 'auto_lint' | 'apply_prelint' | 'other';
  domNodeCount?: number;
}): void {
  const top: LintCandidate | undefined = entry.result.candidates?.[0];
  appendAuditLine({
    phase: 'lint',
    stepId: entry.stepDraft.id,
    stepType: entry.stepDraft.type,
    outcome: entry.result.status, // resolved | ambiguous | not_found | needs_clarification | error
    resolverPath: entry.result.resolverPath,
    confidence: entry.result.confidence,
    topSimilarity: entry.result.topSimilarity,
    candidatesCount: entry.result.candidates?.length,
    candidatesTop: entry.result.candidates?.slice(0, 5).map((c) => ({
      ref: c.ref,
      label: c.label,
      reason: c.reason,
      confidence: c.confidence,
      tag: c.node?.tag,
      role: c.node?.role,
      id: c.node?.id,
      testIdAttr: c.node?.testIdAttr,
      ariaLabel: c.node?.ariaLabel,
      labelText: c.node?.labelText,
      text: c.node?.text,
      isInsideActiveModal: c.node?.isInsideActiveModal,
      isTopMostAtCenter: c.node?.isTopMostAtCenter,
    })),
    resolverDegraded: entry.result.degradedMode,
    degradedReason: (entry.result as any).degradedReason,
    needsAiFallback: (entry.result as any).needsAiFallback,
    aiFallbackReason: (entry.result as any).aiFallbackReason,
    clarificationQuestion: (entry.result as any).clarificationQuestion,
    interpretation: (entry.result as any).interpretation,
    suggestion: (entry.result as any).suggestion,
    message: entry.result.message,
    url: entry.url,
    pageTitle: entry.pageTitle,
    durationMs: entry.durationMs,
    trigger: entry.trigger,
    domNodeCount: entry.domNodeCount,
    intent: buildIntentSnapshot(entry.stepDraft),
    chosen: top ? buildChosenSnapshot(top) : null,
  });
}
