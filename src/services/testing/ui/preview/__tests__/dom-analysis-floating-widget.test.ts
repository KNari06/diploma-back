/**
 * Unit test: the geometry-derived `floatingWidget` flag is carried from
 * LiteElement (set by both collectors) onto the persisted InteractiveNode.
 * Guards the symmetry contract — if this carry breaks, the resolver rule
 * silently never fires.
 */

import { extractInteractiveNodes } from '../dom-analysis-extractor.service';
import type { LiteSnapshot, LiteElement } from '@/agent/core/lite/lite-types';

const baseEl = (ref: string, extra: Partial<LiteElement> = {}): LiteElement => ({
  ref,
  role: 'button',
  name: ref,
  tag: 'button',
  visible: true,
  ...extra,
});

const snapshot = (elements: LiteElement[]): LiteSnapshot => ({
  url: 'https://example.com',
  title: 'test',
  elements,
  timestamp: 1,
});

describe('extractInteractiveNodes — floatingWidget carry', () => {
  it('carries floatingWidget=true from LiteElement to InteractiveNode', () => {
    const nodes = extractInteractiveNodes(snapshot([
      baseEl('e1'),
      baseEl('e2', { floatingWidget: true }),
    ]));
    const byRef = Object.fromEntries(nodes.map(n => [n.ref, n]));
    expect(byRef['e2'].floatingWidget).toBe(true);
  });

  it('leaves floatingWidget undefined for ordinary elements', () => {
    const nodes = extractInteractiveNodes(snapshot([baseEl('e1')]));
    expect(nodes[0].floatingWidget).toBeUndefined();
  });
});
