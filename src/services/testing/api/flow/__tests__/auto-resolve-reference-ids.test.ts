/**
 * autoResolveReferenceIds — replace fabricated entity ids with real ones.
 *
 * Regression guard for "register sends countryId/cityId as invented UUIDs →
 * 400 Country not found". A reference field is linked to a producer of that id,
 * or a matching GET list endpoint is promoted to produce it.
 */

jest.mock('@/services/ai/core/openai.service');

import { __testables } from '../dependency-resolver.service';
import type { DAGNode, VariableExtraction } from '../flow.types';

const { autoResolveReferenceIds } = __testables;

function node(partial: Partial<DAGNode> & { id: string; path: string }): DAGNode {
  return {
    method: 'GET', operationId: partial.id, summary: '', tags: [], dependsOn: [],
    variableExtractions: [], variableInjections: [], priority: 0, isAuthEndpoint: false,
    isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    expectedStatusCodes: [200], ...partial,
  } as unknown as DAGNode;
}

const ext = (variableName: string, jsonPath: string): VariableExtraction => ({ variableName, jsonPath });

describe('autoResolveReferenceIds', () => {
  it('links a fabricated countryId to an existing country_id producer', () => {
    const countries = node({ id: 'findAllCountries', path: '/api/v1/geo/countries', variableExtractions: [ext('country_id', '$[0].id')] });
    const register = node({ id: 'register', method: 'POST', path: '/api/v1/auth/register', sampleRequestBody: { countryId: 'fake-uuid', firstName: 'Jane' } });
    const [reg, ctr] = orderById(autoResolveReferenceIds([register, countries]).nodes, ['register', 'findAllCountries']);
    expect((reg.sampleRequestBody as any).countryId).toBe('{{country_id}}');
    expect((reg.sampleRequestBody as any).firstName).toBe('Jane');
    expect(reg.dependsOn).toContain('findAllCountries');
    expect(ctr.variableExtractions).toHaveLength(1); // unchanged
  });

  it('promotes a matching GET list endpoint to a producer when none exists', () => {
    const cities = node({ id: 'findCities', path: '/api/v1/geo/cities', variableExtractions: [] });
    const register = node({ id: 'register', method: 'POST', path: '/api/v1/auth/register', sampleRequestBody: { cityId: 'fake-uuid' } });
    const result = autoResolveReferenceIds([register, cities]).nodes;
    const reg = result.find(n => n.id === 'register')!;
    const cit = result.find(n => n.id === 'findCities')!;
    expect((reg.sampleRequestBody as any).cityId).toBe('{{city_id}}');
    expect(reg.dependsOn).toContain('findCities');
    expect(cit.variableExtractions).toEqual([{ variableName: 'city_id', jsonPath: '$[0].id' }]);
  });

  it('reuses the array-id jsonPath shape from an existing sibling extraction', () => {
    const countries = node({ id: 'countries', path: '/api/v1/geo/countries', variableExtractions: [ext('country_id', '$.data[0].id')] });
    const cities = node({ id: 'cities', path: '/api/v1/geo/cities', variableExtractions: [] });
    const use = node({ id: 'use', method: 'POST', path: '/x', sampleRequestBody: { cityId: 'fake' } });
    const result = autoResolveReferenceIds([use, countries, cities]).nodes;
    expect(result.find(n => n.id === 'cities')!.variableExtractions).toEqual([{ variableName: 'city_id', jsonPath: '$.data[0].id' }]);
  });

  it('resolves an id reference in a query param', () => {
    const cities = node({ id: 'cities', path: '/api/v1/geo/cities', variableExtractions: [ext('city_id', '$[0].id')] });
    const search = node({ id: 'search', path: '/api/v1/places', sampleQueryParams: { cityId: 'fake' } });
    const result = autoResolveReferenceIds([search, cities]).nodes;
    expect((result.find(n => n.id === 'search')!.sampleQueryParams as any).cityId).toBe('{{city_id}}');
    expect(result.find(n => n.id === 'search')!.dependsOn).toContain('cities');
  });

  it('leaves a reference id alone when neither a producer nor a list endpoint exists', () => {
    const register = node({ id: 'register', method: 'POST', path: '/register', sampleRequestBody: { widgetId: 'fake' } });
    const input = [register];
    const result = autoResolveReferenceIds(input).nodes;
    expect(result[0]).toBe(input[0]);
  });

  it('asks the user for a reference id on an auth-bootstrap node instead of linking to an authed endpoint', () => {
    // register PRODUCES the auth token, so it cannot source countryId from the
    // (authed) countries endpoint — that would be circular. Ask the user.
    const countries = node({ id: 'findAllCountries', path: '/api/v1/geo/countries', variableExtractions: [ext('country_id', '$[0].id')] });
    const register = node({
      id: 'register', method: 'POST', path: '/api/v1/auth/register',
      isAuthEndpoint: true, variableExtractions: [ext('auth_token', '$.accessToken')],
      sampleRequestBody: { countryId: 'fake-uuid', firstName: 'Jane' },
    });
    const { nodes, requiredVars } = autoResolveReferenceIds([register, countries]);
    const reg = nodes.find(n => n.id === 'register')!;
    expect((reg.sampleRequestBody as any).countryId).toBe('{{country_id}}');
    expect(reg.dependsOn).not.toContain('findAllCountries'); // no cycle
    expect(requiredVars).toHaveProperty('country_id', '');
  });

  it('does not touch non-id fields or already-templated placeholders', () => {
    const countries = node({ id: 'countries', path: '/geo/countries', variableExtractions: [ext('country_id', '$[0].id')] });
    const n = node({ id: 'n', method: 'POST', path: '/x', sampleRequestBody: { countryId: '{{country_id}}', name: 'Acme', count: 3 } });
    const result = autoResolveReferenceIds([n, countries]).nodes;
    const body = result.find(x => x.id === 'n')!.sampleRequestBody as any;
    expect(body).toEqual({ countryId: '{{country_id}}', name: 'Acme', count: 3 });
    expect(result.find(x => x.id === 'n')!.dependsOn).toHaveLength(0);
  });
});

// Helper: return nodes in a fixed id order for destructuring.
function orderById(nodes: DAGNode[], ids: string[]): DAGNode[] {
  return ids.map(id => nodes.find(n => n.id === id)!);
}
