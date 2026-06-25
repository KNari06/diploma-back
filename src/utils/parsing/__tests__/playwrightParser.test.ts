import { parsePlaywrightTestSteps, exportGraph } from '../playwrightParser';
import { PlaywrightStep, TestGraph } from '@/types/playwright.types';

/** Minimal helper to build a step without repeating boilerplate. */
function step(partial: Partial<PlaywrightStep> & { type: PlaywrightStep['type'] }): PlaywrightStep {
  return { id: '', label: '', ...partial } as PlaywrightStep;
}

describe('parsePlaywrightTestSteps', () => {
  describe('input validation', () => {
    it('returns an empty graph when steps is null', () => {
      const graph = parsePlaywrightTestSteps(null as unknown as PlaywrightStep[]);
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
      expect(graph.metadata).toEqual({ totalSteps: 0, conditionalBranches: 0, loops: 0, assertions: 0 });
    });

    it('returns an empty graph when steps is not an array', () => {
      const graph = parsePlaywrightTestSteps({} as unknown as PlaywrightStep[]);
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
    });

    it('returns an empty graph when given an empty array', () => {
      const graph = parsePlaywrightTestSteps([]);
      expect(graph.nodes).toEqual([]);
      expect(graph.metadata.totalSteps).toBe(0);
    });

    it('filters out steps that are not objects or are missing a type', () => {
      const graph = parsePlaywrightTestSteps([
        null as unknown as PlaywrightStep,
        { id: 'x', label: 'no type' } as unknown as PlaywrightStep,
        step({ id: 'good', type: 'click', label: 'Click' }),
      ]);
      // Only the one valid step is counted.
      expect(graph.metadata.totalSteps).toBe(1);
      expect(graph.nodes.some((n) => n.id === 'good')).toBe(true);
    });

    it('returns an empty graph when every step is invalid', () => {
      const graph = parsePlaywrightTestSteps([
        null as unknown as PlaywrightStep,
        { label: 'missing type' } as unknown as PlaywrightStep,
      ]);
      expect(graph.nodes).toEqual([]);
      expect(graph.metadata.totalSteps).toBe(0);
    });
  });

  describe('linear flow', () => {
    it('wraps steps with start and end nodes by default', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 'c1', type: 'click', label: 'Click' })]);
      expect(graph.nodes.find((n) => n.type === 'start')).toBeDefined();
      expect(graph.nodes.find((n) => n.type === 'end')).toBeDefined();
      const action = graph.nodes.find((n) => n.id === 'c1');
      expect(action?.type).toBe('action');
    });

    it('connects start → step → end with normal edges', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 'c1', type: 'click', label: 'Click' })]);
      const start = graph.nodes.find((n) => n.type === 'start')!;
      const end = graph.nodes.find((n) => n.type === 'end')!;
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: start.id, target: 'c1', type: 'normal' }));
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'c1', target: end.id, type: 'normal' }));
    });

    it('omits start/end nodes when includeStartEnd is false', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 'c1', type: 'click', label: 'Click' })], {
        includeStartEnd: false,
      });
      expect(graph.nodes.find((n) => n.type === 'start')).toBeUndefined();
      expect(graph.nodes.find((n) => n.type === 'end')).toBeUndefined();
      expect(graph.nodes).toHaveLength(1);
    });

    it('chains multiple steps sequentially', () => {
      const graph = parsePlaywrightTestSteps(
        [
          step({ id: 'a', type: 'goto', label: 'Go' }),
          step({ id: 'b', type: 'fill', label: 'Fill' }),
          step({ id: 'c', type: 'click', label: 'Click' }),
        ],
        { includeStartEnd: false },
      );
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'a', target: 'b' }));
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'b', target: 'c' }));
      expect(graph.metadata.totalSteps).toBe(3);
    });

    it('generates a node id when a step has none', () => {
      const graph = parsePlaywrightTestSteps([step({ type: 'click', label: 'Click' })], {
        includeStartEnd: false,
      });
      expect(graph.nodes[0].id).toMatch(/^node_\d+$/);
    });
  });

  describe('node fields and metadata enrichment', () => {
    it('carries selector and value onto the node', () => {
      const graph = parsePlaywrightTestSteps(
        [step({ id: 's', type: 'fill', label: 'Fill', selector: '#email', value: 'a@b.com' })],
        { includeStartEnd: false },
      );
      expect(graph.nodes[0].selector).toBe('#email');
      expect(graph.nodes[0].value).toBe('a@b.com');
    });

    it('falls back to the step type for the label when label is missing', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 's', type: 'screenshot', label: '' })], {
        includeStartEnd: false,
      });
      expect(graph.nodes[0].label).toBe('screenshot');
    });

    it('adds icon and color meta for known step types', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 's', type: 'goto', label: 'Go' })], {
        includeStartEnd: false,
      });
      expect(graph.nodes[0].meta?.icon).toBe('🌐');
      expect(graph.nodes[0].meta?.color).toBe('#673AB7'); // navigation color
    });

    it('preserves caller-provided meta while adding derived fields', () => {
      const graph = parsePlaywrightTestSteps(
        [step({ id: 's', type: 'click', label: 'Click', meta: { custom: 42 } })],
        { includeStartEnd: false },
      );
      expect(graph.nodes[0].meta?.custom).toBe(42);
      expect(graph.nodes[0].meta?.icon).toBeDefined();
    });

    it('adds run/info/rerun buttons to ordinary action nodes', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 's', type: 'click', label: 'Click' })], {
        includeStartEnd: false,
      });
      const actions = (graph.nodes[0].meta?.buttons ?? []).map((b: any) => b.action);
      expect(actions).toEqual(['run', 'info', 'rerun']);
    });

    it('omits the rerun button on control-flow nodes', () => {
      const graph = parsePlaywrightTestSteps(
        [step({ id: 'l', type: 'loop', label: 'Loop', children: [step({ id: 'b', type: 'click', label: 'C' })] })],
        { includeStartEnd: false },
      );
      const loopNode = graph.nodes.find((n) => n.id === 'l')!;
      const actions = (loopNode.meta?.buttons ?? []).map((b: any) => b.action);
      expect(actions).toEqual(['run', 'info']);
    });

    it('drops all buttons when addButtons is false', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 's', type: 'click', label: 'Click' })], {
        includeStartEnd: false,
        addButtons: false,
      });
      expect(graph.nodes[0].meta?.buttons).toEqual([]);
    });
  });

  describe('node typing and assertion counting', () => {
    it('types assert* steps as assertions and counts them', () => {
      const graph = parsePlaywrightTestSteps(
        [
          step({ id: 'a', type: 'assertVisible', label: 'Visible' }),
          step({ id: 'b', type: 'expect', label: 'Expect' }),
          step({ id: 'c', type: 'click', label: 'Click' }),
        ],
        { includeStartEnd: false },
      );
      expect(graph.nodes.find((n) => n.id === 'a')?.type).toBe('assertion');
      expect(graph.nodes.find((n) => n.id === 'b')?.type).toBe('assertion');
      expect(graph.nodes.find((n) => n.id === 'c')?.type).toBe('action');
      expect(graph.metadata.assertions).toBe(2);
    });
  });

  describe('conditional (if/else) blocks', () => {
    const ifElse = step({
      id: 'cond',
      type: 'if',
      label: 'If logged in',
      children: [step({ id: 'then', type: 'click', label: 'Then' })],
      else: [step({ id: 'otherwise', type: 'click', label: 'Else' })],
    });

    it('types the condition node and counts the branch', () => {
      const graph = parsePlaywrightTestSteps([ifElse], { includeStartEnd: false });
      expect(graph.nodes.find((n) => n.id === 'cond')?.type).toBe('condition');
      expect(graph.metadata.conditionalBranches).toBe(1);
    });

    it('creates true/false branch edges from the condition', () => {
      const graph = parsePlaywrightTestSteps([ifElse], { includeStartEnd: false });
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'cond', target: 'then', type: 'branch', label: 'true' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'cond', target: 'otherwise', type: 'branch', label: 'false' }),
      );
    });

    it('joins both branches into a merge node', () => {
      const graph = parsePlaywrightTestSteps([ifElse], { includeStartEnd: false });
      const merge = graph.nodes.find((n) => n.type === 'merge');
      expect(merge).toBeDefined();
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'then', target: merge!.id, type: 'merge' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'otherwise', target: merge!.id, type: 'merge' }),
      );
    });

    it('connects the condition straight to the merge when there is no else branch', () => {
      const graph = parsePlaywrightTestSteps(
        [
          step({
            id: 'cond',
            type: 'if',
            label: 'If',
            children: [step({ id: 'then', type: 'click', label: 'Then' })],
          }),
        ],
        { includeStartEnd: false },
      );
      const merge = graph.nodes.find((n) => n.type === 'merge')!;
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'cond', target: merge.id, type: 'branch', label: 'false' }),
      );
    });

    it('does not treat an if without children as a conditional block', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 'cond', type: 'if', label: 'If' })], {
        includeStartEnd: false,
      });
      // Counted as a step and typed as condition, but no branch expansion happened.
      expect(graph.metadata.conditionalBranches).toBe(0);
      expect(graph.nodes.find((n) => n.type === 'merge')).toBeUndefined();
    });
  });

  describe('loop blocks', () => {
    const loop = step({
      id: 'loop',
      type: 'loop',
      label: 'Repeat 3x',
      children: [step({ id: 'body', type: 'click', label: 'Body' })],
    });

    it('counts the loop in metadata', () => {
      const graph = parsePlaywrightTestSteps([loop], { includeStartEnd: false });
      expect(graph.metadata.loops).toBe(1);
      expect(graph.nodes.find((n) => n.id === 'loop')?.type).toBe('loop');
    });

    it('creates iterate, repeat-back and done edges', () => {
      const graph = parsePlaywrightTestSteps([loop], { includeStartEnd: false });
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'loop', target: 'body', type: 'loop', label: 'iterate' }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'body', target: 'loop', type: 'return', label: 'repeat' }),
      );
      const exit = graph.nodes.find((n) => n.label === 'Exit Loop')!;
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: 'loop', target: exit.id, type: 'branch', label: 'done' }),
      );
    });

    it('treats while and forEach as loops too', () => {
      const whileGraph = parsePlaywrightTestSteps(
        [step({ id: 'w', type: 'while', label: 'While', children: [step({ id: 'b', type: 'click', label: 'B' })] })],
        { includeStartEnd: false },
      );
      expect(whileGraph.metadata.loops).toBe(1);
      expect(whileGraph.nodes.find((n) => n.id === 'w')?.type).toBe('loop');
    });

    it('does not expand a loop without children', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 'loop', type: 'loop', label: 'Empty' })], {
        includeStartEnd: false,
      });
      expect(graph.metadata.loops).toBe(0);
      expect(graph.nodes.find((n) => n.label === 'Exit Loop')).toBeUndefined();
    });
  });

  describe('autoLayout option', () => {
    it('assigns x/y positions to nodes when enabled', () => {
      const graph = parsePlaywrightTestSteps(
        [step({ id: 'a', type: 'goto', label: 'Go' }), step({ id: 'b', type: 'click', label: 'Click' })],
        { autoLayout: true },
      );
      const positioned = graph.nodes.filter((n) => n.meta?.position);
      expect(positioned.length).toBeGreaterThan(0);
      expect(positioned[0].meta?.position).toHaveProperty('x');
      expect(positioned[0].meta?.position).toHaveProperty('y');
    });

    it('leaves positions unset by default', () => {
      const graph = parsePlaywrightTestSteps([step({ id: 'a', type: 'goto', label: 'Go' })]);
      expect(graph.nodes.every((n) => !n.meta?.position)).toBe(true);
    });
  });
});

describe('exportGraph', () => {
  const sampleGraph = (): TestGraph =>
    parsePlaywrightTestSteps(
      [
        step({ id: 'cond', type: 'if', label: 'If "ok"', children: [step({ id: 'then', type: 'click', label: 'Then' })] }),
      ],
      { includeStartEnd: true },
    );

  it('defaults to pretty-printed JSON', () => {
    const graph = sampleGraph();
    const out = exportGraph(graph);
    expect(JSON.parse(out)).toEqual(graph);
    expect(out).toContain('\n'); // pretty-printed
  });

  it('serializes to JSON when format is json', () => {
    const graph = sampleGraph();
    expect(JSON.parse(exportGraph(graph, 'json'))).toEqual(graph);
  });

  describe('mermaid format', () => {
    it('starts with a graph TD header', () => {
      const out = exportGraph(sampleGraph(), 'mermaid');
      expect(out.startsWith('graph TD\n')).toBe(true);
    });

    it('renders condition nodes with brace shapes and actions with brackets', () => {
      const out = exportGraph(sampleGraph(), 'mermaid');
      expect(out).toContain('cond{"');
      expect(out).toContain('then[');
    });

    it('renders start/end nodes with stadium shapes', () => {
      const out = exportGraph(sampleGraph(), 'mermaid');
      expect(out).toMatch(/node_\d+\(\["Start"\]\)/);
      expect(out).toMatch(/node_\d+\(\["End"\]\)/);
    });

    it('escapes quotes and strips brackets from labels', () => {
      const graph: TestGraph = {
        nodes: [{ id: 'n1', type: 'action', label: 'Click "Save" (now)' }],
        edges: [],
        metadata: { totalSteps: 1, conditionalBranches: 0, loops: 0, assertions: 0 },
      };
      const out = exportGraph(graph, 'mermaid');
      expect(out).toContain('&quot;Save&quot;');
      expect(out).not.toContain('(now)');
    });

    it('renders labelled branch edges with dotted arrows', () => {
      const graph: TestGraph = {
        nodes: [
          { id: 'a', type: 'condition', label: 'A' },
          { id: 'b', type: 'action', label: 'B' },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', type: 'branch', label: 'true' }],
        metadata: { totalSteps: 0, conditionalBranches: 0, loops: 0, assertions: 0 },
      };
      const out = exportGraph(graph, 'mermaid');
      expect(out).toContain('a -.->');
      expect(out).toContain('"true"');
    });

    it('renders plain edges with solid arrows', () => {
      const graph: TestGraph = {
        nodes: [
          { id: 'a', type: 'action', label: 'A' },
          { id: 'b', type: 'action', label: 'B' },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', type: 'normal' }],
        metadata: { totalSteps: 0, conditionalBranches: 0, loops: 0, assertions: 0 },
      };
      const out = exportGraph(graph, 'mermaid');
      expect(out).toContain('a --> b');
    });

    it('skips nodes without an id and edges missing endpoints', () => {
      const graph: TestGraph = {
        nodes: [{ id: '', type: 'action', label: 'bad' } as any, { id: 'ok', type: 'action', label: 'Good' }],
        edges: [{ id: 'e', source: 'ok', target: '' } as any],
        metadata: { totalSteps: 0, conditionalBranches: 0, loops: 0, assertions: 0 },
      };
      const out = exportGraph(graph, 'mermaid');
      expect(out).toContain('ok[');
      expect(out).not.toContain('bad');
    });

    it('returns a bare header for a malformed graph', () => {
      const out = exportGraph({ nodes: null } as unknown as TestGraph, 'mermaid');
      expect(out).toBe('graph TD\n');
    });
  });
});
