import { shouldUpgradeCompiledPlan } from '../mobile-step-apply.service';
import type { MobileCompiledPlan } from '../mobile-runner.types';

// ── Helpers ──────────────────────────────────────────────────────────────

function plan(strategies: Array<{ kind: string; [k: string]: any }>): MobileCompiledPlan {
  return {
    version: 1,
    platform: 'android',
    compiledAt: new Date().toISOString(),
    strategies: strategies as any,
    fingerprint: { label: 'x', role: 'Button' },
  };
}

// ── Rule 1: No candidate → refuse ───────────────────────────────────────

describe('shouldUpgradeCompiledPlan — Rule 1 (refuse missing candidate)', () => {
  it('refuses when candidate is undefined', () => {
    const existing = plan([{ kind: 'label_exact', label: 'X' }]);
    expect(shouldUpgradeCompiledPlan(existing, undefined)).toBe(false);
  });

  it('refuses when candidate has empty strategies (preserves existing)', () => {
    const existing = plan([{ kind: 'label_exact', label: 'X' }]);
    const candidate = plan([]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });
});

// ── Rule 2: No existing → upgrade ───────────────────────────────────────

describe('shouldUpgradeCompiledPlan — Rule 2 (upgrade from nothing)', () => {
  it('takes any candidate when existing is undefined', () => {
    const candidate = plan([{ kind: 'label_exact', label: 'Login' }]);
    expect(shouldUpgradeCompiledPlan(undefined, candidate)).toBe(true);
  });

  it('takes candidate when existing has empty strategies array', () => {
    const existing = plan([]);
    const candidate = plan([{ kind: 'label_exact', label: 'Login' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });
});

// ── Rule 3: Stronger top-tier → upgrade ────────────────────────────────

describe('shouldUpgradeCompiledPlan — Rule 3 (stronger best rank)', () => {
  it('upgrades when candidate adds a top-tier resource_id existing lacked', () => {
    // Real-world canonical case: dev added `android:id` between runs, lint
    // now detects it. Plan should swap to use the stronger locator first.
    const existing = plan([{ kind: 'label_exact', label: 'Login' }]);
    const candidate = plan([
      { kind: 'resource_id', value: 'com.app:id/login' },
      { kind: 'label_exact', label: 'Login' },
    ]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });

  it('upgrades when primary tier rises from near_text to label_exact', () => {
    const existing = plan([{ kind: 'near_text', label: '', anchor: 'X', maxDistance: 400 }]);
    const candidate = plan([{ kind: 'label_exact', label: 'Found Label' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });

  it('upgrades when primary tier rises from bounds_region to anything else', () => {
    const existing = plan([{ kind: 'bounds_region', region: 'middle-center' }]);
    const candidate = plan([{ kind: 'near_text', label: '', anchor: 'X', maxDistance: 400 }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });
});

// ── Rule 4: Weaker top-tier → refuse (the critical anti-downgrade gate) ─

describe('shouldUpgradeCompiledPlan — Rule 4 (refuse downgrade)', () => {
  it('refuses to downgrade resource_id plan to label_exact-only plan', () => {
    // Most important guard: a flaky lint that misses the resource_id
    // (LLM noise, fast-path didn't see it, vision fallback) must NOT
    // overwrite the previous resource_id plan.
    const existing = plan([
      { kind: 'resource_id', value: 'com.app:id/login' },
      { kind: 'label_exact', label: 'Login' },
    ]);
    const candidate = plan([{ kind: 'label_exact', label: 'Login' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('refuses to downgrade strong plan to bounds_region-only fallback', () => {
    // bounds_region as a sole strategy means everything else failed at
    // build time. That alone shouldn't replace a working multi-strategy
    // plan in DB — the fallback might just be one bad apply.
    const existing = plan([
      { kind: 'resource_id', value: 'com.app:id/save' },
      { kind: 'label_exact', label: 'Save' },
    ]);
    const candidate = plan([{ kind: 'bounds_region', region: 'top-right' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('refuses to downgrade label_exact to near_text', () => {
    const existing = plan([{ kind: 'label_exact', label: 'Save' }]);
    const candidate = plan([{ kind: 'near_text', label: '', anchor: 'X', maxDistance: 400 }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });
});

// ── Rule 5: Tied best rank — superset gate ──────────────────────────────

describe('shouldUpgradeCompiledPlan — Rule 5 (tied best, superset rule)', () => {
  it('refuses identical plans — no churn for equal strategy sets', () => {
    const a = plan([{ kind: 'resource_id', value: 'id/x' }, { kind: 'label_exact', label: 'X' }]);
    const b = plan([{ kind: 'resource_id', value: 'id/x' }, { kind: 'label_exact', label: 'X' }]);
    expect(shouldUpgradeCompiledPlan(a, b)).toBe(false);
  });

  it('upgrades when candidate is strict superset (same primary + adds fallback)', () => {
    // Existing: just resource_id. Candidate: same resource_id + label_exact.
    // Same top tier (8), but candidate has more healing fallbacks → upgrade.
    const existing = plan([{ kind: 'resource_id', value: 'id/x' }]);
    const candidate = plan([
      { kind: 'resource_id', value: 'id/x' },
      { kind: 'label_exact', label: 'X' },
    ]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });

  it('upgrades when candidate adds a low-tier fallback to a high-tier primary', () => {
    // Existing has resource_id (8). Candidate has resource_id (8) + near_text (2).
    // Best rank tied at 8. Candidate is strict superset → upgrade.
    const existing = plan([{ kind: 'resource_id', value: 'id/x' }]);
    const candidate = plan([
      { kind: 'resource_id', value: 'id/x' },
      { kind: 'near_text', label: '', anchor: 'X', maxDistance: 400 },
    ]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });

  it('refuses when candidate drops a strategy (loses a fallback)', () => {
    // Existing: [resource_id, label_exact, near_text]. Candidate dropped
    // near_text. Best rank tied at 8. existing.kinds NOT subset of
    // candidate.kinds (near_text missing) → refuse.
    const existing = plan([
      { kind: 'resource_id', value: 'id/x' },
      { kind: 'label_exact', label: 'X' },
      { kind: 'near_text', label: '', anchor: 'Y', maxDistance: 400 },
    ]);
    const candidate = plan([
      { kind: 'resource_id', value: 'id/x' },
      { kind: 'label_exact', label: 'X' },
    ]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('refuses secondary swap that loses strength (label_exact → near_text)', () => {
    // Existing: [resource_id, label_exact (5)]. Candidate: [resource_id,
    // near_text (2)]. Best rank tied at 8 (resource_id), but existing's
    // label_exact missing in candidate → not a superset → refuse.
    // Without this guard the plan would silently lose label_exact strength.
    const existing = plan([
      { kind: 'resource_id', value: 'id/x' },
      { kind: 'label_exact', label: 'X' },
    ]);
    const candidate = plan([
      { kind: 'resource_id', value: 'id/x' },
      { kind: 'near_text', label: '', anchor: 'Y', maxDistance: 400 },
    ]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('refuses cross-platform primary swap at the same top tier', () => {
    // accessibility_id (iOS) and resource_id (Android) both rank 8.
    // In practice plans don't migrate cross-platform (compiled-fast-path
    // does platform_mismatch checks earlier), but if a malformed payload
    // ever arrived, we keep the original platform's plan. existing.kinds
    // = {accessibility_id} not subset of candidate {resource_id} → refuse.
    const existing = plan([{ kind: 'accessibility_id', value: 'login_btn' }]);
    const candidate = plan([{ kind: 'resource_id', value: 'login_btn' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });
});

// ── Forward compat: unknown kinds ───────────────────────────────────────

describe('shouldUpgradeCompiledPlan — unknown strategy kinds (forward compat)', () => {
  it('preserves existing when both plans use unknown kinds and sets are equal', () => {
    // Both kinds rank -1. Tied best, equal sets → refuse (no churn).
    const existing = plan([{ kind: 'future_a' as any, value: 'x' }]);
    const candidate = plan([{ kind: 'future_a' as any, value: 'x' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('preserves existing when candidate swaps to a different unknown kind at same tier', () => {
    // future_a vs future_b — both rank -1. Tied, but kinds differ →
    // existing not subset → refuse. Critical for forward compat: if a
    // future runner emits a new kind, we don't silently swap stable
    // plans for it without an explicit migration path.
    const existing = plan([{ kind: 'future_a' as any, value: 'x' }]);
    const candidate = plan([{ kind: 'future_b' as any, value: 'x' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('upgrades when known kind beats unknown', () => {
    // resource_id (8) beats future_xyz (-1) on rank — clear upgrade.
    const existing = plan([{ kind: 'future_xyz' as any, value: 'x' }]);
    const candidate = plan([{ kind: 'resource_id', value: 'id/x' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });

  it('refuses unknown candidate when existing is known', () => {
    const existing = plan([{ kind: 'resource_id', value: 'id/x' }]);
    const candidate = plan([{ kind: 'future_xyz' as any, value: 'x' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });
});

describe('shouldUpgradeCompiledPlan — creation_location ranking (Flutter)', () => {
  it('upgrades a bounds_region plan to a creation_location plan', () => {
    const existing = plan([{ kind: 'bounds_region', region: 'c-c' }]);
    const candidate = plan([{ kind: 'creation_location', value: 'home.dart:17:4' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(true);
  });

  it('does NOT downgrade a creation_location plan to bounds_region', () => {
    const existing = plan([{ kind: 'creation_location', value: 'home.dart:17:4' }]);
    const candidate = plan([{ kind: 'bounds_region', region: 'c-c' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });

  it('ranks creation_location at least as strong as resource_id', () => {
    // A creation_location plan must not be downgraded to resource_id.
    const existing = plan([{ kind: 'creation_location', value: 'home.dart:17:4' }]);
    const candidate = plan([{ kind: 'resource_id', value: 'btn' }]);
    expect(shouldUpgradeCompiledPlan(existing, candidate)).toBe(false);
  });
});
