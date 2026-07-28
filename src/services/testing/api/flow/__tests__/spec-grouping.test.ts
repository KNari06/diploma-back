/**
 * SPEC GROUPING — narrowing a large API spec into selectable groups.
 *
 * Covers: tag-based grouping (preferred), path-prefix fallback when tags are
 * degenerate, deterministic sort, and that filterSpecByGroup restricts both
 * endpoints and unsupported endpoints to the chosen group.
 */

import {
  LARGE_SPEC_ENDPOINT_THRESHOLD,
  groupEndpointsForSelection,
  subgroupForSelection,
  filterSpecByGroup,
} from '../spec-grouping';
import type { ParsedApiSpec, ParsedEndpoint, UnsupportedEndpoint } from '../flow.types';

function ep(path: string, tags: string[] = [], method: ParsedEndpoint['method'] = 'GET'): ParsedEndpoint {
  return {
    operationId: `${method} ${path}`,
    method,
    path,
    summary: '',
    tags,
    parameters: [],
    responses: { '200': { description: 'ok' } },
    security: [],
  };
}

function spec(endpoints: ParsedEndpoint[], unsupported: UnsupportedEndpoint[] = []): ParsedApiSpec {
  return {
    title: 'Test',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://example.com',
    authSchemes: [],
    sourceType: 'openapi_url',
    endpoints,
    unsupportedEndpoints: unsupported,
  };
}

describe('groupEndpointsForSelection', () => {
  it('groups by tag when tags yield more than one group, largest first', () => {
    const s = spec([
      ep('/admin/a', ['Admin']),
      ep('/admin/b', ['Admin']),
      ep('/admin/c', ['Admin']),
      ep('/students/a', ['Student']),
      ep('/students/b', ['Student']),
    ]);

    const { mode, groups } = groupEndpointsForSelection(s);

    expect(mode).toBe('tag');
    expect(groups).toEqual([
      { name: 'Admin', endpointCount: 3 },
      { name: 'Student', endpointCount: 2 },
    ]);
  });

  it('falls back to path-prefix grouping when the spec has no tags', () => {
    const s = spec([
      ep('/api/v1/users/{id}'),
      ep('/api/v1/users'),
      ep('/api/v2/orders'),
    ]);

    const { mode, groups } = groupEndpointsForSelection(s);

    expect(mode).toBe('path');
    // `api` base + `v1/v2` version + `{id}` param are skipped → users / orders
    expect(groups).toEqual([
      { name: 'users', endpointCount: 2 },
      { name: 'orders', endpointCount: 1 },
    ]);
  });

  it('falls back to path when every endpoint shares a single tag', () => {
    const s = spec([
      ep('/users/a', ['default']),
      ep('/orders/b', ['default']),
    ]);

    const { mode } = groupEndpointsForSelection(s);
    expect(mode).toBe('path');
  });

  it('returns a single group when the spec cannot be split', () => {
    const s = spec([ep('/users/a'), ep('/users/b'), ep('/users/{id}')]);
    const { groups } = groupEndpointsForSelection(s);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ name: 'users', endpointCount: 3 });
  });
});

describe('filterSpecByGroup', () => {
  it('restricts endpoints to the chosen tag group', () => {
    const s = spec([
      ep('/admin/a', ['Admin']),
      ep('/admin/b', ['Admin']),
      ep('/students/a', ['Student']),
    ]);

    const filtered = filterSpecByGroup(s, 'Admin');

    expect(filtered.endpoints.map(e => e.path)).toEqual(['/admin/a', '/admin/b']);
    expect(filtered.title).toBe(s.title); // spec metadata preserved
  });

  it('restricts endpoints and unsupported endpoints by path in path mode', () => {
    const s = spec(
      [ep('/api/v1/users/{id}'), ep('/api/v1/orders')],
      [{ method: 'GET', path: '/api/v1/users/stream', reason: 'sse' }],
    );

    const filtered = filterSpecByGroup(s, 'users');

    expect(filtered.endpoints.map(e => e.path)).toEqual(['/api/v1/users/{id}']);
    expect(filtered.unsupportedEndpoints.map(e => e.path)).toEqual(['/api/v1/users/stream']);
  });

  it('returns an empty endpoint set for an unknown group', () => {
    const s = spec([ep('/admin/a', ['Admin'])]);
    const filtered = filterSpecByGroup(s, 'Nonexistent');
    expect(filtered.endpoints).toHaveLength(0);
  });
});

describe('LARGE_SPEC_ENDPOINT_THRESHOLD', () => {
  it('stays at the documented value', () => {
    expect(LARGE_SPEC_ENDPOINT_THRESHOLD).toBe(300);
  });
});

describe('path-mode does not collapse an over-threshold prefix to one group (#10)', () => {
  it('descends to a deeper path segment when the first collapses everything', () => {
    const eps: ParsedEndpoint[] = [];
    for (let i = 0; i < 160; i++) eps.push(ep(`/api/v1/graphql/users/${i}`));
    for (let i = 0; i < 160; i++) eps.push(ep(`/api/v1/graphql/orders/${i}`));
    const { mode, groups } = groupEndpointsForSelection(spec(eps));

    expect(mode).toBe('path');
    // 320 endpoints all under `graphql` — must NOT be one dead group.
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.map(g => g.name).sort()).toEqual(['graphql/orders', 'graphql/users']);
  });

  it('keeps a small shared prefix as a single group (no needless splitting)', () => {
    const { groups } = groupEndpointsForSelection(spec([ep('/users/a'), ep('/users/b'), ep('/users/{id}')]));
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('users');
  });
});

describe('tag mode assigns unsupported endpoints instead of dropping them (#9)', () => {
  it('keeps a tag group\'s unsupported endpoint and counts it', () => {
    const s = spec(
      [ep('/users/a', ['Users']), ep('/users/b', ['Users']), ep('/orders/a', ['Orders'])],
      [{ method: 'POST', path: '/users/upload', reason: 'unsupported_content_type' }],
    );

    const { groups } = groupEndpointsForSelection(s);
    // `/users/upload` is unrunnable but belongs to Users → counted, not hidden.
    expect(groups.find(g => g.name === 'Users')?.endpointCount).toBe(3);

    const filtered = filterSpecByGroup(s, 'Users');
    expect(filtered.endpoints.map(e => e.path)).toEqual(['/users/a', '/users/b']);
    expect(filtered.unsupportedEndpoints.map(e => e.path)).toEqual(['/users/upload']);
  });
});

describe('sub-grouping round-trips through filterSpecByGroup (#1)', () => {
  it('offers compound children that re-filter to the right subset', () => {
    // An over-threshold tag group (320 endpoints) so sub-grouping actually fires.
    const eps: ParsedEndpoint[] = [];
    for (let i = 0; i < 160; i++) eps.push(ep(`/core/users/${i}`, ['Core']));
    for (let i = 0; i < 160; i++) eps.push(ep(`/core/orders/${i}`, ['Core']));
    eps.push(ep('/other/x', ['Other']));
    const s = spec(eps);

    const coreOnly = filterSpecByGroup(s, 'Core');
    expect(coreOnly.endpoints).toHaveLength(320);

    const { groups } = subgroupForSelection(coreOnly, 'Core');
    const names = groups.map(g => g.name);
    expect(names).toContain('Core ▸ core/users');
    expect(names).toContain('Core ▸ core/orders');

    // The compound name re-applied to the ORIGINAL spec yields exactly that subset.
    const usersSub = filterSpecByGroup(s, 'Core ▸ core/users');
    expect(usersSub.endpoints).toHaveLength(160);
    expect(usersSub.endpoints.every(e => e.path.startsWith('/core/users/'))).toBe(true);
  });
});
