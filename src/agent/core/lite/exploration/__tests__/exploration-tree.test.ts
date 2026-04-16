/**
 * ExplorationTree tests — URL normalization, dedup, SPA support, same-template, checkpoint
 */

import { ExplorationTree } from '../exploration-tree';
import type { EntryPoint } from '../types';
import type { LiteSnapshot, LiteElement } from '../../lite-types';

function mkSnapshot(overrides: Partial<LiteSnapshot> = {}): LiteSnapshot {
  return {
    url: 'https://ex.com/',
    title: 'Example',
    elements: [],
    ...overrides,
  } as LiteSnapshot;
}

function mkElement(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    role: 'button',
    tag: 'button',
    name: 'Click me',
    visible: true,
    ...overrides,
  } as LiteElement;
}

function mkEntryPoint(id: string, name: string, goal?: string): EntryPoint {
  return {
    id,
    name,
    goal: goal ?? `goal for ${name}`,
    category: 'other',
    priority: 'medium',
    requiresAuth: false,
    estimatedComplexity: 'medium',
    relatedElements: [],
    sourceNodeId: 'page-0',
    sourcePageUrl: 'https://ex.com',
  };
}

describe('ExplorationTree — URL normalization', () => {
  it('treats URLs with different query strings as same page', () => {
    const tree = new ExplorationTree();
    const id1 = tree.addNode({
      url: 'https://ex.com/dash?x=1',
      title: 'Dash',
      pageType: 'dashboard',
      snapshot: mkSnapshot({ url: 'https://ex.com/dash?x=1' }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    const id2 = tree.addNode({
      url: 'https://ex.com/dash?x=2',
      title: 'Dash',
      pageType: 'dashboard',
      snapshot: mkSnapshot({ url: 'https://ex.com/dash?x=2', elements: [mkElement({ ref: 'diff', name: 'Other' })] }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull(); // deduped by URL
  });

  it('treats trailing slash variants as same page', () => {
    const tree = new ExplorationTree();
    const id1 = tree.addNode({
      url: 'https://ex.com/page',
      title: 'P',
      pageType: 'page',
      snapshot: mkSnapshot(),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    const id2 = tree.addNode({
      url: 'https://ex.com/page/',
      title: 'P',
      pageType: 'page',
      snapshot: mkSnapshot({ elements: [mkElement({ ref: 'different' })] }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
  });

  it('preserves hash routes as distinct pages (#/ prefix)', () => {
    const tree = new ExplorationTree();
    const id1 = tree.addNode({
      url: 'https://ex.com/app#/dashboard',
      title: 'D',
      pageType: 'dashboard',
      snapshot: mkSnapshot({
        url: 'https://ex.com/app#/dashboard',
        elements: [mkElement({ ref: 'a', name: 'Dashboard' })],
      }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    const id2 = tree.addNode({
      url: 'https://ex.com/app#/settings',
      title: 'S',
      pageType: 'settings',
      snapshot: mkSnapshot({
        url: 'https://ex.com/app#/settings',
        elements: [mkElement({ ref: 'b', name: 'Settings' })],
      }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toEqual(id2);
  });

  it('isVisited normalizes URL before comparison', () => {
    const tree = new ExplorationTree();
    tree.addNode({
      url: 'https://ex.com/page?a=1',
      title: '',
      pageType: '',
      snapshot: mkSnapshot(),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(tree.isVisited('https://ex.com/page?b=2')).toBe(true);
    expect(tree.isVisited('https://ex.com/other')).toBe(false);
  });
});

describe('ExplorationTree — SPA content hash', () => {
  it('dedupes same structural content at different URLs', () => {
    const tree = new ExplorationTree();
    const snap = mkSnapshot({
      elements: [
        mkElement({ ref: 'e1', role: 'button', tag: 'button', name: 'Submit' }),
        mkElement({ ref: 'e2', role: 'textbox', tag: 'input', name: 'Email' }),
      ],
    });
    const id1 = tree.addNode({ url: 'https://ex.com/a', title: '', pageType: '', snapshot: snap, entryPoints: [], depth: 0, requiresAuth: false });
    // Different URL but same interactive structure
    const snap2 = { ...snap, url: 'https://ex.com/b' };
    const id2 = tree.addNode({ url: 'https://ex.com/b', title: '', pageType: '', snapshot: snap2, entryPoints: [], depth: 0, requiresAuth: false });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
  });

  it('treats pages with different interactive elements as distinct', () => {
    const tree = new ExplorationTree();
    const id1 = tree.addNode({
      url: 'https://ex.com/p1',
      title: '',
      pageType: '',
      snapshot: mkSnapshot({ elements: [mkElement({ ref: 'a', name: 'Login' })] }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    const id2 = tree.addNode({
      url: 'https://ex.com/p2',
      title: '',
      pageType: '',
      snapshot: mkSnapshot({ elements: [mkElement({ ref: 'b', name: 'Register' })] }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toEqual(id2);
  });

  it('hashes empty snapshot without crashing', () => {
    const tree = new ExplorationTree();
    const id = tree.addNode({
      url: 'https://ex.com/empty',
      title: '',
      pageType: '',
      snapshot: mkSnapshot({ elements: [] }),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(id).not.toBeNull();
  });
});

describe('ExplorationTree — depth + limits', () => {
  it('rejects node beyond MAX_TREE_DEPTH (3)', () => {
    const tree = new ExplorationTree();
    const id = tree.addNode({
      url: 'https://ex.com/deep',
      title: '',
      pageType: '',
      snapshot: mkSnapshot(),
      entryPoints: [],
      depth: 4,
      requiresAuth: false,
    });
    expect(id).toBeNull();
  });

  it('accepts node at exact depth 3', () => {
    const tree = new ExplorationTree();
    const id = tree.addNode({
      url: 'https://ex.com/d3',
      title: '',
      pageType: '',
      snapshot: mkSnapshot(),
      entryPoints: [],
      depth: 3,
      requiresAuth: false,
    });
    expect(id).not.toBeNull();
  });
});

describe('ExplorationTree — same-template detection', () => {
  it('returns false for first 3 same-template pages, true on 4th', () => {
    const tree = new ExplorationTree();
    const parentId = tree.addNode({
      url: 'https://ex.com/list',
      title: '',
      pageType: 'list',
      snapshot: mkSnapshot(),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    })!;
    // Simulate template pages with same tag distribution
    const tmplSnap = mkSnapshot({
      elements: [
        mkElement({ tag: 'a', role: 'link', name: 'Item' }),
        mkElement({ tag: 'a', role: 'link', name: 'Item2' }),
        mkElement({ tag: 'button', role: 'button', name: 'More' }),
      ],
    });
    expect(tree.registerAndCheckSameTemplate(parentId, tmplSnap)).toBe(false);
    expect(tree.registerAndCheckSameTemplate(parentId, tmplSnap)).toBe(false);
    expect(tree.registerAndCheckSameTemplate(parentId, tmplSnap)).toBe(false);
    expect(tree.registerAndCheckSameTemplate(parentId, tmplSnap)).toBe(true);
  });
});

describe('ExplorationTree — entry point dedup', () => {
  it('dedupes entry points with similar goals across pages', () => {
    const tree = new ExplorationTree();
    tree.addNode({
      url: 'https://ex.com/a',
      title: '',
      pageType: '',
      snapshot: mkSnapshot(),
      entryPoints: [mkEntryPoint('ep1', 'Login', 'authenticate user with email and password')],
      depth: 0,
      requiresAuth: false,
    });
    tree.addNode({
      url: 'https://ex.com/b',
      title: '',
      pageType: '',
      snapshot: mkSnapshot({ elements: [mkElement({ ref: 'diff', name: 'Other' })] }),
      entryPoints: [mkEntryPoint('ep2', 'User Sign In', 'authenticate user with email and password')],
      depth: 0,
      requiresAuth: false,
    });
    // Second entry point should be deduped by goal similarity
    expect(tree.getAllEntryPoints()).toHaveLength(1);
  });

  it('keeps entry points with sufficiently different goals', () => {
    const tree = new ExplorationTree();
    tree.addNode({
      url: 'https://ex.com/a',
      title: '',
      pageType: '',
      snapshot: mkSnapshot(),
      entryPoints: [mkEntryPoint('ep1', 'Login', 'authenticate user')],
      depth: 0,
      requiresAuth: false,
    });
    tree.addNode({
      url: 'https://ex.com/b',
      title: '',
      pageType: '',
      snapshot: mkSnapshot({ elements: [mkElement({ ref: 'diff' })] }),
      entryPoints: [mkEntryPoint('ep2', 'Search Product', 'type query and browse catalog results')],
      depth: 0,
      requiresAuth: false,
    });
    expect(tree.getAllEntryPoints()).toHaveLength(2);
  });
});

describe('ExplorationTree — unvisited nav links', () => {
  it('tracks nav links not yet visited', () => {
    const tree = new ExplorationTree();
    tree.registerNavLink('https://ex.com/contact', 'Contact', 'https://ex.com');
    tree.registerNavLink('https://ex.com/about', 'About', 'https://ex.com');
    expect(tree.getUnvisitedNavLinks()).toHaveLength(2);
  });

  it('removes nav links from unvisited once the URL is added as a node', () => {
    const tree = new ExplorationTree();
    tree.registerNavLink('https://ex.com/contact', 'Contact', 'https://ex.com');
    tree.addNode({
      url: 'https://ex.com/contact',
      title: '',
      pageType: '',
      snapshot: mkSnapshot({ url: 'https://ex.com/contact' }),
      entryPoints: [],
      depth: 1,
      requiresAuth: false,
    });
    expect(tree.getUnvisitedNavLinks()).toHaveLength(0);
  });

  it('dedupes nav links by normalized URL', () => {
    const tree = new ExplorationTree();
    tree.registerNavLink('https://ex.com/contact', 'Contact', 'https://ex.com');
    tree.registerNavLink('https://ex.com/contact?utm=x', 'Contact Us', 'https://ex.com');
    expect(tree.getUnvisitedNavLinks()).toHaveLength(1);
  });
});

describe('ExplorationTree — checkpoint roundtrip', () => {
  it('preserves nodes, entry points, visited URLs, and nav links', () => {
    const tree = new ExplorationTree();
    const nodeId = tree.addNode({
      url: 'https://ex.com/p',
      title: 'Page',
      pageType: 'page',
      snapshot: mkSnapshot({ elements: [mkElement({ ref: 'r1' })] }),
      entryPoints: [mkEntryPoint('ep1', 'Click It')],
      depth: 0,
      requiresAuth: false,
    });
    tree.registerNavLink('https://ex.com/other', 'Other', 'https://ex.com/p');

    const cp = tree.toCheckpoint();
    const restored = ExplorationTree.fromCheckpoint(cp);

    expect(restored.getNodeCount()).toBe(1);
    expect(restored.getAllEntryPoints()).toHaveLength(1);
    expect(restored.isVisited('https://ex.com/p')).toBe(true);
    expect(restored.getUnvisitedNavLinks()).toHaveLength(1);
    // Should continue dedup: adding same URL should still fail
    const secondAdd = restored.addNode({
      url: 'https://ex.com/p',
      title: '',
      pageType: '',
      snapshot: mkSnapshot(),
      entryPoints: [],
      depth: 0,
      requiresAuth: false,
    });
    expect(secondAdd).toBeNull();
    expect(nodeId).toBe(cp.nodes[0].id);
  });
});
