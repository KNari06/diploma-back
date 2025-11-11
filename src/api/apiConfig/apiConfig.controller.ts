import { Request, Response } from 'express';
import { ApiConfigService } from '@/services/api/api-config.service';
import { logger } from '@/utils/logger';
import {
  ApiEnvironment,
  ApiEndpoint,
  ApiConfigurationRequest,
  ApiTestExecutionRequest
} from '@/types';

/**
 * Get all API environments for user and project
 */
export const getEnvironments = async (req: Request, res: Response): Promise<void> => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!projectId) {
      res.status(400).json({ success: false, error: 'Project ID is required' });
      return;
    }

    const environments = await ApiConfigService.getEnvironments(userId, projectId);

    res.json({
      success: true,
      data: environments,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get API environments', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to get API environments',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Get default API environment for user and project
 */
export const getDefaultEnvironment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!projectId) {
      res.status(400).json({ success: false, error: 'Project ID is required' });
      return;
    }

    const environment = await ApiConfigService.getDefaultEnvironment(userId, projectId);

    res.json({
      success: true,
      data: environment,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get default API environment', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to get default API environment',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Create or update API environment
 */
export const upsertEnvironment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id;
    const environmentData = req.body as Partial<ApiEnvironment>;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!projectId) {
      res.status(400).json({ success: false, error: 'Project ID is required' });
      return;
    }

    if (!environmentData.name || !environmentData.base_url) {
      res.status(400).json({
        success: false,
        error: 'Environment name and base URL are required'
      });
      return;
    }

    const environment = await ApiConfigService.upsertEnvironment(
      userId,
      projectId,
      environmentData
    );

    res.json({
      success: true,
      data: environment,
      message: environmentData.id ? 'Environment updated' : 'Environment created',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to upsert API environment', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to save API environment',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Get API endpoints for an environment
 */
export const getEndpoints = async (req: Request, res: Response): Promise<void> => {
  try {
    const { environmentId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!environmentId) {
      res.status(400).json({ success: false, error: 'Environment ID is required' });
      return;
    }

    const endpoints = await ApiConfigService.getEndpoints(environmentId, userId);

    res.json({
      success: true,
      data: endpoints,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to get API endpoints', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to get API endpoints',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Create or update API endpoint
 */
export const upsertEndpoint = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const endpointData = req.body as Partial<ApiEndpoint>;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!endpointData.environment_id || !endpointData.method || !endpointData.path) {
      res.status(400).json({
        success: false,
        error: 'Environment ID, method, and path are required'
      });
      return;
    }

    const endpoint = await ApiConfigService.upsertEndpoint(userId, endpointData);

    res.json({
      success: true,
      data: endpoint,
      message: endpointData.id ? 'Endpoint updated' : 'Endpoint created',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to upsert API endpoint', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to save API endpoint',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Analyze API URL and suggest configuration
 */
export const analyzeApiUrl = async (req: Request, res: Response): Promise<void> => {
  try {
    const { projectId } = req.params;
    const { apiUrl, method = 'GET', headers, body } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!projectId || !apiUrl) {
      res.status(400).json({
        success: false,
        error: 'Project ID and API URL are required'
      });
      return;
    }

    const result = await ApiConfigService.analyzeAndSuggestConfig(
      userId,
      projectId,
      apiUrl,
      method,
      headers,
      body
    );

    res.json({
      success: true,
      data: result,
      message: result.isNew ? 'New configuration created' : 'Existing configuration found',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to analyze API URL', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to analyze API URL',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Execute API test with stored configuration
 */
export const executeWithConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const executionRequest = req.body as ApiTestExecutionRequest;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!executionRequest.environment_id && !executionRequest.endpoint_id) {
      res.status(400).json({
        success: false,
        error: 'Either environment_id or endpoint_id is required'
      });
      return;
    }

    const execution = await ApiConfigService.executeWithConfig(userId, executionRequest);

    res.json({
      success: true,
      data: execution,
      message: 'API test executed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to execute API test with config', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to execute API test',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Bulk configuration setup
 */
export const bulkSetup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id;
    const configRequest = req.body as ApiConfigurationRequest;

    if (!userId) {
      res.status(401).json({ success: false, error: 'User not authenticated' });
      return;
    }

    if (!projectId) {
      res.status(400).json({ success: false, error: 'Project ID is required' });
      return;
    }

    const results: {
      environment?: ApiEnvironment;
      endpoints?: ApiEndpoint[];
      errors?: string[];
    } = {};

    // Create environment if provided
    if (configRequest.environment) {
      try {
        results.environment = await ApiConfigService.upsertEnvironment(
          userId,
          projectId,
          configRequest.environment
        );
      } catch (error) {
        results.errors = results.errors || [];
        results.errors.push(`Failed to create environment: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Create endpoints if provided
    if (configRequest.endpoints && configRequest.endpoints.length > 0) {
      results.endpoints = [];

      for (const endpointData of configRequest.endpoints) {
        try {
          // Use the created environment if available
          if (results.environment && !endpointData.environment_id) {
            endpointData.environment_id = results.environment.id;
          }

          const endpoint = await ApiConfigService.upsertEndpoint(userId, endpointData);
          results.endpoints.push(endpoint);
        } catch (error) {
          results.errors = results.errors || [];
          results.errors.push(`Failed to create endpoint ${endpointData.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    const hasErrors = results.errors && results.errors.length > 0;

    res.status(hasErrors ? 207 : 200).json({
      success: !hasErrors,
      data: results,
      message: hasErrors
        ? 'Configuration setup completed with some errors'
        : 'Configuration setup completed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Failed to setup bulk API configuration', { error, userId: req.user?.id });
    res.status(500).json({
      success: false,
      error: 'Failed to setup API configuration',
      timestamp: new Date().toISOString(),
    });
  }
};
