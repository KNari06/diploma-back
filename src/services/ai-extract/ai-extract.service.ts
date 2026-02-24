/**
 * AI Extract Service
 * Extracts structured data from HTML/DOM using GPT with JSON schema validation
 * Similar to Momentic's AI extract functionality
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { OpenAI } from 'openai';
import { Page } from 'playwright';
import type {
  AIExtractRequest,
  AIExtractResponse,
  JSONSchema,
  SchemaGenerationResult,
  ValidationResult
} from './types';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AI Extract configuration constants
 */
const AI_EXTRACT_CONFIG = {
  // OpenAI client settings
  OPENAI_TIMEOUT: 30000, // 30 seconds for extraction
  OPENAI_MAX_RETRIES: 2,

  // Model settings
  MODEL: AI_TASK_MODELS.dataExtraction, // Centralized model config
  TEMPERATURE: 0.1, // Low temperature for deterministic extraction

  // Element wait settings
  ELEMENT_WAIT_TIMEOUT: 5000, // 5 seconds to wait for element visibility

  // Content limits
  MAX_CONTENT_LENGTH: 10000, // Limit content to 10K chars to avoid token overflow

  // Confidence thresholds
  CONFIDENCE_HIGH: 0.9, // High confidence when schema matches
  CONFIDENCE_LOW: 0.6, // Low confidence when schema mismatch

  // HTML tags that require HTML mode extraction
  HTML_MODE_TAGS: ['TABLE', 'UL', 'OL', 'DL', 'FORM', 'SECTION', 'ARTICLE'] as const,
} as const;

/**
 * System prompt for AI extraction
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a data extraction expert. Extract structured data from HTML/text into JSON format matching the provided schema.

Rules:
1. Return ONLY valid JSON matching the schema
2. If data is missing or unclear, use null or omit the field
3. Preserve data types (string, number, boolean, array, object)
4. For arrays, extract all matching items
5. For numbers, parse strings to numbers (e.g., "$29.99" → 29.99)
6. For booleans, infer from text (e.g., "Yes" → true, "No" → false)
7. Clean and normalize data (trim whitespace, fix formatting)`;

/**
 * Helper method instructions
 */
const HELPER_INSTRUCTIONS = {
  TABLE_WITH_HEADER: 'Extract table data. First row contains column headers.',
  TABLE_WITH_COLUMNS: (columns: string[]) => `Extract table data. Use these column names: ${columns.join(', ')}`,
  TABLE_AUTO: 'Extract table data. Infer column names from content.',
  LIST: 'Extract all list items.',
  PRICING: 'Extract pricing information for all plans.',
} as const;

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: AI_EXTRACT_CONFIG.OPENAI_TIMEOUT,
  maxRetries: AI_EXTRACT_CONFIG.OPENAI_MAX_RETRIES,
});

// ═══════════════════════════════════════════════════════════════════════════
// TYPES - imported from ./types.ts
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// AI EXTRACT SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class AIExtractService {
  /**
   * Extract structured data from page element using AI + JSON schema
   * @param page - Playwright page
   * @param request - Extract request with selector and schema
   * @param costManager - Optional cost manager for budget control
   * @returns Extracted data matching schema
   */
  static async extract(
    page: Page,
    request: AIExtractRequest,
    costManager?: import('@/services/ai/cost/ai-cost-manager.service').AICostManager
  ): Promise<AIExtractResponse> {
    const startTime = Date.now();

    logger.info('[AI_EXTRACT] Starting extraction', {
      selector: request.selector,
      mode: request.mode || 'auto',
      hasSchema: !!request.schema,
      hasCostManager: !!costManager,
    });

    try {
      // Step 1: Find element and extract content
      const element = page.locator(request.selector);
      const elementExists = await element.count();

      if (elementExists === 0) {
        throw new Error(`Element not found: ${request.selector}`);
      }

      // Wait for element to be visible
      await element.first().waitFor({
        state: 'visible',
        timeout: AI_EXTRACT_CONFIG.ELEMENT_WAIT_TIMEOUT
      });

      // Step 2: Determine extraction mode
      const mode = await this.determineMode(element, request.mode);

      // Step 3: Extract content
      const content = await this.extractContent(element, mode);

      if (!content || content.trim().length === 0) {
        throw new Error('No content found in element');
      }

      logger.info('[AI_EXTRACT] Content extracted', {
        selector: request.selector,
        mode,
        contentLength: content.length,
      });

      // Step 4: Build adaptive extraction prompt
      const prompt = await this.buildAdaptiveExtractionPrompt(content, request);

      // Step 5: Call GPT to extract structured data
      const response = await openai.chat.completions.create({
        model: AI_EXTRACT_CONFIG.MODEL,
        messages: [
          {
            role: 'system',
            content: EXTRACTION_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
        response_format: { type: 'json_object' },
      });

      const result = response.choices[0]?.message?.content;
      if (!result) {
        throw new Error('Empty response from GPT');
      }

      // Step 6: Parse and validate result
      const extractedData = JSON.parse(result);

      // Step 7: Validate against schema with AI
      const validationResult = await this.validateAgainstSchemaWithAI(extractedData, request.schema);
      if (!validationResult.valid) {
        logger.warn('[AI_EXTRACT] Extracted data validation failed', {
          selector: request.selector,
          errors: validationResult.errors,
          data: extractedData,
        });
      }

      const duration = Date.now() - startTime;

      logger.info('[AI_EXTRACT] Extraction completed', {
        selector: request.selector,
        duration: `${duration}ms`,
        tokensUsed: response.usage?.total_tokens || 0,
        dataKeys: Object.keys(extractedData),
      });

      return {
        success: true,
        data: extractedData,
        confidence: validationResult.valid
          ? AI_EXTRACT_CONFIG.CONFIDENCE_HIGH
          : AI_EXTRACT_CONFIG.CONFIDENCE_LOW,
        metadata: {
          tokensUsed: response.usage?.total_tokens || 0,
          duration,
          model: AI_EXTRACT_CONFIG.MODEL,
          mode,
          validationErrors: validationResult.errors,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('[AI_EXTRACT] Extraction failed', {
        selector: request.selector,
        error: error instanceof Error ? error.message : String(error),
        duration: `${duration}ms`,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          tokensUsed: 0,
          duration,
          model: AI_EXTRACT_CONFIG.MODEL,
          mode: (request.mode === 'html' || request.mode === 'text') ? request.mode : 'text',
        },
      };
    }
  }

  /**
   * Determine extraction mode (html vs text) using AI analysis
   */
  private static async determineMode(
    element: any,
    requestedMode?: 'html' | 'text' | 'auto'
  ): Promise<'html' | 'text'> {
    if (requestedMode === 'html' || requestedMode === 'text') {
      return requestedMode;
    }

    // Fast path: Check obvious HTML structures first
    const tagName = await element.first().evaluate((el: any) => el.tagName);
    if ((AI_EXTRACT_CONFIG.HTML_MODE_TAGS as readonly string[]).includes(tagName)) {
      return 'html';
    }

    // Slow path: AI analysis for complex cases (DIV, SECTION, etc.)
    const needsAIAnalysis = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER'].includes(tagName);

    if (needsAIAnalysis) {
      try {
        return await this.determineModeWithAI(element);
      } catch (error) {
        logger.warn('[AI_EXTRACT] AI mode determination failed, falling back to text', { error });
        return 'text';
      }
    }

    // Default: text for simple elements
    return 'text';
  }

  /**
   * Use AI to determine if HTML structure is important for extraction
   */
  private static async determineModeWithAI(element: any): Promise<'html' | 'text'> {
    const startTime = Date.now();

    // Get element content for analysis
    const [html, text, tagName] = await Promise.all([
      element.first().innerHTML(),
      element.first().textContent(),
      element.first().evaluate((el: any) => el.tagName)
    ]);

    // Limit content size for analysis
    const htmlSample = html.substring(0, 1000);
    const textSample = text.substring(0, 500);

    logger.debug('[AI_EXTRACT] Analyzing element structure with AI', {
      tagName,
      htmlLength: html.length,
      textLength: text.length,
    });

    const response = await openai.chat.completions.create({
      model: AI_EXTRACT_CONFIG.MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an expert at analyzing HTML structure for data extraction. Determine if HTML structure is important for extracting data from this element.

Rules:
- Return "html" if the element has meaningful structure (tables, lists, nested data, multiple sections)
- Return "text" if the element is simple text content without important structure
- Consider: Does the HTML structure help understand the data relationships?`,
        },
        {
          role: 'user',
          content: `Analyze this element:

Tag: ${tagName}
HTML: ${htmlSample}
Text: ${textSample}

Return JSON: { "mode": "html" | "text", "reason": "brief explanation" }`,
        },
      ],
      temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    const mode = result.mode === 'html' ? 'html' : 'text';
    const duration = Date.now() - startTime;

    logger.info('[AI_EXTRACT] AI mode determination completed', {
      tagName,
      mode,
      reason: result.reason,
      duration: `${duration}ms`,
      tokensUsed: response.usage?.total_tokens || 0,
    });

    return mode;
  }

  /**
   * Extract content from element
   */
  private static async extractContent(
    element: any,
    mode: 'html' | 'text'
  ): Promise<string> {
    if (mode === 'html') {
      return await element.first().innerHTML();
    }

    return await element.first().textContent();
  }

  /**
   * Build adaptive extraction prompt using AI optimization
   */
  private static async buildAdaptiveExtractionPrompt(
    content: string,
    request: AIExtractRequest
  ): Promise<string> {
    try {
      // Try AI-optimized prompt first
      const adaptivePrompt = await this.generateAdaptivePrompt(content, request);
      return adaptivePrompt;
    } catch (error) {
      logger.warn('[AI_EXTRACT] Adaptive prompt generation failed, using static', { error });
      // Fallback to static prompt
      return this.buildStaticExtractionPrompt(content, request);
    }
  }

  /**
   * Generate AI-optimized extraction prompt
   */
  private static async generateAdaptivePrompt(
    content: string,
    request: AIExtractRequest
  ): Promise<string> {
    const startTime = Date.now();

    // Analyze content and schema to generate optimal prompt
    const contentSample = content.substring(0, 1000);
    const schemaType = this.detectSchemaType(request.schema);

    logger.debug('[AI_EXTRACT] Generating adaptive prompt', {
      schemaType,
      contentLength: content.length,
      hasExamples: !!(request.examples && request.examples.length > 0),
    });

    const response = await openai.chat.completions.create({
      model: AI_EXTRACT_CONFIG.MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an expert at creating optimal data extraction prompts. Generate a specialized prompt that will work best for extracting this specific type of data.

Rules:
- Analyze the schema type and content structure
- Create specific instructions for this data type
- Include relevant examples and edge cases
- Optimize for accuracy and consistency
- Keep prompts concise but comprehensive`,
        },
        {
          role: 'user',
          content: `Create an optimal extraction prompt for:

Schema Type: ${schemaType}
Schema: ${JSON.stringify(request.schema, null, 2)}
Content Sample: ${contentSample}
Existing Instructions: ${request.instructions || 'None'}

Generate a specialized prompt that includes:
1. Clear extraction rules for this data type
2. Format specifications
3. Edge case handling
4. Quality guidelines

Return JSON: { "prompt": "optimized extraction prompt" }`,
        },
      ],
      temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    const duration = Date.now() - startTime;

    if (!result.prompt) {
      throw new Error('AI failed to generate adaptive prompt');
    }

    logger.info('[AI_EXTRACT] Adaptive prompt generated', {
      schemaType,
      duration: `${duration}ms`,
      tokensUsed: response.usage?.total_tokens || 0,
      promptLength: result.prompt.length,
    });

    // Build final prompt with AI-generated content
    let finalPrompt = result.prompt + '\n\n';

    // Add schema
    finalPrompt += `JSON Schema:\n${JSON.stringify(request.schema, null, 2)}\n\n`;

    // Add few-shot examples if provided
    if (request.examples && request.examples.length > 0) {
      finalPrompt += 'Examples:\n\n';
      request.examples.forEach((example, idx) => {
        finalPrompt += `Example ${idx + 1}:\nInput:\n${example.input}\n\nOutput:\n${JSON.stringify(example.output, null, 2)}\n\n`;
      });
    }

    // Add content to extract
    const truncatedContent = content.substring(0, AI_EXTRACT_CONFIG.MAX_CONTENT_LENGTH);
    finalPrompt += `Content to extract:\n${truncatedContent}`;

    if (content.length > AI_EXTRACT_CONFIG.MAX_CONTENT_LENGTH) {
      finalPrompt += '\n... (truncated)';
    }

    return finalPrompt;
  }

  /**
   * Build static extraction prompt (fallback)
   */
  private static buildStaticExtractionPrompt(
    content: string,
    request: AIExtractRequest
  ): string {
    let prompt = '';

    // Add instructions if provided
    if (request.instructions) {
      prompt += `Instructions:\n${request.instructions}\n\n`;
    }

    // Add schema
    prompt += `JSON Schema:\n${JSON.stringify(request.schema, null, 2)}\n\n`;

    // Add few-shot examples if provided
    if (request.examples && request.examples.length > 0) {
      prompt += 'Examples:\n\n';
      request.examples.forEach((example, idx) => {
        prompt += `Example ${idx + 1}:\nInput:\n${example.input}\n\nOutput:\n${JSON.stringify(example.output, null, 2)}\n\n`;
      });
    }

    // Add content to extract
    prompt += `Content to extract:\n${content.substring(0, AI_EXTRACT_CONFIG.MAX_CONTENT_LENGTH)}`;

    if (content.length > AI_EXTRACT_CONFIG.MAX_CONTENT_LENGTH) {
      prompt += '\n... (truncated)';
    }

    return prompt;
  }

  /**
   * Detect schema type for prompt optimization
   */
  private static detectSchemaType(schema: JSONSchema): string {
    if (schema.type === 'array' && schema.items) {
      const itemProps = schema.items.properties;
      if (itemProps) {
        // Detect common patterns
        if (itemProps.name && itemProps.price) return 'pricing';
        if (itemProps.title && itemProps.description) return 'content';
        if (Object.keys(itemProps).length > 5) return 'table';
        return 'list';
      }
      return 'array';
    }

    if (schema.type === 'object') {
      const props = schema.properties;
      if (props) {
        if (props.name && props.price) return 'product';
        if (props.title && props.content) return 'article';
        return 'object';
      }
    }

    return schema.type || 'unknown';
  }

  /**
   * Validate extracted data against JSON schema using AI
   * Provides detailed validation with specific error messages
   */
  private static async validateAgainstSchemaWithAI(
    data: any,
    schema: JSONSchema
  ): Promise<ValidationResult> {
    const startTime = Date.now();

    try {
      // First, try basic validation for speed
      const basicValidation = this.validateAgainstSchemaBasic(data, schema);
      if (basicValidation.valid) {
        return {
          valid: true,
          confidence: 0.95,
        };
      }

      // If basic validation fails, use AI for detailed analysis
      logger.debug('[AI_EXTRACT] Running AI validation for detailed errors', {
        dataType: Array.isArray(data) ? 'array' : typeof data,
        schemaType: schema.type,
      });

      const response = await openai.chat.completions.create({
        model: AI_EXTRACT_CONFIG.MODEL,
        messages: [
          {
            role: 'system',
            content: `You are a JSON schema validation expert. Validate data against schema and provide detailed error messages.

Rules:
- Check data types (string, number, boolean, array, object)
- Check required fields
- Check format constraints (email, date, URL patterns)
- Check value ranges and constraints
- Provide specific, actionable error messages
- Return confidence score (0.0-1.0) based on validation quality`,
          },
          {
            role: 'user',
            content: `Validate this data against the schema:

Data:
${JSON.stringify(data, null, 2)}

Schema:
${JSON.stringify(schema, null, 2)}

Return JSON:
{
  "valid": true/false,
  "errors": ["specific error messages"],
  "confidence": 0.0-1.0,
  "summary": "brief validation summary"
}`,
          },
        ],
        temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
        response_format: { type: 'json_object' },
      });

      const result = JSON.parse(response.choices[0]?.message?.content || '{}');
      const duration = Date.now() - startTime;

      logger.info('[AI_EXTRACT] AI validation completed', {
        valid: result.valid,
        errorCount: result.errors?.length || 0,
        confidence: result.confidence,
        duration: `${duration}ms`,
        tokensUsed: response.usage?.total_tokens || 0,
      });

      return {
        valid: result.valid || false,
        errors: result.errors || [],
        confidence: result.confidence || 0.5,
      };
    } catch (error) {
      logger.warn('[AI_EXTRACT] AI validation failed, falling back to basic', { error });

      // Fallback to basic validation
      const basicResult = this.validateAgainstSchemaBasic(data, schema);
      return {
        valid: basicResult.valid,
        errors: basicResult.errors,
        confidence: 0.3, // Low confidence due to fallback
      };
    }
  }

  /**
   * Basic schema validation (fast fallback)
   */
  private static validateAgainstSchemaBasic(
    data: any,
    schema: JSONSchema
  ): ValidationResult {
    const errors: string[] = [];

    try {
      // Check type
      const dataType = Array.isArray(data) ? 'array' : typeof data;
      if (dataType !== schema.type && schema.type !== 'object') {
        errors.push(`Expected type '${schema.type}', got '${dataType}'`);
      }

      // Check required fields for objects
      if (schema.type === 'object' && schema.required && typeof data === 'object' && data !== null) {
        for (const field of schema.required) {
          if (!(field in data)) {
            errors.push(`Missing required field: '${field}'`);
          }
        }
      }

      // Check array items
      if (schema.type === 'array' && schema.items && Array.isArray(data)) {
        data.forEach((item, index) => {
          const itemValidation = this.validateAgainstSchemaBasic(item, schema.items!);
          if (!itemValidation.valid) {
            errors.push(`Array item ${index}: ${itemValidation.errors?.join(', ') || 'validation failed'}`);
          }
        });
      }

      // Check object properties
      if (schema.type === 'object' && schema.properties && typeof data === 'object' && data !== null) {
        for (const [key, value] of Object.entries(data)) {
          const propSchema = schema.properties[key];
          if (propSchema) {
            const propValidation = this.validateAgainstSchemaBasic(value, propSchema);
            if (!propValidation.valid) {
              errors.push(`Property '${key}': ${propValidation.errors?.join(', ') || 'validation failed'}`);
            }
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  /**
   * Extract data from table with AI-generated schema (helper method)
   */
  static async extractTable(
    page: Page,
    selector: string,
    options?: {
      hasHeader?: boolean; // First row is header
      columns?: string[]; // Column names (if no header)
      useAISchema?: boolean; // Use AI to generate schema (default: true)
    }
  ): Promise<AIExtractResponse> {
    const useAISchema = options?.useAISchema !== false; // Default to true

    let schema: JSONSchema;
    let instructions: string;

    if (useAISchema) {
      try {
        // AI generates optimal schema for this specific table
        const aiSchemaResult = await this.generateTableSchema(page, selector, options);
        schema = aiSchemaResult.schema;
        instructions = aiSchemaResult.instructions;

        logger.info('[AI_EXTRACT] Using AI-generated table schema', {
          selector,
          schemaProperties: Object.keys(aiSchemaResult.schema.items?.properties || {}),
        });
      } catch (error) {
        logger.warn('[AI_EXTRACT] AI schema generation failed, using fallback', { error });
        // Fallback to basic schema
        schema = {
          type: 'array',
          items: {
            type: 'object',
            properties: {}, // Will be populated by GPT
          },
        };
        instructions = options?.hasHeader
          ? HELPER_INSTRUCTIONS.TABLE_WITH_HEADER
          : options?.columns
            ? HELPER_INSTRUCTIONS.TABLE_WITH_COLUMNS(options.columns)
            : HELPER_INSTRUCTIONS.TABLE_AUTO;
      }
    } else {
      // Use basic schema (backwards compatibility)
      schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {}, // Will be populated by GPT
        },
      };
      instructions = options?.hasHeader
        ? HELPER_INSTRUCTIONS.TABLE_WITH_HEADER
        : options?.columns
          ? HELPER_INSTRUCTIONS.TABLE_WITH_COLUMNS(options.columns)
          : HELPER_INSTRUCTIONS.TABLE_AUTO;
    }

    return this.extract(page, {
      selector,
      schema,
      mode: 'html',
      instructions,
    });
  }

  /**
   * Generate optimal JSON schema for table extraction using AI
   */
  private static async generateTableSchema(
    page: Page,
    selector: string,
    options?: {
      hasHeader?: boolean;
      columns?: string[];
    }
  ): Promise<SchemaGenerationResult> {
    const startTime = Date.now();

    // Get table HTML for analysis
    const element = page.locator(selector);
    await element.first().waitFor({ state: 'visible', timeout: AI_EXTRACT_CONFIG.ELEMENT_WAIT_TIMEOUT });

    const html = await element.first().innerHTML();
    const htmlSample = html.substring(0, 3000); // Limit for analysis

    logger.debug('[AI_EXTRACT] Generating table schema with AI', {
      selector,
      htmlLength: html.length,
      hasHeader: options?.hasHeader,
      columns: options?.columns,
    });

    const response = await openai.chat.completions.create({
      model: AI_EXTRACT_CONFIG.MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an expert at analyzing HTML tables and generating JSON schemas. Analyze the table structure and generate an optimal JSON schema for data extraction.

Rules:
- Detect column types: string, number, boolean, array
- Use descriptive property names (camelCase)
- Mark required fields appropriately
- For numbers: detect prices, quantities, percentages, etc.
- For booleans: detect yes/no, true/false, checkmarks, etc.
- For arrays: detect comma-separated values, lists, etc.
- Include descriptions for complex fields`,
        },
        {
          role: 'user',
          content: `Analyze this HTML table:

${htmlSample}

Context:
${options?.hasHeader ? '- First row contains column headers' : ''}
${options?.columns ? `- Use these column names: ${options.columns.join(', ')}` : ''}

Generate JSON schema and extraction instructions:
{
  "schema": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "columnName": {
          "type": "string|number|boolean|array",
          "description": "what this column contains"
        }
      },
      "required": ["requiredColumns"]
    }
  },
  "instructions": "specific instructions for this table"
}`,
        },
      ],
      temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    const duration = Date.now() - startTime;

    // Validate generated schema
    if (!result.schema || !result.schema.items || !result.schema.items.properties) {
      throw new Error('Invalid schema generated by AI');
    }

    logger.info('[AI_EXTRACT] Table schema generated successfully', {
      selector,
      duration: `${duration}ms`,
      tokensUsed: response.usage?.total_tokens || 0,
      columns: Object.keys(result.schema.items.properties),
      requiredFields: result.schema.items.required || [],
    });

    return {
      schema: result.schema,
      instructions: result.instructions || HELPER_INSTRUCTIONS.TABLE_AUTO,
    };
  }

  /**
   * Extract data from list (helper method)
   */
  static async extractList(
    page: Page,
    selector: string,
    itemSchema?: JSONSchema
  ): Promise<AIExtractResponse> {
    const schema: JSONSchema = {
      type: 'array',
      items: itemSchema || { type: 'string' },
    };

    return this.extract(page, {
      selector,
      schema,
      mode: 'html',
      instructions: HELPER_INSTRUCTIONS.LIST,
    });
  }

  /**
   * Extract pricing/product data with AI-adaptive schema (helper method)
   */
  static async extractPricing(
    page: Page,
    selector: string,
    options?: {
      useAISchema?: boolean; // Use AI to generate adaptive schema (default: true)
    }
  ): Promise<AIExtractResponse> {
    const useAISchema = options?.useAISchema !== false; // Default to true

    let schema: JSONSchema;
    let instructions: string;

    if (useAISchema) {
      try {
        // AI generates adaptive schema for this specific pricing structure
        const aiSchemaResult = await this.generatePricingSchema(page, selector);
        schema = aiSchemaResult.schema;
        instructions = aiSchemaResult.instructions;

        logger.info('[AI_EXTRACT] Using AI-generated pricing schema', {
          selector,
          schemaProperties: Object.keys(aiSchemaResult.schema.items?.properties || {}),
        });
      } catch (error) {
        logger.warn('[AI_EXTRACT] AI pricing schema generation failed, using fallback', { error });
        // Fallback to static schema
        schema = this.getStaticPricingSchema();
        instructions = HELPER_INSTRUCTIONS.PRICING;
      }
    } else {
      // Use static schema (backwards compatibility)
      schema = this.getStaticPricingSchema();
      instructions = HELPER_INSTRUCTIONS.PRICING;
    }

    return this.extract(page, {
      selector,
      schema,
      mode: 'html',
      instructions,
    });
  }

  /**
   * Generate adaptive JSON schema for pricing extraction using AI
   */
  private static async generatePricingSchema(
    page: Page,
    selector: string
  ): Promise<SchemaGenerationResult> {
    const startTime = Date.now();

    // Get pricing HTML for analysis
    const element = page.locator(selector);
    await element.first().waitFor({ state: 'visible', timeout: AI_EXTRACT_CONFIG.ELEMENT_WAIT_TIMEOUT });

    const html = await element.first().innerHTML();
    const htmlSample = html.substring(0, 4000); // Larger sample for pricing analysis

    logger.debug('[AI_EXTRACT] Generating pricing schema with AI', {
      selector,
      htmlLength: html.length,
    });

    const response = await openai.chat.completions.create({
      model: AI_EXTRACT_CONFIG.MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an expert at analyzing pricing sections and generating JSON schemas. Analyze the pricing structure and generate an optimal schema that matches the actual data available.

Rules:
- Always include: name (plan/product name), price (as number)
- Conditionally include: currency, period, originalPrice, discount, features, popular, recommended, etc.
- Detect price formats: $29.99, €50/month, ¥1000, "Free", "Contact us"
- Detect features: lists, checkmarks, included/excluded items
- Detect special labels: "Most popular", "Recommended", "Best value"
- Use appropriate types: number for prices, boolean for flags, array for features
- Only include fields that actually exist in the pricing data`,
        },
        {
          role: 'user',
          content: `Analyze this pricing section:

${htmlSample}

Generate adaptive JSON schema that matches the actual structure:
{
  "schema": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "description": "Plan name" },
        "price": { "type": "number", "description": "Price as number" },
        // Add other fields only if they exist in the data
      },
      "required": ["name", "price"]
    }
  },
  "instructions": "specific instructions for this pricing structure"
}`,
        },
      ],
      temperature: AI_EXTRACT_CONFIG.TEMPERATURE,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    const duration = Date.now() - startTime;

    // Validate generated schema
    if (!result.schema || !result.schema.items || !result.schema.items.properties) {
      throw new Error('Invalid pricing schema generated by AI');
    }

    // Ensure required fields are present
    if (!result.schema.items.properties.name || !result.schema.items.properties.price) {
      throw new Error('AI schema missing required fields (name, price)');
    }

    logger.info('[AI_EXTRACT] Pricing schema generated successfully', {
      selector,
      duration: `${duration}ms`,
      tokensUsed: response.usage?.total_tokens || 0,
      fields: Object.keys(result.schema.items.properties),
      requiredFields: result.schema.items.required || [],
    });

    return {
      schema: result.schema,
      instructions: result.instructions || HELPER_INSTRUCTIONS.PRICING,
    };
  }

  /**
   * Get static pricing schema (fallback)
   */
  private static getStaticPricingSchema(): JSONSchema {
    return {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plan or product name' },
          price: { type: 'number', description: 'Price as number (e.g., 29.99)' },
          currency: { type: 'string', description: 'Currency symbol or code' },
          period: { type: 'string', description: 'Billing period (monthly, yearly, etc.)' },
          features: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of features',
          },
        },
        required: ['name', 'price'],
      },
    };
  }
}
