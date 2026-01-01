import {
  buildCustomScopeStrategyPrompt,
  buildCustomScopeStrategySystemPrompt,
} from '@/ai/prompts';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { VALID_SCOPES } from '@/types';
import { logger } from '@/utils/core/logger';

/**
 * Generate custom scope strategy via AI
 * Used when user provides a scope that's not in VALID_SCOPES
 */
async function generateCustomScopeStrategy(
  customScope: string,
  urlContext?: { insights: string[]; warnings: string[]; recommendations: string[] }
): Promise<{
  description: string;
  estimatedDuration: string;
  focusAreas: string[];
  testTypes: string[];
}> {
  try {
    const prompt = buildCustomScopeStrategyPrompt({
      customScope,
      urlContext,
    });

    const response = await getChatCompletionWithMessages(
      [
        {
          role: 'system',
          content: buildCustomScopeStrategySystemPrompt(),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }
    );

    const parsed = JSON.parse(response.content);

    // Normalize arrays
    const toStringArray = (field: any): string[] => {
      if (!Array.isArray(field)) return [];
      return field.filter(item => typeof item === 'string' && item.trim().length > 0);
    };

    const strategy = {
      description: typeof parsed.description === 'string' ? parsed.description : 'Custom testing scope',
      estimatedDuration: typeof parsed.estimatedDuration === 'string' ? parsed.estimatedDuration : '5-10 minutes',
      focusAreas: toStringArray(parsed.focusAreas),
      testTypes: toStringArray(parsed.testTypes),
    };

    // Ensure we have at least some defaults
    if (strategy.focusAreas.length === 0) {
      strategy.focusAreas = ['Basic functionality', 'User interactions'];
    }
    if (strategy.testTypes.length === 0) {
      strategy.testTypes = ['functional'];
    }

    logger.info('[SCOPE_STRATEGY] AI-generated custom scope strategy', {
      customScope,
      focusAreas: strategy.focusAreas.length,
      testTypes: strategy.testTypes.length,
      tokens: response.usage.totalTokens,
    });

    return strategy;
  } catch (error) {
    logger.error('[SCOPE_STRATEGY] Failed to generate custom scope strategy, using fallback', {
      customScope,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to general strategy
    return {
      description: 'General testing',
      estimatedDuration: '5-10 minutes',
      focusAreas: ['Basic functionality', 'User interactions', 'Visual verification'],
      testTypes: ['functional'],
    };
  }
}

/**
 * Get scope-specific testing strategy
 * Provides detailed guidance for test plan generation
 * Enhanced with URL context insights for better adaptation
 *
 * Uses centralized VALID_SCOPES constant from @/types
 * For invalid scopes, generates custom strategy via AI
 */
export async function getScopeStrategy(
  scope: string,
  urlContext?: { insights: string[]; warnings: string[]; recommendations: string[] }
): Promise<{
  description: string;
  estimatedDuration: string;
  focusAreas: string[];
  testTypes: string[];
}> {
  // Normalize and validate scope using centralized constant
  const normalizedScope = scope?.trim().toLowerCase() || 'general';
  const isValidScope = VALID_SCOPES.includes(normalizedScope as any);
  const strategies: Record<string, any> = {
    'full': {
      description: 'Comprehensive site-wide testing',
      estimatedDuration: '10-15 minutes',
      focusAreas: [
        'All major user journeys',
        'Navigation across sections',
        'Responsive design (desktop/mobile)',
        'Accessibility compliance',
        'Performance on key pages',
        'Cross-browser compatibility',
        'Core platform functionality',
        'Integration points',
        'Platform stability',
      ],
      testTypes: ['functional', 'visual', 'accessibility', 'performance', 'integration', 'smoke'],
    },
    'flow': {
      description: 'Specific user journey testing',
      estimatedDuration: '5-10 minutes',
      focusAreas: [
        'Complete user flow from start to finish',
        'Happy path validation',
        'Error handling scenarios',
        'State persistence across steps',
        'Flow interruption and recovery',
      ],
      testTypes: ['functional', 'integration', 'error-handling'],
    },
    'page': {
      description: 'Single page deep testing',
      estimatedDuration: '3-5 minutes',
      focusAreas: [
        'All interactive elements',
        'Page-specific functionality',
        'Responsive behavior',
        'Accessibility features',
        'Page load performance',
      ],
      testTypes: ['functional', 'visual', 'accessibility'],
    },
    'element': {
      description: 'Element-level focused testing',
      estimatedDuration: '2-3 minutes',
      focusAreas: [
        'Element visibility and interaction',
        'Element states (enabled/disabled)',
        'Element accessibility',
        'Element responsiveness',
        'Edge cases and error states',
      ],
      testTypes: ['functional', 'accessibility'],
    },
    'form': {
      description: 'Form functionality testing',
      estimatedDuration: '3-5 minutes',
      focusAreas: [
        'Form validation rules',
        'Input field interactions',
        'Form submission flow',
        'Error message display',
        'Required vs optional fields',
        'Form accessibility',
      ],
      testTypes: ['functional', 'accessibility', 'validation'],
    },
    'auth': {
      description: 'Authentication process testing',
      estimatedDuration: '3-5 minutes',
      focusAreas: [
        'Login flow validation',
        'Password reset functionality',
        'Session management',
        'Error handling (wrong credentials)',
        'Security measures',
        'Authentication accessibility',
      ],
      testTypes: ['functional', 'security', 'accessibility'],
    },
    'navigation': {
      description: 'Navigation and menu testing',
      estimatedDuration: '2-4 minutes',
      focusAreas: [
        'Menu functionality',
        'Breadcrumb navigation',
        'Link validation',
        'Routing behavior',
        'Navigation accessibility',
        'Mobile vs desktop navigation',
      ],
      testTypes: ['functional', 'accessibility'],
    },
  };

  // Generate custom strategy via AI for invalid scopes
  if (!isValidScope && normalizedScope !== 'general') {
    logger.info('[SCOPE_STRATEGY] Generating custom scope strategy via AI', {
      provided: scope,
      normalized: normalizedScope,
      validScopes: VALID_SCOPES,
    });
    return await generateCustomScopeStrategy(normalizedScope, urlContext);
  }

  const validScope = isValidScope ? normalizedScope : 'general';
  const baseStrategy = strategies[validScope] || {
    description: 'General testing',
    estimatedDuration: '5-10 minutes',
    focusAreas: ['Basic functionality', 'User interactions', 'Visual verification'],
    testTypes: ['functional'],
  };

  // Adapt strategy based on URL context (if provided)
  if (urlContext && urlContext.recommendations.length > 0) {
    // Add URL-specific recommendations to focus areas (keep unique)
    const urlSpecificFocus = urlContext.recommendations.slice(0, 3); // Top 3 recommendations
    const combinedFocusAreas = [...baseStrategy.focusAreas, ...urlSpecificFocus];
    // Remove duplicates while preserving order
    const uniqueFocusAreas = Array.from(new Set(combinedFocusAreas));

    return {
      ...baseStrategy,
      focusAreas: uniqueFocusAreas,
    };
  }

  return baseStrategy;
}
