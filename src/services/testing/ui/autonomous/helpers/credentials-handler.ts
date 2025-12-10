import { retrieveCredentials, storeCredentials } from '@/services/api/credentials-manager.service';
import { logger } from '@/utils/logger';

/**
 * Handle credentials storage and retrieval for authenticated exploration
 */
export async function handleCredentialsForExploration(params: {
  needsAuth: boolean;
  credentials?: { email?: string; username?: string; password: string };
  userId: string;
  projectId: string;
  url: string;
}): Promise<{ email?: string; username?: string; password: string } | undefined> {
  const { needsAuth, credentials, userId, projectId, url } = params;

  if (!needsAuth) {
    return undefined;
  }

  if (!credentials) {
    logger.error('[AUTONOMOUS] Auth required but no credentials provided');
    throw new Error(
      'Authentication required but credentials not provided. Please provide login credentials.'
    );
  }

  logger.info('[AUTONOMOUS] Handling credentials', {
    needsAuth,
    hasCredentials: !!credentials,
  });

  // Store credentials securely
  const stored = await storeCredentials({
    userId,
    projectId,
    ...credentials,
    urlPattern: url,
    label: `Auto-generated for ${url}`,
  });

  // Retrieve for immediate use
  const retrieved = await retrieveCredentials(stored.id, userId);
  if (!retrieved) {
    logger.error('[AUTONOMOUS] Failed to retrieve stored credentials', {
      storedId: stored.id,
    });
    throw new Error(
      'Failed to retrieve credentials. Please try again or contact support.'
    );
  }

  logger.info('[AUTONOMOUS] Credentials retrieved successfully');
  return retrieved;
}
