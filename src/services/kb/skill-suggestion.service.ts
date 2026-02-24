import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { ChatService } from '@/services/utils/chat.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKILL SUGGESTION SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AI-powered analysis for skill suggestions. Two entry points:
 *
 * 1. analyzeMessageForSkill — called when user likes a chat message
 *    Analyzes the message content and sends a skill_suggestion back to chat.
 *
 * 2. suggestFromTestCase — called when user exits AI Editor
 *    Analyzes test case steps and returns suggested skills.
 *
 * Principle: The agent proposes, the user confirms.
 * Nothing is saved to memory without explicit user action.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

interface SkillAnalysisResult {
  isSkillWorthy: boolean;
  key: string;
  content: string;
  category: string;
}

interface SkillSuggestion {
  key: string;
  content: string;
  category: string;
}

const VALID_CATEGORIES = ['fact', 'preference', 'test_pattern', 'bug_pattern', 'integration_context'];

export class SkillSuggestionService {
  /**
   * Analyze a liked message and potentially suggest a skill.
   * Called asynchronously (fire-and-forget) after feedback is saved.
   */
  static async analyzeMessageForSkill(
    messageId: string,
    userId: string,
    sessionId: string
  ): Promise<void> {
    try {
      logger.info('[SKILL_SUGGESTION] Analyzing message for skill', { messageId, sessionId });

      // 1. Load the liked message
      const { data: message, error: msgError } = await supabaseAdmin
        .from('chat_messages')
        .select('id, content, role, session_id, metadata')
        .eq('id', messageId)
        .maybeSingle();

      if (msgError || !message) {
        logger.warn('[SKILL_SUGGESTION] Message not found', { messageId, error: msgError?.message });
        return;
      }

      // Only analyze AI messages
      if (message.role !== 'ai') {
        logger.debug('[SKILL_SUGGESTION] Skipping non-AI message', { messageId, role: message.role });
        return;
      }

      // Skip if message content is too short to be meaningful
      if (!message.content || message.content.trim().length < 50) {
        logger.debug('[SKILL_SUGGESTION] Message too short for analysis', { messageId });
        return;
      }

      // Skip if this message is already a skill suggestion
      if (message.metadata?.type === 'skill_suggestion' || message.metadata?.type === 'skill_saved') {
        logger.debug('[SKILL_SUGGESTION] Skipping skill-related message', { messageId });
        return;
      }

      // 2. Analyze with GPT-4o-mini
      const analysis = await this.analyzeContent(message.content);

      if (!analysis.isSkillWorthy) {
        logger.info('[SKILL_SUGGESTION] Message not skill-worthy', { messageId });
        return;
      }

      // 3. Send skill_suggestion message back to chat
      const suggestionMetadata = {
        type: 'skill_suggestion' as const,
        skill: {
          key: analysis.key,
          content: analysis.content,
          category: analysis.category,
          sourceMessageId: messageId,
        },
      };

      const suggestionContent =
        `I noticed something worth remembering from this conversation.\n\n` +
        `**${analysis.key.replace(/_/g, ' ')}**\n` +
        `${analysis.content}\n\n` +
        `_Category: ${analysis.category}_`;

      // Save to chat
      await ChatService.saveChatMessages(sessionId, [
        { role: 'ai', content: suggestionContent, metadata: suggestionMetadata },
      ]);

      // Emit via WebSocket for real-time update
      webSocketService.emitToChat(sessionId, 'chat:message', {
        message: suggestionContent,
        role: 'ai',
        timestamp: new Date().toISOString(),
        metadata: suggestionMetadata,
      });

      logger.info('[SKILL_SUGGESTION] Skill suggestion sent', {
        messageId,
        sessionId,
        key: analysis.key,
        category: analysis.category,
      });
    } catch (error) {
      // Non-fatal — log and move on
      logger.error('[SKILL_SUGGESTION] analyzeMessageForSkill error', {
        error: error instanceof Error ? error.message : String(error),
        messageId,
        sessionId,
      });
    }
  }

  /**
   * Analyze message content with GPT-4o-mini to determine if it's skill-worthy
   */
  private static async analyzeContent(content: string): Promise<SkillAnalysisResult> {
    try {
      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: `You analyze AI assistant messages to determine if they contain reusable knowledge worth saving as a "skill" for a QA testing agent.

A skill is worth saving if the message contains:
- A testing pattern or best practice specific to the user's application
- A bug pattern or common failure mode discovered during testing
- An integration-specific insight (API behavior, auth flow, specific selectors)
- A user preference or workflow detail relevant to future tests
- A factual finding about the application under test

A skill is NOT worth saving if:
- The message is generic advice not specific to the user's app
- It's a simple confirmation or status update
- It's a question or clarification request
- The information is temporary or one-time

Return a JSON object:
{
  "isSkillWorthy": boolean,
  "key": "snake_case_key (max 50 chars, descriptive)",
  "content": "concise description of the knowledge (max 300 chars)",
  "category": "fact | preference | test_pattern | bug_pattern | integration_context"
}

If NOT skill-worthy: { "isSkillWorthy": false, "key": "", "content": "", "category": "" }`,
          },
          {
            role: 'user',
            content: `Analyze this AI message:\n\n${content.substring(0, 2000)}`,
          },
        ],
        {
          model: AI_TASK_MODELS.skillSuggestion,
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(response.content);
      const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'fact';
      return {
        isSkillWorthy: parsed.isSkillWorthy === true,
        key: String(parsed.key || '').substring(0, 50),
        content: String(parsed.content || '').substring(0, 300),
        category,
      };
    } catch (error) {
      logger.error('[SKILL_SUGGESTION] Content analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { isSkillWorthy: false, key: '', content: '', category: '' };
    }
  }

  /**
   * Suggest skills from a test case (for editor exit flow).
   * Analyzes test steps and returns up to 3 suggestions.
   */
  static async suggestFromTestCase(testCaseId: string): Promise<SkillSuggestion[]> {
    try {
      logger.info('[SKILL_SUGGESTION] Suggesting skills from test case', { testCaseId });

      // Load test case
      const { data: testCase, error: tcError } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, description, start_url, steps_json')
        .eq('id', testCaseId)
        .maybeSingle();

      if (tcError || !testCase) {
        logger.warn('[SKILL_SUGGESTION] Test case not found', { testCaseId, error: tcError?.message });
        return [];
      }

      // Skip if no steps
      const steps = testCase.steps_json;
      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        logger.debug('[SKILL_SUGGESTION] Test case has no steps', { testCaseId });
        return [];
      }

      // Format steps concisely for AI analysis
      const stepsText = steps
        .map((step: any, i: number) => {
          const parts = [`${i + 1}. ${step.action || step.type || 'unknown'}`];
          if (step.target) parts.push(`target: ${step.target}`);
          if (step.value) parts.push(`value: "${String(step.value).substring(0, 50)}"`);
          if (step.assertionText) parts.push(`assert: "${step.assertionText}"`);
          if (step.url) parts.push(`url: ${step.url}`);
          return parts.join(' | ');
        })
        .join('\n');

      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: `You analyze QA test case steps and extract reusable patterns that a testing agent should remember for future tests.

Focus on:
- Login/auth flow specifics (SSO, 2FA, specific form fields)
- Navigation patterns (specific menu paths, URL structures)
- Form validation rules discovered from the steps
- Element interaction quirks (waits, specific selectors, click sequences)
- Page-specific behaviors

Return a JSON object with a "suggestions" array (max 3 items):
{
  "suggestions": [
    {
      "key": "snake_case_key (max 50 chars)",
      "content": "concise reusable knowledge (max 300 chars)",
      "category": "test_pattern | bug_pattern | fact"
    }
  ]
}

If nothing reusable found, return: { "suggestions": [] }

Do NOT suggest generic testing best practices. Only suggest patterns specific to this application.`,
          },
          {
            role: 'user',
            content: `Test: "${testCase.name || 'Untitled'}"\nURL: ${testCase.start_url || 'N/A'}\n${testCase.description ? `Description: ${testCase.description}\n` : ''}\nSteps:\n${stepsText.substring(0, 3000)}`,
          },
        ],
        {
          model: AI_TASK_MODELS.skillSuggestion,
          temperature: 0.3,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(response.content);
      const suggestions: SkillSuggestion[] = Array.isArray(parsed.suggestions)
        ? parsed.suggestions
            .filter((s: any) => s.key && s.content && s.category)
            .slice(0, 3)
            .map((s: any) => ({
              key: String(s.key).substring(0, 50),
              content: String(s.content).substring(0, 300),
              category: VALID_CATEGORIES.includes(s.category) ? s.category : 'test_pattern',
            }))
        : [];

      logger.info('[SKILL_SUGGESTION] Suggestions generated from test case', {
        testCaseId,
        count: suggestions.length,
      });

      return suggestions;
    } catch (error) {
      logger.error('[SKILL_SUGGESTION] suggestFromTestCase error', {
        error: error instanceof Error ? error.message : String(error),
        testCaseId,
      });
      return [];
    }
  }
}
