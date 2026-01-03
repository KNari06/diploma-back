/**
 * Supabase mock helpers for unit tests
 * Provides chainable query builder mocks
 */

export interface MockQueryResult {
  data: any;
  error: any;
}

/**
 * Create a chainable Supabase query builder mock
 * Usage: mockSupabaseChain({ data: [...], error: null })
 */
export function createSupabaseChainMock(result: MockQueryResult) {
  const chainMock: any = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result),
    maybeSingle: jest.fn().mockResolvedValue(result),
    then: jest.fn((resolve) => resolve(result)),
  };
  return chainMock;
}

/**
 * Create a mock supabaseAdmin client
 */
export function createSupabaseAdminMock(defaultResult: MockQueryResult = { data: null, error: null }) {
  return {
    from: jest.fn(() => createSupabaseChainMock(defaultResult)),
    rpc: jest.fn().mockResolvedValue(defaultResult),
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn().mockResolvedValue({ data: { path: 'test/path.png' }, error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://test.supabase.co/test.png' } }),
      })),
    },
  };
}

/**
 * Mock supabaseAdmin module
 * Use this in jest.mock('@/db/supabase', () => ...)
 */
export function mockSupabaseModule(customAdmin?: ReturnType<typeof createSupabaseAdminMock>) {
  const admin = customAdmin || createSupabaseAdminMock();
  return {
    supabase: admin,
    supabaseAdmin: admin,
    testSupabaseConnection: jest.fn().mockResolvedValue(true),
    testSupabaseAuthHealth: jest.fn().mockResolvedValue({ healthy: true, latency: 50 }),
    dbService: {
      createTest: jest.fn(),
      getTest: jest.fn(),
      updateTest: jest.fn(),
      getTestsByProject: jest.fn(),
      createTestResult: jest.fn(),
      updateTestResult: jest.fn(),
      getTestResults: jest.fn(),
    },
    dbAdminService: {
      createTest: jest.fn(),
      getTest: jest.fn(),
      updateTest: jest.fn(),
    },
  };
}
