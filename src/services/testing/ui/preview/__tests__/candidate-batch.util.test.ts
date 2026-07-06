import {
  splitBatchesWithLexicalAnchor,
  matchesIntentLexically,
} from '../candidate-batch.util';
import type { InteractiveNode } from '../preview.types';

const node = (ref: string, fields: Partial<InteractiveNode> = {}): InteractiveNode =>
  ({ ref, tag: 'button', ...fields }) as InteractiveNode;

/** N filler buttons with labels that never collide with test intents. */
const filler = (count: number, offset = 0): InteractiveNode[] =>
  Array.from({ length: count }, (_, i) => node(`f${offset + i}`, { text: `filler ${offset + i}` }));

describe('matchesIntentLexically', () => {
  it('matches when the intent token is contained in the visible text', () => {
    expect(matchesIntentLexically(node('e1', { text: 'Войти' }), 'Войти')).toBe(true);
    expect(matchesIntentLexically(node('e1', { text: 'Войти или зарегистрироваться' }), 'Войти')).toBe(true);
  });

  it('matches across label channels beyond the first non-empty one', () => {
    // labelText present but the match lives in text — the effective-label
    // cascade alone would miss it.
    expect(
      matchesIntentLexically(node('e1', { labelText: 'account menu', text: 'Войти' }), 'Войти'),
    ).toBe(true);
    expect(matchesIntentLexically(node('e1', { ariaLabel: 'login button' }), 'login')).toBe(true);
  });

  it('folds Cyrillic homoglyphs so МАТ matches MAT', () => {
    expect(matchesIntentLexically(node('e1', { text: 'MAT-SMART' }), 'МАТ')).toBe(true);
  });

  it('matches short labels below the tokenizer floor via whole-intent substring', () => {
    expect(matchesIntentLexically(node('e1', { text: 'ОК' }), 'ОК')).toBe(true);
  });

  it('does not match unrelated labels or label-less nodes', () => {
    expect(matchesIntentLexically(node('e1', { text: 'Все города Казахстана' }), 'Войти')).toBe(false);
    expect(matchesIntentLexically(node('e1'), 'Войти')).toBe(false);
  });
});

describe('splitBatchesWithLexicalAnchor', () => {
  it('returns the plain slice when everything fits', () => {
    const nodes = [...filler(5), node('target', { text: 'Войти' })];
    const split = splitBatchesWithLexicalAnchor({ nodes, intentText: 'Войти', maxPrimary: 60 });
    expect(split.primary.map((n) => n.ref)).toEqual(nodes.map((n) => n.ref));
    expect(split.overflow).toEqual([]);
    expect(split.rescuedRefs).toEqual([]);
  });

  it('returns the plain slice when nothing matches the intent', () => {
    const nodes = filler(70);
    const split = splitBatchesWithLexicalAnchor({ nodes, intentText: 'Войти', maxPrimary: 60 });
    expect(split.primary).toHaveLength(60);
    expect(split.primary[0].ref).toBe('f0');
    expect(split.overflow).toHaveLength(10);
    expect(split.rescuedRefs).toEqual([]);
  });

  it('pins a matching candidate from beyond the cap into the primary batch', () => {
    // The bi.group shape: target demoted past the cap by a penalty.
    const nodes = [...filler(65), node('e7', { text: 'Войти' })];
    const split = splitBatchesWithLexicalAnchor({ nodes, intentText: 'Войти', maxPrimary: 60 });
    expect(split.primary.map((n) => n.ref)).toContain('e7');
    expect(split.primary).toHaveLength(60);
    expect(split.rescuedRefs).toEqual(['e7']);
    // Displaced filler ends up in overflow, nothing is lost.
    expect(split.primary.length + split.overflow.length).toBe(nodes.length);
  });

  it('preserves DOM order inside both batches', () => {
    const nodes = [...filler(65), node('e7', { text: 'Войти' }), ...filler(5, 100)];
    const split = splitBatchesWithLexicalAnchor({ nodes, intentText: 'Войти', maxPrimary: 60 });
    const originalOrder = new Map(nodes.map((n, i) => [n.ref, i]));
    const indices = split.primary.map((n) => originalOrder.get(n.ref)!);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    const overflowIndices = split.overflow.map((n) => originalOrder.get(n.ref)!);
    expect([...overflowIndices].sort((a, b) => a - b)).toEqual(overflowIndices);
  });

  it('caps the number of anchored candidates', () => {
    const matching = Array.from({ length: 20 }, (_, i) => node(`m${i}`, { text: `Войти ${i}` }));
    const nodes = [...filler(60), ...matching];
    const split = splitBatchesWithLexicalAnchor({
      nodes,
      intentText: 'Войти',
      maxPrimary: 60,
      maxAnchors: 3,
    });
    const rescued = split.primary.filter((n) => n.ref?.startsWith('m'));
    expect(rescued).toHaveLength(3);
    expect(rescued.map((n) => n.ref)).toEqual(['m0', 'm1', 'm2']);
  });

  it('keeps batch size at the cap when anchors displace tail fillers', () => {
    const nodes = [...filler(100), node('e7', { ariaLabel: 'Войти' })];
    const split = splitBatchesWithLexicalAnchor({ nodes, intentText: 'Войти', maxPrimary: 60 });
    expect(split.primary).toHaveLength(60);
    expect(split.overflow).toHaveLength(41);
    expect(split.primary.map((n) => n.ref)).toContain('e7');
  });
});
