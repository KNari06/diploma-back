import { NotFoundError, QAIError, RateLimitError, ValidationError } from '@/types';
import { NextFunction, Request, Response } from 'express';
import { logger } from './logger';

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

// ✅ FIX: Helper to check if origin is allowed (same logic as in index.ts)
const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return false;

  const isDevelopment = process.env.NODE_ENV === 'development';
  if (isDevelopment) return true; // Development mode - allow all

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  if (!allowedOrigins || typeof allowedOrigins !== 'string') {
    return false;
  }

  try {
    const origins = allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
    return origins.includes(origin);
  } catch {
    return false;
  }
};

// Error handler middleware
export const errorHandler = (
  error: Error,
  req: Request,
  res: Response
): void => {
  // ✅ FIX: Ensure CORS headers are always set, even on errors
  // This prevents CORS errors when backend is unavailable (502/503)
  // BUT only for allowed origins to avoid security issues
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
  }

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
  if (error.message && typeof error.message === 'string' && error.message.includes('Redis')) {
    res.status(503).json({
      success: false,
      error: 'Queue service unavailable',
      code: 'QUEUE_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle OpenAI errors
  if (error.message && typeof error.message === 'string' && error.message.includes('OpenAI')) {
    res.status(503).json({
      success: false,
      error: 'AI service unavailable',
      code: 'AI_SERVICE_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Handle agent communication errors
  if (error.message && typeof error.message === 'string' && error.message.includes('Agent')) {
    res.status(503).json({
      success: false,
      error: 'Test agent unavailable',
      code: 'AGENT_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // ✅ FIX: Handle connection errors that indicate backend is unavailable/restarting
  // These should return 502 (Bad Gateway) - backend is down, not just temporarily unavailable
  const errorCode = (error as any).code;
  if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT' || errorCode === 'ENOTFOUND' || errorCode === 'ECONNRESET') {
    res.status(502).json({
      success: false,
      error: 'Bad Gateway',
      code: 'BAD_GATEWAY',
      details: 'The service is temporarily unavailable. Please try again in a few moments.',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // ✅ FIX: Handle 502 Bad Gateway errors (from proxy/load balancer or error messages)
  if (error.message && typeof error.message === 'string' && (
    error.message.includes('502') ||
    error.message.includes('Bad Gateway')
  )) {
    res.status(502).json({
      success: false,
      error: 'Bad Gateway',
      code: 'BAD_GATEWAY',
      details: 'The service is temporarily unavailable. Please try again in a few moments.',
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
  // ✅ FIX: Ensure CORS headers are set for 404 responses (only for allowed origins)
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
  }

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
  if (!error || typeof error !== 'object') {
    throw error;
  }

  if (error.isJoi && Array.isArray(error.details)) {
    const details = error.details.map((detail: any) => ({
      field: Array.isArray(detail.path) ? detail.path.join('.') : String(detail.path || 'unknown'),
      message: detail.message || 'Validation error',
    }));

    throw new ValidationError('Validation failed', details);
  }

  if (error.name === 'ZodError' && Array.isArray(error.errors)) {
    const details = error.errors.map((err: any) => ({
      field: Array.isArray(err.path) ? err.path.join('.') : String(err.path || 'unknown'),
      message: err.message || 'Validation error',
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
  if (!error || typeof error !== 'object') {
    throw error;
  }

  if (error.message && typeof error.message === 'string') {
    if (error.message.includes('Connection is closed')) {
      throw new QAIError('Queue service unavailable', 'QUEUE_UNAVAILABLE', 503);
    }

    if (error.message.includes('Job not found')) {
      throw new NotFoundError('Job', 'unknown');
    }
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
  const errorMessage = error && typeof error === 'object' && error.message
    ? String(error.message)
    : (error ? String(error) : 'Unknown error');

  logger.warn(`Health check failed for ${service}:`, errorMessage);
  return {
    service: service || 'unknown',
    status: 'unhealthy',
    error: errorMessage,
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
