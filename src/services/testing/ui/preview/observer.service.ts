/**
 * Background editor Observer — Stage 2 of the LLM observer concept.
 *
 * WHAT IT IS
 * ──────────
 * A proactive, fire-and-forget LLM watcher over the live editor. On discrete
 * events (a step was recorded, an apply finished, the page navigated) it looks
 * at the current page + recent steps and, if something is worth flagging,
 * emits a single hint to the UI:
 *
 *   login_required — the flow hit a login gate (supersedes the hardcoded
 *                    auth-detector verdict once promoted out of shadow)
 *   step_missing   — an obvious step is missing before the next one
 *                    (e.g. a menu must be opened before clicking its item)
 *   blocked        — captcha / verification / dead-end blocks progress
 *   wrong_page     — the step looks recorded on a different page than now
 *   none           — nothing to say (the common case → silent)
 *
 * ROLE BOUNDARY (do not blur)
 * ───────────────────────────
 * This is PROACTIVE and runs OUTSIDE the execution loop. The existing
 * `step-blocker-diagnosis.service.ts` is REACTIVE — it explains why a step
 * already FAILED, inside the retry loop. They never overlap: Observer hints
 * before/independent of failure; step-blocker diagnoses after failure. Keep it
 * that way — do not call Observer from the apply retry path, and do not make
 * step-blocker proactive.
 *
 * NON-NEGOTIABLE — off the hot path
 * ─────────────────────────────────
 * Every entry point is `void observe(...)` — never awaited by a WS handler,
 * the run loop, or the frame pipeline. A debounce coalesces event bursts into
 * one LLM call; a per-session page-signature dedup + rate-limit bound cost;
 * the model is gemini-flash-lite; and every failure path is swallowed
 * (fail-open). A slow or dead LLM degrades to "no hint", never to latency or
 * an error on the user's path.
 *
 * SHADOW (this iteration): flag-gated `OBSERVER_LLM_SHADOW`. When on, it logs
 * its verdict but does NOT emit to the UI yet — we collect prod signal first,
 * exactly like the Stage-1 login classifier. A follow-up flips emission on.
 */

import { createHash } from 'crypto';
import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { getPageContext, formatPageContextForChat } from '@/services/chat/editor-context.service';
import { LOGIN_URL_RE } from './login-url.util';

function envOn(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * SHADOW: the observer runs (LLM + logging) but does NOT surface anything to
 * the user. This is the safe default for collecting prod precision data.
 */
export function isObserverShadowEnabled(): boolean {
  return envOn('OBSERVER_LLM_SHADOW');
}

/**
 * EMIT: surface hints to the editor UI via `preview:observer:hint`. Separate
 * flag ON PURPOSE — you enable this ONLY after the shadow logs show the
 * verdicts are reliable. Emission also implies the observer must run, so
 * either flag activates the pipeline.
 */
export function isObserverEmitEnabled(): boolean {
  return envOn('OBSERVER_LLM_EMIT');
}

function isObserverActive(): boolean {
  return isObserverShadowEnabled() || isObserverEmitEnabled();
}

/** Min confidence before a hint is shown to the user (logging is unconditional). */
const EMIT_CONFIDENCE_FLOOR = 0.7;

export type ObserverHintKind =
  | 'login_required'
  | 'step_missing'
  | 'blocked'
  | 'wrong_page'
  | 'none';

export interface ObserverHint {
  kind: ObserverHintKind;
  confidence: number; // 0..1
  message: string; // short, user-facing
}

/** Why the observer woke up — for logs + prompt context, not user-facing. */
export type ObserverReason = 'step_added' | 'apply_done' | 'navigation';

// ── Tunables ────────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 800; // coalesce event bursts (redirect chains, fast typing)
const RATE_LIMIT_MS = 8_000; // at most one LLM call per session per this window
const CACHE_TTL_MS = 5 * 60_000; // verdict cache per page+steps signature
const CACHE_MAX = 400;
const LLM_TIMEOUT_MS = 5_000;
// Bump whenever buildPrompt changes — it's part of the cache key so old
// verdicts for the same page don't survive a prompt change. v2: merged the
// login-classifier negatives + steps-first context (Stage-1/2 unification).
const PROMPT_VERSION = 'v2';

// ── Per-session state (in-memory; lost on restart, which is fine) ────────────
const debounceTimers = new Map<string, NodeJS.Timeout>();
const lastRunAt = new Map<string, number>();
const verdictCache = new Map<string, { hint: ObserverHint; at: number }>();

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const now = (): number => Date.now();

function cacheGet(key: string): ObserverHint | undefined {
  const hit = verdictCache.get(key);
  if (!hit) return undefined;
  if (now() - hit.at > CACHE_TTL_MS) {
    verdictCache.delete(key);
    return undefined;
  }
  return hit.hint;
}

function cacheSet(key: string, hint: ObserverHint): void {
  if (verdictCache.size >= CACHE_MAX) {
    const drop = Math.ceil(CACHE_MAX * 0.1);
    let i = 0;
    for (const k of verdictCache.keys()) {
      verdictCache.delete(k);
      if (++i >= drop) break;
    }
  }
  verdictCache.set(key, { hint, at: now() });
}

function buildPrompt(ctxText: string, stepsText: string, reason: ObserverReason): string {
  return [
    'You are a background assistant watching a user build a UI test in a live',
    'browser editor. Decide if there is ONE thing worth flagging RIGHT NOW.',
    'Be conservative: stay silent ("none") unless you are fairly sure — a noisy',
    'assistant is worse than a quiet one. Judge by meaning, in ANY language.',
    '',
    'Flag only these:',
    '  login_required — a LOGIN GATE: the user must sign IN with EXISTING',
    '                   credentials to proceed. These are NOT login_required',
    '                   (common false positives — do NOT flag them):',
    '                     • registration / sign-up ("create account",',
    '                       "Регистрация", "Тіркелу")',
    '                     • change/reset password while already signed in',
    '                       (settings / security pages)',
    '                     • a password field used for something else',
    '                       (checkout confirm, unlock)',
    '                     • search boxes, marketing pages, dashboards',
    '  step_missing   — an obvious action is missing before the next step would',
    '                   work (e.g. a dropdown/menu must be opened first)',
    '  blocked        — a captcha, verification / OTP code prompt, or error',
    '                   blocks progress',
    '  wrong_page     — the latest step looks recorded on a different page than',
    '                   the current URL suggests',
    '  none           — nothing to flag (most of the time)',
    '',
    `Woke up because: ${reason}`,
    '',
    // Steps FIRST and on their own line so they are never truncated away by
    // the page-context cap — step_missing / wrong_page depend on seeing them.
    'Recorded test steps so far (oldest→newest):',
    stepsText || '(none yet)',
    '',
    'Current page context:',
    ctxText.slice(0, 2000),
    '',
    'Respond with JSON only:',
    '{"kind":"login_required|step_missing|blocked|wrong_page|none","confidence":0..1,"message":"<=14 words"}',
  ].join('\n');
}

function parseHint(raw: string): ObserverHint | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as { kind?: string; confidence?: number; message?: string };
    const kinds: ObserverHintKind[] = [
      'login_required',
      'step_missing',
      'blocked',
      'wrong_page',
      'none',
    ];
    if (!(kinds as string[]).includes(o.kind ?? '')) return null;
    const confidence =
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.max(0, Math.min(1, o.confidence))
        : 0.5;
    return {
      kind: o.kind as ObserverHintKind,
      confidence,
      message: typeof o.message === 'string' ? o.message.slice(0, 160) : '',
    };
  } catch {
    return null;
  }
}

/**
 * Run one observation NOW (post-debounce). Internal — `observe` is the public,
 * debounced entry. Fail-open: returns the hint or null, never throws.
 */
async function runObservation(
  sessionId: string,
  userId: string | undefined,
  reason: ObserverReason,
): Promise<ObserverHint | null> {
  // Rate-limit: at most one LLM call per session per window.
  const last = lastRunAt.get(sessionId) ?? 0;
  if (now() - last < RATE_LIMIT_MS) return null;

  const ctx = await getPageContext(sessionId, userId);
  if (!ctx) return null; // session gone / no DOM — nothing to observe

  // Cheap pre-gate (cost floor, no hardcode): skip the LLM only when there is
  // provably nothing to observe — NO recorded steps yet AND a contentless page
  // (no DOM summary, no page text). Such a state can't yield any of the four
  // verdicts. We deliberately do NOT gate on "no form" like the old
  // login-only classifier did: the observer also flags step_missing/wrong_page,
  // which don't require a form. Reuses the shared LOGIN_URL_RE only as a
  // belt-and-suspenders "this might be login" override so a bare /login URL is
  // never skipped even on a still-loading page.
  const hasSteps = (ctx.testSteps?.length ?? 0) > 0;
  const hasContent = !!(ctx.domSummary?.trim() || ctx.pageText?.trim());
  let urlLooksLogin = false;
  try { urlLooksLogin = LOGIN_URL_RE.test(new URL(ctx.url).pathname); } catch { /* non-URL */ }
  if (!hasSteps && !hasContent && !urlLooksLogin) {
    logger.debug('[OBSERVER_SHADOW] pre-gate skip (nothing to observe)', { sessionId, url: ctx.url });
    return null;
  }

  const ctxText = formatPageContextForChat(ctx);
  const recentSteps = (ctx.testSteps ?? []).slice(-8);
  const stepsText = recentSteps.map((s, i) => `${i + 1}. ${s.type}: ${s.description}`).join('\n');
  // Signature = page url + dom summary + recent step descriptions. Same shape
  // → cached verdict (a quiet page the user is staring at won't re-bill).
  const stepsSig = recentSteps.map((s) => `${s.type}:${s.description}`).join('|');
  const key = sha1(`${ctx.url}|${ctx.domSummary}|${stepsSig}`) + ':' + PROMPT_VERSION;

  let hint = cacheGet(key);
  if (!hint) {
    lastRunAt.set(sessionId, now());
    const res = (await withAIContext(
      {
        workspaceId: '',
        userId: userId || '',
        operationType: 'lite-test',
        logSource: 'ai-selector',
        logActionType: 'observer',
        logEntityType: 'test_execution',
        logEntityId: sessionId,
      },
      () =>
        generateTextWithGemini({
          prompt: buildPrompt(ctxText, stepsText, reason),
          model: AI_TASK_MODELS.observer,
          temperature: 0,
          maxTokens: 80,
          timeout: LLM_TIMEOUT_MS,
          jsonMode: true,
        }),
    )) as { content: string };

    const parsed = parseHint(res?.content ?? '');
    if (!parsed) return null; // unparsable → fail-open, no hint
    hint = parsed;
    cacheSet(key, hint);
  }

  // Always log (shadow signal) regardless of emission — this is the data we
  // use to validate precision before turning emission on.
  if (hint.kind !== 'none') {
    logger.info('[OBSERVER_SHADOW] Hint', {
      sessionId,
      reason,
      kind: hint.kind,
      confidence: hint.confidence,
      message: hint.message,
      url: ctx.url,
      willEmit: isObserverEmitEnabled() && hint.confidence >= EMIT_CONFIDENCE_FLOOR,
    });
  } else {
    logger.debug('[OBSERVER_SHADOW] none', { sessionId, reason, url: ctx.url });
  }

  // EMIT (Stage 3) — only when explicitly enabled, the verdict is actionable
  // (not `none`), and confidence clears the floor. Advisory chip; never blocks.
  // Wrapped so a transport failure can't break the observer's fail-open contract.
  if (
    isObserverEmitEnabled() &&
    hint.kind !== 'none' &&
    hint.confidence >= EMIT_CONFIDENCE_FLOOR
  ) {
    try {
      // Lazy import: keep the WS layer out of this module's static graph
      // (mirrors how auth-detector reaches webSocketService) and avoid any
      // import cycle through the websocket barrel.
      const { webSocketService } = await import('@/websocket/core/websocket.service');
      webSocketService.emitToRoom('preview', sessionId, 'preview:observer:hint', {
        previewSessionId: sessionId,
        kind: hint.kind,
        message: hint.message,
        confidence: hint.confidence,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.debug('[OBSERVER_SHADOW] emit failed (ignored)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return hint;
}

/**
 * Public entry — fire-and-forget, debounced. Call from event sites with
 * `void observe(...)`. NEVER await it on a hot path.
 */
export function observe(
  sessionId: string,
  reason: ObserverReason,
  userId?: string,
): void {
  if (!isObserverActive()) return;
  if (!sessionId) return;

  const existing = debounceTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId);
    // Detached — the timer callback owns the async work; nothing awaits it.
    void runObservation(sessionId, userId, reason).catch((err) => {
      logger.debug('[OBSERVER_SHADOW] runObservation failed (ignored)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive on this timer (avoids holding process open
  // in tests / shutdown).
  timer.unref?.();
  debounceTimers.set(sessionId, timer);
}

/** Clear all per-session timers/state for a session (call on session close). */
export function clearObserverSession(sessionId: string): void {
  const t = debounceTimers.get(sessionId);
  if (t) clearTimeout(t);
  debounceTimers.delete(sessionId);
  lastRunAt.delete(sessionId);
}

/** Test/diagnostic helpers. */
export function _resetObserverForTests(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  lastRunAt.clear();
  verdictCache.clear();
}
