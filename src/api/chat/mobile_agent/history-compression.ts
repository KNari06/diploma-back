/**
 * Pure conversation-history compression for the mobile agent.
 *
 * Extracted from the handler so it's unit-testable without a DB. Given prior
 * turns (oldest→newest, already role-mapped + redacted), keep the most recent
 * `verbatimCount` as full turns and condense everything older into ONE system
 * "earlier conversation" block. Deterministic truncation — no LLM call — so a
 * reference to a much earlier turn still lands within the token budget.
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompressHistoryOptions {
  /** Recent turns kept verbatim. Default 8. */
  verbatimCount?: number;
  /** Max chars per compressed line. Default 160. */
  previewChars?: number;
}

export function compressHistoryTurns(
  turns: HistoryTurn[],
  opts: CompressHistoryOptions = {},
): ChatCompletionMessageParam[] {
  const verbatimCount = opts.verbatimCount ?? 8;
  const previewChars = opts.previewChars ?? 160;

  if (turns.length === 0) return [];
  // Short history → all verbatim.
  if (turns.length <= verbatimCount) {
    return turns as ChatCompletionMessageParam[];
  }

  const older = turns.slice(0, -verbatimCount);
  const recent = turns.slice(-verbatimCount);
  const lines = older.map((t) => {
    const who = t.role === 'user' ? 'User' : 'Assistant';
    const body = t.content.replace(/\s+/g, ' ').trim();
    const preview = body.length > previewChars ? `${body.slice(0, previewChars)}…` : body;
    return `${who}: ${preview}`;
  });
  const summary: ChatCompletionMessageParam = {
    role: 'system',
    content:
      '--- Earlier conversation (older turns, condensed) ---\n' +
      lines.join('\n') +
      '\n--- End of earlier context. Recent turns follow verbatim. ---',
  };
  return [summary, ...(recent as ChatCompletionMessageParam[])];
}
