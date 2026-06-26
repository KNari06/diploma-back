import { GraphBuilder } from '../graph-builder.service';

const action = (over: any = {}): any => ({
  action: over.action ?? 'click',
  selector: over.selector,
  value: over.value,
  description: over.description,
});

describe('GraphBuilder — start node', () => {
  it('adds a start node and returns a full graph with zeroed metadata', () => {
    const g = new GraphBuilder();
    const update = g.addStartNode();
    expect(update.type).toBe('full');
    expect(update.fullGraph?.nodes).toHaveLength(1);
    expect(update.fullGraph?.nodes[0]).toMatchObject({ id: 'node_1', type: 'start' });
    expect(update.fullGraph?.metadata).toEqual({ totalSteps: 0, completedSteps: 0, failedSteps: 0 });
  });
});

describe('GraphBuilder — action nodes', () => {
  it('adds an action node with an incremental edge from the previous node', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    const update = g.addActionNode(action({ action: 'click', selector: '#btn', description: 'Click button' }));
    expect(update.type).toBe('incremental');
    expect(update.newNode).toMatchObject({ id: 'node_2', type: 'action', stepType: 'click', label: 'Click button' });
    expect(update.newEdge).toMatchObject({ id: 'edge_1', source: 'node_1', target: 'node_2' });
    expect(update.newNode?.meta?.success).toBe(true);
  });

  it('classifies node types (assertion / condition / loop / action)', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    expect(g.addActionNode(action({ action: 'assertVisible' })).newNode?.type).toBe('assertion');
    expect(g.addActionNode(action({ action: 'if' })).newNode?.type).toBe('condition');
    expect(g.addActionNode(action({ action: 'loop' })).newNode?.type).toBe('loop');
    expect(g.addActionNode(action({ action: 'click' })).newNode?.type).toBe('action');
  });

  it('marks a failed action red and counts it as a failed step', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    const update = g.addActionNode(action({ action: 'click' }), { success: false, error: 'not found' } as any);
    expect(update.newNode?.meta?.success).toBe(false);
    expect(update.newNode?.meta?.color).toBe('#F44336');
    expect(g.getMetadata().failedSteps).toBe(1);
  });

  it('annotates retries in the label', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    const update = g.addActionNode(action({ action: 'click', description: 'Login' }), {
      success: true,
      retryCount: 2,
    } as any);
    expect(update.newNode?.label).toContain('retry 2');
    expect(update.newNode?.meta?.retryCount).toBe(2);
  });

  it('detects timeouts from the error text', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    const update = g.addActionNode(action({ action: 'click' }), {
      success: false,
      error: 'Timeout 30000ms exceeded',
    } as any);
    expect(update.newNode?.meta?.isTimeout).toBe(true);
  });

  it('flags a repeated action (same selector + type seen recently)', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    g.addActionNode(action({ action: 'click', selector: '#same' }));
    g.addActionNode(action({ action: 'click', selector: '#same' }));
    const third = g.addActionNode(action({ action: 'click', selector: '#same', description: 'Click' }));
    expect(third.newNode?.meta?.isRepeated).toBe(true);
    expect(third.newNode?.label).toContain('repeated');
    expect(third.newNode?.meta?.warning).toBeDefined();
  });
});

describe('GraphBuilder — updateNodeMeta', () => {
  it('patches an existing node meta', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    const { newNode } = g.addActionNode(action());
    const update = g.updateNodeMeta(newNode!.id, { screenshotAfter: 'https://x/s.png' } as any);
    expect(update?.updatedNode?.meta?.screenshotAfter).toBe('https://x/s.png');
  });

  it('returns null for an unknown node id', () => {
    const g = new GraphBuilder();
    expect(g.updateNodeMeta('missing', {} as any)).toBeNull();
  });
});

describe('GraphBuilder — end node & accessors', () => {
  it('adds an end node and reports totals (excluding start/end)', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    g.addActionNode(action({ action: 'click' }));
    g.addActionNode(action({ action: 'fill' }), { success: false, error: 'x' } as any);
    const end = g.addEndNode(true, 'done', { actionsTaken: 2 });
    expect(end.type).toBe('full');
    expect(end.newNode).toMatchObject({ type: 'end', label: 'Test Completed ✅' });
    expect(end.fullGraph?.metadata).toEqual({ totalSteps: 2, completedSteps: 1, failedSteps: 1 });
  });

  it('labels a failed end node', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    expect(g.addEndNode(false).newNode?.label).toBe('Test Failed ❌');
  });

  it('getGraph returns defensive copies of nodes/edges', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    g.addActionNode(action());
    const snap = g.getGraph();
    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    snap.nodes.push({} as any); // mutating the snapshot must not affect the builder
    expect(g.getGraph().nodes).toHaveLength(2);
  });

  it('getFullGraph exposes node/edge/action counts and start/end ids', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    g.addActionNode(action({ action: 'click' }));
    g.addEndNode(true);
    const full = g.getFullGraph();
    expect(full.metadata).toMatchObject({
      totalNodes: 3,
      totalEdges: 2,
      totalActions: 1,
      startNodeId: 'node_1',
      version: '1.0',
    });
    expect(full.metadata.endNodeId).toBe('node_3');
  });

  it('getMetadata counts completed and failed steps', () => {
    const g = new GraphBuilder();
    g.addStartNode();
    g.addActionNode(action());
    g.addActionNode(action(), { success: false, error: 'x' } as any);
    const meta = g.getMetadata();
    expect(meta.completedSteps).toBe(1);
    expect(meta.failedSteps).toBe(1);
    expect(meta.totalSteps).toBe(3); // start + 2 actions
  });
});
