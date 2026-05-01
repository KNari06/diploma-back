/**
 * Static analyzer for the editor lint/apply/run pipeline.
 *
 * Walks a fixed set of source files (the hot path), builds a graph of
 * services -> methods -> outgoing calls, and writes pipeline-graph.json
 * which the viz UI consumes.
 *
 * Run: npm run viz:build       (one shot)
 *      npm run viz:watch       (rebuild on change)
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  Project,
  SourceFile,
  ClassDeclaration,
  MethodDeclaration,
  FunctionDeclaration,
  Node,
  CallExpression,
  SyntaxKind,
} from 'ts-morph';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'dev-tools', 'pipeline-viz', 'pipeline-graph.json');

type Layer =
  | 'snapshot'
  | 'dom-analysis'
  | 'lint'
  | 'locator-plan'
  | 'resolver'
  | 'step-apply'
  | 'run'
  | 'session'
  | 'recording';

interface SourceEntry {
  file: string;
  layer: Layer;
  service?: string;
  hub?: boolean;
}

const SOURCES: SourceEntry[] = [
  { file: 'src/agent/core/lite/collectors/snapshot-collector.ts', layer: 'snapshot', service: 'SnapshotCollector', hub: true },
  { file: 'src/services/testing/ui/preview/dom-analysis-extractor.service.ts', layer: 'dom-analysis', service: 'DomAnalysisExtractorService' },
  { file: 'src/services/testing/ui/preview/intent-step-lint.service.ts', layer: 'lint', service: 'IntentStepLintService' },
  { file: 'src/services/testing/ui/preview/locator-plan-builder.service.ts', layer: 'locator-plan', service: 'LocatorPlanBuilder' },
  { file: 'src/services/testing/ui/preview/element-resolver.service.ts', layer: 'resolver', service: 'ElementResolver', hub: true },
  { file: 'src/services/testing/ui/preview/preview-step-apply.service.ts', layer: 'step-apply', service: 'PreviewStepApplyService', hub: true },
  { file: 'src/services/testing/ui/preview/preview-run.service.ts', layer: 'run', service: 'PreviewRunService', hub: true },
  { file: 'src/services/testing/ui/preview/preview-session.service.ts', layer: 'session', service: 'PreviewSessionService' },
  { file: 'src/services/testing/ui/preview/recording-capture.service.ts', layer: 'recording', service: 'RecordingCaptureService' },
];

const LAYER_ORDER: Layer[] = [
  'snapshot',
  'dom-analysis',
  'lint',
  'locator-plan',
  'resolver',
  'step-apply',
  'run',
  'session',
  'recording',
];

interface MethodNode {
  id: string;
  name: string;
  service: string;
  layer: Layer;
  file: string;
  line: number;
  kind: 'method' | 'function';
  visibility: 'public' | 'private' | 'protected';
  isStatic: boolean;
  isAsync: boolean;
  signature: string;
  emitsWs: string[];
}

interface ServiceNode {
  id: string;
  name: string;
  layer: Layer;
  file: string;
  hub: boolean;
  methodCount: number;
}

interface Edge {
  from: string;
  to: string;
  count: number;
}

interface Graph {
  generatedAt: string;
  layers: Layer[];
  services: ServiceNode[];
  methods: MethodNode[];
  edges: Edge[];
  externalEdges: Edge[];
  unresolved: { from: string; called: string; count: number }[];
  stats: {
    files: number;
    services: number;
    methods: number;
    edges: number;
    unresolved: number;
  };
}

function methodId(service: string, name: string): string {
  return `${service}.${name}`;
}

function shortSignature(node: MethodDeclaration | FunctionDeclaration): string {
  const params = node.getParameters().map((p) => {
    const t = p.getType().getText(p);
    const shortT = t.length > 32 ? t.slice(0, 30) + '…' : t;
    return `${p.getName()}: ${shortT}`;
  });
  const ret = node.getReturnType().getText(node);
  const shortRet = ret.length > 48 ? ret.slice(0, 46) + '…' : ret;
  return `(${params.join(', ')}) => ${shortRet}`;
}

const WS_EMIT_REGEX = /['"`](preview:[a-z0-9:_-]+)['"`]/gi;

function findWsEmits(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = WS_EMIT_REGEX.exec(body)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out).sort();
}

function getMethodBody(node: MethodDeclaration | FunctionDeclaration): string {
  const b = node.getBody();
  return b ? b.getText() : '';
}

function isWithinMethod(call: CallExpression, method: Node): boolean {
  let parent: Node | undefined = call.getParent();
  while (parent) {
    if (parent === method) return true;
    parent = parent.getParent();
  }
  return false;
}

interface CollectedFile {
  source: SourceEntry;
  methods: MethodNode[];
  rawMethodNodes: { node: MethodNode; tsNode: MethodDeclaration | FunctionDeclaration }[];
}

function collectMethods(sf: SourceFile, source: SourceEntry): CollectedFile {
  const methods: MethodNode[] = [];
  const raw: CollectedFile['rawMethodNodes'] = [];

  const declaredService = source.service ?? path.basename(source.file).replace(/\.ts$/, '');

  // class methods
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? declaredService;
    for (const m of cls.getMethods()) {
      const name = m.getName();
      if (!name) continue;
      const visibility = m.hasModifier(SyntaxKind.PrivateKeyword)
        ? 'private'
        : m.hasModifier(SyntaxKind.ProtectedKeyword)
          ? 'protected'
          : 'public';
      const body = getMethodBody(m);
      const node: MethodNode = {
        id: methodId(className, name),
        name,
        service: className,
        layer: source.layer,
        file: source.file,
        line: m.getStartLineNumber(),
        kind: 'method',
        visibility,
        isStatic: m.isStatic(),
        isAsync: m.isAsync(),
        signature: shortSignature(m),
        emitsWs: findWsEmits(body),
      };
      methods.push(node);
      raw.push({ node, tsNode: m });
    }
  }

  // module-level functions (only exported ones — internal helpers we can group later)
  for (const f of sf.getFunctions()) {
    const name = f.getName();
    if (!name) continue;
    if (!f.isExported() && !looksLikeKeyHelper(name)) continue;
    const body = getMethodBody(f);
    const node: MethodNode = {
      id: methodId(declaredService, name),
      name,
      service: declaredService,
      layer: source.layer,
      file: source.file,
      line: f.getStartLineNumber(),
      kind: 'function',
      visibility: 'public',
      isStatic: false,
      isAsync: f.isAsync(),
      signature: shortSignature(f),
      emitsWs: findWsEmits(body),
    };
    methods.push(node);
    raw.push({ node, tsNode: f });
  }

  return { source, methods, rawMethodNodes: raw };
}

// Functions that are internal but worth keeping (resolver waterfall stages, etc.)
const KEY_INTERNAL_HELPERS = new Set<string>([
  'rescueWithGeminiFlash',
  'selectElementWithLLM',
  'resolveScreenshot',
  'buildSceneSummary',
  'shouldUpgradeCompiledPlan',
  'buildBindingHintsFromNode',
  'buildSyntheticFingerprintFromNode',
  'detectModalBlockingFromSession',
  'verifyModalActuallyBlocks',
  'detectOverlayBlockingCandidate',
  'waitForPageSettled',
  'executeWaitFor',
  'dismissParasiticOverlay',
  'captureClickPreState',
  'verifyClickHadEffect',
  'compareToRecordedFingerprint',
  'verifyActionEffect',
  'executeAction',
  'selectFromCustomDropdown',
  'uploadViaFileChooserOrDrop',
  'dispatchFileDrop',
  'classifyNavigationError',
]);

function looksLikeKeyHelper(name: string): boolean {
  return KEY_INTERNAL_HELPERS.has(name);
}

interface Index {
  byId: Map<string, MethodNode>;
  byName: Map<string, MethodNode[]>;
}

function buildIndex(methods: MethodNode[]): Index {
  const byId = new Map<string, MethodNode>();
  const byName = new Map<string, MethodNode[]>();
  for (const m of methods) {
    byId.set(m.id, m);
    const list = byName.get(m.name) ?? [];
    list.push(m);
    byName.set(m.name, list);
  }
  return { byId, byName };
}

function resolveCallTarget(
  call: CallExpression,
  fromMethod: MethodNode,
  index: Index,
  serviceNames: Set<string>,
): { id: string; external: boolean } | { unresolved: string } | null {
  const expr = call.getExpression();

  // foo.bar()
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const lhs = pae.getExpression().getText();
    const name = pae.getName();

    // Service.method  or  serviceInstance.method
    // We try several heuristics.
    const candidates = index.byName.get(name) ?? [];
    if (candidates.length === 0) {
      // skip JS builtins / playwright noise
      if (isNoiseCall(lhs, name)) return null;
      return null;
    }

    // If lhs matches a known service (PascalCase or camelCase variant)
    const lhsService = matchServiceFromLhs(lhs, serviceNames);
    if (lhsService) {
      const exact = candidates.find((c) => c.service === lhsService);
      if (exact) return { id: exact.id, external: exact.service !== fromMethod.service };
    }
    // single candidate name across all services — accept
    if (candidates.length === 1) {
      return { id: candidates[0].id, external: candidates[0].service !== fromMethod.service };
    }
    // multiple candidates, no service hint — best-effort: prefer same service
    const sameService = candidates.find((c) => c.service === fromMethod.service);
    if (sameService) return { id: sameService.id, external: false };
    // ambiguous → unresolved
    return { unresolved: `${lhs}.${name}` };
  }

  // bare call: foo()
  if (expr.getKind() === SyntaxKind.Identifier) {
    const name = expr.getText();
    const candidates = index.byName.get(name) ?? [];
    if (candidates.length === 0) return null;
    const sameService = candidates.find((c) => c.service === fromMethod.service);
    if (sameService) return { id: sameService.id, external: false };
    if (candidates.length === 1) return { id: candidates[0].id, external: candidates[0].service !== fromMethod.service };
    return { unresolved: name };
  }

  return null;
}

const NOISE_LHS = new Set([
  'console',
  'logger',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Promise',
  'Date',
  'Number',
  'String',
  'this.logger',
  'page',
  'context',
  'browser',
]);

function isNoiseCall(lhs: string, _name: string): boolean {
  if (NOISE_LHS.has(lhs)) return true;
  if (lhs.endsWith('.locator') || lhs.endsWith('.evaluate') || lhs.endsWith('.evaluateHandle')) return true;
  return false;
}

function matchServiceFromLhs(lhs: string, serviceNames: Set<string>): string | null {
  // direct
  if (serviceNames.has(lhs)) return lhs;
  // this.foo → infer same-service via caller
  if (lhs === 'this') return null;
  // this.somethingService → strip
  if (lhs.startsWith('this.')) {
    const tail = lhs.slice(5);
    const pascal = tail.charAt(0).toUpperCase() + tail.slice(1);
    if (serviceNames.has(pascal)) return pascal;
  }
  // camelCase variants: domAnalysisExtractor → DomAnalysisExtractorService
  for (const svc of serviceNames) {
    const camel = svc.charAt(0).toLowerCase() + svc.slice(1);
    if (lhs === camel || lhs.endsWith(`.${camel}`)) return svc;
  }
  return null;
}

function build(): Graph {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });

  // add only the files we care about
  for (const s of SOURCES) {
    project.addSourceFileAtPath(path.join(ROOT, s.file));
  }

  const collected: CollectedFile[] = [];
  for (const s of SOURCES) {
    const sf = project.getSourceFileOrThrow(path.join(ROOT, s.file));
    collected.push(collectMethods(sf, s));
  }

  const allMethods = collected.flatMap((c) => c.methods);
  const index = buildIndex(allMethods);
  const serviceNames = new Set<string>(
    collected.map((c) => c.source.service).filter((x): x is string => Boolean(x)),
  );

  const edgeMap = new Map<string, Edge>();
  const externalMap = new Map<string, Edge>();
  const unresolvedMap = new Map<string, { from: string; called: string; count: number }>();

  for (const c of collected) {
    for (const { node: from, tsNode } of c.rawMethodNodes) {
      const calls = tsNode.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        if (!isWithinMethod(call, tsNode)) continue;
        const resolved = resolveCallTarget(call, from, index, serviceNames);
        if (!resolved) continue;
        if ('unresolved' in resolved) {
          const key = `${from.id}→${resolved.unresolved}`;
          const e = unresolvedMap.get(key) ?? { from: from.id, called: resolved.unresolved, count: 0 };
          e.count++;
          unresolvedMap.set(key, e);
          continue;
        }
        const map = resolved.external ? externalMap : edgeMap;
        const key = `${from.id}→${resolved.id}`;
        const existing = map.get(key);
        if (existing) {
          existing.count++;
        } else {
          map.set(key, { from: from.id, to: resolved.id, count: 1 });
        }
      }
    }
  }

  const services: ServiceNode[] = collected.map((c) => ({
    id: c.source.service ?? c.source.file,
    name: c.source.service ?? c.source.file,
    layer: c.source.layer,
    file: c.source.file,
    hub: !!c.source.hub,
    methodCount: c.methods.length,
  }));

  const edges = Array.from(edgeMap.values()).sort((a, b) => b.count - a.count);
  const externalEdges = Array.from(externalMap.values()).sort((a, b) => b.count - a.count);
  const unresolved = Array.from(unresolvedMap.values()).sort((a, b) => b.count - a.count).slice(0, 30);

  return {
    generatedAt: new Date().toISOString(),
    layers: LAYER_ORDER,
    services,
    methods: allMethods,
    edges,
    externalEdges,
    unresolved,
    stats: {
      files: collected.length,
      services: services.length,
      methods: allMethods.length,
      edges: edges.length + externalEdges.length,
      unresolved: unresolved.length,
    },
  };
}

function writeGraph(g: Graph) {
  fs.writeFileSync(OUT, JSON.stringify(g, null, 2));
  console.log(
    `[viz] graph written → ${path.relative(ROOT, OUT)}  ` +
      `${g.stats.services} services · ${g.stats.methods} methods · ` +
      `${g.stats.edges} edges (internal ${g.edges.length} / external ${g.externalEdges.length}) · ` +
      `${g.stats.unresolved} unresolved`,
  );
}

async function watch() {
  const chokidar = await import('chokidar');
  const watched = SOURCES.map((s) => path.join(ROOT, s.file));
  const watcher = chokidar.watch(watched, { ignoreInitial: true });
  console.log(`[viz] watching ${watched.length} files…`);
  let timer: NodeJS.Timeout | null = null;
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        writeGraph(build());
      } catch (e) {
        console.error('[viz] rebuild failed:', (e as Error).message);
      }
    }, 200);
  };
  watcher.on('change', rebuild).on('add', rebuild).on('unlink', rebuild);
  // initial build
  writeGraph(build());
}

function main() {
  if (process.argv.includes('--watch')) {
    void watch();
  } else {
    writeGraph(build());
  }
}

main();
