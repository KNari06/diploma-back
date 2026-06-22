/**
 * Phase 8 — Per-test-case chat: critical invariants.
 *
 * Scope (deliberate)
 * ──────────────────
 * Unit-level tests for the *architectural invariants* that any future
 * refactor must preserve. NOT a full HTTP/WebSocket integration suite —
 * those need a real Supabase instance and are out of scope for the
 * type-checked-and-merge milestone.
 *
 * Each test corresponds to ONE risk we identified during design:
 *
 *   - Risk #1 (silent cross-write):   ChatPersistence routing tests
 *   - Risk #2 (ownership bypass):     assertCanAccessTestCase tests
 *   - Risk #3 (cancel-key collision): RequestKey namespace tests
 *   - Risk #10 (intent leakage):      intent-parsing blocklist tests
 *   - Lazy-create idempotency:        TestCaseChatService.getOrCreateSession
 *   - Auto-title race safety:         updateTitleIfDefault contract
 *   - WS room contract:               createTestCaseChatRoomName format
 *
 * If any of these fail in the future, frontend/SQL/security guarantees
 * are broken. Treat failures as MUST-FIX before merge — don't disable.
 */

// Mocks must be declared BEFORE the imports they shadow. Jest hoists
// `jest.mock` calls but our manual factories below are referenced
// inside them, so we keep the order as: mocks → imports.

// Hoisted mock state — referenced by both jest.mock factories and tests.
type SaveCall = { table: 'chat_messages' | 'test_case_chat_messages'; sessionId: string; rows: any[] };
const persistenceCalls: SaveCall[] = [];

// Track which underlying service receives a saveMessages call.
// We stub both ChatService (legacy global) and TestCaseChatService
// (per-test-case) so ChatPersistence has somewhere to dispatch.
jest.mock('@/services/utils/chat.service', () => ({
  ChatService: {
    saveChatMessages: jest.fn(async (sessionId: string, rows: any[]) => {
      persistenceCalls.push({ table: 'chat_messages', sessionId, rows });
      return rows.map((_, i) => ({
        id: `msg-${i}`,
        created_at: new Date(Date.now() + i).toISOString(),
      }));
    }),
    getRecentMessages: jest.fn(async () => []),
    autoGenerateTitle: jest.fn(async () => 'Auto title'),
  },
}));

jest.mock('@/services/utils/test-case-chat.service', () => ({
  TestCaseChatService: {
    saveMessages: jest.fn(async (sessionId: string, rows: any[]) => {
      persistenceCalls.push({ table: 'test_case_chat_messages', sessionId, rows });
      return rows.map((_, i) => ({
        id: `tc-msg-${i}`,
        created_at: new Date(Date.now() + i).toISOString(),
      }));
    }),
    getRecentMessages: jest.fn(async () => []),
    autoGenerateTitle: jest.fn(async () => 'TC auto title'),
    findSession: jest.fn(),
    getOrCreateSession: jest.fn(),
    setTitle: jest.fn(),
  },
}));

// Mock supabase admin so assertCanAccessTestCase can drive DB responses
// without a real DB. Each test sets up its own response chain.
const supabaseFromMock = jest.fn();
jest.mock('@/db/supabase', () => ({
  supabaseAdmin: { from: (...args: any[]) => supabaseFromMock(...args) },
}));

// Mock workspace access — used by assertCanAccessTestCase.
const isMemberMock = jest.fn();
jest.mock('@/services/core/workspace-access.service', () => {
  // Re-export AccessDeniedError so callers / instanceof checks work.
  class AccessDeniedError extends Error {
    public readonly code = 'ACCESS_DENIED';
    public readonly statusCode = 403;
    constructor(message = 'Access denied') {
      super(message);
      this.name = 'AccessDeniedError';
    }
  }
  return {
    AccessDeniedError,
    WorkspaceAccessService: {
      isMember: (...args: any[]) => isMemberMock(...args),
    },
  };
});

// ──────────────────────────────────────────────────────────────────────────
// Imports under test (after mocks)
// ──────────────────────────────────────────────────────────────────────────
import {
  GLOBAL_STORE,
  TESTCASE_STORE,
  isTestCaseStore,
  type ChatStore,
} from '@/services/utils/chat-store';
import { ChatPersistence } from '@/services/utils/chat-persistence';
import {
  cancel as registryCancel,
  hasActive as registryHasActive,
  keyOfGlobal,
  keyOfTestCase,
  register as registryRegister,
  unregister as registryUnregister,
  __resetTestCaseRequestsForTests,
} from '@/api/chat/shared/request-key';
import {
  assertCanAccessTestCase,
  TestCaseNotFoundError,
} from '@/api/chat/shared/test-case-access';
import { AccessDeniedError } from '@/services/core/workspace-access.service';
import { createTestCaseChatRoomName } from '@/websocket/types/types';

// Minimal helper to build a maybeSingle()-shaped chain mock.
function chainOf(resolve: { data: any; error: any }) {
  const chain: any = {
    select: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    maybeSingle: jest.fn().mockResolvedValue(resolve),
    single: jest.fn().mockResolvedValue(resolve),
  };
  return chain;
}

beforeEach(() => {
  persistenceCalls.length = 0;
  supabaseFromMock.mockReset();
  isMemberMock.mockReset();
  __resetTestCaseRequestsForTests();
  jest.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// 1. ChatStore — frozen constants, kind discriminator
// ══════════════════════════════════════════════════════════════════════════

describe('ChatStore', () => {
  it('exposes the two canonical stores keyed on the right tables', () => {
    expect(GLOBAL_STORE.kind).toBe('global');
    expect(GLOBAL_STORE.sessions).toBe('chat_sessions');
    expect(GLOBAL_STORE.messages).toBe('chat_messages');
    expect(GLOBAL_STORE.embeddings).toBe('chat_message_embeddings');
    expect(GLOBAL_STORE.summaries).toBe('chat_summaries');
    expect(GLOBAL_STORE.feedback).toBe('message_feedback');

    expect(TESTCASE_STORE.kind).toBe('testcase');
    expect(TESTCASE_STORE.sessions).toBe('test_case_chat_sessions');
    expect(TESTCASE_STORE.messages).toBe('test_case_chat_messages');
    expect(TESTCASE_STORE.embeddings).toBe('test_case_chat_message_embeddings');
    expect(TESTCASE_STORE.summaries).toBe('test_case_chat_summaries');
    expect(TESTCASE_STORE.feedback).toBe('test_case_message_feedback');
  });

  it('freezes the store objects so a runtime patch cannot redirect writes', () => {
    expect(Object.isFrozen(GLOBAL_STORE)).toBe(true);
    expect(Object.isFrozen(TESTCASE_STORE)).toBe(true);
    // Trying to reassign in strict mode throws; in sloppy mode silently
    // no-ops. We verify the value is unchanged after attempted write.
    try {
      (GLOBAL_STORE as any).messages = 'evil_table';
    } catch {
      /* expected in strict mode */
    }
    expect(GLOBAL_STORE.messages).toBe('chat_messages');
  });

  it('isTestCaseStore narrows correctly', () => {
    expect(isTestCaseStore(GLOBAL_STORE)).toBe(false);
    expect(isTestCaseStore(TESTCASE_STORE)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. ChatPersistence — RISK #1 SILENT CROSS-WRITE GUARD (highest priority)
// ══════════════════════════════════════════════════════════════════════════

describe('ChatPersistence — silent cross-write guard', () => {
  const testRows = [
    { role: 'user' as const, content: 'hello' },
    { role: 'ai' as const, content: 'world' },
  ];

  it('routes GLOBAL_STORE writes to chat_messages only', async () => {
    await ChatPersistence.saveMessages(GLOBAL_STORE, 'sess-1', testRows);
    expect(persistenceCalls).toHaveLength(1);
    expect(persistenceCalls[0].table).toBe('chat_messages');
    // CRITICAL: nothing landed in test_case_chat_messages
    expect(persistenceCalls.filter((c) => c.table === 'test_case_chat_messages')).toHaveLength(0);
  });

  it('routes TESTCASE_STORE writes to test_case_chat_messages only', async () => {
    await ChatPersistence.saveMessages(TESTCASE_STORE, 'sess-2', testRows);
    expect(persistenceCalls).toHaveLength(1);
    expect(persistenceCalls[0].table).toBe('test_case_chat_messages');
    // CRITICAL: nothing landed in chat_messages — this is exactly the
    // FK-violation bug we fixed in clarification.ts. If this assertion
    // fails, a saveMessages call on the test-case path is leaking into
    // the global table. Immediate revert candidate.
    expect(persistenceCalls.filter((c) => c.table === 'chat_messages')).toHaveLength(0);
  });

  it('does not silently swap stores between calls (each call is independent)', async () => {
    await ChatPersistence.saveMessages(GLOBAL_STORE, 'g-1', testRows);
    await ChatPersistence.saveMessages(TESTCASE_STORE, 't-1', testRows);
    await ChatPersistence.saveMessages(GLOBAL_STORE, 'g-2', testRows);
    expect(persistenceCalls.map((c) => c.table)).toEqual([
      'chat_messages',
      'test_case_chat_messages',
      'chat_messages',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. RequestKey — RISK #3 NAMESPACE COLLISION GUARD
// ══════════════════════════════════════════════════════════════════════════

describe('RequestKey namespace', () => {
  it('global and testcase keys with the SAME sessionId are independent', async () => {
    const sharedId = 'aaa-shared-id';
    const userId = 'user-1';

    const globalAbort = await registryRegister(keyOfGlobal(sharedId), userId, 'msg');
    const tcAbort = await registryRegister(keyOfTestCase(sharedId), userId, 'msg');

    // Both should be registered (independent maps).
    expect(await registryHasActive(keyOfGlobal(sharedId))).toBe(true);
    expect(await registryHasActive(keyOfTestCase(sharedId))).toBe(true);

    // Cancelling test-case must NOT abort the global controller.
    await registryCancel(keyOfTestCase(sharedId), userId);
    expect(globalAbort.signal.aborted).toBe(false);
    expect(tcAbort.signal.aborted).toBe(true);

    // Test-case map should now be empty.
    expect(await registryHasActive(keyOfTestCase(sharedId))).toBe(false);
    // Global still active.
    expect(await registryHasActive(keyOfGlobal(sharedId))).toBe(true);

    // Cleanup: cancel global so next test starts clean.
    await registryCancel(keyOfGlobal(sharedId), userId);
  });

  it('testcase cancel rejects mismatched userId (defense in depth)', async () => {
    const sid = 'test-case-session-1';
    await registryRegister(keyOfTestCase(sid), 'owner', 'msg');
    const result = await registryCancel(keyOfTestCase(sid), 'someone-else');
    // Owner mismatch → no cancel.
    expect(result.cancelled).toBe(false);
    // The original AbortController must still be alive.
    expect(await registryHasActive(keyOfTestCase(sid))).toBe(true);
  });

  it('cancelling a missing testcase entry returns cancelled:false (no throw)', async () => {
    const result = await registryCancel(keyOfTestCase('never-registered'), 'user-1');
    expect(result.cancelled).toBe(false);
  });

  it('unregister removes the entry so future hasActive returns false', async () => {
    const sid = 't-unreg';
    await registryRegister(keyOfTestCase(sid), 'u', 'm');
    expect(await registryHasActive(keyOfTestCase(sid))).toBe(true);
    await registryUnregister(keyOfTestCase(sid), 'u');
    expect(await registryHasActive(keyOfTestCase(sid))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. assertCanAccessTestCase — RISK #2 OWNERSHIP BYPASS GUARD
// ══════════════════════════════════════════════════════════════════════════

describe('assertCanAccessTestCase', () => {
  const userId = 'caller-user-id';
  const tcId = 'tc-uuid-1';

  function setupTwoTableProbe(opts: {
    testCaseRow?: { user_id: string | null; project_id: string | null } | null;
    projectRow?: { workspace_id: string | null } | null;
  }) {
    // First call: intent_test_cases lookup. Second: projects lookup.
    let callIdx = 0;
    supabaseFromMock.mockImplementation((table: string) => {
      callIdx += 1;
      if (table === 'intent_test_cases') {
        return chainOf({
          data: opts.testCaseRow === undefined ? { id: tcId, user_id: userId, project_id: 'proj-1' } : opts.testCaseRow,
          error: null,
        });
      }
      if (table === 'projects') {
        return chainOf({
          data: opts.projectRow === undefined ? { workspace_id: 'ws-1' } : opts.projectRow,
          error: null,
        });
      }
      throw new Error(`Unexpected supabase.from(${table}) call #${callIdx}`);
    });
  }

  it('throws TestCaseNotFoundError when the test case does not exist', async () => {
    setupTwoTableProbe({ testCaseRow: null });
    await expect(assertCanAccessTestCase(userId, 'missing-tc')).rejects.toBeInstanceOf(
      TestCaseNotFoundError,
    );
  });

  it('takes the owner shortcut without calling workspace.isMember', async () => {
    // Owner of test case == caller → workspace check is skipped.
    setupTwoTableProbe({});
    const access = await assertCanAccessTestCase(userId, tcId);
    expect(access.testCaseOwnerId).toBe(userId);
    expect(access.workspaceId).toBe('ws-1');
    expect(isMemberMock).not.toHaveBeenCalled();
  });

  it('falls through to workspace membership when caller is not the owner', async () => {
    setupTwoTableProbe({
      testCaseRow: { user_id: 'someone-else', project_id: 'proj-1' },
    });
    isMemberMock.mockResolvedValueOnce(true);
    const access = await assertCanAccessTestCase(userId, tcId);
    expect(access.testCaseOwnerId).toBe('someone-else');
    expect(isMemberMock).toHaveBeenCalledWith(userId, 'ws-1');
  });

  it('throws AccessDeniedError when caller is not workspace member', async () => {
    setupTwoTableProbe({
      testCaseRow: { user_id: 'someone-else', project_id: 'proj-1' },
    });
    isMemberMock.mockResolvedValueOnce(false);
    await expect(assertCanAccessTestCase(userId, tcId)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('rejects empty testCaseId with TestCaseNotFoundError (no DB call)', async () => {
    await expect(assertCanAccessTestCase(userId, '')).rejects.toBeInstanceOf(
      TestCaseNotFoundError,
    );
    expect(supabaseFromMock).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. WS room helper — contract surface for frontend
// ══════════════════════════════════════════════════════════════════════════

describe('createTestCaseChatRoomName', () => {
  it('builds the canonical chat:tc:<id> form', () => {
    expect(createTestCaseChatRoomName('abc-123')).toBe('chat:tc:abc-123');
  });

  it('trims whitespace consistently with the legacy createRoomName', () => {
    expect(createTestCaseChatRoomName('  xyz  ')).toBe('chat:tc:xyz');
  });

  it('throws on empty input rather than producing chat:tc:', () => {
    expect(() => createTestCaseChatRoomName('')).toThrow();
    expect(() => createTestCaseChatRoomName('   ')).toThrow();
    expect(() => createTestCaseChatRoomName(undefined as any)).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. ChatPersistence read-path also routes by store
// ══════════════════════════════════════════════════════════════════════════

describe('ChatPersistence — read path routing', () => {
  it('global store → ChatService.getRecentMessages', async () => {
    const { ChatService } = await import('@/services/utils/chat.service');
    await ChatPersistence.getRecentMessages(GLOBAL_STORE, 'sid', 'uid', 5);
    expect(ChatService.getRecentMessages).toHaveBeenCalledWith('sid', 'uid', 5);
  });

  it('testcase store → TestCaseChatService.getRecentMessages (no userId arg)', async () => {
    const { TestCaseChatService } = await import('@/services/utils/test-case-chat.service');
    // Even if the caller passed userId, it must NOT be forwarded into
    // TestCaseChatService — middleware already vetted ownership and
    // re-checking would just cost a round-trip.
    await ChatPersistence.getRecentMessages(TESTCASE_STORE, 'tc-sid', 'uid', 5);
    expect(TestCaseChatService.getRecentMessages).toHaveBeenCalledWith('tc-sid', 5);
  });

  it('autoGenerateTitle routes by store as well', async () => {
    const { ChatService } = await import('@/services/utils/chat.service');
    const { TestCaseChatService } = await import('@/services/utils/test-case-chat.service');
    await ChatPersistence.autoGenerateTitle(GLOBAL_STORE, 'g');
    await ChatPersistence.autoGenerateTitle(TESTCASE_STORE, 't');
    expect(ChatService.autoGenerateTitle).toHaveBeenCalledWith('g');
    expect(TestCaseChatService.autoGenerateTitle).toHaveBeenCalledWith('t');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. Type-level invariant: ChatStore is a discriminated union
// ══════════════════════════════════════════════════════════════════════════

describe('ChatStore type discriminator', () => {
  it('compile-time + runtime: kind discriminator survives narrowing', () => {
    const stores: ChatStore[] = [GLOBAL_STORE, TESTCASE_STORE];
    const kinds = stores.map((s) => (s.kind === 'global' ? 'g' : 't'));
    expect(kinds).toEqual(['g', 't']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. Intent guards — RISK #10 LEAKAGE GUARD
// ──────────────────────────────────────────────────────────────────────────
// We can't `import` the private `blockedInTestCaseScope` set from
// intent-parsing.ts (it's defined inside a closure). Instead we:
//   (a) duplicate the canonical list here as the SOURCE OF TRUTH for
//       "what test-case scope must NOT execute", and
//   (b) cross-reference it against the registry so the universe of
//       intents is fully partitioned into {blocked, allowed}.
//
// If anyone adds a new intent to INTENT_HANDLERS and forgets to either
// (a) block it OR (b) explicitly whitelist it, this test fails. That's
// the whole point — fail loudly so reviewers can decide which side of
// the line a new intent belongs to.
// ══════════════════════════════════════════════════════════════════════════

describe('Intent test-case scope partition', () => {
  // CRITICAL: import the SAME blocklist the runtime guard uses. An
  // earlier version of this test mirrored the set inline — that meant
  // a mutation in intent-parsing.ts (e.g. removing an intent from the
  // runtime blocklist) wouldn't fail this test, because the test's
  // copy was untouched. We caught this gap during mutation testing
  // and refactored intent-parsing.ts to export the constant.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BLOCKED_IN_TEST_CASE_SCOPE } = require('@/api/chat/shared/intent-parsing') as {
    BLOCKED_IN_TEST_CASE_SCOPE: ReadonlySet<string>;
  };

  // Intents that ARE allowed in test-case scope. These either:
  //   (a) are migrated to use ChatPersistence/dual-emit (general_chat,
  //       editor_action, needs_clarification), or
  //   (b) don't write to chat tables at all (analyze_failure,
  //       coverage_analysis, test_recommendations, flaky_report — they
  //       only res.json).
  // Whitelisting keeps the partition explicit so adding a new intent
  // forces a deliberate classification.
  const ALLOWED_IN_TEST_CASE_SCOPE = new Set([
    'general_chat',
    'editor_action',
    'needs_clarification',
    'analyze_failure',
    'coverage_analysis',
    'test_recommendations',
    // Read-only workspace analytics: routes qa_detect_flaky_tests through
    // runManageTool (read tool → no confirm gating, no chat-table writes),
    // identical to the three analytics intents above. Safe inside a test
    // case — it only res.json()s a flakiness report.
    'flaky_report',
    // Mobile editor agents — parallel to web's editor_action. They operate
    // on the LIVE emulator attached to the test-case editor, so they must
    // work in test-case scope. Migrated to ChatPersistence (store threaded
    // through saveMobileChatTurn → handler → registry wrapper), so their
    // turns land in the test-case store, not the global tables.
    'mobile_action',
    'mobile_agent',
  ]);

  it('every registered intent is either explicitly blocked or explicitly allowed', () => {
    // Late require so the registry is loaded after our mocks above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAvailableIntents } = require('@/api/chat/shared/handler-registry');
    const all: string[] = getAvailableIntents();
    const unclassified = all.filter(
      (i) => !BLOCKED_IN_TEST_CASE_SCOPE.has(i) && !ALLOWED_IN_TEST_CASE_SCOPE.has(i),
    );
    // FAILURE here means: a new intent was added to INTENT_HANDLERS but
    // not classified. Decide if it's safe in test-case scope (then add
    // to ALLOWED_IN_TEST_CASE_SCOPE here) or not (then add to the
    // intent-parsing.ts blocklist AND mirror it here).
    expect(unclassified).toEqual([]);
  });

  it('blocked and allowed sets are disjoint (no overlaps)', () => {
    const overlap = [...BLOCKED_IN_TEST_CASE_SCOPE].filter((i) =>
      ALLOWED_IN_TEST_CASE_SCOPE.has(i),
    );
    expect(overlap).toEqual([]);
  });

  it('the canonical test-creating intents are blocked', () => {
    // Sanity check — these are the intents most likely to corrupt the
    // global tables if they ever leaked into test-case scope.
    for (const dangerous of ['platform_test', 'api_test', 'mobile_test', 'run_regression']) {
      expect(BLOCKED_IN_TEST_CASE_SCOPE.has(dangerous)).toBe(true);
    }
  });
});
