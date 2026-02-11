/**
 * PromptSanitizer
 * Protects against prompt injection attacks from malicious page content
 *
 * Security layers:
 * 1. Pattern-based injection detection (ignore instructions, goal override)
 * 2. Suspicious marker filtering (system delimiters)
 * 3. Hidden content detection (display:none with instructions)
 * 4. Text flooding prevention (excessively long blocks)
 */

import { logger } from '@/utils/core/logger';

interface SanitizationResult {
  sanitized: string;
  blocked: Array<{
    originalText: string;
    reason: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  modified: boolean;
}

interface SnapshotSanitizationResult {
  sanitized: string;
  totalBlocked: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  blocked: SanitizationResult['blocked'];
}

export class PromptSanitizer {
  /**
   * Injection patterns to detect and block
   * Covers common prompt injection techniques
   */
  private static readonly INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: 'high' | 'medium' }> = [
    // Direct instruction override patterns
    { pattern: /ignore\s+(all\s+)?previous\s+(instructions?|commands?)/gi, severity: 'high' },
    { pattern: /disregard\s+(all\s+)?previous\s+(instructions?|commands?)/gi, severity: 'high' },
    { pattern: /forget\s+(all\s+)?previous\s+(instructions?|commands?)/gi, severity: 'high' },
    { pattern: /override\s+(all\s+)?previous\s+(instructions?|commands?)/gi, severity: 'high' },

    // Goal manipulation patterns
    { pattern: /your\s+new\s+goal\s+is/gi, severity: 'high' },
    { pattern: /change\s+your\s+goal\s+to/gi, severity: 'high' },
    { pattern: /instead\s+of\s+.*?,?\s*(do|perform|execute|click|fill|type|navigate)/gi, severity: 'high' },
    { pattern: /don't\s+do\s+.*?,?\s*(instead|but|and)\s+(do|perform|execute)/gi, severity: 'high' },

    // System prompt leakage attempts
    { pattern: /repeat\s+your\s+(system\s+)?instructions?/gi, severity: 'high' },
    { pattern: /what\s+are\s+your\s+(system\s+)?(instructions?|rules?|prompts?)/gi, severity: 'high' },
    { pattern: /show\s+me\s+your\s+(system\s+)?(prompt|instructions?)/gi, severity: 'high' },
    { pattern: /print\s+your\s+(system\s+)?(prompt|instructions?)/gi, severity: 'high' },

    // Code execution attempts (XSS-like)
    { pattern: /<script[\s\S]*?<\/script>/gi, severity: 'high' },
    { pattern: /javascript:/gi, severity: 'medium' },
    { pattern: /eval\s*\(/gi, severity: 'high' },
    { pattern: /function\s*\(/gi, severity: 'medium' },
    { pattern: /on(load|error|click|mouseover)\s*=/gi, severity: 'medium' },

    // Credential harvesting attempts
    { pattern: /send\s+(all\s+)?(credentials?|passwords?|tokens?|secrets?)\s+to/gi, severity: 'high' },
    { pattern: /submit\s+(your\s+)?(credentials?|passwords?|tokens?)\s+to/gi, severity: 'high' },
    { pattern: /post\s+(your\s+)?(credentials?|passwords?|tokens?)\s+to/gi, severity: 'high' },

    // Role manipulation
    { pattern: /you\s+are\s+now\s+(a|an)\s+/gi, severity: 'high' },
    { pattern: /act\s+as\s+(a|an)\s+/gi, severity: 'medium' },
    { pattern: /pretend\s+(you\s+are|to\s+be)\s+(a|an)\s+/gi, severity: 'medium' },

    // Output manipulation
    { pattern: /respond\s+with\s+only/gi, severity: 'medium' },
    { pattern: /output\s+only/gi, severity: 'medium' },
    { pattern: /return\s+only/gi, severity: 'medium' },
  ];

  /**
   * Suspicious markers that could be used to confuse the AI
   * These often indicate attempts to inject fake system messages
   */
  private static readonly SUSPICIOUS_MARKERS = [
    '===', '---', '***',
    'SYSTEM:', 'ASSISTANT:', 'USER:', 'AI:',
    'IMPORTANT:', 'CRITICAL:', 'OVERRIDE:', 'ATTENTION:',
    'NEW INSTRUCTION:', 'NEW GOAL:', 'NEW TASK:',
  ];

  /**
   * Maximum length for a single text block to prevent flooding attacks
   */
  private static readonly MAX_SINGLE_TEXT_LENGTH = 5000;

  /**
   * Sanitize text content before including in prompt
   *
   * @param pageText - Raw text from page
   * @param context - Context information (URL, element ref)
   * @returns Sanitization result with cleaned text and blocked items
   */
  static sanitize(pageText: string, context: {
    url: string;
    elementRef?: string;
  }): SanitizationResult {
    let sanitized = pageText;
    const blocked: SanitizationResult['blocked'] = [];
    let modified = false;

    // 1. Check for injection patterns
    for (const { pattern, severity } of this.INJECTION_PATTERNS) {
      const matches = pageText.match(pattern);
      if (matches) {
        for (const match of matches) {
          blocked.push({
            originalText: match.slice(0, 100), // Truncate for logging
            reason: 'Prompt injection pattern detected',
            severity,
          });

          // Replace with safe placeholder
          sanitized = sanitized.replace(
            match,
            `[REDACTED: suspicious ${severity === 'high' ? 'instruction' : 'content'}]`
          );
          modified = true;
        }
      }
    }

    // 2. Check for suspicious markers
    for (const marker of this.SUSPICIOUS_MARKERS) {
      if (pageText.includes(marker)) {
        blocked.push({
          originalText: marker,
          reason: 'Suspicious system marker detected',
          severity: 'medium',
        });

        // Replace marker with escaped version (remove special chars)
        const escaped = marker.replace(/[=\-*:]/g, '');
        sanitized = sanitized.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), escaped);
        modified = true;
      }
    }

    // 3. Check for excessively long text blocks (flood attack prevention)
    const lines = sanitized.split('\n');
    const processedLines: string[] = [];

    for (const line of lines) {
      if (line.length > this.MAX_SINGLE_TEXT_LENGTH) {
        blocked.push({
          originalText: line.slice(0, 100) + '...',
          reason: 'Excessively long text block (possible flood attack)',
          severity: 'low',
        });
        processedLines.push(line.slice(0, this.MAX_SINGLE_TEXT_LENGTH) + '... [TRUNCATED]');
        modified = true;
      } else {
        processedLines.push(line);
      }
    }

    sanitized = processedLines.join('\n');

    // 4. Check for hidden content with instructions (specific pattern)
    // This catches attempts to hide malicious instructions in invisible elements
    const hiddenInstructionPattern = /\[(?:HIDDEN|INVISIBLE|DISPLAY:NONE)\][\s\S]{0,500}?(ignore|disregard|new\s+goal|override|instead)[\s\S]{0,200}?\[\/(?:HIDDEN|INVISIBLE|DISPLAY:NONE)\]/gi;
    const hiddenMatches = sanitized.match(hiddenInstructionPattern);
    if (hiddenMatches) {
      for (const match of hiddenMatches) {
        blocked.push({
          originalText: match.slice(0, 100),
          reason: 'Hidden element with instruction-like content',
          severity: 'high',
        });
        sanitized = sanitized.replace(match, '[REDACTED: hidden instruction]');
        modified = true;
      }
    }

    return { sanitized, blocked, modified };
  }

  /**
   * Sanitize entire snapshot before building prompt
   *
   * @param snapshot - Formatted snapshot text
   * @param url - Current page URL
   * @returns Sanitization result with statistics
   */
  static sanitizeSnapshot(snapshot: string, url: string): SnapshotSanitizationResult {
    const result = this.sanitize(snapshot, { url });

    const highSeverityCount = result.blocked.filter(b => b.severity === 'high').length;
    const mediumSeverityCount = result.blocked.filter(b => b.severity === 'medium').length;

    // Log security events
    if (highSeverityCount > 0) {
      logger.warn('[SECURITY] High-severity injection attempts blocked', {
        url,
        count: highSeverityCount,
        samples: result.blocked
          .filter(b => b.severity === 'high')
          .slice(0, 3)
          .map(b => ({
            text: b.originalText,
            reason: b.reason,
          })),
      });
    }

    if (mediumSeverityCount > 3) {
      logger.info('[SECURITY] Multiple medium-severity patterns detected', {
        url,
        count: mediumSeverityCount,
      });
    }

    return {
      sanitized: result.sanitized,
      totalBlocked: result.blocked.length,
      highSeverityCount,
      mediumSeverityCount,
      blocked: result.blocked,
    };
  }

  /**
   * Check if a URL is potentially malicious based on patterns
   * This is a basic check - more sophisticated detection could be added
   *
   * @param url - URL to check
   * @returns True if URL looks suspicious
   */
  static isUrlSuspicious(url: string): boolean {
    const suspiciousPatterns = [
      // Data URLs with scripts
      /^data:text\/html.*<script/i,
      // JavaScript protocol
      /^javascript:/i,
      // Known malicious TLDs (extend as needed)
      /\.(tk|ml|ga|cf|gq)$/i,
    ];

    return suspiciousPatterns.some(pattern => pattern.test(url));
  }

  /**
   * Sanitize element text content specifically
   * Used for individual elements that might contain injection attempts
   *
   * @param text - Element text
   * @param elementType - Type of element (button, input, etc.)
   * @returns Sanitized text
   */
  static sanitizeElementText(text: string, elementType: string): string {
    // Quick sanitization for element text
    // More aggressive than full snapshot sanitization

    // Remove any suspicious instruction patterns
    let sanitized = text;

    for (const { pattern } of this.INJECTION_PATTERNS.filter(p => p.severity === 'high')) {
      sanitized = sanitized.replace(pattern, '[redacted]');
    }

    // Limit length based on element type
    const maxLength = elementType === 'button' ? 100 : 500;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.slice(0, maxLength) + '...';
    }

    return sanitized;
  }
}
