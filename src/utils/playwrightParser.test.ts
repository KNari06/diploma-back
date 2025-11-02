import { PlaywrightStep } from '../types/playwright.types';
import { exportGraph, parsePlaywrightTestSteps } from './playwrightParser';

describe('Playwright Test Parser', () => {
  describe('parsePlaywrightTestSteps', () => {
    it('should parse simple linear flow', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Navigate' },
        { id: '2', type: 'click', label: 'Click button' },
        { id: '3', type: 'assert', label: 'Verify' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(2);
      expect(graph.metadata.totalSteps).toBe(3);
      expect(graph.metadata.assertions).toBe(1);
    });

    it('should add start and end nodes when enabled', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Navigate' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: true });

      expect(graph.nodes).toHaveLength(3); // start + step + end
      expect(graph.nodes[0].type).toBe('start');
      expect(graph.nodes[2].type).toBe('end');
    });

    it('should handle if/else conditional', () => {
      const steps: PlaywrightStep[] = [
        {
          id: '1',
          type: 'if',
          label: 'Check condition',
          children: [
            { id: '2', type: 'click', label: 'If branch' },
          ],
          else: [
            { id: '3', type: 'click', label: 'Else branch' },
          ],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.nodes.length).toBeGreaterThanOrEqual(3); // condition + if + else + merge
      expect(graph.metadata.conditionalBranches).toBe(1);

      // Check for branch edges
      const branchEdges = graph.edges.filter(e => e.type === 'branch');
      expect(branchEdges.length).toBeGreaterThan(0);
    });

    it('should handle if without else', () => {
      const steps: PlaywrightStep[] = [
        {
          id: '1',
          type: 'if',
          label: 'Check condition',
          children: [
            { id: '2', type: 'click', label: 'If branch' },
          ],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
      expect(graph.metadata.conditionalBranches).toBe(1);
    });

    it('should handle loops', () => {
      const steps: PlaywrightStep[] = [
        {
          id: '1',
          type: 'loop',
          label: 'Repeat actions',
          value: 3,
          children: [
            { id: '2', type: 'click', label: 'Click item' },
            { id: '3', type: 'assert', label: 'Verify' },
          ],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.nodes.length).toBeGreaterThanOrEqual(3); // loop + children + exit
      expect(graph.metadata.loops).toBe(1);

      // Check for loop edges
      const loopEdges = graph.edges.filter(e => e.type === 'loop' || e.type === 'return');
      expect(loopEdges.length).toBeGreaterThan(0);
    });

    it('should handle nested if inside loop', () => {
      const steps: PlaywrightStep[] = [
        {
          id: '1',
          type: 'loop',
          label: 'Process items',
          children: [
            {
              id: '2',
              type: 'if',
              label: 'Check availability',
              children: [
                { id: '3', type: 'click', label: 'Add to cart' },
              ],
              else: [
                { id: '4', type: 'click', label: 'Skip' },
              ],
            },
          ],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.metadata.loops).toBe(1);
      expect(graph.metadata.conditionalBranches).toBe(1);
      expect(graph.nodes.length).toBeGreaterThan(4);
    });

    it('should assign correct node types', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Navigate' },
        { id: '2', type: 'click', label: 'Click' },
        { id: '3', type: 'assert', label: 'Assert' },
        { id: '4', type: 'if', label: 'Condition', children: [] },
        { id: '5', type: 'loop', label: 'Loop', children: [] },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      const gotoNode = graph.nodes.find(n => n.stepType === 'goto');
      const clickNode = graph.nodes.find(n => n.stepType === 'click');
      const assertNode = graph.nodes.find(n => n.stepType === 'assert');
      const ifNode = graph.nodes.find(n => n.stepType === 'if');
      const loopNode = graph.nodes.find(n => n.stepType === 'loop');

      expect(gotoNode?.type).toBe('action');
      expect(clickNode?.type).toBe('action');
      expect(assertNode?.type).toBe('assertion');
      expect(ifNode?.type).toBe('condition');
      expect(loopNode?.type).toBe('loop');
    });

    it('should add metadata correctly', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Navigate' },
        { id: '2', type: 'assert', label: 'Assert 1' },
        { id: '3', type: 'expect', label: 'Expect' },
        {
          id: '4',
          type: 'if',
          label: 'Condition',
          children: [{ id: '5', type: 'click', label: 'Click' }],
        },
        {
          id: '6',
          type: 'loop',
          label: 'Loop',
          children: [{ id: '7', type: 'assertVisible', label: 'Check' }],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.metadata.totalSteps).toBe(7);
      expect(graph.metadata.assertions).toBe(3); // assert, expect, assertVisible
      expect(graph.metadata.conditionalBranches).toBe(1);
      expect(graph.metadata.loops).toBe(1);
    });

    it('should add action buttons when enabled', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'click', label: 'Click' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { addButtons: true });

      const node = graph.nodes.find(n => n.stepType === 'click');
      expect(node?.meta?.buttons).toBeDefined();
      expect(node?.meta?.buttons?.length).toBeGreaterThan(0);
    });

    it('should not add buttons when disabled', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'click', label: 'Click' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { addButtons: false });

      const node = graph.nodes.find(n => n.stepType === 'click');
      expect(node?.meta?.buttons).toEqual([]);
    });

    it('should handle empty steps array', () => {
      const steps: PlaywrightStep[] = [];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: true });

      expect(graph.nodes.length).toBe(1); // Only start node
      expect(graph.edges.length).toBe(0);
    });

    it('should assign groups for nested blocks', () => {
      const steps: PlaywrightStep[] = [
        {
          id: '1',
          type: 'if',
          label: 'Condition',
          children: [
            { id: '2', type: 'click', label: 'Nested click' },
          ],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps, { groupNesting: true });

      const nestedNode = graph.nodes.find(n => n.stepType === 'click');
      expect(nestedNode?.group).toBeDefined();
      expect(nestedNode?.group).toContain('if');
    });
  });

  describe('exportGraph', () => {
    it('should export to JSON', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Navigate' },
      ];

      const graph = parsePlaywrightTestSteps(steps);
      const json = exportGraph(graph, 'json');

      expect(json).toBeDefined();
      expect(() => JSON.parse(json)).not.toThrow();

      const parsed = JSON.parse(json);
      expect(parsed.nodes).toBeDefined();
      expect(parsed.edges).toBeDefined();
    });

    it('should export to Mermaid', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Navigate' },
        { id: '2', type: 'click', label: 'Click' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });
      const mermaid = exportGraph(graph, 'mermaid');

      expect(mermaid).toContain('graph TD');
      expect(mermaid).toContain('Navigate');
      expect(mermaid).toContain('Click');
      expect(mermaid).toContain('-->');
    });

    it('should handle conditional branches in Mermaid', () => {
      const steps: PlaywrightStep[] = [
        {
          id: '1',
          type: 'if',
          label: 'Condition',
          children: [{ id: '2', type: 'click', label: 'If branch' }],
        },
      ];

      const graph = parsePlaywrightTestSteps(steps);
      const mermaid = exportGraph(graph, 'mermaid');

      expect(mermaid).toContain('graph TD');
      expect(mermaid).toContain('Condition');
    });
  });

  describe('Edge connections', () => {
    it('should connect nodes sequentially', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Step 1' },
        { id: '2', type: 'click', label: 'Step 2' },
        { id: '3', type: 'assert', label: 'Step 3' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });

      expect(graph.edges).toHaveLength(2);
      expect(graph.edges[0].source).toBe('1');
      expect(graph.edges[0].target).toBe('2');
      expect(graph.edges[1].source).toBe('2');
      expect(graph.edges[1].target).toBe('3');
    });

    it('should have unique edge IDs', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Step 1' },
        { id: '2', type: 'click', label: 'Step 2' },
        { id: '3', type: 'assert', label: 'Step 3' },
      ];

      const graph = parsePlaywrightTestSteps(steps);

      const edgeIds = graph.edges.map(e => e.id);
      const uniqueIds = new Set(edgeIds);
      expect(uniqueIds.size).toBe(edgeIds.length);
    });
  });

  describe('All step types', () => {
    it('should handle all navigation types', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'goto', label: 'Go to page' },
        { id: '2', type: 'goBack', label: 'Go back' },
        { id: '3', type: 'goForward', label: 'Go forward' },
        { id: '4', type: 'reload', label: 'Reload' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });
      expect(graph.nodes).toHaveLength(4);
    });

    it('should handle all interaction types', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'click', label: 'Click' },
        { id: '2', type: 'dblclick', label: 'Double click' },
        { id: '3', type: 'fill', label: 'Fill' },
        { id: '4', type: 'type', label: 'Type' },
        { id: '5', type: 'hover', label: 'Hover' },
        { id: '6', type: 'check', label: 'Check' },
        { id: '7', type: 'uncheck', label: 'Uncheck' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });
      expect(graph.nodes).toHaveLength(7);
    });

    it('should handle all assertion types', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'assert', label: 'Assert' },
        { id: '2', type: 'expect', label: 'Expect' },
        { id: '3', type: 'assertVisible', label: 'Assert visible' },
        { id: '4', type: 'assertHidden', label: 'Assert hidden' },
        { id: '5', type: 'assertText', label: 'Assert text' },
        { id: '6', type: 'assertValue', label: 'Assert value' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });
      expect(graph.metadata.assertions).toBe(6);
    });

    it('should handle custom steps', () => {
      const steps: PlaywrightStep[] = [
        { id: '1', type: 'custom', label: 'Custom action' },
        { id: '2', type: 'script', label: 'Run script' },
        { id: '3', type: 'evaluate', label: 'Evaluate JS' },
      ];

      const graph = parsePlaywrightTestSteps(steps, { includeStartEnd: false });
      expect(graph.nodes).toHaveLength(3);
    });
  });
});
