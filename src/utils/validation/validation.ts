import { ValidationError } from '@/types';
import { z } from 'zod';
import { logger } from '../core/logger';

// Common validation schemas
export const uuidSchema = z.string().uuid('Invalid UUID format');
export const urlSchema = z.string().url('Invalid URL format');
export const emailSchema = z.string().email('Invalid email format');

// UUID validation regex (centralized)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate UUID format
 * @param uuid - UUID string to validate
 * @returns true if valid UUID, false otherwise
 */
export function isValidUUID(uuid: string | undefined | null): boolean {
  if (!uuid || typeof uuid !== 'string') return false;
  return UUID_REGEX.test(uuid);
}

// Browser type validation
export const browserTypeSchema = z.enum([
  'chrome',
  'firefox',
  'safari',
  'edge',
  'mobile-chrome',
  'mobile-safari'
]);

// Test status validation
export const testStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timeout'
]);

// Pagination validation
export const paginationSchema = z.object({
  page: z.string().transform(Number).refine(n => n > 0, 'Page must be positive').optional().default('1'),
  limit: z.string().transform(Number).refine(n => n > 0 && n <= 100, 'Limit must be between 1 and 100').optional().default('20'),
});

// Test run request validation
export const testRunRequestSchema = z.object({
  url: urlSchema,
  browsers: z.array(browserTypeSchema).min(1, 'At least one browser is required'),
  projectId: uuidSchema,
  userId: uuidSchema.optional(),
  options: z.object({
    mobile: z.boolean().optional(),
    viewport: z.object({
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    }).optional(),
    timeout: z.number().positive().optional(),
    retries: z.number().min(0).optional(),
    waitForSelector: z.string().optional(),
    customScripts: z.array(z.string()).optional(),
    headers: z.record(z.string()).optional(),
  }).optional(),
});

// Test result validation
export const testResultSchema = z.object({
  testId: uuidSchema,
  browser: browserTypeSchema,
  status: testStatusSchema,
  screenshot: z.string().optional(),
  dom: z.string().optional(),
  logs: z.array(z.string()).default([]),
  networkLogs: z.array(z.any()).default([]),
  errors: z.array(z.any()).default([]),
  performance: z.any().optional(),
});

// Project validation
export const projectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(255, 'Project name too long'),
  description: z.string().max(1000, 'Description too long').optional(),
  settings: z.object({
    defaultBrowsers: z.array(browserTypeSchema).optional(),
    defaultOptions: z.any().optional(),
    notifications: z.object({
      email: z.boolean().optional(),
      slack: z.boolean().optional(),
      webhook: z.string().url().optional(),
    }).optional(),
    integrations: z.object({
      jira: z.object({
        enabled: z.boolean().optional(),
        projectKey: z.string().optional(),
        issueType: z.string().optional(),
      }).optional(),
      slack: z.object({
        enabled: z.boolean().optional(),
        channel: z.string().optional(),
      }).optional(),
    }).optional(),
  }).optional(),
});

// User validation
export const userSchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(255, 'Name too long').optional(),
  role: z.enum(['admin', 'user', 'ai']).optional(),
});

// Validation helper functions
export const validateRequest = <T>(schema: z.ZodSchema<T>, data: unknown): T => {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code,
      }));
      throw new ValidationError('Validation failed', details);
    }
    throw error;
  }
};

export const validateQuery = <T>(schema: z.ZodSchema<T>, query: any): T => {
  return validateRequest(schema, query);
};

export const validateBody = <T>(schema: z.ZodSchema<T>, body: any): T => {
  return validateRequest(schema, body);
};

export const validateParams = <T>(schema: z.ZodSchema<T>, params: any): T => {
  return validateRequest(schema, params);
};

// Sanitization helpers
export const sanitizeUrl = (url: string): string => {
  // Validate input
  if (!url || typeof url !== 'string') {
    throw new ValidationError('URL must be a non-empty string');
  }

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    throw new ValidationError('URL cannot be empty');
  }

  try {
    const parsed = new URL(trimmedUrl);

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ValidationError('Only HTTP and HTTPS protocols are allowed');
    }

    // Basic security: prevent localhost/private network access in production
    const hostname = parsed.hostname.toLowerCase();
    const forbiddenHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (forbiddenHosts.includes(hostname)) {
      throw new ValidationError('Localhost URLs are not allowed');
    }

    return parsed.toString();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError('Invalid URL format');
  }
};

export const sanitizeHtml = (html: string): string => {
  // Validate input
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Basic HTML sanitization - in production, use a proper library like DOMPurify
  // Remove script tags, iframes, and event handlers
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, ''); // Remove javascript: protocol
};

export const sanitizeLogs = (logs: string[]): string[] => {
  // Validate input
  if (!logs || !Array.isArray(logs)) {
    return [];
  }

  return logs
    .filter(log => log != null) // Filter out null/undefined
    .map(log => {
      // Convert to string if not already
      const logString = typeof log === 'string' ? log : String(log);

      return logString
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
        .substring(0, 10000); // Limit length to prevent memory issues
    })
    .filter(log => log.length > 0); // Filter out empty strings
};

// Custom validators
export const validateBrowserCompatibility = (browsers: string[], options?: any): void => {
  // Validate input
  if (!browsers || !Array.isArray(browsers) || browsers.length === 0) {
    throw new ValidationError('Browsers must be a non-empty array');
  }

  // Validate each browser is a string
  const invalidBrowsers = browsers.filter(b => typeof b !== 'string' || b.trim().length === 0);
  if (invalidBrowsers.length > 0) {
    throw new ValidationError('All browsers must be non-empty strings');
  }

  const mobileBrowsers = ['mobile-chrome', 'mobile-safari'];
  const hasMobileBrowser = browsers.some(b => mobileBrowsers.includes(b));
  const hasDesktopBrowser = browsers.some(b => !mobileBrowsers.includes(b));

  if (hasMobileBrowser && hasDesktopBrowser && options?.mobile === true) {
    throw new ValidationError('Cannot mix mobile and desktop browsers when mobile option is true');
  }
};

export const validateViewport = (viewport: any): void => {
  if (!viewport) {
    return; // Optional parameter
  }

  if (typeof viewport !== 'object' || Array.isArray(viewport)) {
    throw new ValidationError('Viewport must be an object');
  }

  const { width, height } = viewport;

  if (width !== undefined && width !== null) {
    if (!Number.isFinite(width) || !Number.isInteger(width)) {
      throw new ValidationError('Viewport width must be a finite integer');
    }
    if (width < 100 || width > 4000) {
      throw new ValidationError('Viewport width must be between 100 and 4000 pixels');
    }
  }

  if (height !== undefined && height !== null) {
    if (!Number.isFinite(height) || !Number.isInteger(height)) {
      throw new ValidationError('Viewport height must be a finite integer');
    }
    if (height < 100 || height > 4000) {
      throw new ValidationError('Viewport height must be between 100 and 4000 pixels');
    }
  }
};

export const validateTimeout = (timeout: number): void => {
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout)) {
    throw new ValidationError('Timeout must be a finite integer');
  }

  if (timeout < 1000 || timeout > 300000) {
    throw new ValidationError('Timeout must be between 1000ms and 300000ms (5 minutes)');
  }
};

export const validateRetries = (retries: number): void => {
  if (!Number.isFinite(retries) || !Number.isInteger(retries)) {
    throw new ValidationError('Retries must be a finite integer');
  }

  if (retries < 0 || retries > 10) {
    throw new ValidationError('Retries must be between 0 and 10');
  }
};

// Rate limiting validation
export const validateRateLimit = (userId: string, action: string): void => {
  // In a real implementation, you would check against Redis or database
  // For now, just a placeholder
  const limits = {
    'test.run': 10, // 10 tests per minute
    'test.retry': 5, // 5 retries per minute
    'project.create': 3, // 3 projects per hour
  };

  const limit = limits[action as keyof typeof limits];
  if (!limit) return;

  // TODO: Implement actual rate limiting check
  // This would involve checking Redis for user's action count
};

// File validation
export const validateScreenshot = (screenshot: string): void => {
  // Validate input
  if (!screenshot) {
    return; // Optional parameter
  }

  if (typeof screenshot !== 'string') {
    throw new ValidationError('Screenshot must be a string');
  }

  if (screenshot.trim().length === 0) {
    return; // Empty string is acceptable (optional)
  }

  // Check if it's a valid base64 string
  const base64Regex = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i;
  if (!base64Regex.test(screenshot)) {
    throw new ValidationError('Screenshot must be a valid base64 encoded image with data URI prefix');
  }

  // Extract base64 part (after comma)
  const base64Part = screenshot.includes(',') ? screenshot.split(',')[1] : screenshot;

  // Validate base64 format
  const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Pattern.test(base64Part)) {
    throw new ValidationError('Screenshot contains invalid base64 characters');
  }

  // Check size (max 10MB)
  // Base64 is ~33% larger than binary, so divide by 1.33 (~= 0.75 factor)
  const sizeInBytes = Math.ceil((base64Part.length * 3) / 4);
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (sizeInBytes > maxSize) {
    throw new ValidationError(`Screenshot size (${(sizeInBytes / 1024 / 1024).toFixed(2)}MB) exceeds 10MB limit`);
  }
};

export const validateDom = (dom: string): void => {
  // Validate input
  if (!dom) {
    return; // Optional parameter
  }

  if (typeof dom !== 'string') {
    throw new ValidationError('DOM must be a string');
  }

  // Check size (max 1MB)
  const maxSize = 1024 * 1024; // 1MB
  if (dom.length > maxSize) {
    const sizeMB = (dom.length / 1024 / 1024).toFixed(2);
    throw new ValidationError(`DOM size (${sizeMB}MB) exceeds 1MB limit`);
  }

  // Basic HTML structure validation - check for opening and closing html tag
  // Note: Some DOM snapshots might not have full HTML structure, so we make this check lenient
  const hasHtmlTag = dom.toLowerCase().includes('<html') || dom.toLowerCase().includes('<body');
  if (!hasHtmlTag && dom.length > 1000) {
    // Only warn if DOM is large but doesn't have HTML structure
    logger?.warn?.('[VALIDATION] DOM appears to lack HTML structure tags', {
      domLength: dom.length,
      preview: dom.substring(0, 100),
    });
    // Don't throw error - some test frameworks might provide partial DOM
  }
};
