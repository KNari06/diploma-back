import { logger } from '@/utils/logger';
import { ApiConfigService } from '../api/api-config.service';
import { ApiEnvironment } from '@/types';

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
    try {
      // Clean the relative path
      const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;

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
        error,
        relativePath,
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

    // Common patterns based on path structure
    if (path.startsWith('/api/v')) {
      // Versioned API
      suggestions.push(
        'https://api.example.com',
        'https://your-api.com',
        'http://localhost:3000',
        'http://localhost:8000'
      );
    } else if (path.startsWith('/api/')) {
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
    try {
      // If we can create a URL object, it's absolute
      new URL(url);
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
    try {
      const url = new URL(fullUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      return '';
    }
  }

  /**
   * Extract path from full URL
   */
  static extractPath(fullUrl: string): string {
    try {
      const url = new URL(fullUrl);
      return url.pathname;
    } catch {
      // If it's not a valid URL, assume it's already a path
      return fullUrl.startsWith('/') ? fullUrl : `/${fullUrl}`;
    }
  }

  /**
   * Generate environment name from base URL
   */
  static generateEnvironmentName(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      const hostname = url.hostname;

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
    const message = `🔗 Для тестирования API нужен полный URL. Вы указали только путь: \`${relativePath}\`\n\nПожалуйста, укажите базовый URL вашего API:`;

    const questions = [
      {
        id: 'base_url',
        question: 'Базовый URL API (например: https://api.example.com)',
        type: 'url',
        required: true,
        suggestions,
      },
      {
        id: 'auth_token',
        question: 'Токен авторизации (если требуется)',
        type: 'text',
        required: false,
      },
      {
        id: 'additional_headers',
        question: 'Дополнительные заголовки (JSON формат, если нужны)',
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
    try {
      // Try to extract URL from user response
      const urlMatch = userResponse.match(/(https?:\/\/[^\s]+)/i);

      if (urlMatch) {
        const baseUrl = urlMatch[1].replace(/\/$/, ''); // Remove trailing slash
        const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
        const fullUrl = `${baseUrl}${cleanPath}`;

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
        error: 'Не удалось найти URL в ответе. Пожалуйста, укажите полный URL (например: https://api.example.com)',
      };
    } catch (error) {
      return {
        error: 'Ошибка при обработке ответа. Пожалуйста, укажите корректный URL.',
      };
    }
  }

  /**
   * Smart URL completion - try to complete partial URLs
   */
  static smartCompleteUrl(partialUrl: string): string[] {
    const suggestions: string[] = [];

    // If it looks like a domain without protocol
    if (partialUrl.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) && !partialUrl.startsWith('http')) {
      suggestions.push(`https://${partialUrl}`, `http://${partialUrl}`);
    }

    // If it looks like localhost
    if (partialUrl.includes('localhost') && !partialUrl.startsWith('http')) {
      suggestions.push(`http://${partialUrl}`, `https://${partialUrl}`);
    }

    // If it's just a port number
    if (partialUrl.match(/^:\d+/)) {
      suggestions.push(`http://localhost${partialUrl}`, `https://localhost${partialUrl}`);
    }

    // If it's just a number (port)
    if (partialUrl.match(/^\d+$/)) {
      suggestions.push(`http://localhost:${partialUrl}`, `https://localhost:${partialUrl}`);
    }

    return suggestions;
  }
}
