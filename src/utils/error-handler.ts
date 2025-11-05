import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { QAIError, ValidationError, NotFoundError, RateLimitError } from '@/types';

/**
 * Send success response
 */
export const successResponse = (res: Response, data: any, statusCode: number = 200): void => {
  res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Send error response
 */
export const errorResponse = (res: Response, message: string, statusCode: number = 400, code?: string): void => {
  res.status(statusCode).json({
    success: false,
    error: message,
    code: code || 'ERROR',
    timestamp: new Date().toISOString(),
  });
};

// Error handler middleware
export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Log the error
  logger.error({
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString(),
  });

  // Handle known error types
  if (error instanceof QAIError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle validation errors
  if (error.name === 'ValidationError') {
    res.status(400).json({
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError') {
    res.status(401).json({
      success: false,
      error: 'Invalid token',
      code: 'INVALID_TOKEN',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (error.name === 'TokenExpiredError') {
    res.status(401).json({
      success: false,
      error: 'Token expired',
      code: 'TOKEN_EXPIRED',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle Supabase errors
  if (error.name === 'PostgrestError') {
    const pgError = error as any;
    res.status(400).json({
      success: false,
      error: 'Database error',
      code: 'DATABASE_ERROR',
      details: pgError.message,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle Redis errors
  if (error.message.includes('Redis')) {
    res.status(503).json({
      success: false,
      error: 'Queue service unavailable',
      code: 'QUEUE_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle OpenAI errors
  if (error.message.includes('OpenAI')) {
    res.status(503).json({
      success: false,
      error: 'AI service unavailable',
      code: 'AI_SERVICE_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle agent communication errors
  if (error.message.includes('Agent')) {
    res.status(503).json({
      success: false,
      error: 'Test agent unavailable',
      code: 'AGENT_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Default error response
  const statusCode = 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : error.message;

  res.status(statusCode).json({
    success: false,
    error: message,
    code: 'INTERNAL_ERROR',
    timestamp: new Date().toISOString(),
  });
};

// 404 handler
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.originalUrl} not found`,
    code: 'NOT_FOUND',
    timestamp: new Date().toISOString(),
  });
};

// Async error wrapper
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Validation error handler
export const handleValidationError = (error: any) => {
  if (error.isJoi) {
    const details = error.details.map((detail: any) => ({
      field: detail.path.join('.'),
      message: detail.message,
    }));

    throw new ValidationError('Validation failed', details);
  }

  if (error.name === 'ZodError') {
    const details = error.errors.map((err: any) => ({
      field: err.path.join('.'),
      message: err.message,
    }));

    throw new ValidationError('Validation failed', details);
  }

  throw error;
};

// Database error handler
export const handleDatabaseError = (error: any) => {
  if (error.code === '23505') { // Unique constraint violation
    throw new ValidationError('Resource already exists');
  }

  if (error.code === '23503') { // Foreign key constraint violation
    throw new ValidationError('Referenced resource not found');
  }

  if (error.code === '23502') { // Not null constraint violation
    throw new ValidationError('Required field is missing');
  }

  throw error;
};

// Queue error handler
export const handleQueueError = (error: any) => {
  if (error.message.includes('Connection is closed')) {
    throw new QAIError('Queue service unavailable', 'QUEUE_UNAVAILABLE', 503);
  }

  if (error.message.includes('Job not found')) {
    throw new NotFoundError('Job', 'unknown');
  }

  throw error;
};

// AI service error handler
export const handleAIError = (error: any) => {
  if (error.status === 429) {
    throw new RateLimitError('AI service rate limit exceeded');
  }

  if (error.status === 401) {
    throw new QAIError('AI service authentication failed', 'AI_AUTH_ERROR', 401);
  }

  if (error.status === 403) {
    throw new QAIError('AI service access forbidden', 'AI_ACCESS_FORBIDDEN', 403);
  }

  throw new QAIError('AI service error', 'AI_SERVICE_ERROR', 503, error.message);
};

// Agent communication error handler
export const handleAgentError = (error: any) => {
  if (error.code === 'ECONNREFUSED') {
    throw new QAIError('Test agent unavailable', 'AGENT_UNAVAILABLE', 503);
  }

  if (error.code === 'ETIMEDOUT') {
    throw new QAIError('Test agent timeout', 'AGENT_TIMEOUT', 504);
  }

  if (error.status >= 400 && error.status < 500) {
    throw new QAIError('Test agent client error', 'AGENT_CLIENT_ERROR', error.status);
  }

  if (error.status >= 500) {
    throw new QAIError('Test agent server error', 'AGENT_SERVER_ERROR', 503);
  }

  throw new QAIError('Test agent communication error', 'AGENT_COMMUNICATION_ERROR', 503);
};

// Health check error handler
export const handleHealthCheckError = (service: string, error: any) => {
  logger.warn(`Health check failed for ${service}:`, error.message);
  return {
    service,
    status: 'unhealthy',
    error: error.message,
    timestamp: new Date().toISOString(),
  };
};

// Retry error handler
export const shouldRetry = (error: any, attempt: number, maxAttempts: number): boolean => {
  // Don't retry if we've exceeded max attempts
  if (attempt >= maxAttempts) {
    return false;
  }

  // Retry on network errors
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    return true;
  }

  // Retry on rate limit errors (with exponential backoff)
  if (error.status === 429) {
    return true;
  }

  // Retry on server errors (5xx)
  if (error.status >= 500) {
    return true;
  }

  // Don't retry on client errors (4xx) except rate limiting
  if (error.status >= 400 && error.status < 500) {
    return false;
  }

  // Retry on unknown errors
  return true;
};

// Calculate retry delay with exponential backoff
export const calculateRetryDelay = (attempt: number, baseDelay: number = 1000): number => {
  return Math.min(baseDelay * Math.pow(2, attempt), 30000); // Max 30 seconds
};
