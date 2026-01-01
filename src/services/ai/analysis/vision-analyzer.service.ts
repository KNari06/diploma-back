import { buildVisionPrompt } from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * Analyze screenshot using GPT-4o Vision
 */
export async function analyzeScreenshotWithVision(
  screenshotBase64: string,
  context: {
    scope: string;
    url: string;
  }
): Promise<{
  // Core fields (backward compatible)
  elements: Array<{
    type: string;
    purpose: string;
    text: string;
    location: string;
    required: boolean;
    priority: string;
    isCTA?: boolean;
  }>;
  layout: string;
  suggestions: string[];
  // Enhanced fields (new)
  pageType?: string;
  description?: string;
  warnings?: string[];
  modals?: Array<{
    type: string;
    description: string;
    hasCloseButton: boolean;
    closeButtonText: string | null;
  }>;
}> {
  try {
    logger.info('Analyzing screenshot with GPT-4o Vision', {
      scope: context.scope,
      url: context.url,
    });

    const prompt = buildVisionPrompt(context.scope, context.url);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // GPT-4o with vision
      messages: [
        {
          role: 'system',
          content: 'You are an expert QA engineer analyzing web page screenshots to create comprehensive test plans.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${screenshotBase64}`,
                detail: 'high', // High detail for better analysis
              },
            },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.2, // Lower temperature for more consistent analysis
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from Vision API');
    }

    const parsed = JSON.parse(content);

    // ✅ ENHANCED: Validate and sanitize Vision analysis response (matching intelligent-page-analyzer.ts)
    const validatedElements = (parsed.elements || []).filter((el: any) => {
      // Filter out invalid elements
      return el && typeof el === 'object' && el.type && el.purpose;
    }).map((el: any) => ({
      type: el.type || 'other',
      purpose: el.purpose || '',
      text: el.text || '',
      location: el.location || '',
      required: el.required || false,
      priority: el.priority || 'medium',
      isCTA: el.isCTA === true ? true : undefined,
    }));

    logger.info('Screenshot analysis completed', {
      elementsFound: validatedElements.length,
      suggestionsCount: parsed.suggestions?.length || 0,
      pageType: parsed.pageType || 'unknown',
      warningsCount: parsed.warnings?.length || 0,
      modalsCount: parsed.modals?.length || 0,
    });

    // Return enhanced structure with backward compatibility
    return {
      // Core fields (backward compatible)
      elements: validatedElements,
      layout: parsed.layout || parsed.description || 'Unknown layout',
      suggestions: parsed.suggestions || [],
      // Enhanced fields (new)
      pageType: parsed.pageType || 'unknown',
      description: parsed.description || parsed.layout || 'No description',
      warnings: parsed.warnings || [],
      modals: (parsed.modals || []).filter((modal: any) => modal && typeof modal === 'object'),
    };
  } catch (error) {
    logger.error('Vision analysis failed', { error });

    // Fallback to basic structure
    return {
      elements: [],
      layout: 'Could not analyze layout',
      suggestions: ['Perform manual visual inspection'],
      pageType: 'unknown',
      description: 'Vision analysis failed',
      warnings: ['Vision analysis failed'],
      modals: [],
    };
  }
}

/**
 * Build prompt for vision analysis based on scope
 */
// Moved to src/ai/prompts/index.ts

// Legacy function for backward compatibility
function buildVisionPromptLegacy(scope: string, url: string): string {
  let basePrompt = `Analyze this screenshot of a web page (URL: ${url}).

Your task: Identify all interactive elements and provide testing recommendations.

Focus on: ${scope}

Please analyze and return JSON in this exact format:
{
  "elements": [
    {
      "type": "input|button|link|select|checkbox|etc",
      "purpose": "What this element does (e.g., 'email input', 'submit button')",
      "location": "Where on page (e.g., 'top-left form', 'center of page')",
      "required": true/false (if applicable)
    }
  ],
  "layout": "Brief description of page layout and structure",
  "suggestions": [
    "Specific test case suggestions based on what you see"
  ]
}

Important:
- Identify ALL form fields, buttons, and interactive elements
- Note which fields appear to be required (asterisk, 'required' label, red border)
- Suggest specific test cases based on visible elements
- Pay attention to validation messages, error states, or hints
- Note any accessibility features (aria labels, alt text)`;

  // Add scope-specific instructions
  if (scope.toLowerCase().includes('регистрац') || scope.toLowerCase().includes('register')) {
    basePrompt += `\n\nFor registration forms, specifically identify:
- Email/username field
- Password field(s)
- Confirm password field
- Any additional required fields
- Submit button
- Terms/privacy policy checkboxes
- Social login buttons`;
  }

  if (scope.toLowerCase().includes('логин') || scope.toLowerCase().includes('login')) {
    basePrompt += `\n\nFor login forms, specifically identify:
- Email/username field
- Password field
- "Remember me" checkbox
- "Forgot password" link
- Submit button
- Social login options`;
  }

  if (scope.toLowerCase().includes('форм') || scope.toLowerCase().includes('form')) {
    basePrompt += `\n\nFor forms, specifically identify:
- All input fields and their types
- Required vs optional fields
- Validation rules (if visible)
- Submit and cancel buttons
- Any file upload fields
- Dropdown/select fields`;
  }

  return basePrompt;
}

/**
 * Analyze multiple screenshots (for multi-page flows)
 */
export async function analyzeMultipleScreenshots(
  screenshots: Array<{ url: string; screenshot: string; step: string }>
): Promise<Array<{
  url: string;
  step: string;
  analysis: Awaited<ReturnType<typeof analyzeScreenshotWithVision>>;
}>> {
  const results = [];

  for (const { url, screenshot, step } of screenshots) {
    logger.info('Analyzing screenshot for step', { step, url });

    const analysis = await analyzeScreenshotWithVision(screenshot, {
      scope: step,
      url,
    });

    results.push({
      url,
      step,
      analysis,
    });

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}
