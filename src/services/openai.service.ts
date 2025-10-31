import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Get chat completion from OpenAI
 * @param prompt - User message
 * @param context - Optional context for RAG (future feature)
 * @returns AI response
 */
export async function getChatCompletion(prompt: string, context?: string): Promise<string> {
  try {
    const systemPrompt = `Ты AI-тестер на платформе QAI. Помогай пользователям генерировать тесты, анализировать результаты, тестировать API. Отвечай кратко, по делу и мягко.

ВОЗМОЖНОСТИ ПЛАТФОРМЫ:
- Тестирование UI элементов и веб-страниц
- Тестирование API через естественный язык
- Генерация тестовых сценариев

КАК ТЕСТИРОВАТЬ API:
Пользователь может просто описать что нужно протестировать, например:
- "Проверь, что GET запрос на https://api.example.com/users возвращает статус 200"
- "Сделай POST запрос на /api/login с телом {"email":"test@test.com"} и проверь что возвращает 401"
- "Протестируй GET https://api.myapp.com/data"

Когда пользователь просит протестировать API, объясни ему что он может просто описать запрос естественным языком, и я автоматически выполню его.

Если пользователь спрашивает про возможности или как что-то сделать - объясни кратко и по делу.`;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add context if provided (for future RAG integration)
    if (context) {
      messages.push({
        role: 'system',
        content: `Контекст: ${context}`,
      });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: env.OPENAI_MAX_TOKENS || 1000,
      temperature: 0.5, // Softer, more balanced responses
    });

    const reply = response.choices[0]?.message?.content || '🤖 Не понял запрос.';

    logger.info('Chat completion successful', { promptLength: prompt.length, replyLength: reply.length });

    return reply;
  } catch (error) {
    logger.error('Chat completion error:', error);
    throw new Error('AI chat failed');
  }
}
