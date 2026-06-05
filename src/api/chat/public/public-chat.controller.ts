import { readFileSync } from 'fs';
import { join } from 'path';
import { Request, Response } from 'express';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';

/**
 * Public B2C "Ask Me Anything" chat — product Q&A only.
 *
 * Deliberately isolated from the authenticated chat pipeline: NO auth, NO
 * credits, NO DB session, NO tools, NO browser/test execution. It is a single
 * direct LLM call grounded in `product-facts.md`. "Answer-only, no execution"
 * is guaranteed by construction (no tools are ever passed), not by suppressing
 * an agentic loop.
 */

const LANGUAGE_LABEL: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
  kk: 'Kazakh',
};

// product-facts.md is small and changes rarely — read once and cache in memory.
// A server restart picks up edits (documented in the file header).
let cachedFacts: string | null = null;
function getProductFacts(): string {
  if (cachedFacts !== null) return cachedFacts;
  try {
    cachedFacts = readFileSync(join(__dirname, 'product-facts.md'), 'utf-8');
  } catch (err) {
    logger.error('[PUBLIC_CHAT] Failed to read product-facts.md', {
      error: err instanceof Error ? err.message : String(err),
    });
    cachedFacts = ''; // degrade gracefully — prompt still constrains the bot
  }
  return cachedFacts;
}

function buildSystemPrompt(lang: string): string {
  const languageName = LANGUAGE_LABEL[lang] || 'the user’s language';
  return [
    'You are the QAIT website assistant for prospective customers.',
    'Answer questions about the QAIT product ONLY — its features, pricing, limits, integrations, supported platforms, and how to get started.',
    '',
    'Rules:',
    `- Reply in ${languageName}.`,
    '- Use ONLY the facts in the PRODUCT FACTS section below. Do not invent pricing, limits, or features.',
    '- If a fact is not covered (or is unknown/placeholder), say you are not certain and suggest booking a demo or contacting the team — do not guess.',
    '- If asked something unrelated to QAIT, politely steer back to the product.',
    '- You cannot run tests, open browsers, access accounts, or perform any action — you only answer questions.',
    '- Be concise and friendly. A few sentences is ideal.',
    '',
    '--- PRODUCT FACTS ---',
    getProductFacts(),
    '--- END PRODUCT FACTS ---',
  ].join('\n');
}

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_TURNS = 6; // cap context the client can send

/**
 * POST /api/v1/chat/public/ask
 * Body: { message: string, lang?: 'en'|'ru'|'kk', history?: {role,content}[] }
 * Returns: { reply: string }
 */
export async function handlePublicChat(req: Request, res: Response): Promise<void> {
  const rawMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'en';

  if (!rawMessage) {
    res.status(400).json({ success: false, error: 'Message is required' });
    return;
  }
  if (rawMessage.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ success: false, error: 'Message too long' });
    return;
  }

  // Optional short conversation history for follow-ups. Sanitized + capped so a
  // client can't smuggle a giant or malformed context into the prompt.
  const history: ChatCompletionMessageParam[] = Array.isArray(req.body?.history)
    ? req.body.history
        .filter(
          (m: any) =>
            m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.length <= MAX_MESSAGE_LENGTH,
        )
        .slice(-MAX_HISTORY_TURNS)
        .map((m: any) => ({ role: m.role, content: m.content }))
    : [];

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(lang) },
    ...history,
    { role: 'user', content: rawMessage },
  ];

  try {
    const response = await getChatCompletionWithMessages(messages, {
      temperature: 0.3,
      max_tokens: 500,
      // No `tools` → the model literally cannot call anything. Answer-only.
    });

    res.json({ success: true, reply: response.content ?? '' });
  } catch (err) {
    logger.error('[PUBLIC_CHAT] LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ success: false, error: 'Assistant is temporarily unavailable' });
  }
}
