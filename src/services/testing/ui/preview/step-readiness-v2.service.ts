/**
 * Step Readiness V2 — Smart Waiter
 *
 * Цель: подтвердить что **элемент следующего шага реально готов к действию**
 * на стабильной странице. Скорость — побочный эффект, не цель.
 *
 * Дизайн (минимум gate'ов, максимум сигналов):
 *   Уровень 1 — существование (count + visible + enabled)
 *   Уровень 2 — physical actionability (bbox stable, in viewport, not obstructed,
 *               pointer-events ok, not inert, not aria-disabled)
 *   Уровень 3 — identity match через recordedFingerprint (strong/weak/mismatch)
 *   pageStable — consensus quiet window (DOM tail + same-origin XHR tail)
 *
 * Ключевые правила, чтобы готовность всё-таки наступала:
 *   • Один deadline на всё, фазы НЕ аддитивны.
 *   • После 70% бюджета (soft escape) pageStable gate отпускается, identity
 *     downgrade'ится strong→weak. Не блокируем выход на permanent-polling SPA.
 *   • Identity не блокирует ready=true, кроме явного mismatch — caller получает
 *     сигнал и решает (re-resolve до клика).
 *   • Все проверки fail-open под hard-cap perCheckCapMs (500ms). 30s
 *     Playwright actionability никогда не съест бюджет.
 *
 * Никаких `if (isPreview/isBackground)` внутри — только параметры.
 */

import { logger } from '@/utils/core/logger';
import type { Locator, Page } from 'playwright';
import { STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';
import type { IntentActionType, IntentStep, TargetFingerprint } from './preview.types';

const V2 = STEP_READINESS_CONFIG.v2;

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ReadinessV2Options {
  /** Total budget. preview defaults to 5s, background to 7s. */
  maxWaitMs?: number;
  /** Previous action — drives quiet-window length. */
  prevActionType?: IntentActionType;
  /** URL when previous step started — used as a stability signal source. */
  prevUrl?: string;
  /** Recorded inter-step delay (ms). Applied only on missed deadline. */
  recordedDelayMs?: number;
  /** Optional structured tracer (same shape as V1 — silent if missing). */
  tracer?: ReadinessV2Tracer;
}

export interface ReadinessV2Tracer {
  start?(data: {
    nextStepId: string;
    nextActionType: string;
    prevActionType?: string;
    maxWaitMs: number;
  }): void;
  phase?(data: { phase: string; durationMs: number; details?: Record<string, any> }): void;
  end?(data: { nextStepId: string; result: ReadinessV2Result }): void;
}

export type IdentityMatch = 'strong' | 'weak' | 'mismatch' | 'no_fingerprint';

export type ReadinessV2FailureReason =
  | 'element_not_visible'
  | 'element_not_attached'
  | 'element_disabled'
  | 'element_obstructed'
  | 'element_unstable'
  | 'identity_drift'
  | 'no_locator'
  | 'deadline'
  | 'skip';

export interface ReadinessV2Result {
  /** Безопасно действовать? level1 ✓ AND identity ≠ mismatch. */
  ready: boolean;
  /** ms потраченных на ожидание. */
  waited: number;
  /** Грубая уверенность для caller-а ('high' если все сигналы зелёные). */
  confidence: 'high' | 'medium' | 'low';
  flags: {
    /** Уровень 1 — существование + visible + enabled (по типу экшена). */
    elementCheckPassed: boolean;
    /** Уровень 2 — bbox stable + in viewport + not obstructed + pointer-events. */
    actionablePassed: boolean;
    /** Уровень 3 — fingerprint match. */
    identityMatch: IdentityMatch;
    /** Page consensus quiet window сошёлся? (или дропнут soft-escape) */
    pageStablePassed: boolean;
    /** Не удалось построить ни одного локатора из compiled plan/evidence. */
    hadNoLocator: boolean;
    /** Soft-OR escape сработал (бюджет потрачен >= 70%). */
    softEscapeUsed: boolean;
  };
  failureReason?: ReadinessV2FailureReason;
  /** waited > autoWaitThreshold — сигнал "значимое ожидание" для телеметрии. */
  autoWaitApplied: boolean;
  /** Если ничего не делали (skip-list) — почему. */
  skipReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// SKIP / ACTION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

const NON_TARGETING: ReadonlySet<IntentActionType> = new Set([
  'wait', 'wait_for', 'ai_check', 'wait_for_email',
  'dialog', 'download', 'switch_tab', 'close_tab', 'open_tab',
]);

const NEEDS_VISIBLE_ENABLED: ReadonlySet<IntentActionType> = new Set([
  'click', 'type', 'select', 'check', 'uncheck', 'toggle',
  'dblclick', 'contextmenu', 'open', 'close', 'drag_and_drop',
]);

const NEEDS_VISIBLE_ONLY: ReadonlySet<IntentActionType> = new Set([
  'assert', 'hover', 'scroll',
]);

const NEEDS_ATTACHED_ONLY: ReadonlySet<IntentActionType> = new Set([
  'press', 'upload',
]);

const CLICK_LIKE: ReadonlySet<IntentActionType> = new Set([
  'click', 'dblclick', 'contextmenu', 'check', 'uncheck',
  'toggle', 'open', 'close',
]);

const NAV_CLASS: ReadonlySet<IntentActionType> = new Set([
  'click', 'open', 'close', 'toggle', 'press',
  'hover', 'navigate', 'scroll', 'upload', 'drag_and_drop',
]);

function quietForPrevAction(prev: IntentActionType | undefined): number {
  if (!prev) return V2.quietMs.default;
  if (NAV_CLASS.has(prev)) return V2.quietMs.navigation;
  if (prev === 'type' || prev === 'select') return V2.quietMs.input;
  if (prev === 'assert' || prev === 'hover') return V2.quietMs.assertion;
  return V2.quietMs.default;
}

// ═══════════════════════════════════════════════════════════════════════════
// HARD-CAP WRAPPER
// ═══════════════════════════════════════════════════════════════════════════

async function withCap<T>(fn: () => Promise<T>, capMs: number, fallback: T): Promise<T> {
  return Promise.race([
    fn().catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), capMs)),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATOR BUILDER (mirrors V1 to keep target selection symmetric)
// ═══════════════════════════════════════════════════════════════════════════

function buildLocators(page: Page, step: IntentStep): Locator[] {
  const locators: Locator[] = [];

  if (step.compiled?.locatorPlan?.length) {
    const stable = step.compiled.locatorPlan.filter((e) => e.strategy !== 'ref');
    for (const entry of stable) {
      try {
        let loc: Locator | null = null;
        switch (entry.strategy) {
          case 'role':
            loc = page.getByRole(entry.roleName as any, { name: entry.value }).first();
            break;
          case 'label':
            loc = page.getByLabel(entry.value).first();
            break;
          case 'testId':
            loc = page.getByTestId(entry.value).first();
            break;
          case 'placeholder':
            loc = page.getByPlaceholder(entry.value).first();
            break;
          case 'css':
            loc = page.locator(entry.value).first();
            break;
        }
        if (loc) locators.push(loc);
      } catch {
        /* malformed entry — skip */
      }
    }
    if (locators.length) return locators;
  }

  // Evidence fallback — same guards as V1.
  if (step.evidence?.lastSuccessRef) {
    const ref = step.evidence.lastSuccessRef;
    if (/^(e\d+|s\d+|bg-\d+)$/.test(ref)) return locators;
    if (step.evidence.capturedAt) {
      const age = Date.now() - new Date(step.evidence.capturedAt).getTime();
      if (Number.isFinite(age) && age > 60 * 60 * 1000) return locators;
    }
    try {
      const escaped = ref.replace(/"/g, '\\"');
      locators.push(page.locator(`[data-agent-ref="${escaped}"]`).first());
    } catch {
      /* ignore */
    }
  }
  return locators;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVEL 1 — EXISTENCE (count + visible + enabled, hard-capped)
// ═══════════════════════════════════════════════════════════════════════════

interface Level1Result {
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  /** Тот локатор который реально матчит (для уровней 2/3). */
  matchedLocator?: Locator;
}

async function checkLevel1Single(
  loc: Locator,
  actionType: IntentActionType,
): Promise<Level1Result> {
  const cap = V2.perCheckCapMs;
  const count = await withCap(() => loc.count(), cap, 0);
  const attached = count > 0;
  if (!attached) return { attached: false, visible: false, enabled: false };

  if (NEEDS_ATTACHED_ONLY.has(actionType)) {
    return { attached: true, visible: true, enabled: true, matchedLocator: loc };
  }

  const visible = await withCap(() => loc.isVisible(), cap, false);
  if (!visible) return { attached: true, visible: false, enabled: false };

  if (NEEDS_VISIBLE_ENABLED.has(actionType)) {
    const enabled = await withCap(() => loc.isEnabled(), cap, false);
    return {
      attached: true,
      visible: true,
      enabled,
      matchedLocator: enabled ? loc : undefined,
    };
  }

  return { attached: true, visible: true, enabled: true, matchedLocator: loc };
}

/**
 * Возвращает ВСЕХ кандидатов прошедших L1, плюс best-effort диагностический
 * результат если никто не прошёл. Caller'у важно иметь весь список — будет
 * выбирать по identity match (#3 fix), не первого попавшегося.
 */
async function checkLevel1All(
  locators: Locator[],
  actionType: IntentActionType,
): Promise<{ winners: Level1Result[]; diag: Level1Result }> {
  const results = await Promise.all(locators.map((l) => checkLevel1Single(l, actionType)));
  const winners = results.filter((r) => r.matchedLocator);
  const diag = winners[0]
    ?? results.find((r) => r.attached)
    ?? results[0]
    ?? { attached: false, visible: false, enabled: false };
  return { winners, diag };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVEL 2 — PHYSICAL ACTIONABILITY
// (bbox stable, in viewport, not obstructed, pointer-events, inert, aria-disabled)
// ═══════════════════════════════════════════════════════════════════════════

interface Level2Result {
  passed: boolean;
  inViewport: boolean;
  notObstructed: boolean;
  bboxStable: boolean;
  pointerEventsOk: boolean;
  notInert: boolean;
  notAriaDisabled: boolean;
  /** Снапшот для post-action verify. */
  snapshot?: { bbox: { x: number; y: number; w: number; h: number }; hitTagAtCenter?: string };
}

async function checkLevel2(
  loc: Locator,
  actionType: IntentActionType,
  bboxJitterPx: number,
  capMs: number,
): Promise<Level2Result> {
  const fail: Level2Result = {
    passed: false, inViewport: false, notObstructed: false, bboxStable: false,
    pointerEventsOk: false, notInert: false, notAriaDisabled: false,
  };

  // Один проход в браузере: всё посчитать в evaluate. Дёшево, без round-trips.
  const data = await withCap(
    () =>
      loc.evaluate(
        // @ts-ignore
        (el, opts: { jitter: number; clickLike: boolean }) => {
          const rect = el.getBoundingClientRect();
          // @ts-expect-error - browser context
          const winH = window.innerHeight || 0;
          // @ts-expect-error - browser context
          const winW = window.innerWidth || 0;
          const inViewport =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < winH &&
            rect.left < winW;

          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          let hitTagAtCenter: string | undefined;
          let notObstructed = true;
          if (opts.clickLike && inViewport) {
            // @ts-expect-error - browser context
            const hit = document.elementFromPoint(cx, cy);
            hitTagAtCenter = hit ? hit.tagName.toLowerCase() : undefined;
            notObstructed =
              !!hit &&
              (hit === el || el.contains(hit) || hit.contains(el));
          }

          // @ts-expect-error - browser context
          const cs = window.getComputedStyle(el);
          const pointerEventsOk = cs.pointerEvents !== 'none';
          const notInert = !el.closest('[inert]');
          const notAriaDisabled = el.getAttribute('aria-disabled') !== 'true';

          return {
            rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
            inViewport,
            hitTagAtCenter,
            notObstructed,
            pointerEventsOk,
            notInert,
            notAriaDisabled,
          };
        },
        { jitter: bboxJitterPx, clickLike: CLICK_LIKE.has(actionType) },
      ),
    capMs,
    null as any,
  );

  if (!data) return fail;

  // Bbox stability: МИНИМУМ 1 кадр + V2.bboxRecheckDelayMs. Без реальной паузы
  // мы сравниваем bbox с самим собой и stability=true даже на анимированном
  // элементе — это был бы фальшивый сигнал готовности.
  await new Promise((r) => setTimeout(r, V2.bboxRecheckDelayMs));
  const second = await withCap(
    () =>
      // @ts-ignore
      loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }),
    capMs,
    null as { x: number; y: number; w: number; h: number } | null,
  );
  const bboxStable =
    !!second &&
    Math.abs(second.x - data.rect.x) <= bboxJitterPx &&
    Math.abs(second.y - data.rect.y) <= bboxJitterPx &&
    Math.abs(second.w - data.rect.w) <= bboxJitterPx &&
    Math.abs(second.h - data.rect.h) <= bboxJitterPx;

  const passed =
    data.inViewport &&
    data.pointerEventsOk &&
    data.notInert &&
    data.notAriaDisabled &&
    (CLICK_LIKE.has(actionType) ? data.notObstructed : true) &&
    bboxStable;

  return {
    passed,
    inViewport: data.inViewport,
    notObstructed: data.notObstructed,
    bboxStable,
    pointerEventsOk: data.pointerEventsOk,
    notInert: data.notInert,
    notAriaDisabled: data.notAriaDisabled,
    snapshot: { bbox: data.rect, hitTagAtCenter: data.hitTagAtCenter },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEVEL 3 — IDENTITY (recordedFingerprint match)
// ═══════════════════════════════════════════════════════════════════════════

interface IdentityProbe {
  elementId?: string;
  testIdAttr?: string;
  name?: string;
  href?: string;
  svgIcon?: string;
  routerLink?: string;
  ariaLabel?: string;
  labelText?: string;
  placeholder?: string;
  text?: string;
  role?: string;
  tag?: string;
}

async function probeIdentity(loc: Locator, capMs: number): Promise<IdentityProbe | null> {
  return withCap(
    () =>
      // @ts-ignore
      loc.evaluate((el) => {
        const e: any = el;
        const tag = e.tagName?.toLowerCase();
        const ariaLabel = e.getAttribute('aria-label') ?? undefined;
        const role = e.getAttribute('role') ?? undefined;
        const placeholder = e.placeholder ?? undefined;
        const name = e.name ?? undefined;
        const href = e.href ?? undefined;
        const elementId = e.id || undefined;
        const stableId =
          elementId && !/^(el-id-|radix-|:r\d|mui-|headlessui-|[\da-f]{8}-[\da-f]{4})/i.test(elementId)
            ? elementId
            : undefined;
        const testIdAttr =
          e.getAttribute('data-testid') ||
          e.getAttribute('data-test-id') ||
          e.getAttribute('data-test') ||
          undefined;
        const routerLink = e.getAttribute('routerlink') ?? undefined;
        const svgIcon =
          e.getAttribute('svgicon') ||
          e.getAttribute('data-mat-icon-name') ||
          undefined;
        const text = (e.textContent || '').trim().slice(0, 200) || undefined;
        let labelText: string | undefined;
        if (stableId) {
          // @ts-expect-error - browser context
          const lab = document.querySelector(`label[for="${CSS.escape(stableId)}"]`);
          labelText = lab?.textContent?.trim().slice(0, 200) || undefined;
        }
        return {
          elementId: stableId,
          testIdAttr,
          name,
          href,
          svgIcon,
          routerLink,
          ariaLabel,
          labelText,
          placeholder,
          text,
          role,
          tag,
        };
      }),
    capMs,
    null,
  );
}

/** Нормализация URL-подобных полей перед сравнением (#10 fix). */
function normUrlLike(s: string): string {
  try {
    const u = new URL(s);
    // strip trailing slash on pathname; keep search/hash
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}${u.search}${u.hash}`;
  } catch {
    // not a full URL — strip trailing slash
    return s.replace(/\/+$/, '');
  }
}

function fieldEq(field: string, want: any, got: any): boolean {
  if (field === 'href' || field === 'routerLink') {
    return normUrlLike(String(want)) === normUrlLike(String(got));
  }
  return String(want) === String(got);
}

/**
 * SYRoy identity classification — без soft-escape downgrade.
 * Caller сам решает что делать с mismatch под escape (#4 fix).
 * `score` — для выбора best-кандидата среди нескольких локаторов.
 */
function classifyIdentityRaw(
  probe: IdentityProbe | null,
  fp: TargetFingerprint | undefined,
): { match: IdentityMatch; score: number } {
  if (!fp) return { match: 'no_fingerprint', score: 0 };
  if (!probe) return { match: 'no_fingerprint', score: 0 };

  const strongHits: string[] = [];
  const strongMisses: string[] = [];
  for (const f of V2.identity.strongFields) {
    const want = (fp as any)[f];
    const got = (probe as any)[f];
    if (want === undefined || want === null || want === '') continue;
    if (got === undefined || got === null || got === '') continue;
    if (fieldEq(f, want, got)) strongHits.push(f);
    else strongMisses.push(f);
  }

  const weakHits: string[] = [];
  const weakMisses: string[] = [];
  for (const f of V2.identity.weakFields) {
    const want = (fp as any)[f];
    const got = (probe as any)[f];
    if (want === undefined || want === null || want === '') continue;
    if (got === undefined || got === null || got === '') continue;
    if (fieldEq(f, want, got)) weakHits.push(f);
    else weakMisses.push(f);
  }

  // Skor: strong = +3, weak = +1, mismatch = -1 (для weak-полей).
  const score = strongHits.length * 3 + weakHits.length - weakMisses.length;

  // Strong: хотя бы один strong-hit и нет strong-mismatch.
  if (strongHits.length > 0 && strongMisses.length === 0) {
    return { match: 'strong', score };
  }

  // Явный strong-mismatch (хотя бы один strong-промах) — тянет к weak/mismatch.
  if (strongMisses.length > 0) {
    if (strongHits.length > 0) return { match: 'weak', score };
    if (weakHits.length > weakMisses.length) return { match: 'weak', score };
    return { match: 'mismatch', score };
  }

  // Только weak-сигналы.
  if (weakHits.length >= 1 && weakMisses.length === 0) return { match: 'weak', score };

  // Нет данных вообще.
  if (
    strongHits.length === 0 && weakHits.length === 0 &&
    strongMisses.length === 0 && weakMisses.length === 0
  ) {
    return { match: 'no_fingerprint', score: 0 };
  }

  return { match: 'weak', score };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE-STABLE CONSENSUS
// (DOM mutation tail + same-origin XHR tail + URL-change reset)
// ═══════════════════════════════════════════════════════════════════════════

interface StabilityWatcher {
  isQuiet(): boolean;
  /** ms с момента последнего «шума». */
  quietForMs(): number;
  dispose(): Promise<void>;
}

async function startStabilityWatcher(page: Page, prevUrl?: string): Promise<StabilityWatcher> {
  let lastNoise = Date.now();
  const inflight = new Set<string>();
  const inflightStartedAt = new Map<string, number>();

  let pageOrigin = '';
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {
    /* non-fatal */
  }

  const onReq = (req: { resourceType: () => string; url: () => string }) => {
    const t = req.resourceType();
    if (t !== 'fetch' && t !== 'xhr') return;
    const url = req.url();
    if (pageOrigin) {
      try {
        if (new URL(url).origin !== pageOrigin) return;
      } catch {
        return;
      }
    }
    inflight.add(url);
    inflightStartedAt.set(url, Date.now());
    lastNoise = Date.now();
  };
  const onDone = (req: { url: () => string }) => {
    const url = req.url();
    if (inflight.delete(url)) {
      inflightStartedAt.delete(url);
      lastNoise = Date.now();
    }
  };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  const onFrameNav = () => {
    lastNoise = Date.now();
  };
  page.on('framenavigated', onFrameNav);

  // Track URL polling as a backup signal for pushState.
  // Also bumps lastNoise once if the page already differs from prevUrl on
  // start — so the very first quietForMs read isn't trivially "quiet" right
  // after a navigation that landed before the watcher attached.
  let lastUrl = page.url();
  if (prevUrl && lastUrl !== prevUrl) {
    lastNoise = Date.now();
  }
  const urlPoll = setInterval(() => {
    try {
      const u = page.url();
      if (u !== lastUrl) {
        lastUrl = u;
        lastNoise = Date.now();
      }
    } catch {
      /* page may be closed */
    }
  }, 100);

  // DOM mutation observer in the page context.
  const observerHandle = await page.evaluateHandle(
    () => {
      // @ts-expect-error - browser context
      const w = window as any;
      w.__readinessV2 = w.__readinessV2 || {};
      w.__readinessV2.lastDomMutation = Date.now();
      const animationAttrs = new Set(['class', 'style', 'aria-hidden', 'data-state', 'data-active']);
      // @ts-expect-error - browser context
      const obs = new MutationObserver((muts: any[]) => {
        for (const m of muts) {
          if (m.type === 'childList') {
            w.__readinessV2.lastDomMutation = Date.now();
            return;
          }
          if (m.type === 'attributes' && m.attributeName && !animationAttrs.has(m.attributeName)) {
            w.__readinessV2.lastDomMutation = Date.now();
            return;
          }
        }
      });
      // @ts-expect-error - browser context
      if (document.body) {
        // @ts-expect-error - browser context
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
      w.__readinessV2.observer = obs;
      return obs;
    },
  );

  const isStreamish = (url: string): boolean => {
    const startedAt = inflightStartedAt.get(url);
    if (!startedAt) return false;
    return Date.now() - startedAt > 10_000; // 10s+ in-flight = SSE/long-poll, ignore
  };

  return {
    isQuiet(): boolean {
      // XHR tail: ignore stream-ish (long-lived) requests. inflight==0 — НЕОБХОДИМОЕ
      // условие, но не достаточное — quiet проверяется отдельно через quietForMs().
      const liveCount = Array.from(inflight).filter((u) => !isStreamish(u)).length;
      return liveCount === 0;
    },
    quietForMs(): number {
      // ms с момента последнего сетевого/нав события (request/finished/failed/framenavigated/urlChange).
      return Date.now() - lastNoise;
    },
    async dispose(): Promise<void> {
      try {
        page.off('request', onReq);
        page.off('requestfinished', onDone);
        page.off('requestfailed', onDone);
        page.off('framenavigated', onFrameNav);
      } catch {
        /* ignore */
      }
      clearInterval(urlPoll);
      try {
        await page.evaluate(() => {
          // @ts-expect-error - browser context
          const w = window as any;
          if (w.__readinessV2?.observer) {
            w.__readinessV2.observer.disconnect();
            w.__readinessV2.observer = null;
          }
        });
      } catch {
        /* ignore */
      }
      try {
        await observerHandle.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

async function readDomQuietForMs(page: Page): Promise<number> {
  return withCap(
    () =>
      page.evaluate(() => {
        // @ts-expect-error - browser context
        const w = window as any;
        const ts = w.__readinessV2?.lastDomMutation ?? Date.now();
        return Date.now() - ts;
      }),
    100,
    0,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═══════════════════════════════════════════════════════════════════════════

export async function waitForStepReadinessV2(
  page: Page,
  nextStep: IntentStep,
  options: ReadinessV2Options = {},
): Promise<ReadinessV2Result> {
  const start = Date.now();
  const maxWaitMs = options.maxWaitMs ?? STEP_READINESS_CONFIG.defaults.maxWaitMs;
  const deadline = start + maxWaitMs;
  const quietMs = quietForPrevAction(options.prevActionType);
  const tracer = options.tracer;

  const flags = {
    elementCheckPassed: false,
    actionablePassed: false,
    identityMatch: 'no_fingerprint' as IdentityMatch,
    pageStablePassed: false,
    hadNoLocator: false,
    softEscapeUsed: false,
  };

  try { tracer?.start?.({ nextStepId: nextStep.id, nextActionType: nextStep.type, prevActionType: options.prevActionType, maxWaitMs }); } catch { /* non-fatal */ }

  // ── Skip-list ─────────────────────────────────────────────────────────────
  if (NON_TARGETING.has(nextStep.type) || nextStep.options?.disableLookaheadWait) {
    const skipReason = nextStep.options?.disableLookaheadWait
      ? 'disableLookaheadWait flag set'
      : `Non-targeting action: ${nextStep.type}`;
    const result: ReadinessV2Result = {
      ready: true,
      waited: 0,
      confidence: 'high',
      flags: { ...flags, pageStablePassed: true },
      autoWaitApplied: false,
      skipReason,
    };
    try { tracer?.end?.({ nextStepId: nextStep.id, result }); } catch { /* non-fatal */ }
    return result;
  }

  // ── Build target locators ────────────────────────────────────────────────
  const locators = buildLocators(page, nextStep);
  if (locators.length === 0) {
    flags.hadNoLocator = true;
    // Без локатора подтвердить готовность элемента нельзя. Возвращаем ready=false
    // с явным failureReason — caller (executor) сам решит: пропустить, дать
    // Playwright actionability, или сходить в LLM resolver. Раньше тут было
    // ready=true + failureReason='no_locator' — противоречивая комбинация.
    const blindMs = Math.min(STEP_READINESS_CONFIG.blindSettleMs, maxWaitMs);
    if (blindMs > 0) await new Promise((r) => setTimeout(r, blindMs));
    const waited = Date.now() - start;
    const result: ReadinessV2Result = {
      ready: false,
      waited,
      confidence: 'low',
      flags,
      autoWaitApplied: waited > V2.autoWaitThresholdMs,
      failureReason: 'no_locator',
    };
    try { tracer?.end?.({ nextStepId: nextStep.id, result }); } catch { /* non-fatal */ }
    return result;
  }

  // ── Stability watcher (фоновый, лёгкий) ──────────────────────────────────
  const watcher = await startStabilityWatcher(page, options.prevUrl);
  const phaseStart = Date.now();

  // Финальная диагностика level1 для failureReason.
  let lastL1: Level1Result = { attached: false, visible: false, enabled: false };
  let lastL2: Level2Result | null = null;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const elapsedRatio = (Date.now() - start) / maxWaitMs;
      const softEscape = elapsedRatio >= V2.softEscapeRatio;
      flags.softEscapeUsed = softEscape;

      // ── Level 1: ВСЕ кандидаты ─────────────────────────────────────────
      // #3 fix: если в плане 3 локатора и matchедают разные элементы —
      // identity probe должен идти не по первому, а по ТОМУ кто матчит fingerprint.
      const { winners, diag } = await checkLevel1All(locators, nextStep.type);
      lastL1 = diag;
      flags.elementCheckPassed = winners.length > 0;

      if (winners.length === 0) {
        // Элемент ещё не доступен — короткий poll и снова.
        await new Promise((r) => setTimeout(r, V2.pollIntervalMs));
        continue;
      }

      // ── Level 3 — Identity (по всем winners, выбираем best) ─────────────
      const fp = (nextStep as any).recordedFingerprint as TargetFingerprint | undefined;
      let bestL1: Level1Result = winners[0];
      let bestRawIdentity: { match: IdentityMatch; score: number } = { match: 'no_fingerprint', score: 0 };

      if (fp) {
        // Probe ВСЕХ winners параллельно, выбираем кандидата с лучшим identity score.
        const probes = await Promise.all(
          winners.map((w) => probeIdentity(w.matchedLocator!, V2.perCheckCapMs)),
        );
        const classified = probes.map((p) => classifyIdentityRaw(p, fp));
        let bestIdx = 0;
        for (let i = 1; i < classified.length; i++) {
          // Strong > weak > mismatch > no_fingerprint; tie-break по score.
          const rank = (m: IdentityMatch) =>
            m === 'strong' ? 3 : m === 'weak' ? 2 : m === 'no_fingerprint' ? 1 : 0;
          const cur = classified[bestIdx];
          const cand = classified[i];
          if (
            rank(cand.match) > rank(cur.match) ||
            (rank(cand.match) === rank(cur.match) && cand.score > cur.score)
          ) {
            bestIdx = i;
          }
        }
        bestL1 = winners[bestIdx];
        bestRawIdentity = classified[bestIdx];
      }

      // Сохраняем СЫРОЙ identity (без soft-escape downgrade) — caller увидит mismatch
      // даже под escape и сможет понизить confidence/делать re-resolve. (#4 fix)
      flags.identityMatch = bestRawIdentity.match;

      // ── Level 2 — actionability на ВЫБРАННОМ кандидате ─────────────────
      const l2 = await checkLevel2(
        bestL1.matchedLocator!,
        nextStep.type,
        V2.bboxJitterPx,
        V2.perCheckCapMs,
      );
      lastL2 = l2;
      flags.actionablePassed = l2.passed;

      // ── Page stability ─────────────────────────────────────────────────
      // pageStable consensus: ВСЕ три условия одновременно
      //   1) inflight (same-origin XHR, без stream-ish) пуст
      //   2) с момента последнего network/nav события прошло >= quietMs (XHR-tail)
      //   3) DOM не мутировал >= quietMs (DOM-tail)
      // Без (2) запрос только что закончился = моментально «тихо», что неверно:
      // следующий burst через 100ms прилетит — мы уже мимо.
      const xhrInflightEmpty = watcher.isQuiet();
      const networkQuietFor = watcher.quietForMs();
      const domQuietFor = await readDomQuietForMs(page);
      const pageStable =
        xhrInflightEmpty && networkQuietFor >= quietMs && domQuietFor >= quietMs;
      flags.pageStablePassed = pageStable || softEscape;

      // ── Decision ───────────────────────────────────────────────────────
      // mismatch блокирует ready=true ТОЛЬКО без soft-escape.
      // Под escape mismatch остаётся видим в flags (caller увидит и понизит
      // уверенность), но не фейлим — иначе на медленных SaaS никогда не выйдем.
      const identityBlocks = bestRawIdentity.match === 'mismatch' && !softEscape;

      // physicalOk зависит от КЛАССА экшена:
      //   • NEEDS_ATTACHED_ONLY (press/upload): L2 не нужен — input скрыт,
      //     bbox обычно zero, hit-test нерелевантен. Достаточно L1.attached.
      //   • scroll: цель MOZHET быть вне viewport (за тем и скролл). Требуем
      //     pointerEvents/inert/bboxStable, но НЕ inViewport.
      //   • assert/hover: НЕ click-like — hit-test пропущен в L2; bbox stable
      //     полезен (защита от анимации), но inViewport мягче (можно ассертить
      //     элемент чуть ниже фолда). softEscape ослабляет до базы.
      //   • click-like (NEEDS_VISIBLE_ENABLED): полный l2.passed.
      let physicalOk: boolean;
      if (NEEDS_ATTACHED_ONLY.has(nextStep.type)) {
        physicalOk = true;
      } else if (nextStep.type === 'scroll') {
        physicalOk = l2.pointerEventsOk && l2.notInert && l2.notAriaDisabled && l2.bboxStable;
      } else if (softEscape) {
        physicalOk = l2.inViewport && l2.pointerEventsOk;
      } else {
        physicalOk = l2.passed;
      }

      const ready =
        flags.elementCheckPassed &&
        physicalOk &&
        !identityBlocks &&
        flags.pageStablePassed;

      if (ready) {
        const waited = Date.now() - start;
        try {
          tracer?.phase?.({
            phase: 'level_consensus',
            durationMs: Date.now() - phaseStart,
            details: {
              softEscape,
              identity: bestRawIdentity.match,
              identityScore: bestRawIdentity.score,
              winnerCount: winners.length,
              xhrInflightEmpty,
              networkQuietFor,
              domQuietFor,
              quietRequired: quietMs,
            },
          });
        } catch { /* non-fatal */ }
        // Confidence ladder с учётом raw identity И soft-escape.
        // mismatch под escape ⇒ low (даже при ready=true) — это сигнал caller-у
        // что пора re-resolve, хоть мы и не блокируем.
        const confidence: 'high' | 'medium' | 'low' =
          bestRawIdentity.match === 'mismatch'
            ? 'low'
            : bestRawIdentity.match === 'strong' && !softEscape && l2.passed
              ? 'high'
              : 'medium';
        const result: ReadinessV2Result = {
          ready: true,
          waited,
          confidence,
          flags,
          autoWaitApplied: waited > V2.autoWaitThresholdMs,
        };
        try { tracer?.end?.({ nextStepId: nextStep.id, result }); } catch { /* non-fatal */ }
        return result;
      }

      // Identity mismatch без soft-escape — выходим раньше. Caller re-resolve.
      if (identityBlocks) {
        const waited = Date.now() - start;
        const result: ReadinessV2Result = {
          ready: false,
          waited,
          confidence: 'low',
          flags,
          autoWaitApplied: waited > V2.autoWaitThresholdMs,
          failureReason: 'identity_drift',
        };
        try { tracer?.end?.({ nextStepId: nextStep.id, result }); } catch { /* non-fatal */ }
        return result;
      }

      // Иначе — спим polling и ещё раз.
      await new Promise((r) => setTimeout(r, V2.pollIntervalMs));
      if (remaining <= V2.pollIntervalMs) break;
    }

    // ── Deadline истёк ───────────────────────────────────────────────────
    const waited = Date.now() - start;

    // recordedDelayMs гейт — только при missed deadline.
    if (options.recordedDelayMs && options.recordedDelayMs > 0) {
      const remainHint = Math.min(
        Math.max(0, options.recordedDelayMs * 0.5 - waited),
        500, // cap чтоб не множить ожидание
      );
      if (remainHint > 100) {
        await new Promise((r) => setTimeout(r, remainHint));
      }
    }

    const finalWaited = Date.now() - start;

    let reason: ReadinessV2FailureReason = 'deadline';
    if (!lastL1.attached) reason = 'element_not_attached';
    else if (!lastL1.visible) reason = 'element_not_visible';
    else if (NEEDS_VISIBLE_ENABLED.has(nextStep.type) && !lastL1.enabled) reason = 'element_disabled';
    else if (lastL2 && !lastL2.notObstructed) reason = 'element_obstructed';
    else if (lastL2 && !lastL2.bboxStable) reason = 'element_unstable';
    else if (flags.identityMatch === 'mismatch') reason = 'identity_drift';

    // Soft-escape: если level1 + identity ok, но pageStable не сошёлся за бюджет —
    // отпускаем как ready=true с medium confidence (не блокируем permanent-polling SPA).
    const escapeReady =
      flags.elementCheckPassed &&
      flags.identityMatch !== 'mismatch';

    const result: ReadinessV2Result = {
      ready: escapeReady,
      waited: finalWaited,
      confidence: escapeReady ? 'medium' : 'low',
      flags,
      autoWaitApplied: finalWaited > V2.autoWaitThresholdMs,
      failureReason: escapeReady ? undefined : reason,
    };
    try { tracer?.end?.({ nextStepId: nextStep.id, result }); } catch { /* non-fatal */ }
    return result;
  } finally {
    try { await watcher.dispose(); } catch { /* non-fatal */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW-MODE ADAPTER
// V1 остаётся primary; V2 запускается ПАРАЛЛЕЛЬНО (с того же стартового момента)
// и пишет diff в лог. Никакого влияния на поведение caller-а.
//
// Раньше V2 запускался ПОСЛЕ V1 → страница уже стабильна → V2 всегда «ready=true
// мгновенно» → diff бесполезен. Сейчас оба waiter'а получают одну и ту же page
// в одинаковом состоянии и видят реальную картину.
// ═══════════════════════════════════════════════════════════════════════════

export function shouldRunV2(): 'off' | 'shadow' | 'primary' {
  return STEP_READINESS_CONFIG.v2Mode;
}

/**
 * Запустить V1 (primary) и V2 (shadow) параллельно с общей точки старта.
 * Возвращает результат V1 для caller-а; V2-результат уходит в лог как diff.
 *
 * Использование на каждом callsite:
 *   const v1 = await runV1WithShadow(
 *     () => waitForStepReadiness(page, nextStep, v1Opts),  // существующий V1 вызов
 *     page, nextStep, v2Opts,
 *   );
 *
 * V2 НИКОГДА не влияет на возвращённый результат и не бросает наружу.
 */
export async function runV1WithShadow<T extends { ready: boolean; waited: number }>(
  v1Fn: () => Promise<T>,
  page: Page,
  nextStep: IntentStep,
  v2Options: ReadinessV2Options,
): Promise<T> {
  if (STEP_READINESS_CONFIG.v2Mode !== 'shadow') {
    return v1Fn();
  }

  // Запускаем V1 и V2 ОДНОВРЕМЕННО — каждый стартует со своего setup'а
  // (watcher для V2, фазы для V1) на одной page.
  const startedAt = Date.now();
  const [v1Settled, v2Settled] = await Promise.allSettled([
    v1Fn(),
    waitForStepReadinessV2(page, nextStep, v2Options),
  ]);

  // V2 best-effort: никогда не падает наружу.
  if (v2Settled.status === 'fulfilled') {
    const v2 = v2Settled.value;
    const v1 = v1Settled.status === 'fulfilled' ? v1Settled.value : null;
    const v1ReadyEqual = v1 && v1.ready === v2.ready;
    const waitDelta = v1 ? Math.abs(v1.waited - v2.waited) : -1;
    if (!v1ReadyEqual || waitDelta > 500) {
      logger.info('[STEP_READINESS_V2] shadow diff (parallel)', {
        stepId: nextStep.id,
        actionType: nextStep.type,
        sharedStartAt: startedAt,
        v1: v1 ? { ready: v1.ready, waited: v1.waited } : { error: 'v1 threw' },
        v2: {
          ready: v2.ready,
          waited: v2.waited,
          confidence: v2.confidence,
          identity: v2.flags.identityMatch,
          softEscape: v2.flags.softEscapeUsed,
          failureReason: v2.failureReason,
        },
      });
    }
  } else {
    logger.debug('[STEP_READINESS_V2] shadow run failed (non-fatal)', {
      stepId: nextStep.id,
      error: v2Settled.reason instanceof Error
        ? v2Settled.reason.message
        : String(v2Settled.reason),
    });
  }

  // Caller получает РОВНО результат V1 (или его ошибку).
  if (v1Settled.status === 'fulfilled') return v1Settled.value;
  throw v1Settled.reason;
}
