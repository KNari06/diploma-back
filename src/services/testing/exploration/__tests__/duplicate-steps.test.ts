/**
 * Dedupe rule for PERSISTED steps — the logic the prod backfill rewrites live
 * rows with, so its edges matter more than usual: a false positive silently
 * deletes a real step from a user's saved test.
 */

import { dedupePersistedSteps, type PersistedStep } from '../duplicate-steps';

const click = (text: string, extra: Partial<PersistedStep> = {}): PersistedStep => ({
  type: 'click',
  description: `Clicked "${text}" (a)`,
  compiled: { targetFingerprint: { tag: 'a', href: `/${text}`, text, role: 'link' } },
  ...extra,
});

describe('dedupePersistedSteps', () => {
  it('collapses the reported prod case — the same click captured twice', () => {
    // Clicked "H&M" on /brand_products/Polo, landed on /Biba, clicked again.
    // Both were saved, so the test replayed the agent's wandering.
    const { steps, removed } = dedupePersistedSteps([click('H&M'), click('H&M')]);
    expect(removed).toBe(1);
    expect(steps).toHaveLength(1);
  });

  it('collapses a repeated navigate to the same URL', () => {
    const nav: PersistedStep = { type: 'navigate', value: 'https://ex.com/a', description: 'Navigate to https://ex.com/a' };
    const { steps, removed } = dedupePersistedSteps([nav, { ...nav }]);
    expect(removed).toBe(1);
    expect(steps).toHaveLength(1);
  });

  it('keeps a NON-consecutive repeat — reopening a control is a real flow', () => {
    const { steps, removed } = dedupePersistedSteps([click('Menu'), click('Item'), click('Menu')]);
    expect(removed).toBe(0);
    expect(steps).toHaveLength(3);
  });

  it('never collapses a repeated text entry — retyping can be deliberate', () => {
    const fill: PersistedStep = { type: 'type', value: 'abc', description: 'Filled "Email"' };
    const { steps, removed } = dedupePersistedSteps([fill, { ...fill }]);
    expect(removed).toBe(0);
    expect(steps).toHaveLength(2);
  });

  it('never collapses a repeated press — ArrowDown twice is real input', () => {
    const press: PersistedStep = { type: 'press', value: 'ArrowDown', description: 'Pressed ArrowDown' };
    const { steps, removed } = dedupePersistedSteps([press, { ...press }]);
    expect(removed).toBe(0);
  });

  it('keeps clicks on DIFFERENT elements that share a description', () => {
    // Two "Add to cart" buttons on a listing page are distinct targets; the
    // fingerprint is what separates them.
    const a = click('Add to cart', { compiled: { targetFingerprint: { tag: 'a', href: '/p/1', text: 'Add to cart' } } });
    const b = click('Add to cart', { compiled: { targetFingerprint: { tag: 'a', href: '/p/2', text: 'Add to cart' } } });
    const { removed } = dedupePersistedSteps([a, b]);
    expect(removed).toBe(0);
  });

  it('keeps two "Add to cart" clicks that differ ONLY by position', () => {
    // Real prod row (351e293a…): a product listing where every "Add to cart"
    // shares tag, href (`javascript:void();`), text, role AND the same primary
    // locator — the ONLY difference is the bounding box. These are two
    // different products; collapsing them would delete a real step.
    const at = (x: number, y: number): PersistedStep => ({
      type: 'click',
      description: 'Clicked " Add to cart" (a)',
      compiled: {
        targetFingerprint: {
          tag: 'a', href: 'javascript:void();', text: 'Add to cart', role: 'link',
          boundingBox: { x, y, width: 115.5, height: 33.4 },
        },
      },
    });
    const { removed, steps } = dedupePersistedSteps([at(448.46875, 240.375), at(735.953125, 632.671875)]);
    expect(removed).toBe(0);
    expect(steps).toHaveLength(2);
  });

  it('still collapses a genuine retry — same element, same box', () => {
    const same = (): PersistedStep => ({
      type: 'click',
      description: 'Clicked "(5) H&M" (a)',
      compiled: {
        targetFingerprint: {
          tag: 'a', href: '/brand_products/H&M', text: 'H&M', role: 'link',
          boundingBox: { x: 71, y: 556.375, width: 260.5, height: 30 },
        },
      },
    });
    expect(dedupePersistedSteps([same(), same()]).removed).toBe(1);
  });

  it('tolerates sub-pixel jitter on the same element', () => {
    // Fractional layout differences must not defeat the retry match.
    const at = (x: number): PersistedStep => ({
      type: 'click',
      description: 'Clicked "Go" (a)',
      compiled: {
        targetFingerprint: { tag: 'a', href: '/go', text: 'Go', role: 'link', boundingBox: { x, y: 100.2 } },
      },
    });
    expect(dedupePersistedSteps([at(50.1), at(50.4)]).removed).toBe(1);
  });

  it('collapses a run of three identical clicks down to one', () => {
    const { steps, removed } = dedupePersistedSteps([click('X'), click('X'), click('X')]);
    expect(removed).toBe(2);
    expect(steps).toHaveLength(1);
  });

  it('falls back to selector/label when no compiled plan is present', () => {
    const s: PersistedStep = {
      type: 'click',
      description: 'Clicked "Go"',
      options: { cssSelector: '#go' },
      bindingHints: { label: 'Go' },
    };
    expect(dedupePersistedSteps([s, { ...s }]).removed).toBe(1);
  });

  it('does not treat two plan-less clicks with different selectors as equal', () => {
    const a: PersistedStep = { type: 'click', description: 'Clicked "Go"', options: { cssSelector: '#go' } };
    const b: PersistedStep = { type: 'click', description: 'Clicked "Go"', options: { cssSelector: '#go2' } };
    expect(dedupePersistedSteps([a, b]).removed).toBe(0);
  });

  it('never mutates the input array', () => {
    const input = [click('X'), click('X')];
    const copy = JSON.parse(JSON.stringify(input));
    dedupePersistedSteps(input);
    expect(input).toEqual(copy);
  });

  it('handles empty, single-step and malformed input without throwing', () => {
    expect(dedupePersistedSteps([]).removed).toBe(0);
    expect(dedupePersistedSteps([click('X')]).steps).toHaveLength(1);
    expect(dedupePersistedSteps(null as unknown as PersistedStep[]).steps).toEqual([]);
    // A row whose steps lack `type` must be left strictly alone.
    const untyped = [{ description: 'x' }, { description: 'x' }] as PersistedStep[];
    expect(dedupePersistedSteps(untyped).removed).toBe(0);
  });

  it('leaves a clean case completely untouched', () => {
    const input = [click('A'), click('B'), { type: 'ai_check', description: 'verify' } as PersistedStep];
    const { steps, removed } = dedupePersistedSteps(input);
    expect(removed).toBe(0);
    expect(steps).toEqual(input);
  });
});
