import { z } from 'zod';
import { ValidationError } from '@/types';

// Common validation schemas
export const uuidSchema = z.string().uuid('Invalid UUID format');
export const urlSchema = z.string().url('Invalid URL format');
export const emailSchema = z.string().email('Invalid email format');

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
  role: z.enum(['admin', 'user', 'viewer']).optional(),
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
  try {
    const parsed = new URL(url);
    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP and HTTPS protocols are allowed');
    }
    return parsed.toString();
  } catch (error) {
    throw new ValidationError('Invalid URL format');
  }
};

export const sanitizeHtml = (html: string): string => {
  // Basic HTML sanitization - in production, use a proper library like DOMPurify
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '');
};

export const sanitizeLogs = (logs: string[]): string[] => {
  return logs.map(log => 
    log
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
      .substring(0, 10000) // Limit length
  );
};

// Custom validators
export const validateBrowserCompatibility = (browsers: string[], options?: any): void => {
  const mobileBrowsers = ['mobile-chrome', 'mobile-safari'];
  const hasMobileBrowser = browsers.some(b => mobileBrowsers.includes(b));
  const hasDesktopBrowser = browsers.some(b => !mobileBrowsers.includes(b));
  
  if (hasMobileBrowser && hasDesktopBrowser && options?.mobile === true) {
    throw new ValidationError('Cannot mix mobile and desktop browsers when mobile option is true');
  }
};

export const validateViewport = (viewport: any): void => {
  if (viewport) {
    const { width, height } = viewport;
    if (width && (width < 100 || width > 4000)) {
      throw new ValidationError('Viewport width must be between 100 and 4000 pixels');
    }
    if (height && (height < 100 || height > 4000)) {
      throw new ValidationError('Viewport height must be between 100 and 4000 pixels');
    }
  }
};

export const validateTimeout = (timeout: number): void => {
  if (timeout < 1000 || timeout > 300000) {
    throw new ValidationError('Timeout must be between 1000ms and 300000ms (5 minutes)');
  }
};

export const validateRetries = (retries: number): void => {
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
  if (!screenshot) return;
  
  // Check if it's a valid base64 string
  const base64Regex = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
  if (!base64Regex.test(screenshot)) {
    throw new ValidationError('Screenshot must be a valid base64 encoded image');
  }
  
  // Check size (max 10MB)
  const sizeInBytes = (screenshot.length * 3) / 4;
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (sizeInBytes > maxSize) {
    throw new ValidationError('Screenshot size exceeds 10MB limit');
  }
};

export const validateDom = (dom: string): void => {
  if (!dom) return;
  
  // Check size (max 1MB)
  const maxSize = 1024 * 1024; // 1MB
  if (dom.length > maxSize) {
    throw new ValidationError('DOM size exceeds 1MB limit');
  }
  
  // Basic HTML structure validation
  if (!dom.includes('<html') || !dom.includes('</html>')) {
    throw new ValidationError('DOM must contain valid HTML structure');
  }
};
