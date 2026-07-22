import { ensureUniqueOperationIds } from '../adapter-utils';
import type { ParsedEndpoint } from '../../flow.types';

const ep = (operationId: string, method = 'GET', path = '/x'): ParsedEndpoint => ({
  operationId,
  method: method as ParsedEndpoint['method'],
  path,
  summary: `${method} ${path}`,
  tags: [],
  parameters: [],
  responses: {},
  security: [],
});

describe('ensureUniqueOperationIds', () => {
  it('leaves already-unique ids untouched', () => {
    const eps = [ep('login'), ep('get_users'), ep('create_user')];
    ensureUniqueOperationIds(eps);
    expect(eps.map(e => e.operationId)).toEqual(['login', 'get_users', 'create_user']);
  });

  it('suffixes a duplicate id, keeping the first occurrence bare', () => {
    const eps = [ep('login'), ep('login')];
    ensureUniqueOperationIds(eps);
    expect(eps.map(e => e.operationId)).toEqual(['login', 'login_2']);
  });

  it('handles three-way and repeated collisions deterministically', () => {
    const eps = [ep('Get_User'), ep('Get_User'), ep('Get_User'), ep('Get_User')];
    ensureUniqueOperationIds(eps);
    expect(eps.map(e => e.operationId)).toEqual(['Get_User', 'Get_User_2', 'Get_User_3', 'Get_User_4']);
  });

  it('does not collide a generated suffix with a pre-existing suffixed id', () => {
    // `a` and `a` would want `a_2`, but `a_2` already exists → skip to `a_3`.
    const eps = [ep('a'), ep('a_2'), ep('a')];
    ensureUniqueOperationIds(eps);
    expect(eps.map(e => e.operationId)).toEqual(['a', 'a_2', 'a_3']);
  });

  it('returns the same array reference (mutates in place)', () => {
    const eps = [ep('x'), ep('x')];
    expect(ensureUniqueOperationIds(eps)).toBe(eps);
  });
});
