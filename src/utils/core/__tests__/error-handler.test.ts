/**
 * Unit tests for error-handler.ts
 * Tests error handling middleware and helper functions
 */

import { Request, Response, NextFunction } from 'express';
import {
  successResponse,
  errorResponse,
  errorHandler,
  httpErrorAuditMiddleware,
  notFoundHandler,
  asyncHandler,
  handleValidationError,
  handleDatabaseError,
  handleQueueError,
  handleAIError,
  handleAgentError,
  shouldRetry,
  calculateRetryDelay,
} from '../error-handler';
import { QAIError, ValidationError, NotFoundError, RateLimitError } from '@/types';
import { logger } from '../logger';

describe('error-handler', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = {
      url: '/api/v1/test',
      originalUrl: '/api/v1/test',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
      get: jest.fn().mockReturnValue('Test-Agent'),
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      on: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();

    // Set NODE_ENV to test
    process.env.NODE_ENV = 'test';
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // successResponse
  // ═══════════════════════════════════════════════════════════════════════════
  describe('successResponse', () => {
    it('should return 200 with data by default', () => {
      const data = { id: '123', name: 'Test' };

      successResponse(mockRes as Response, data);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data,
          timestamp: expect.any(String),
        })
      );
    });

    it('should return custom status code', () => {
      successResponse(mockRes as Response, { created: true }, 201);

      expect(mockRes.status).toHaveBeenCalledWith(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // errorResponse
  // ═══════════════════════════════════════════════════════════════════════════
  describe('errorResponse', () => {
    it('should return 400 with error message by default', () => {
      errorResponse(mockRes as Response, 'Bad request');

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Bad request',
          code: 'ERROR',
          timestamp: expect.any(String),
        })
      );
    });

    it('should return custom status code and error code', () => {
      errorResponse(mockRes as Response, 'Not found', 404, 'NOT_FOUND');

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Not found',
          code: 'NOT_FOUND',
        })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // errorHandler middleware
  // ═══════════════════════════════════════════════════════════════════════════
  describe('errorHandler', () => {
    it('should handle QAIError correctly', () => {
      const error = new QAIError('Custom error', 'CUSTOM_ERROR', 422, { field: 'test' });

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(422);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Custom error',
          code: 'CUSTOM_ERROR',
          details: { field: 'test' },
        })
      );
    });

    it('should handle ValidationError (from name)', () => {
      const error = new Error('Validation failed');
      error.name = 'ValidationError';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
        })
      );
    });

    it('should handle JsonWebTokenError', () => {
      const error = new Error('invalid token');
      error.name = 'JsonWebTokenError';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid token',
          code: 'INVALID_TOKEN',
        })
      );
    });

    it('should handle TokenExpiredError', () => {
      const error = new Error('jwt expired');
      error.name = 'TokenExpiredError';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Token expired',
          code: 'TOKEN_EXPIRED',
        })
      );
    });

    it('should handle PostgrestError (Supabase)', () => {
      const error = new Error('Database constraint violated');
      error.name = 'PostgrestError';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Database error',
          code: 'DATABASE_ERROR',
        })
      );
    });

    it('should handle Redis errors (503)', () => {
      const error = new Error('Redis connection failed');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Queue service unavailable',
          code: 'QUEUE_UNAVAILABLE',
        })
      );
    });

    it('should handle OpenAI errors (503)', () => {
      const error = new Error('OpenAI API rate limit exceeded');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'AI service unavailable',
          code: 'AI_SERVICE_UNAVAILABLE',
        })
      );
    });

    it('should handle Agent errors (503)', () => {
      const error = new Error('Agent connection timeout');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Test agent unavailable',
          code: 'AGENT_UNAVAILABLE',
        })
      );
    });

    it('should handle ECONNREFUSED as 502', () => {
      const error = new Error('connect ECONNREFUSED') as any;
      error.code = 'ECONNREFUSED';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(502);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Bad Gateway',
          code: 'BAD_GATEWAY',
        })
      );
    });

    it('should handle ETIMEDOUT as 502', () => {
      const error = new Error('Connection timed out') as any;
      error.code = 'ETIMEDOUT';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(502);
    });

    it('should handle ENOTFOUND as 502', () => {
      const error = new Error('getaddrinfo ENOTFOUND') as any;
      error.code = 'ENOTFOUND';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(502);
    });

    it('should handle ECONNRESET as 502', () => {
      const error = new Error('Connection reset') as any;
      error.code = 'ECONNRESET';

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(502);
    });

    it('should handle 502 message as 502', () => {
      const error = new Error('502 Bad Gateway from upstream');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(502);
    });

    it('should return 500 for unknown errors', () => {
      const error = new Error('Something unexpected happened');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          code: 'INTERNAL_ERROR',
        })
      );
    });

    it('should hide error message in production', () => {
      process.env.NODE_ENV = 'production';
      const error = new Error('Sensitive internal error details');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal server error',
        })
      );
    });

  });

  describe('httpErrorAuditMiddleware', () => {
    const makeRes = (statusCode: number) => {
      let finishCb: (() => void) | undefined;
      const res = {
        on: jest.fn((event: string, cb: () => void) => {
          if (event === 'finish') finishCb = cb;
        }),
        statusCode,
      } as unknown as Response;
      return { res, fireFinish: () => finishCb?.() };
    };

    it('emits a keyed http.error audit event on a 5xx response', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockReturnValue(undefined as never);
      const { res, fireFinish } = makeRes(500);
      const reqWithUser = { ...mockReq, user: { id: 'user-123' } } as unknown as Request;

      httpErrorAuditMiddleware(reqWithUser, res, mockNext);
      fireFinish();

      expect(mockNext).toHaveBeenCalled();
      expect(loggerSpy).toHaveBeenCalledWith(
        '[HTTP] server error response',
        expect.objectContaining({ event: 'http.error', severity: 'error', status: 500, userId: 'user-123' }),
      );
      loggerSpy.mockRestore();
    });

    it('does NOT emit http.error for a 4xx response', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockReturnValue(undefined as never);
      const { res, fireFinish } = makeRes(400);

      httpErrorAuditMiddleware(mockReq as Request, res, mockNext);
      fireFinish();

      expect(loggerSpy).not.toHaveBeenCalledWith(
        '[HTTP] server error response',
        expect.anything(),
      );
      loggerSpy.mockRestore();
    });

    it('does not propagate a logger failure — finish handler is best-effort', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => { throw new Error('loki transport down'); });
      const { res, fireFinish } = makeRes(500);

      httpErrorAuditMiddleware(mockReq as Request, res, mockNext);
      expect(() => fireFinish()).not.toThrow();
      loggerSpy.mockRestore();
    });

    it('strips the query string from the logged URL to prevent secret leakage', () => {
      const loggerSpy = jest.spyOn(logger, 'error').mockReturnValue(undefined as never);
      const { res, fireFinish } = makeRes(500);
      const req = {
        ...mockReq,
        originalUrl: '/api/v1/verify-email?token=super-secret-otp',
        url: '/api/v1/verify-email?token=super-secret-otp',
      } as unknown as Request;

      httpErrorAuditMiddleware(req, res, mockNext);
      fireFinish();

      expect(loggerSpy).toHaveBeenCalledWith(
        '[HTTP] server error response',
        expect.objectContaining({ url: '/api/v1/verify-email' }),
      );
      expect(loggerSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ url: expect.stringContaining('token=') }),
      );
      loggerSpy.mockRestore();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // notFoundHandler
  // ═══════════════════════════════════════════════════════════════════════════
  describe('notFoundHandler', () => {
    it('should return 404 with route info', () => {
      notFoundHandler(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Route /api/v1/test not found',
          code: 'NOT_FOUND',
        })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // asyncHandler
  // ═══════════════════════════════════════════════════════════════════════════
  describe('asyncHandler', () => {
    it('should call handler and pass result', async () => {
      const handler = jest.fn().mockResolvedValue('result');
      const wrapped = asyncHandler(handler);

      await wrapped(mockReq as Request, mockRes as Response, mockNext);

      expect(handler).toHaveBeenCalledWith(mockReq, mockRes, mockNext);
    });

    it('should call next with error when handler rejects', async () => {
      const error = new Error('Handler failed');
      const handler = jest.fn().mockRejectedValue(error);
      const wrapped = asyncHandler(handler);

      await wrapped(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleValidationError
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handleValidationError', () => {
    it('should throw unchanged for null/undefined', () => {
      expect(() => handleValidationError(null)).toThrow();
      expect(() => handleValidationError(undefined)).toThrow();
    });

    it('should throw unchanged for non-objects', () => {
      expect(() => handleValidationError('string error')).toThrow('string error');
    });

    it('should convert Joi error to ValidationError', () => {
      const joiError = {
        isJoi: true,
        details: [
          { path: ['email'], message: 'Email is required' },
          { path: ['password'], message: 'Password too short' },
        ],
      };

      expect(() => handleValidationError(joiError)).toThrow(ValidationError);
      try {
        handleValidationError(joiError);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).details).toEqual([
          { field: 'email', message: 'Email is required' },
          { field: 'password', message: 'Password too short' },
        ]);
      }
    });

    it('should convert ZodError to ValidationError', () => {
      const zodError = {
        name: 'ZodError',
        errors: [
          { path: ['name'], message: 'Name is required' },
          { path: ['age'], message: 'Must be a number' },
        ],
      };

      expect(() => handleValidationError(zodError)).toThrow(ValidationError);
      try {
        handleValidationError(zodError);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).details).toEqual([
          { field: 'name', message: 'Name is required' },
          { field: 'age', message: 'Must be a number' },
        ]);
      }
    });

    it('should throw unchanged for unknown error objects', () => {
      const unknownError = new Error('Unknown');

      expect(() => handleValidationError(unknownError)).toThrow('Unknown');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleDatabaseError
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handleDatabaseError', () => {
    it('should throw ValidationError for unique constraint (23505)', () => {
      const error = { code: '23505' };

      expect(() => handleDatabaseError(error)).toThrow(ValidationError);
      expect(() => handleDatabaseError(error)).toThrow('Resource already exists');
    });

    it('should throw ValidationError for foreign key constraint (23503)', () => {
      const error = { code: '23503' };

      expect(() => handleDatabaseError(error)).toThrow('Referenced resource not found');
    });

    it('should throw ValidationError for not null constraint (23502)', () => {
      const error = { code: '23502' };

      expect(() => handleDatabaseError(error)).toThrow('Required field is missing');
    });

    it('should rethrow unknown errors', () => {
      const error = new Error('Unknown DB error');

      expect(() => handleDatabaseError(error)).toThrow('Unknown DB error');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleQueueError
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handleQueueError', () => {
    it('should throw QAIError for closed connection', () => {
      const error = { message: 'Connection is closed' };

      expect(() => handleQueueError(error)).toThrow(QAIError);
      expect(() => handleQueueError(error)).toThrow('Queue service unavailable');
    });

    it('should throw NotFoundError for job not found', () => {
      const error = { message: 'Job not found' };

      expect(() => handleQueueError(error)).toThrow(NotFoundError);
    });

    it('should rethrow unknown errors', () => {
      const error = new Error('Unknown queue error');

      expect(() => handleQueueError(error)).toThrow('Unknown queue error');
    });

    it('should rethrow null/undefined', () => {
      expect(() => handleQueueError(null)).toThrow();
      expect(() => handleQueueError(undefined)).toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleAIError
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handleAIError', () => {
    it('should throw RateLimitError for 429', () => {
      const error = { status: 429 };

      expect(() => handleAIError(error)).toThrow(RateLimitError);
    });

    it('should throw QAIError with 401 for auth failure', () => {
      const error = { status: 401 };

      expect(() => handleAIError(error)).toThrow(QAIError);
      try {
        handleAIError(error);
      } catch (e) {
        expect((e as QAIError).statusCode).toBe(401);
        expect((e as QAIError).code).toBe('AI_AUTH_ERROR');
      }
    });

    it('should throw QAIError with 403 for forbidden', () => {
      const error = { status: 403 };

      expect(() => handleAIError(error)).toThrow(QAIError);
      try {
        handleAIError(error);
      } catch (e) {
        expect((e as QAIError).statusCode).toBe(403);
      }
    });

    it('should throw generic AI service error for other errors', () => {
      const error = { status: 500, message: 'Internal AI error' };

      expect(() => handleAIError(error)).toThrow(QAIError);
      try {
        handleAIError(error);
      } catch (e) {
        expect((e as QAIError).statusCode).toBe(503);
        expect((e as QAIError).code).toBe('AI_SERVICE_ERROR');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // handleAgentError
  // ═══════════════════════════════════════════════════════════════════════════
  describe('handleAgentError', () => {
    it('should throw QAIError for ECONNREFUSED', () => {
      const error = { code: 'ECONNREFUSED' };

      expect(() => handleAgentError(error)).toThrow(QAIError);
      try {
        handleAgentError(error);
      } catch (e) {
        expect((e as QAIError).code).toBe('AGENT_UNAVAILABLE');
      }
    });

    it('should throw QAIError for ETIMEDOUT', () => {
      const error = { code: 'ETIMEDOUT' };

      expect(() => handleAgentError(error)).toThrow(QAIError);
      try {
        handleAgentError(error);
      } catch (e) {
        expect((e as QAIError).code).toBe('AGENT_TIMEOUT');
        expect((e as QAIError).statusCode).toBe(504);
      }
    });

    it('should throw QAIError for 4xx client errors', () => {
      const error = { status: 400 };

      expect(() => handleAgentError(error)).toThrow(QAIError);
      try {
        handleAgentError(error);
      } catch (e) {
        expect((e as QAIError).code).toBe('AGENT_CLIENT_ERROR');
      }
    });

    it('should throw QAIError for 5xx server errors', () => {
      const error = { status: 502 };

      expect(() => handleAgentError(error)).toThrow(QAIError);
      try {
        handleAgentError(error);
      } catch (e) {
        expect((e as QAIError).code).toBe('AGENT_SERVER_ERROR');
      }
    });

    it('should throw generic agent error for unknown errors', () => {
      const error = {};

      expect(() => handleAgentError(error)).toThrow(QAIError);
      try {
        handleAgentError(error);
      } catch (e) {
        expect((e as QAIError).code).toBe('AGENT_COMMUNICATION_ERROR');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // shouldRetry
  // ═══════════════════════════════════════════════════════════════════════════
  describe('shouldRetry', () => {
    it('should return false when max attempts exceeded', () => {
      expect(shouldRetry({}, 3, 3)).toBe(false);
      expect(shouldRetry({}, 4, 3)).toBe(false);
    });

    it('should return true for ECONNREFUSED', () => {
      expect(shouldRetry({ code: 'ECONNREFUSED' }, 1, 3)).toBe(true);
    });

    it('should return true for ETIMEDOUT', () => {
      expect(shouldRetry({ code: 'ETIMEDOUT' }, 1, 3)).toBe(true);
    });

    it('should return true for 429 rate limit', () => {
      expect(shouldRetry({ status: 429 }, 1, 3)).toBe(true);
    });

    it('should return true for 5xx errors', () => {
      expect(shouldRetry({ status: 500 }, 1, 3)).toBe(true);
      expect(shouldRetry({ status: 502 }, 1, 3)).toBe(true);
      expect(shouldRetry({ status: 503 }, 1, 3)).toBe(true);
    });

    it('should return false for 4xx client errors (except 429)', () => {
      expect(shouldRetry({ status: 400 }, 1, 3)).toBe(false);
      expect(shouldRetry({ status: 401 }, 1, 3)).toBe(false);
      expect(shouldRetry({ status: 404 }, 1, 3)).toBe(false);
    });

    it('should return true for unknown errors', () => {
      expect(shouldRetry({}, 1, 3)).toBe(true);
      expect(shouldRetry(new Error('Random'), 1, 3)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // calculateRetryDelay
  // ═══════════════════════════════════════════════════════════════════════════
  describe('calculateRetryDelay', () => {
    it('should use exponential backoff', () => {
      expect(calculateRetryDelay(0)).toBe(1000); // 2^0 * 1000 = 1000
      expect(calculateRetryDelay(1)).toBe(2000); // 2^1 * 1000 = 2000
      expect(calculateRetryDelay(2)).toBe(4000); // 2^2 * 1000 = 4000
      expect(calculateRetryDelay(3)).toBe(8000); // 2^3 * 1000 = 8000
    });

    it('should cap at 30 seconds', () => {
      expect(calculateRetryDelay(10)).toBe(30000); // Would be 1024000, capped to 30000
      expect(calculateRetryDelay(20)).toBe(30000);
    });

    it('should use custom base delay', () => {
      expect(calculateRetryDelay(0, 500)).toBe(500);
      expect(calculateRetryDelay(1, 500)).toBe(1000);
    });
  });
});
