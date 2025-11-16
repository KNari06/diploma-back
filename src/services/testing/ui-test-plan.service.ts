/**
 * UI Test Plan Service
 * Generates intelligent UI test plans using AI analysis
 * Replaces hardcoded test plans with adaptive, context-aware plans
 */

import { buildUiTestPlanPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { logger } from '@/utils/logger';
import { TestPlan } from './test-plan-generator.service';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const FALLBACK_DURATION = '5-10 minutes';
const FALLBACK_PAGES = '3-8 pages';
const FALLBACK_COST = '$0.05-0.20';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface UiTestPlanParams {
  url: string;
  scope: string;
  target?: string;
  userMessage: string;
  hasCredentials: boolean;
  projectContext?: {
    name?: string;
    previousTests?: string[];
    knownIssues?: string[];
  };
}

interface GPTTestPlanResponse {
  summary: string;
  steps: Array<{
    id: string;
    description: string;
    action: string;
    expectedOutcome: string;
    selector?: string;
    value?: string;
  }>;
  commands: Array<{
    action: string;
    selector?: string;
    value?: string;
    url?: string;
    description: string;
  }>;
  estimated_duration: string;
  what_will_be_tested: string[];
  what_will_not_be_tested: string[];
  risks: string[];
  estimated_pages?: string;
  estimated_cost?: string;
  intelligent_mode?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class UiTestPlanService {
  /**
   * Generate comprehensive UI test plan using AI
   * Analyzes user request, URL, and context to create adaptive test plan
   */
  static async generateUiTestPlan(params: UiTestPlanParams): Promise<TestPlan> {
    const startTime = Date.now();

    try {
      logger.info('[UI_TEST_PLAN] Generating AI test plan', {
        url: params.url,
        scope: params.scope,
        target: params.target,
        hasCredentials: params.hasCredentials,
        userMessage: params.userMessage.substring(0, 100),
      });

      // Build comprehensive prompt with all context
      const prompt = this.buildEnhancedPrompt(params);

      // Generate plan using GPT-4o (better for complex reasoning)
      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: this.buildSystemPrompt(),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          model: 'gpt-4o', // Use GPT-4o for better quality
          temperature: 0.3, // Low temperature for consistent results
          max_tokens: 4000, // Allow detailed plans
          response_format: { type: 'json_object' },
        }
      );

      // Parse and validate GPT response
      const gptPlan = this.parseAndValidateGPTResponse(response.content);

      // Create normalized TestPlan
      const testPlan = this.createNormalizedTestPlan(params, gptPlan);

      const duration = Date.now() - startTime;
      logger.info('[UI_TEST_PLAN] AI test plan generated successfully', {
        planId: testPlan.id,
        stepsCount: testPlan.steps.length,
        commandsCount: testPlan.commands.length,
        duration: `${duration}ms`,
        tokensUsed: response.usage?.totalTokens || 0,
      });

      return testPlan;

    } catch (error) {
      logger.error('[UI_TEST_PLAN] Error generating AI test plan', {
        error: error instanceof Error ? error.message : String(error),
        url: params.url,
        scope: params.scope,
      });

      // Fallback: create intelligent fallback plan
      return this.createIntelligentFallbackPlan(params);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROMPT BUILDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build system prompt for UI test plan generation
   */
  private static buildSystemPrompt(): string {
    return `You are a senior QA automation engineer with 10+ years of experience in UI testing.

EXPERTISE:
- Playwright automation
- User experience testing
- Cross-browser compatibility
- Accessibility testing
- Performance testing
- Security testing

TASK:
Generate comprehensive, intelligent UI test plans that adapt to the specific website and user requirements.

PRINCIPLES:
1. **Context-Aware**: Analyze the URL, scope, and user intent
2. **Comprehensive**: Cover all critical user journeys
3. **Realistic**: Account for real-world constraints and risks
4. **Actionable**: Provide specific, executable test steps
5. **Intelligent**: Prioritize high-impact tests based on site type

RESPONSE FORMAT:
Always respond with valid JSON matching the specified schema.
Be thorough but practical. Focus on user-critical functionality.`;
  }

  /**
   * Build enhanced prompt with full context
   */
  private static buildEnhancedPrompt(params: UiTestPlanParams): string {
    const basePrompt = buildUiTestPlanPrompt({
      url: params.url,
      scope: params.scope,
      target: params.target,
      userMessage: params.userMessage,
    });

    // Enhance with additional context
    const enhancements = [];

    // Add authentication context
    if (params.hasCredentials) {
      enhancements.push(`
AUTHENTICATION:
- Credentials are available for testing authenticated flows
- Include login/logout scenarios in the test plan
- Test both authenticated and unauthenticated states`);
    } else {
      enhancements.push(`
AUTHENTICATION:
- No credentials provided - focus on public/guest functionality
- Test guest user experience and public pages
- Note any authentication requirements as risks`);
    }

    // Add project context if available
    if (params.projectContext) {
      enhancements.push(`
PROJECT CONTEXT:
${params.projectContext.name ? `- Project: ${params.projectContext.name}` : ''}
${params.projectContext.previousTests?.length ? `- Previous tests: ${params.projectContext.previousTests.join(', ')}` : ''}
${params.projectContext.knownIssues?.length ? `- Known issues: ${params.projectContext.knownIssues.join(', ')}` : ''}`);
    }

    // Add scope-specific guidance
    const scopeGuidance = this.getScopeGuidance(params.scope);
    if (scopeGuidance) {
      enhancements.push(scopeGuidance);
    }

    // Add URL analysis
    const urlAnalysis = this.analyzeUrl(params.url);
    if (urlAnalysis) {
      enhancements.push(urlAnalysis);
    }

    return basePrompt + '\n\n' + enhancements.join('\n\n');
  }

  /**
   * Get scope-specific testing guidance
   */
  private static getScopeGuidance(scope: string): string {
    const guidance: Record<string, string> = {
      'full': `
SCOPE GUIDANCE (Full Site Testing):
- Test all major user journeys and workflows
- Include navigation testing across all sections
- Test responsive design on different viewports
- Validate accessibility compliance
- Check performance on key pages
- Estimated duration: 10-20 minutes`,

      'flow': `
SCOPE GUIDANCE (User Flow Testing):
- Focus on specific user journey completion
- Test happy path and error scenarios
- Validate form submissions and validations
- Check state persistence across steps
- Test flow interruption and recovery
- Estimated duration: 5-10 minutes`,

      'page': `
SCOPE GUIDANCE (Single Page Testing):
- Deep testing of one specific page
- Test all interactive elements thoroughly
- Validate page-specific functionality
- Check responsive behavior
- Test accessibility features
- Estimated duration: 3-7 minutes`,

      'component': `
SCOPE GUIDANCE (Component Testing):
- Focus on specific UI component or feature
- Test component in different states
- Validate component interactions
- Check edge cases and error states
- Test component accessibility
- Estimated duration: 2-5 minutes`,
    };

    return guidance[scope] || '';
  }

  /**
   * Analyze URL to provide context-specific guidance
   */
  private static analyzeUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();
      const pathname = parsedUrl.pathname.toLowerCase();

      const insights = [];

      // Domain analysis
      if (hostname.includes('admin') || pathname.includes('admin')) {
        insights.push('- Admin interface detected - focus on CRUD operations and permissions');
      }

      if (hostname.includes('api') || pathname.includes('api')) {
        insights.push('- API endpoint detected - consider API testing instead of UI testing');
      }

      if (hostname.includes('staging') || hostname.includes('dev') || hostname.includes('test')) {
        insights.push('- Development environment detected - expect potential instability');
      }

      // Path analysis
      if (pathname.includes('login') || pathname.includes('auth')) {
        insights.push('- Authentication page detected - focus on login flows and security');
      }

      if (pathname.includes('register') || pathname.includes('signup')) {
        insights.push('- Registration page detected - test form validation and user creation');
      }

      if (pathname.includes('dashboard') || pathname.includes('profile')) {
        insights.push('- User dashboard detected - test personalized content and user actions');
      }

      if (pathname.includes('checkout') || pathname.includes('payment')) {
        insights.push('- Payment flow detected - be cautious with financial transactions');
      }

      if (insights.length > 0) {
        return `
URL ANALYSIS:
${insights.join('\n')}`;
      }

    } catch (error) {
      logger.warn('[UI_TEST_PLAN] URL analysis failed', {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESPONSE PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse and validate GPT response with multiple fallback strategies
   */
  private static parseAndValidateGPTResponse(content: string): GPTTestPlanResponse {
    try {
      // Strategy 1: Direct JSON parse
      const parsed = JSON.parse(content);

      // Validate required fields
      if (!parsed.summary || !Array.isArray(parsed.steps)) {
        throw new Error('Missing required fields: summary or steps');
      }

      // Normalize and validate structure
      return {
        summary: String(parsed.summary),
        steps: this.validateSteps(parsed.steps),
        commands: this.validateCommands(parsed.commands || []),
        estimated_duration: String(parsed.estimated_duration || FALLBACK_DURATION),
        what_will_be_tested: Array.isArray(parsed.what_will_be_tested)
          ? parsed.what_will_be_tested.map(String)
          : [],
        what_will_not_be_tested: Array.isArray(parsed.what_will_not_be_tested)
          ? parsed.what_will_not_be_tested.map(String)
          : [],
        risks: Array.isArray(parsed.risks)
          ? parsed.risks.map(String)
          : [],
        estimated_pages: String(parsed.estimated_pages || FALLBACK_PAGES),
        estimated_cost: String(parsed.estimated_cost || FALLBACK_COST),
        intelligent_mode: Boolean(parsed.intelligent_mode !== false), // Default true
      };

    } catch (error) {
      logger.error('[UI_TEST_PLAN] Failed to parse GPT response', {
        error: error instanceof Error ? error.message : String(error),
        contentPreview: content.substring(0, 200),
      });

      // Strategy 2: Try to extract JSON from markdown or other formats
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return this.parseAndValidateGPTResponse(jsonMatch[0]);
        } catch {
          // Continue to fallback
        }
      }

      // Strategy 3: Create minimal valid response
      throw new Error(`Invalid GPT response format: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Validate and normalize steps array
   */
  private static validateSteps(steps: any[]): GPTTestPlanResponse['steps'] {
    if (!Array.isArray(steps)) return [];

    return steps
      .filter(step => step && typeof step === 'object')
      .map((step, index) => ({
        id: String(step.id || `step_${index + 1}`),
        description: String(step.description || 'Test step'),
        action: String(step.action || 'manual'),
        expectedOutcome: String(step.expectedOutcome || step.expected_outcome || 'Verify functionality'),
        selector: step.selector ? String(step.selector) : undefined,
        value: step.value ? String(step.value) : undefined,
      }))
      .slice(0, 15); // Limit to 15 steps max
  }

  /**
   * Validate and normalize commands array
   */
  private static validateCommands(commands: any[]): GPTTestPlanResponse['commands'] {
    if (!Array.isArray(commands)) return [];

    return commands
      .filter(cmd => cmd && typeof cmd === 'object')
      .map(cmd => ({
        action: String(cmd.action || 'goto'),
        selector: cmd.selector ? String(cmd.selector) : undefined,
        value: cmd.value ? String(cmd.value) : undefined,
        url: cmd.url ? String(cmd.url) : undefined,
        description: String(cmd.description || 'Execute action'),
      }))
      .slice(0, 20); // Limit to 20 commands max
  }

  /**
   * Create normalized TestPlan from GPT response
   */
  private static createNormalizedTestPlan(
    params: UiTestPlanParams,
    gptPlan: GPTTestPlanResponse
  ): TestPlan {
    const planId = `ui_ai_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    return {
      id: planId,
      status: 'pending_confirmation',
      url: params.url,
      scope: params.scope,
      summary: gptPlan.summary,
      steps: gptPlan.steps,
      commands: gptPlan.commands.map(cmd => ({
        action: cmd.action,
        selector: cmd.selector,
        value: cmd.value,
        url: cmd.url,
        description: cmd.description,
      })),
      estimatedDuration: gptPlan.estimated_duration,
      whatWillBeTested: gptPlan.what_will_be_tested,
      whatWillNotBeTested: gptPlan.what_will_not_be_tested,
      risks: gptPlan.risks,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
      intelligentMode: gptPlan.intelligent_mode,
      estimatedPages: gptPlan.estimated_pages,
      estimatedCost: gptPlan.estimated_cost,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FALLBACK LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create intelligent fallback plan when GPT fails
   * Uses heuristics based on URL, scope, and user message
   */
  private static createIntelligentFallbackPlan(params: UiTestPlanParams): TestPlan {
    logger.info('[UI_TEST_PLAN] Creating intelligent fallback plan', {
      url: params.url,
      scope: params.scope,
    });

    const planId = `ui_fallback_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Generate context-aware fallback based on URL and scope
    const fallbackData = this.generateFallbackData(params);

    return {
      id: planId,
      status: 'pending_confirmation',
      url: params.url,
      scope: params.scope,
      summary: fallbackData.summary,
      steps: fallbackData.steps,
      commands: fallbackData.commands,
      estimatedDuration: fallbackData.estimatedDuration,
      whatWillBeTested: fallbackData.whatWillBeTested,
      whatWillNotBeTested: fallbackData.whatWillNotBeTested,
      risks: fallbackData.risks,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      intelligentMode: true,
      estimatedPages: FALLBACK_PAGES,
      estimatedCost: FALLBACK_COST,
    };
  }

  /**
   * Generate intelligent fallback data based on context
   */
  private static generateFallbackData(params: UiTestPlanParams) {
    const { url, scope, hasCredentials } = params;

    // Analyze URL for context
    const isAuthPage = /login|signin|auth|register|signup/i.test(url);
    const isDashboard = /dashboard|profile|account|admin/i.test(url);
    const isEcommerce = /shop|cart|checkout|payment|product/i.test(url);
    const isForm = /form|contact|submit|create|edit/i.test(url);

    let summary = `Intelligent UI testing of ${url}`;
    const steps = [];
    const commands = [];
    const whatWillBeTested = ['Page loading and accessibility', 'Basic navigation'];
    const whatWillNotBeTested = ['Third-party integrations', 'Backend logic'];
    const risks = ['Dynamic content may affect results'];

    // Base steps
    steps.push({
      id: 'step_1',
      description: 'Navigate to target URL and verify page loads',
      action: 'goto',
      expectedOutcome: 'Page loads successfully without errors',
    });

    commands.push({
      action: 'goto',
      url: url,
      description: 'Navigate to target page',
    });

    // Context-specific steps
    if (isAuthPage) {
      summary += '. Focus on authentication flows and form validation.';

      if (hasCredentials) {
        steps.push({
          id: 'step_2',
          description: 'Test login functionality with provided credentials',
          action: 'login',
          expectedOutcome: 'Successful authentication and redirect',
        });
        whatWillBeTested.push('Login form validation', 'Authentication flow');
      } else {
        steps.push({
          id: 'step_2',
          description: 'Test login form validation without credentials',
          action: 'validate_form',
          expectedOutcome: 'Proper error messages for invalid inputs',
        });
        whatWillBeTested.push('Form validation', 'Error messaging');
        risks.push('Cannot test successful login without credentials');
      }

    } else if (isDashboard) {
      summary += '. Focus on dashboard functionality and user interface.';
      steps.push({
        id: 'step_2',
        description: 'Verify dashboard elements and navigation',
        action: 'verify_elements',
        expectedOutcome: 'All dashboard components are visible and functional',
      });
      whatWillBeTested.push('Dashboard widgets', 'User interface elements');

      if (!hasCredentials) {
        risks.push('May require authentication to access dashboard features');
      }

    } else if (isEcommerce) {
      summary += '. Focus on e-commerce functionality and user experience.';
      steps.push({
        id: 'step_2',
        description: 'Test product browsing and search functionality',
        action: 'test_search',
        expectedOutcome: 'Search and filtering work correctly',
      });
      whatWillBeTested.push('Product search', 'Shopping cart functionality');
      whatWillNotBeTested.push('Payment processing', 'Order fulfillment');
      risks.push('Avoid completing actual purchases');

    } else if (isForm) {
      summary += '. Focus on form functionality and validation.';
      steps.push({
        id: 'step_2',
        description: 'Test form fields and validation',
        action: 'test_form',
        expectedOutcome: 'Form validation works correctly',
      });
      whatWillBeTested.push('Form validation', 'Input field functionality');
      risks.push('Avoid submitting real data');

    } else {
      // Generic website
      summary += '. Comprehensive testing of website functionality.';
      steps.push({
        id: 'step_2',
        description: 'Test main navigation and key page elements',
        action: 'test_navigation',
        expectedOutcome: 'Navigation works and key elements are functional',
      });
      whatWillBeTested.push('Navigation menu', 'Interactive elements');
    }

    // Scope-specific adjustments
    if (scope === 'full') {
      steps.push({
        id: 'step_3',
        description: 'Explore and test multiple pages across the site',
        action: 'intelligent_explore',
        expectedOutcome: 'Comprehensive coverage of site functionality',
      });
      whatWillBeTested.push('Cross-page navigation', 'Site-wide consistency');
    }

    // Final validation step
    steps.push({
      id: `step_${steps.length + 1}`,
      description: 'Generate comprehensive test report',
      action: 'generate_report',
      expectedOutcome: 'Detailed findings and recommendations',
    });

    return {
      summary,
      steps,
      commands,
      estimatedDuration: scope === 'full' ? '10-15 minutes' : '5-8 minutes',
      whatWillBeTested,
      whatWillNotBeTested,
      risks,
    };
  }
}
