// Editor pipeline visualizer.
//
// Two modes:
//   collapsed (default): one node per service, edges aggregated.
//   expanded:            services become parents, methods are inner nodes,
//                        method→method edges shown.
//
// Auto-reload: SSE channel /events fires "graph-updated" when serve.js sees
// pipeline-graph.json change on disk. Runtime overlay: a future tracer can
// POST/WS events with method ids and we'll pulse the matching node.

/* global cytoscape */

const layerOrder = [
  'ws-handler',
  'snapshot',
  'dom-analysis',
  'lint',
  'locator-plan',
  'pruner',
  'resolver',
  'readiness',
  'wait',
  'diagnosis',
  'trace',
  'step-apply',
  'run',
  'session',
  'recording',
];

const layerColor = {
  'ws-handler': '#79c0ff',
  snapshot: '#2f81f7',
  'dom-analysis': '#3fb950',
  lint: '#d29922',
  'locator-plan': '#db61a2',
  pruner: '#e3b341',
  resolver: '#f0883e',
  readiness: '#7ee787',
  wait: '#9ed1ff',
  diagnosis: '#ff9f6d',
  trace: '#a371f7',
  'step-apply': '#bc8cff',
  run: '#ff7b72',
  session: '#56d4dd',
  recording: '#8b949e',
};

const els = {
  status: document.getElementById('status'),
  search: document.getElementById('search'),
  fit: document.getElementById('btn-fit'),
  segButtons: document.querySelectorAll('#seg-mode button'),
  external: document.getElementById('t-external'),
  internal: document.getElementById('t-internal'),
  ws: document.getElementById('t-ws'),
  side: {
    empty: document.getElementById('side-empty'),
    content: document.getElementById('side-content'),
  },
};

let graph = null;
let cy = null;
// modes: 'flow' (client→pipeline→client), 'blocks' (block diagram), 'focus' (one service deep)
let mode = 'flow';
let focusService = null; // service id when in focus mode

async function loadGraph() {
  setStatus('loading…');
  try {
    const res = await fetch(`./pipeline-graph.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    graph = await res.json();
    setStatus(
      `${graph.stats.services} services · ${graph.stats.methods} methods · ${graph.stats.edges} edges · ${
        timeAgo(graph.generatedAt)
      }`,
    );
    render();
  } catch (e) {
    setStatusError(`graph not loaded — run "npm run viz:build" (${e.message})`);
  }
}

function setStatus(msg) {
  els.status.textContent = msg;
  els.status.classList.remove('error');
}
function setStatusError(msg) {
  els.status.textContent = msg;
  els.status.classList.add('error');
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function buildElements() {
  if (!graph) return [];
  if (mode === 'flow') return buildFlowElements();
  if (mode === 'blocks') return buildCollapsedElements();
  return buildExpandedElements();
}

// ---- FLOW MODE ---------------------------------------------------------------
//
// Layout (left → right):
//   col 1: Client Input groups   (mouse, keyboard, page nav, exec, recording, …)
//   col 2: PreviewHandler        (WS dispatch)
//   col 3-7: pipeline blocks     (snapshot/lint/plan/resolver/wait/apply/run)
//   col 8: side-cars             (session, recording, trace)
//   col 9: Client Output groups  (page state, run progress, errors, recording, …)
//
// Inputs are grouped: each group is one node, with hover-listing of events inside.
// Outputs same. Edges:
//   inputGroup  → PreviewHandler          (one per group)
//   PreviewHandler → next pipeline service (aggregated cross-service edges)
//   pipeline service → outputGroup         (one per group whose events are emitted from that service)

const INPUT_GROUPS = [
  { id: 'in:lifecycle', label: 'Lifecycle', events: ['subscribe:preview', 'unsubscribe:preview', 'disconnect'] },
  { id: 'in:input',     label: 'User input', events: ['preview:mouse:move', 'preview:mouse:click', 'preview:mouse:down', 'preview:mouse:up', 'preview:mouse:wheel', 'preview:mouse:probe', 'preview:keyboard:type', 'preview:keyboard:press', 'preview:viewport:set'] },
  { id: 'in:nav',       label: 'Navigation',  events: ['preview:page:refresh', 'preview:page:back', 'preview:page:forward', 'preview:page:reset', 'preview:tab:switch', 'preview:tab:close'] },
  { id: 'in:query',     label: 'Inspect',     events: ['preview:html:request', 'preview:accessibility:request', 'preview:network:list:request', 'preview:network:detail:request', 'preview:session:inspect', 'preview:context:set'] },
  { id: 'in:exec',      label: 'Step exec',   events: ['preview:step:lint', 'preview:step:clarify:select', 'preview:step:apply', 'mobile:step:apply'] },
  { id: 'in:run',       label: 'Run',         events: ['preview:run:start', 'preview:run:cancel'] },
  { id: 'in:rec',       label: 'Recording',   events: ['preview:recording:start', 'preview:recording:stop', 'preview:recording:upload:resolve', 'preview:recording:upload:cancel'] },
];

const OUTPUT_GROUPS = [
  { id: 'out:page',    label: 'Page state',     events: ['preview:page', 'preview:page:navigated', 'preview:viewport', 'preview:tab:opened', 'preview:tab:closed', 'preview:tab:switched', 'preview:loading', 'preview:html:update', 'preview:accessibility:update', 'preview:context:update', 'preview:network:list', 'preview:network:detail', 'preview:dialog', 'preview:dialog:pending', 'preview:download', 'preview:element:hover', 'preview:mouse:probe:result', 'preview:session:state', 'preview:session:progress'] },
  { id: 'out:exec',    label: 'Step result',    events: ['preview:step:lint:result', 'preview:step:apply:result', 'preview:step:clarify', 'mobile:step:apply:result'] },
  { id: 'out:run',     label: 'Run progress',   events: ['preview:run:started', 'preview:run:step', 'preview:run:completed', 'preview:run:cancelled', 'preview:run:auth-reset', 'preview:run:url-mismatch'] },
  { id: 'out:rec',     label: 'Recording',      events: ['preview:recording:state', 'preview:recording:step', 'preview:recording:step:remove', 'preview:recording:step:update', 'preview:recording:warning', 'preview:recording:upload:prompt', 'preview:recording:upload:resolve', 'preview:recording:upload:warning'] },
  { id: 'out:err',     label: 'Errors',         events: ['preview:error'] },
];

function buildFlowElements() {
  const nodes = [];
  const edges = [];

  // ---- columns / positions ----------------------------------------------------
  const COL = 280;
  const ROW = 120;

  // Pipeline mid columns: re-use the COLLAPSED_ROWS structure but rotate so that
  // PreviewHandler sits at col 0 (relative), and the rest cascade right.
  // Easier: hand-place pipeline blocks by stage.
  const STAGES = [
    { x: 1, members: ['PreviewHandler'] },
    { x: 2, members: ['SnapshotCollector', 'DomAnalysisExtractorService'] },
    { x: 3, members: ['IntentStepLintService', 'LocatorPlanBuilder'] },
    { x: 4, members: ['CandidatePrunerLlm', 'ElementResolver'] },
    { x: 5, members: ['StepReadiness', 'AutoWaitFor', 'SmartStepWait', 'StepBlockerDiagnosis'] },
    { x: 6, members: ['PreviewStepApplyService'] },
    { x: 7, members: ['PreviewRunService'] },
  ];
  const SIDECARS_X = 8;
  const SIDECARS = ['PreviewSessionService', 'RecordingCaptureService', 'EditorTraceService'];

  const INPUTS_X = 0;
  const OUTPUTS_X = 9;

  const stagePos = new Map();
  for (const stage of STAGES) {
    const total = stage.members.length;
    stage.members.forEach((id, i) => {
      const yOffset = (i - (total - 1) / 2) * ROW * 0.55;
      stagePos.set(id, { x: stage.x * COL, y: yOffset });
    });
  }

  // ---- input group nodes ------------------------------------------------------
  INPUT_GROUPS.forEach((g, i) => {
    const y = (i - (INPUT_GROUPS.length - 1) / 2) * ROW;
    nodes.push({
      data: {
        id: g.id,
        label: `${g.label}\n(${g.events.length})`,
        kind: 'terminal',
        terminalRole: 'input',
        events: g.events,
      },
      position: { x: INPUTS_X * COL, y },
    });
  });

  // ---- pipeline service nodes -------------------------------------------------
  for (const s of graph.services) {
    let pos;
    if (stagePos.has(s.id)) {
      pos = stagePos.get(s.id);
    } else if (SIDECARS.includes(s.id)) {
      const idx = SIDECARS.indexOf(s.id);
      pos = { x: SIDECARS_X * COL, y: (idx - (SIDECARS.length - 1) / 2) * ROW };
    } else {
      pos = { x: 0, y: 0 };
    }
    nodes.push({
      data: {
        id: s.id,
        label: s.name,
        layer: s.layer,
        hub: s.hub,
        methodCount: s.methodCount,
        kind: 'service',
      },
      position: pos,
    });
  }

  // ---- output group nodes -----------------------------------------------------
  OUTPUT_GROUPS.forEach((g, i) => {
    const y = (i - (OUTPUT_GROUPS.length - 1) / 2) * ROW;
    nodes.push({
      data: {
        id: g.id,
        label: `${g.label}\n(${g.events.length})`,
        kind: 'terminal',
        terminalRole: 'output',
        events: g.events,
      },
      position: { x: OUTPUTS_X * COL, y },
    });
  });

  // ---- inbound edges: input group → PreviewHandler ----------------------------
  // One edge per group, weight = number of events in that group.
  for (const g of INPUT_GROUPS) {
    edges.push({
      data: {
        id: `e:in:${g.id}`,
        source: g.id,
        target: 'PreviewHandler',
        weight: g.events.length,
        kind: 'flow-in-edge',
      },
    });
  }

  // ---- pipeline edges: aggregated service → service ---------------------------
  const agg = new Map();
  const methodToService = new Map(graph.methods.map((m) => [m.id, m.service]));
  for (const e of graph.externalEdges) {
    const a = methodToService.get(e.from);
    const b = methodToService.get(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a}→${b}`;
    agg.set(key, (agg.get(key) ?? 0) + e.count);
  }
  for (const [key, count] of agg.entries()) {
    const [from, to] = key.split('→');
    edges.push({
      data: { id: `e:svc:${key}`, source: from, target: to, weight: count, kind: 'service-edge' },
    });
  }

  // ---- outbound edges: service → output group --------------------------------
  // For each method that emits a WS event, find which output group it belongs to,
  // and add an edge from the method's service to that group.
  const eventToGroup = new Map();
  for (const g of OUTPUT_GROUPS) for (const evt of g.events) eventToGroup.set(evt, g.id);

  const outAgg = new Map(); // serviceId→groupId → count
  for (const m of graph.methods) {
    for (const evt of m.emitsWs) {
      const grp = eventToGroup.get(evt);
      if (!grp) continue;
      const key = `${m.service}→${grp}`;
      outAgg.set(key, (outAgg.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of outAgg.entries()) {
    const [from, to] = key.split('→');
    edges.push({
      data: { id: `e:out:${key}`, source: from, target: to, weight: count, kind: 'flow-out-edge' },
    });
  }

  return [...nodes, ...edges];
}

// Classic vertical block diagram. Each row = one stage of the pipeline.
// Side-cars (session/recording/trace) sit on the right rail, called from many stages.
const COLLAPSED_ROWS = [
  ['PreviewHandler'],                                   // entry
  ['SnapshotCollector', 'DomAnalysisExtractorService'], // observe
  ['IntentStepLintService', 'LocatorPlanBuilder'],      // plan
  ['CandidatePrunerLlm', 'ElementResolver'],            // resolve
  ['StepReadiness', 'AutoWaitFor', 'SmartStepWait', 'StepBlockerDiagnosis'], // wait/diagnose
  ['PreviewStepApplyService'],                          // apply
  ['PreviewRunService'],                                // run
];
const SIDECAR_COLUMN = ['PreviewSessionService', 'RecordingCaptureService', 'EditorTraceService'];

const COL_W = 230;
const ROW_H = 110;
const SIDECAR_X_OFFSET = 110;

function computeCollapsedPositions() {
  const positions = new Map();

  const mainCols = Math.max(...COLLAPSED_ROWS.map((r) => r.length));
  const mainWidth = mainCols * COL_W;

  COLLAPSED_ROWS.forEach((row, ri) => {
    const y = ri * ROW_H;
    const rowWidth = row.length * COL_W;
    const startX = (mainWidth - rowWidth) / 2 + COL_W / 2;
    row.forEach((id, ci) => {
      positions.set(id, { x: startX + ci * COL_W, y });
    });
  });

  // sidecars: vertical column on the right rail
  const railX = mainWidth + SIDECAR_X_OFFSET;
  const totalRows = COLLAPSED_ROWS.length;
  SIDECAR_COLUMN.forEach((id, i) => {
    const y = ((i + 0.5) / SIDECAR_COLUMN.length) * (totalRows * ROW_H) - ROW_H / 2;
    positions.set(id, { x: railX, y });
  });

  return positions;
}

function buildCollapsedElements() {
  const positions = computeCollapsedPositions();

  const nodes = graph.services.map((s) => ({
    data: {
      id: s.id,
      label: s.name,
      layer: s.layer,
      hub: s.hub,
      methodCount: s.methodCount,
      kind: 'service',
    },
    position: positions.get(s.id) ?? { x: 0, y: 0 },
  }));

  // aggregate cross-service edges
  const agg = new Map(); // serviceFrom→serviceTo → count
  const methodToService = new Map(graph.methods.map((m) => [m.id, m.service]));
  for (const e of graph.externalEdges) {
    const a = methodToService.get(e.from);
    const b = methodToService.get(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a}→${b}`;
    agg.set(key, (agg.get(key) ?? 0) + e.count);
  }
  const edges = Array.from(agg.entries()).map(([key, count]) => {
    const [from, to] = key.split('→');
    return {
      data: {
        id: `e:${key}`,
        source: from,
        target: to,
        weight: count,
        kind: 'service-edge',
      },
    };
  });
  return [...nodes, ...edges];
}

// Expanded = focus on one service. Show its methods + neighbouring service stubs.
// dagre handles this layout cleanly because we never use compound parents.
function buildExpandedElements() {
  const focus = focusService ?? graph.services[0].id;
  const includeInternal = els.internal.checked;
  const includeExternal = els.external.checked;

  const focusMethods = graph.methods.filter((m) => m.service === focus);
  const focusIds = new Set(focusMethods.map((m) => m.id));

  // figure out neighbour services touched by edges in/out of focus
  const neighbours = new Set();
  const externalEdgesForFocus = [];
  for (const e of graph.externalEdges) {
    if (focusIds.has(e.from)) {
      const m = graph.methods.find((x) => x.id === e.to);
      if (m) {
        neighbours.add(m.service);
        externalEdgesForFocus.push({ ...e, dir: 'out' });
      }
    } else if (focusIds.has(e.to)) {
      const m = graph.methods.find((x) => x.id === e.from);
      if (m) {
        neighbours.add(m.service);
        externalEdgesForFocus.push({ ...e, dir: 'in' });
      }
    }
  }

  const focusServiceMeta = graph.services.find((s) => s.id === focus);

  const nodes = [
    // header pill (rendered as a service node) for the focused service
    {
      data: {
        id: `focus:${focus}`,
        label: focus,
        layer: focusServiceMeta.layer,
        methodCount: focusServiceMeta.methodCount,
        hub: focusServiceMeta.hub,
        kind: 'service',
        focused: true,
      },
    },
    // method nodes
    ...focusMethods.map((m) => ({
      data: {
        id: m.id,
        label: m.name,
        layer: m.layer,
        service: m.service,
        kind: 'method',
        visibility: m.visibility,
        isAsync: m.isAsync,
        emitsWs: m.emitsWs,
        file: m.file,
        line: m.line,
        signature: m.signature,
      },
    })),
    // neighbour stubs (clickable to refocus)
    ...Array.from(neighbours).map((svcId) => {
      const s = graph.services.find((x) => x.id === svcId);
      return {
        data: {
          id: `stub:${svcId}`,
          label: svcId,
          layer: s?.layer ?? 'session',
          methodCount: s?.methodCount ?? 0,
          kind: 'stub',
        },
      };
    }),
  ];

  const edges = [];

  // intra-service method→method edges
  if (includeInternal) {
    for (const e of graph.edges) {
      if (focusIds.has(e.from) && focusIds.has(e.to)) {
        edges.push({
          data: {
            id: `e:int:${e.from}→${e.to}`,
            source: e.from,
            target: e.to,
            weight: e.count,
            kind: 'internal-edge',
          },
        });
      }
    }
  }

  // method→stub / stub→method
  if (includeExternal) {
    for (const e of externalEdgesForFocus) {
      const otherMethod = graph.methods.find((m) => m.id === (e.dir === 'out' ? e.to : e.from));
      if (!otherMethod) continue;
      const stubId = `stub:${otherMethod.service}`;
      const src = e.dir === 'out' ? e.from : stubId;
      const tgt = e.dir === 'out' ? stubId : e.to;
      const id = `e:ext:${e.dir}:${e.from}→${e.to}`;
      edges.push({
        data: {
          id,
          source: src,
          target: tgt,
          weight: e.count,
          kind: 'external-edge',
          callee: otherMethod.name,
        },
      });
    }
  }

  return [...nodes, ...edges];
}

function styleSheet() {
  return [
    {
      selector: 'node[kind = "service"]',
      style: {
        'background-color': (n) => layerColor[n.data('layer')] ?? '#888',
        'background-opacity': 0.18,
        'border-color': (n) => layerColor[n.data('layer')] ?? '#888',
        'border-width': 1.5,
        'shape': 'round-rectangle',
        'label': (n) => `${n.data('label')}\n${n.data('methodCount')} methods`,
        'color': '#e6edf3',
        'font-size': 12,
        'font-weight': 600,
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-margin-y': 0,
        width: 170,
        height: 56,
        'padding': 8,
      },
    },
    {
      selector: 'node[kind = "service"][?hub]',
      style: { 'border-width': 2.5, 'border-color': '#f0883e' },
    },
    {
      selector: 'node[kind = "service"][?focused]',
      style: {
        'background-opacity': 0.32,
        'border-width': 3,
        width: 220,
        height: 64,
      },
    },
    {
      selector: 'node[kind = "stub"]',
      style: {
        'background-color': '#161b22',
        'background-opacity': 0.6,
        'border-color': (n) => layerColor[n.data('layer')] ?? '#888',
        'border-width': 1,
        'border-style': 'dotted',
        'shape': 'round-rectangle',
        'label': (n) => `${n.data('label')}\n${n.data('methodCount')} methods`,
        'color': '#8b949e',
        'font-size': 10,
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        width: 140,
        height: 40,
        'padding': 6,
      },
    },
    {
      selector: 'node[kind = "group"]',
      style: {
        'background-color': (n) => layerColor[n.data('layer')] ?? '#888',
        'background-opacity': 0.06,
        'border-color': (n) => layerColor[n.data('layer')] ?? '#888',
        'border-width': 1,
        'border-style': 'dashed',
        'shape': 'round-rectangle',
        'label': 'data(label)',
        'color': '#e6edf3',
        'font-size': 12,
        'font-weight': 600,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -6,
        'padding': 14,
      },
    },
    {
      selector: 'node[kind = "method"]',
      style: {
        'background-color': '#161b22',
        'border-color': (n) => layerColor[n.data('layer')] ?? '#888',
        'border-width': 1,
        'shape': 'round-rectangle',
        'label': 'data(label)',
        'color': '#e6edf3',
        'font-size': 11,
        'font-family': 'ui-monospace, SF Mono, Menlo, monospace',
        'text-valign': 'center',
        'text-halign': 'center',
        width: 180,
        height: 28,
        'padding': '6px',
        'text-max-width': 170,
        'text-overflow-wrap': 'anywhere',
      },
    },
    {
      selector: 'node[kind = "method"][?isAsync]',
      style: { 'border-style': 'double', 'border-width': 2 },
    },
    {
      selector: 'node[kind = "method"][visibility = "private"]',
      style: { 'background-color': '#0d1117', 'color': '#8b949e' },
    },
    {
      selector: 'node.has-ws',
      style: { 'border-color': '#a371f7', 'border-width': 2 },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'line-color': '#3a414c',
        'target-arrow-color': '#3a414c',
        width: (e) => Math.min(6, 1 + Math.log2((e.data('weight') || 1) + 1)),
        opacity: 0.75,
      },
    },
    {
      selector: 'edge[kind = "service-edge"]',
      style: {
        'curve-style': mode === 'flow' ? 'bezier' : 'taxi',
        'taxi-direction': mode === 'flow' ? 'horizontal' : 'vertical',
        'taxi-turn': 30,
        'taxi-turn-min-distance': 8,
        'line-color': '#58a6ff',
        'target-arrow-color': '#58a6ff',
        opacity: 0.65,
      },
    },
    {
      selector: 'node[kind = "terminal"]',
      style: {
        'shape': 'round-rectangle',
        'background-color': (n) => n.data('terminalRole') === 'input' ? '#1f3147' : '#3d1f2c',
        'border-color': (n) => n.data('terminalRole') === 'input' ? '#79c0ff' : '#ff7b72',
        'border-width': 1.5,
        'label': 'data(label)',
        'color': '#e6edf3',
        'font-size': 12,
        'font-weight': 600,
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        width: 170,
        height: 56,
        'padding': 8,
      },
    },
    {
      selector: 'edge[kind = "flow-in-edge"]',
      style: {
        'curve-style': 'bezier',
        'line-color': '#79c0ff',
        'target-arrow-color': '#79c0ff',
        'target-arrow-shape': 'triangle',
        opacity: 0.7,
        width: (e) => Math.min(5, 1.2 + Math.log2((e.data('weight') || 1) + 1)),
      },
    },
    {
      selector: 'edge[kind = "flow-out-edge"]',
      style: {
        'curve-style': 'bezier',
        'line-color': '#ff7b72',
        'target-arrow-color': '#ff7b72',
        'target-arrow-shape': 'triangle',
        opacity: 0.55,
        width: (e) => Math.min(5, 1 + Math.log2((e.data('weight') || 1) + 1)),
      },
    },
    {
      selector: 'edge[kind = "external-edge"]',
      style: { 'line-color': '#58a6ff', 'target-arrow-color': '#58a6ff' },
    },
    {
      selector: 'edge[kind = "internal-edge"]',
      style: { 'line-style': 'dashed', 'line-color': '#3a414c', 'target-arrow-color': '#3a414c', opacity: 0.4 },
    },
    {
      selector: '.dim',
      style: { opacity: 0.12 },
    },
    {
      selector: '.highlight',
      style: { 'border-color': '#58a6ff', 'border-width': 3, opacity: 1 },
    },
    {
      selector: 'edge.highlight',
      style: { 'line-color': '#58a6ff', 'target-arrow-color': '#58a6ff', width: 3, opacity: 1 },
    },
    {
      selector: '.active',
      style: {
        'border-color': '#58a6ff',
        'border-width': 3,
        'background-color': '#1f3147',
      },
    },
  ];
}

function layoutFor(mode) {
  if (mode === 'flow' || mode === 'blocks') {
    return { name: 'preset', animate: false, fit: true, padding: 60 };
  }
  // expanded / focus mode: vertical waterfall of methods with stubs on the sides
  return {
    name: 'dagre',
    rankDir: 'LR',
    nodeSep: 14,
    rankSep: 110,
    edgeSep: 10,
    animate: false,
  };
}

function render() {
  if (!graph) return;
  const elements = buildElements();
  if (!cy) {
    cy = cytoscape({
      container: document.getElementById('graph'),
      elements,
      style: styleSheet(),
      layout: layoutFor(mode),
      minZoom: 0.35,
      maxZoom: 2.5,
    });
    cy.on('tap', 'node', (evt) => onNodeTap(evt.target));
    cy.on('tap', (evt) => {
      if (evt.target === cy) clearSelection();
    });
  } else {
    cy.elements().remove();
    cy.add(elements);
    cy.style(styleSheet());
    cy.layout(layoutFor(mode)).run();
  }
  applyWsClass();
  cy.resize();
  cy.fit(undefined, 30);
  window.__viz.cy = cy;
}

function applyWsClass() {
  if (!cy) return;
  const showWs = els.ws.checked;
  cy.nodes('node[kind = "method"]').forEach((n) => {
    const emits = (n.data('emitsWs') || []).length > 0;
    n.toggleClass('has-ws', showWs && emits);
  });
}

function onNodeTap(node) {
  const kind = node.data('kind');
  if (kind === 'terminal') {
    showTerminalPanel(node);
    highlightNeighborhood(node);
    return;
  }
  if (kind === 'service' && (mode === 'flow' || mode === 'blocks')) {
    // dive into focus mode for this service
    focusService = node.data('id');
    setMode('focus');
    return;
  }
  if (kind === 'stub') {
    // jump focus to the neighbour service
    focusService = node.data('label');
    render();
    return;
  }
  if (kind === 'service' && node.data('focused')) {
    // header click → back to flow overview
    focusService = null;
    setMode('flow');
    return;
  }
  showSidePanel(node);
  highlightNeighborhood(node);
}

function showTerminalPanel(node) {
  els.side.empty.hidden = true;
  els.side.content.hidden = false;
  const c = els.side.content;
  c.innerHTML = '';
  const title = document.createElement('h3');
  const role = node.data('terminalRole') === 'input' ? 'Client → server' : 'Server → client';
  title.textContent = `${role}: ${node.data('label').split('\n')[0]}`;
  c.appendChild(title);
  const events = node.data('events') || [];
  const head = document.createElement('div');
  head.className = 'row';
  head.innerHTML = `<span class="k">events</span><span class="v">${events.length}</span>`;
  c.appendChild(head);
  const ul = document.createElement('ul');
  for (const e of events) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = e;
    li.appendChild(code);
    ul.appendChild(li);
  }
  c.appendChild(ul);
}

function clearSelection() {
  if (!cy) return;
  cy.elements().removeClass('dim highlight');
  els.side.empty.hidden = false;
  els.side.content.hidden = true;
}

function highlightNeighborhood(node) {
  cy.elements().addClass('dim').removeClass('highlight');
  const hood = node.closedNeighborhood();
  hood.removeClass('dim').addClass('highlight');
}

function showSidePanel(node) {
  const data = node.data();
  els.side.empty.hidden = true;
  els.side.content.hidden = false;
  const c = els.side.content;
  c.innerHTML = '';

  const title = document.createElement('h3');
  title.textContent = data.kind === 'service' ? data.label : `${data.service}.${data.label}`;
  c.appendChild(title);

  if (data.signature) {
    const sig = document.createElement('div');
    sig.className = 'sig';
    sig.textContent = data.signature;
    c.appendChild(sig);
  }

  const rows = [];
  rows.push(['layer', data.layer]);
  if (data.kind === 'method') {
    rows.push(['file', `${data.file}:${data.line}`]);
    rows.push(['visibility', data.visibility + (data.isAsync ? ' · async' : '')]);
  } else if (data.kind === 'service') {
    rows.push(['methods', data.methodCount]);
    rows.push(['hub', data.hub ? 'yes' : 'no']);
  }
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    r.className = 'row';
    r.innerHTML = `<span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span>`;
    c.appendChild(r);
  }

  if (data.kind === 'method' && data.emitsWs?.length) {
    const h = document.createElement('div');
    h.className = 'row';
    h.innerHTML = `<span class="k">emits</span><span class="v">${data.emitsWs.length}</span>`;
    c.appendChild(h);
    const tags = document.createElement('div');
    for (const e of data.emitsWs) {
      const t = document.createElement('span');
      t.className = 'ws-tag';
      t.textContent = e;
      tags.appendChild(t);
    }
    c.appendChild(tags);
  }

  if (data.kind === 'method') {
    appendCallList(c, 'calls →', incomingOrOutgoing(data.id, 'out'));
    appendCallList(c, '← called by', incomingOrOutgoing(data.id, 'in'));
  } else if (data.kind === 'service') {
    const methods = (graph?.methods || []).filter((m) => m.service === data.id);
    const head = document.createElement('div');
    head.className = 'row';
    head.innerHTML = `<span class="k">members</span><span class="v">${methods.length}</span>`;
    c.appendChild(head);
    const ul = document.createElement('ul');
    for (const m of methods.slice(0, 80)) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = m.name + (m.isAsync ? ' (async)' : '');
      code.dataset.id = m.id;
      code.addEventListener('click', () => focusMethod(m.id));
      li.appendChild(code);
      ul.appendChild(li);
    }
    c.appendChild(ul);
  }
}

function appendCallList(container, label, ids) {
  if (!ids.length) return;
  const head = document.createElement('div');
  head.className = 'row';
  head.innerHTML = `<span class="k">${label}</span><span class="v">${ids.length}</span>`;
  container.appendChild(head);
  const ul = document.createElement('ul');
  for (const id of ids.slice(0, 40)) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = id;
    code.dataset.id = id;
    code.addEventListener('click', () => focusMethod(id));
    li.appendChild(code);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

function incomingOrOutgoing(methodId, dir) {
  const all = [...(graph?.edges || []), ...(graph?.externalEdges || [])];
  const out = new Set();
  for (const e of all) {
    if (dir === 'out' && e.from === methodId) out.add(e.to);
    if (dir === 'in' && e.to === methodId) out.add(e.from);
  }
  return Array.from(out);
}

function focusMethod(id) {
  if (!cy) return;
  if (mode !== 'focus') {
    setMode('focus');
    setTimeout(() => focusMethod(id), 80);
    return;
  }
  const n = cy.getElementById(id);
  if (n.nonempty()) {
    cy.animate({ fit: { eles: n.closedNeighborhood(), padding: 60 } }, { duration: 250 });
    onNodeTap(n);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// search

let searchT = null;
els.search.addEventListener('input', () => {
  if (searchT) clearTimeout(searchT);
  searchT = setTimeout(applySearch, 100);
});
function applySearch() {
  if (!cy || !graph) return;
  const q = els.search.value.trim().toLowerCase();
  if (!q) {
    cy.elements().removeClass('dim highlight');
    return;
  }
  // global search: find first matching method, jump focus to its service
  const found = graph.methods.find(
    (m) => m.name.toLowerCase().includes(q) || m.service.toLowerCase().includes(q),
  );
  if (!found) return;
  if (mode !== 'focus' || focusService !== found.service) {
    focusService = found.service;
    setMode('focus');
    setTimeout(() => highlightSearchInCurrent(q), 80);
  } else {
    highlightSearchInCurrent(q);
  }
}

function highlightSearchInCurrent(q) {
  if (!cy) return;
  const matches = cy.nodes().filter((n) => {
    if (n.data('kind') !== 'method') return false;
    return (n.data('label') || '').toLowerCase().includes(q);
  });
  cy.elements().addClass('dim').removeClass('highlight');
  matches.removeClass('dim').addClass('highlight');
  matches.forEach((n) => n.closedNeighborhood().removeClass('dim'));
  if (matches.length) cy.animate({ fit: { eles: matches, padding: 80 } }, { duration: 250 });
}

// toggles

function setMode(next) {
  mode = next;
  for (const b of els.segButtons) {
    b.classList.toggle('active', b.dataset.mode === next);
  }
  if (next === 'focus' && !focusService) {
    focusService = graph?.services?.[0]?.id ?? null;
  }
  render();
}
for (const b of els.segButtons) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
els.external.addEventListener('change', () => render());
els.internal.addEventListener('change', () => render());
els.ws.addEventListener('change', applyWsClass);
els.fit.addEventListener('click', () => cy && cy.fit(undefined, 30));

// SSE auto-reload
function connectSse() {
  if (!('EventSource' in window)) return;
  const es = new EventSource('/events');
  es.addEventListener('graph-updated', () => {
    loadGraph();
  });
  es.onerror = () => { /* keep retrying via browser default */ };
}

// runtime overlay API.
//
// Tracer side (server) emits {method: "Service.method", phase: "start"|"end", durationMs?, traceId?}
// over SSE event "trace". We pulse the matching node. Methods always identify by `${service}.${method}`.
window.__viz = {
  cy: null,
  pulse(methodId) {
    const c = this.cy;
    if (!c) return false;
    const n = c.getElementById(methodId);
    if (n.empty()) return false;
    n.addClass('active');
    setTimeout(() => n.removeClass('active'), 700);
    return true;
  },
};

// also handle SSE "trace" events if a tracer is wired up
function connectTraceSse() {
  if (!('EventSource' in window)) return;
  const es = new EventSource('/events');
  es.addEventListener('trace', (evt) => {
    try {
      const { method, phase } = JSON.parse(evt.data);
      if (phase === 'start') window.__viz.pulse(method);
    } catch { /* ignored */ }
  });
}

loadGraph();
connectSse();
connectTraceSse();
window.addEventListener('resize', () => { if (cy) { cy.resize(); cy.fit(undefined, 30); } });
setInterval(() => {
  if (graph) setStatus(els.status.textContent.replace(/\b\d+[smh] ago\b/, timeAgo(graph.generatedAt)));
}, 5000);
