/**
 * ChatStore — declarative table set for chat persistence.
 *
 * The chat system supports two parallel storage backends with identical schemas:
 *
 *   - GLOBAL_STORE   → workspace-level chat (chat_sessions / chat_messages / ...)
 *   - TESTCASE_STORE → per-test-case chat (test_case_chat_sessions / ...)
 *
 * The ChatRepository layer takes a `ChatStore` parameter and reads/writes the
 * corresponding tables. This indirection makes it impossible (at the type level)
 * to "forget" which backend a query targets, eliminating silent cross-writes
 * between global chat and test-case chat — the highest-risk failure mode of
 * this whole feature.
 *
 * NEVER instantiate ChatStore objects ad-hoc. Only the two constants below are
 * valid. Adding a third would require schema work, a registry update, and
 * intent-parser plumbing — design choice, not configuration.
 */

export type ChatStoreKind = 'global' | 'testcase';

export type ChatStore = Readonly<{
  /** Discriminator. Lets call sites branch on origin without string comparison. */
  kind: ChatStoreKind;
  /** Sessions table name. */
  sessions: string;
  /** Messages table name. */
  messages: string;
  /** Per-message vector embeddings table name (pgvector, 1536d). */
  embeddings: string;
  /** Compressed older-history summaries table name. */
  summaries: string;
  /** RLHF / 👍👎 feedback table name. */
  feedback: string;
}>;

/** Global workspace chat — the legacy, broadly-shared chat backend. */
export const GLOBAL_STORE: ChatStore = Object.freeze({
  kind: 'global',
  sessions: 'chat_sessions',
  messages: 'chat_messages',
  embeddings: 'chat_message_embeddings',
  summaries: 'chat_summaries',
  feedback: 'message_feedback',
});

/** Per-test-case chat — isolated context, lazy-created on first user message. */
export const TESTCASE_STORE: ChatStore = Object.freeze({
  kind: 'testcase',
  sessions: 'test_case_chat_sessions',
  messages: 'test_case_chat_messages',
  embeddings: 'test_case_chat_message_embeddings',
  summaries: 'test_case_chat_summaries',
  feedback: 'test_case_message_feedback',
});

/** Type guard. Useful at call sites that want to log/branch on origin. */
export const isTestCaseStore = (store: ChatStore): boolean => store.kind === 'testcase';
