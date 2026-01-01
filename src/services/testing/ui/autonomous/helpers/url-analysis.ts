import {
  buildUrlAnalysisPrompt,
  buildUrlAnalysisSystemPrompt,
} from '@/ai/prompts';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';

/**
 * Analyze URL using GPT-4o-mini to provide context-specific insights
 * Helps generateTestPlan create more accurate plans
 * Cost: ~$0.0001-0.0002 per call (GPT-4o-mini)
 */
export async function analyzeUrlContext(url: string): Promise<{
  insights: string[];
  warnings: string[];
  recommendations: string[];
}> {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const pathname = parsedUrl.pathname;
    const searchParams = parsedUrl.search;

    // Build AI prompt using centralized prompt builder
    const prompt = buildUrlAnalysisPrompt({
      url,
      hostname,
      pathname,
      searchParams: searchParams || undefined,
    });

    const response = await getChatCompletionWithMessages(
      [
        {
          role: 'system',
          content: buildUrlAnalysisSystemPrompt(),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: 'gpt-4o-mini',
        temperature: 0.1, // Very low temperature for strict format adherence
        max_tokens: 500,
        response_format: { type: 'json_object' }, // Forces JSON mode
      }
    );

    // Parse AI response (json_object mode guarantees valid JSON)
    const parsed = JSON.parse(response.content);

    // Normalize to arrays and filter non-string items
    const toStringArray = (field: any): string[] => {
      if (!Array.isArray(field)) return [];
      return field.filter(item => typeof item === 'string' && item.trim().length > 0);
    };

    const insights = toStringArray(parsed.insights);
    const warnings = toStringArray(parsed.warnings);
    const recommendations = toStringArray(parsed.recommendations);

    logger.info('[URL_ANALYSIS] AI analysis completed', {
      url: url.substring(0, 100),
      insights: insights.length,
      warnings: warnings.length,
      recommendations: recommendations.length,
      tokens: response.usage.totalTokens,
    });

    return { insights, warnings, recommendations };
  } catch (error) {
    logger.error('[URL_ANALYSIS] AI analysis failed, using fallback', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to basic analysis if AI fails
    return {
      insights: ['URL analysis unavailable'],
      warnings: [],
      recommendations: ['Proceed with standard testing approach'],
    };
  }
}
