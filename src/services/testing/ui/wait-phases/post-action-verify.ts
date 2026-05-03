/**
 * Wait phases: value-reflected / state-reflected / option-reflected /
 * post-condition-met
 *
 * Post-phases that verify the action produced the observable state change
 * we expected. This is the "don't just wait for DOM stability — wait for
 * the RIGHT state change" pattern Playwright best-practices recommend
 * (hydration race bait: element was visible+enabled but handler wasn't
 * attached; only a post-condition catches it).
 *
 * All four are permissive: if no expected state is present (step has no
 * value to type / no postconditions declared), they fastCheck as ready
 * and add zero latency.
 */

import type { PhaseResult, SubPhase } from '../smart-step-wait.service';

const POLL_INTERVAL_MS = 100;

// ─── value-reflected ──────────────────────────────────────────────────────
//
// Post-phase for `type` action. Some frameworks (WPForms, controlled React
// inputs) swallow .fill() and the DOM value reverts. Probe locator.inputValue
// until it matches step.value OR we run out of budget.
//
// Contract: step.value is string | undefined. Missing/empty value → phase
// is irrelevant, fastCheck = true.

const VALUE_REFLECT_CAP_MS = 1_500;

export const valueReflectedPhase: SubPhase = {
  name: 'value-reflected',
  requiresLocator: true,
  fastCheck: async (ctx) => {
    const expected = (ctx.step as unknown as { value?: string }).value;
    if (expected === undefined || expected === '') return true;
    if (!ctx.locator) return false;
    try {
      const actual = await ctx.locator.inputValue();
      // Accept exact match OR substring (handles masked inputs / locale
      // formatting that adds characters during render).
      return actual === expected || actual.includes(expected) || expected.includes(actual);
    } catch {
      return false;
    }
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const expected = (ctx.step as unknown as { value?: string }).value;
    if (expected === undefined || expected === '' || !ctx.locator) {
      return { name: 'value-reflected', ready: true, waitedMs: 0, skipped: false };
    }
    const deadline = Date.now() + Math.min(remaining, VALUE_REFLECT_CAP_MS);
    let lastActual = '';
    while (Date.now() < deadline) {
      try {
        lastActual = await ctx.locator.inputValue();
        if (
          lastActual === expected ||
          lastActual.includes(expected) ||
          expected.includes(lastActual)
        ) {
          return {
            name: 'value-reflected',
            ready: true,
            waitedMs: Date.now() - start,
            skipped: false,
          };
        }
      } catch {
        // Element might briefly detach during React re-render; let the
        // next poll reacquire it.
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return {
      name: 'value-reflected',
      ready: false,
      waitedMs: Date.now() - start,
      skipped: false,
      evidence: { expected, actual: lastActual },
    };
  },
};

// ─── state-reflected ──────────────────────────────────────────────────────
//
// Post-phase for check/uncheck/toggle/open/close. Reads aria-pressed /
// aria-checked / aria-expanded attributes (whichever is present) and polls
// until it matches the expected post-state derived from the action type.
//
// Expected value per action:
//   check   → aria-checked='true' OR native checked=true
//   uncheck → aria-checked='false' OR native checked=false
//   toggle  → ANY transition (we don't know direction a priori)
//   open    → aria-expanded='true'
//   close   → aria-expanded='false'

const STATE_REFLECT_CAP_MS = 1_500;

type StateAction = 'check' | 'uncheck' | 'toggle' | 'open' | 'close';

async function probeState(
  ctx: { locator: NonNullable<import('../smart-step-wait.service').SmartWaitContext['locator']> },
  action: StateAction,
): Promise<boolean> {
  const locator = ctx.locator;
  try {
    // Try all three ARIA attrs + native checked — whichever the component uses.
    // Types avoid `dom` lib: we run inside page context via page.evaluate,
    // so we cast to any to access DOM APIs without pulling in lib.dom globally.
    const snapshot = await locator.evaluate((el) => {
      const e = el as any;
      const input = e.querySelector('input[type="checkbox"],input[type="radio"]') as any;
      return {
        ariaChecked: e.getAttribute('aria-checked') as string | null,
        ariaPressed: e.getAttribute('aria-pressed') as string | null,
        ariaExpanded: e.getAttribute('aria-expanded') as string | null,
        // Radix UI / shadcn / Vaul / many headless React libs encode toggle
        // state as data-state. Many primitives (Dialog, Popover,
        // DropdownMenu, Collapsible) do NOT mirror to aria-expanded —
        // without this read, every Radix open/close step times out the
        // state-reflected phase even when the click actually worked.
        dataState: e.getAttribute('data-state') as string | null,
        nativeChecked: input ? (input.checked as boolean) : null,
      };
    });
    switch (action) {
      case 'check':
        // Radix Checkbox uses data-state="checked" / "unchecked" instead of
        // aria-checked. Native input.checked still wins when present.
        return snapshot.ariaChecked === 'true'
          || snapshot.dataState === 'checked'
          || snapshot.dataState === 'on'
          || snapshot.nativeChecked === true;
      case 'uncheck':
        return snapshot.ariaChecked === 'false'
          || snapshot.dataState === 'unchecked'
          || snapshot.dataState === 'off'
          || snapshot.nativeChecked === false;
      case 'toggle':
        // We don't know prior value — accept ANY defined state.
        return (
          snapshot.ariaPressed !== null ||
          snapshot.ariaChecked !== null ||
          snapshot.dataState !== null ||
          snapshot.nativeChecked !== null
        );
      case 'open':
        // Radix Dialog/Popover/DropdownMenu set data-state="open" without
        // touching aria-expanded. Tabs use 'active' for the current tab —
        // that's open-semantic enough for the verifier (the test author's
        // intent "open this thing" is satisfied either way).
        return snapshot.ariaExpanded === 'true'
          || snapshot.dataState === 'open'
          || snapshot.dataState === 'active'
          || snapshot.dataState === 'on';
      case 'close':
        return snapshot.ariaExpanded === 'false'
          || snapshot.dataState === 'closed'
          || snapshot.dataState === 'inactive'
          || snapshot.dataState === 'off';
    }
  } catch {
    return false;
  }
}

export const stateReflectedPhase: SubPhase = {
  name: 'state-reflected',
  requiresLocator: true,
  fastCheck: async (ctx) => {
    if (!ctx.locator) return false;
    const t = ctx.step.type as StateAction;
    if (!['check', 'uncheck', 'toggle', 'open', 'close'].includes(t)) return true;
    return probeState({ locator: ctx.locator }, t);
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const t = ctx.step.type as StateAction;
    if (!['check', 'uncheck', 'toggle', 'open', 'close'].includes(t) || !ctx.locator) {
      return { name: 'state-reflected', ready: true, waitedMs: 0, skipped: false };
    }
    const deadline = Date.now() + Math.min(remaining, STATE_REFLECT_CAP_MS);
    while (Date.now() < deadline) {
      if (await probeState({ locator: ctx.locator }, t)) {
        return {
          name: 'state-reflected',
          ready: true,
          waitedMs: Date.now() - start,
          skipped: false,
        };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return {
      name: 'state-reflected',
      ready: false,
      waitedMs: Date.now() - start,
      skipped: false,
    };
  },
};

// ─── option-reflected ─────────────────────────────────────────────────────
//
// Post-phase for `select`. Verifies the chosen option actually shows as
// selected in the dropdown's value/text. Step.value holds the expected
// option label/value.

const OPTION_REFLECT_CAP_MS = 1_500;

export const optionReflectedPhase: SubPhase = {
  name: 'option-reflected',
  requiresLocator: true,
  fastCheck: async (ctx) => {
    const expected = (ctx.step as unknown as { value?: string }).value;
    if (expected === undefined || expected === '' || !ctx.locator) return true;
    try {
      // Native <select>: locator.inputValue() returns selected option value.
      // Custom combobox: fall back to textContent which usually mirrors the
      // selected label.
      const asInput = await ctx.locator.inputValue().catch(() => null);
      if (asInput !== null && (asInput === expected || asInput.includes(expected))) return true;
      const asText = await ctx.locator.textContent();
      return !!asText && (asText.includes(expected) || expected.includes(asText));
    } catch {
      return false;
    }
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const expected = (ctx.step as unknown as { value?: string }).value;
    if (expected === undefined || expected === '' || !ctx.locator) {
      return { name: 'option-reflected', ready: true, waitedMs: 0, skipped: false };
    }
    const deadline = Date.now() + Math.min(remaining, OPTION_REFLECT_CAP_MS);
    while (Date.now() < deadline) {
      try {
        const asInput = await ctx.locator.inputValue().catch(() => null);
        if (asInput !== null && (asInput === expected || asInput.includes(expected))) {
          return { name: 'option-reflected', ready: true, waitedMs: Date.now() - start, skipped: false };
        }
        const asText = await ctx.locator.textContent();
        if (asText && (asText.includes(expected) || expected.includes(asText))) {
          return { name: 'option-reflected', ready: true, waitedMs: Date.now() - start, skipped: false };
        }
      } catch {
        // element briefly detached; retry
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return {
      name: 'option-reflected',
      ready: false,
      waitedMs: Date.now() - start,
      skipped: false,
      evidence: { expected },
    };
  },
};

// ─── post-condition-met ───────────────────────────────────────────────────
//
// Generic post-phase that reads step.compiled.postconditions and verifies
// the action produced the declared observable change. This is the
// Playwright best-practice "verify an observable state change, not just
// DOM stability" pattern.
//
// Supported postcondition tags (per CompiledPlanMeta):
//   'navigation' | 'urlChange' → URL changed from prevUrl
//   'domMutation'              → at least one attribute mutation since action
//   (extensions possible later; unknown tags fastCheck as ready=true)
//
// When step has no postconditions, phase is inert.

const POSTCOND_CAP_MS = 1_500;

type PostCondition = 'navigation' | 'urlChange' | 'domMutation';

function getPostconditions(ctx: import('../smart-step-wait.service').SmartWaitContext): PostCondition[] {
  const compiled = (ctx.step as unknown as { compiled?: { postconditions?: string[] } }).compiled;
  const raw = compiled?.postconditions;
  if (!Array.isArray(raw)) return [];
  const known: PostCondition[] = ['navigation', 'urlChange', 'domMutation'];
  return raw.filter((t): t is PostCondition => known.includes(t as PostCondition));
}

function checkUrlChanged(ctx: import('../smart-step-wait.service').SmartWaitContext): boolean {
  if (!ctx.prevUrl) return true; // no baseline → can't verify → assume ok
  try {
    return ctx.page.url() !== ctx.prevUrl;
  } catch {
    return false;
  }
}

export const postConditionMetPhase: SubPhase = {
  name: 'post-condition-met',
  fastCheck: async (ctx) => {
    const conds = getPostconditions(ctx);
    if (conds.length === 0) return true;
    // We only verify url-change cheaply; domMutation needs a tracker we
    // don't maintain here — defer to execute which polls.
    if (conds.every((c) => c === 'navigation' || c === 'urlChange')) {
      return checkUrlChanged(ctx);
    }
    return false;
  },
  execute: async (ctx, remaining): Promise<PhaseResult> => {
    const start = Date.now();
    const conds = getPostconditions(ctx);
    if (conds.length === 0) {
      return { name: 'post-condition-met', ready: true, waitedMs: 0, skipped: false };
    }
    const deadline = Date.now() + Math.min(remaining, POSTCOND_CAP_MS);

    while (Date.now() < deadline) {
      let allMet = true;
      for (const c of conds) {
        if (c === 'navigation' || c === 'urlChange') {
          if (!checkUrlChanged(ctx)) {
            allMet = false;
            break;
          }
        }
        // domMutation is not strictly verifiable post-hoc without a mutation
        // tracker set up pre-action. Treat as "assume caller handled" and
        // don't block on it — recorded for completeness.
      }
      if (allMet) {
        return {
          name: 'post-condition-met',
          ready: true,
          waitedMs: Date.now() - start,
          skipped: false,
        };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
      name: 'post-condition-met',
      ready: false,
      waitedMs: Date.now() - start,
      skipped: false,
      evidence: { conditions: conds, urlNow: (() => { try { return ctx.page.url(); } catch { return '?'; } })() },
    };
  },
};
