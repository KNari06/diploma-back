import { ApiEnvironment } from '@/types';
import { logger } from '@/utils/logger';
import { ApiConfigService } from '../api/api-config.service';

/**
 * Service for resolving relative API paths to full URLs
 */
export class UrlResolverService {

  /**
   * Resolve relative path to full URL using project context
   */
  static async resolveApiUrl(
    relativePath: string,
    userId: string,
    projectId: string,
    method: string = 'GET'
  ): Promise<{
    fullUrl: string;
    environment?: ApiEnvironment;
    source: 'default_env' | 'suggested_env' | 'user_input_required';
    suggestions?: string[];
  }> {
    // Validate inputs
    if (!relativePath || typeof relativePath !== 'string' || relativePath.trim().length === 0) {
      logger.warn('[URL_RESOLVER] Invalid relativePath', { relativePath: typeof relativePath });
      return {
        fullUrl: relativePath || '',
        source: 'user_input_required',
        suggestions: this.generateBaseUrlSuggestions('/api/'),
      };
    }

    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      logger.warn('[URL_RESOLVER] Invalid userId', { userId: typeof userId });
      return {
        fullUrl: relativePath,
        source: 'user_input_required',
        suggestions: this.generateBaseUrlSuggestions(relativePath),
      };
    }

    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      logger.warn('[URL_RESOLVER] Invalid projectId', { projectId: typeof projectId });
      return {
        fullUrl: relativePath,
        source: 'user_input_required',
        suggestions: this.generateBaseUrlSuggestions(relativePath),
      };
    }

    try {
      // Clean the relative path
      const cleanPath = relativePath.trim().startsWith('/') ? relativePath.trim() : `/${relativePath.trim()}`;

      logger.info('[URL_RESOLVER] Resolving relative path', {
        relativePath: cleanPath,
        userId,
        projectId,
        method,
      });

      // 1. Try to find default environment for this project
      const defaultEnv = await ApiConfigService.getDefaultEnvironment(userId, projectId);

      if (defaultEnv) {
        const fullUrl = `${defaultEnv.base_url}${cleanPath}`;
        logger.info('[URL_RESOLVER] Resolved using default environment', {
          environmentId: defaultEnv.id,
          environmentName: defaultEnv.name,
          baseUrl: defaultEnv.base_url,
          fullUrl,
        });

        return {
          fullUrl,
          environment: defaultEnv,
          source: 'default_env',
        };
      }

      // 2. Try to find any environment for this project
      const environments = await ApiConfigService.getEnvironments(userId, projectId);

      if (environments.length > 0) {
        // Use the first available environment
        const env = environments[0];
        const fullUrl = `${env.base_url}${cleanPath}`;

        logger.info('[URL_RESOLVER] Resolved using first available environment', {
          environmentId: env.id,
          environmentName: env.name,
          baseUrl: env.base_url,
          fullUrl,
        });

        // Also provide suggestions from other environments
        const suggestions = environments.slice(1).map(e => `${e.base_url}${cleanPath}`);

        return {
          fullUrl,
          environment: env,
          source: 'suggested_env',
          suggestions,
        };
      }

      // 3. No environments found - need user input
      logger.info('[URL_RESOLVER] No environments found, user input required', {
        relativePath: cleanPath,
        userId,
        projectId,
      });

      // Generate common base URL suggestions
      const suggestions = this.generateBaseUrlSuggestions(cleanPath);

      return {
        fullUrl: cleanPath, // Return as-is, will need user input
        source: 'user_input_required',
        suggestions,
      };

    } catch (error) {
      logger.error('[URL_RESOLVER] Error resolving relative path', {
        error: error instanceof Error ? error.message : String(error),
        relativePath: relativePath.substring(0, 100),
        userId,
        projectId,
      });

      // Fallback: return as-is and let user provide base URL
      return {
        fullUrl: relativePath,
        source: 'user_input_required',
        suggestions: this.generateBaseUrlSuggestions(relativePath),
      };
    }
  }

  /**
   * Generate common base URL suggestions based on the path
   */
  static generateBaseUrlSuggestions(path: string): string[] {
    const suggestions: string[] = [];

    // Validate input
    if (!path || typeof path !== 'string') {
      return ['https://api.example.com', 'http://localhost:3000'];
    }

    const normalizedPath = path.trim();

    // Common patterns based on path structure
    if (normalizedPath.startsWith('/api/v')) {
      // Versioned API
      suggestions.push(
        'https://api.example.com',
        'https://your-api.com',
        'http://localhost:3000',
        'http://localhost:8000'
      );
    } else if (normalizedPath.startsWith('/api/')) {
      // Standard API
      suggestions.push(
        'https://api.example.com',
        'https://your-domain.com',
        'http://localhost:3000',
        'http://localhost:8080'
      );
    } else {
      // Direct path
      suggestions.push(
        'https://api.example.com/api',
        'https://your-api.com/v1',
        'http://localhost:3000/api',
        'http://localhost:8000/api/v1'
      );
    }

    return suggestions;
  }

  /**
   * Check if a URL is relative (doesn't have protocol and host)
   */
  static isRelativeUrl(url: string): boolean {
    // Validate input
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return true; // Empty string is considered relative
    }

    try {
      // If we can create a URL object, it's absolute
      new URL(url.trim());
      return false;
    } catch {
      // If URL constructor fails, it's likely relative
      return true;
    }
  }

  /**
   * Extract base URL from full URL
   */
  static extractBaseUrl(fullUrl: string): string {
    // Validate input
    if (!fullUrl || typeof fullUrl !== 'string' || fullUrl.trim().length === 0) {
      logger.debug('[URL_RESOLVER] Invalid fullUrl in extractBaseUrl', { fullUrl: typeof fullUrl });
      return '';
    }

    try {
      const url = new URL(fullUrl.trim());
      const baseUrl = `${url.protocol}//${url.host}`;

      // Validate extracted base URL
      if (baseUrl.length === 0 || !url.host) {
        logger.warn('[URL_RESOLVER] Extracted empty base URL', { fullUrl: fullUrl.substring(0, 100) });
        return '';
      }

      return baseUrl;
    } catch {
      logger.debug('[URL_RESOLVER] Failed to extract base URL', { fullUrl: fullUrl.substring(0, 100) });
      return '';
    }
  }

  /**
   * Extract path from full URL
   */
  static extractPath(fullUrl: string): string {
    // Validate input
    if (!fullUrl || typeof fullUrl !== 'string') {
      return '/';
    }

    const normalized = fullUrl.trim();

    try {
      const url = new URL(normalized);
      return url.pathname || '/';
    } catch {
      // If it's not a valid URL, assume it's already a path
      return normalized.startsWith('/') ? normalized : `/${normalized}`;
    }
  }

  /**
   * Generate environment name from base URL
   */
  static generateEnvironmentName(baseUrl: string): string {
    // Validate input
    if (!baseUrl || typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      return 'Default';
    }

    try {
      const url = new URL(baseUrl.trim());
      const hostname = url.hostname;

      if (!hostname || hostname.length === 0) {
        return 'Default';
      }

      // Extract meaningful name from hostname
      if (hostname.includes('localhost')) {
        return `Local (${url.port || '80'})`;
      } else if (hostname.includes('staging') || hostname.includes('stage')) {
        return 'Staging';
      } else if (hostname.includes('dev')) {
        return 'Development';
      } else if (hostname.includes('test')) {
        return 'Testing';
      } else if (hostname.includes('prod') || hostname.includes('api.')) {
        return 'Production';
      } else {
        // Use domain name
        const parts = hostname.split('.');
        return parts.length > 1 ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : hostname;
      }
    } catch (error) {
      return 'Default';
    }
  }

  /**
   * Suggest missing information for API testing
   */
  static generateMissingInfoPrompt(
    relativePath: string,
    method: string,
    suggestions: string[]
  ): {
    message: string;
    questions: Array<{
      id: string;
      question: string;
      type: string;
      required: boolean;
      suggestions?: string[];
    }>;
  } {
    const message = `🔗 For API testing, a full URL is required. You provided only a path: \`${relativePath}\`\n\nPlease provide your API base URL:`;

    const questions = [
      {
        id: 'base_url',
        question: 'API base URL (e.g., https://api.example.com)',
        type: 'url',
        required: true,
        suggestions,
      },
      {
        id: 'auth_token',
        question: 'Authorization token (if required)',
        type: 'text',
        required: false,
      },
      {
        id: 'additional_headers',
        question: 'Additional headers (JSON format, if needed)',
        type: 'json',
        required: false,
      },
    ];

    return { message, questions };
  }

  /**
   * Parse user response with base URL and create full URL
   */
  static parseUserResponse(
    relativePath: string,
    userResponse: string
  ): {
    fullUrl?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    error?: string;
  } {
    // Validate inputs
    if (!relativePath || typeof relativePath !== 'string') {
      return {
        error: 'Invalid relative path',
      };
    }

    if (!userResponse || typeof userResponse !== 'string' || userResponse.trim().length === 0) {
      return {
        error: 'Empty user response',
      };
    }

    try {
      // Try to extract URL from user response
      const urlMatch = userResponse.match(/(https?:\/\/[^\s<>"']+)/i);

      if (urlMatch && urlMatch[1]) {
        // Validate extracted URL
        let baseUrl: string;
        try {
          const extracted = urlMatch[1].replace(/\/$/, ''); // Remove trailing slash
          new URL(extracted); // Validate URL format
          baseUrl = extracted;
        } catch {
          return {
            error: 'Invalid URL format in user response',
          };
        }

        const cleanPath = relativePath.trim().startsWith('/') ? relativePath.trim() : `/${relativePath.trim()}`;

        // Validate full URL can be constructed
        let fullUrl: string;
        try {
          fullUrl = `${baseUrl}${cleanPath}`;
          new URL(fullUrl); // Validate full URL format
        } catch {
          return {
            error: 'Cannot construct valid full URL',
          };
        }

        // Try to extract token/headers from response
        const headers: Record<string, string> = {};

        // Look for Bearer token
        const tokenMatch = userResponse.match(/(?:token|bearer)\s*:?\s*([a-zA-Z0-9._-]+)/i);
        if (tokenMatch) {
          headers['Authorization'] = `Bearer ${tokenMatch[1]}`;
        }

        // Look for API key
        const apiKeyMatch = userResponse.match(/(?:api[_-]?key|key)\s*:?\s*([a-zA-Z0-9._-]+)/i);
        if (apiKeyMatch) {
          headers['X-API-Key'] = apiKeyMatch[1];
        }

        return {
          fullUrl,
          baseUrl,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        };
      }

      return {
        error: 'Could not find URL in response. Please provide a full URL (e.g., https://api.example.com)',
      };
    } catch (error) {
      return {
        error: 'Error processing response. Please provide a valid URL.',
      };
    }
  }

  /**
   * Smart URL completion - try to complete partial URLs
   */
  static smartCompleteUrl(partialUrl: string): string[] {
    const suggestions: string[] = [];

    // Validate input
    if (!partialUrl || typeof partialUrl !== 'string' || partialUrl.trim().length === 0) {
      return suggestions;
    }

    const normalized = partialUrl.trim();

    // If it looks like a domain without protocol
    if (normalized.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) && !normalized.startsWith('http')) {
      suggestions.push(`https://${normalized}`, `http://${normalized}`);
    }

    // If it looks like localhost
    if (normalized.includes('localhost') && !normalized.startsWith('http')) {
      suggestions.push(`http://${normalized}`, `https://${normalized}`);
    }

    // If it's just a port number
    if (normalized.match(/^:\d+$/)) {
      suggestions.push(`http://localhost${normalized}`, `https://localhost${normalized}`);
    }

    // If it's just a number (port)
    if (normalized.match(/^\d+$/)) {
      const port = parseInt(normalized, 10);
      if (port > 0 && port <= 65535) {
        suggestions.push(`http://localhost:${normalized}`, `https://localhost:${normalized}`);
      }
    }

    // Validate suggestions (filter out invalid URLs)
    return suggestions.filter((url) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    });
  }
}
