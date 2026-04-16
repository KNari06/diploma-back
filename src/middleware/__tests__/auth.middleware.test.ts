/**
 * Unit tests for auth.middleware.ts
 * Tests requireAuth middleware with mocked verifyToken
 */

import { Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin, requireCredits } from '../auth.middleware';

// Mock verifyToken from auth.service
jest.mock('@/services/auth/auth.service', () => ({
  verifyToken: jest.fn(),
}));

// Mock UserCreditsService for requireCredits
jest.mock('@/services/core/user-credits.service', () => ({
  UserCreditsService: {
    getUserCredits: jest.fn(),
    getOrCreateUserCredits: jest.fn(),
  },
}));

import { verifyToken } from '@/services/auth/auth.service';
import { UserCreditsService } from '@/services/core/user-credits.service';

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockUserCreditsService = UserCreditsService as jest.Mocked<typeof UserCreditsService>;

describe('auth.middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = {
      headers: {},
      path: '/api/v1/test',
      method: 'GET',
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // requireAuth
  // ═══════════════════════════════════════════════════════════════════════════
  describe('requireAuth', () => {
    it('should return 401 when no Authorization header', async () => {
      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: No token provided',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when Authorization header does not start with Bearer', async () => {
      mockReq.headers = { authorization: 'Basic some-token' };

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: No token provided',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when token is too short', async () => {
      mockReq.headers = { authorization: 'Bearer short' };

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: Invalid token format',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when verifyToken returns null', async () => {
      mockReq.headers = { authorization: 'Bearer valid-token-long-enough' };
      mockVerifyToken.mockResolvedValue(null);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockVerifyToken).toHaveBeenCalledWith('valid-token-long-enough');
      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: Invalid or expired token',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should call next() and set req.user when token is valid', async () => {
      const mockUser = { id: 'user-123', email: 'test@test.com', role: 'user' };
      mockReq.headers = { authorization: 'Bearer valid-token-long-enough' };
      mockVerifyToken.mockResolvedValue(mockUser);

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockVerifyToken).toHaveBeenCalledWith('valid-token-long-enough');
      expect(mockReq.user).toEqual(mockUser);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 401 when verifyToken throws an error', async () => {
      mockReq.headers = { authorization: 'Bearer valid-token-long-enough' };
      mockVerifyToken.mockRejectedValue(new Error('Token verification failed'));

      await requireAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: Authentication failed',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // requireAdmin
  // ═══════════════════════════════════════════════════════════════════════════
  describe('requireAdmin', () => {
    it('should return 401 when no user on request', async () => {
      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: Authentication required',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', async () => {
      mockReq.user = { id: 'user-123', email: 'test@test.com', role: 'user' };

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Forbidden: Admin access required',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should call next() when user is admin', async () => {
      mockReq.user = { id: 'admin-123', email: 'admin@test.com', role: 'admin' };

      await requireAdmin(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // requireCredits
  // ═══════════════════════════════════════════════════════════════════════════
  describe('requireCredits', () => {
    it('should throw error for negative requiredCredits', () => {
      expect(() => requireCredits(-1)).toThrow('Invalid requiredCredits');
    });

    it('should throw error for NaN requiredCredits', () => {
      expect(() => requireCredits(NaN)).toThrow('Invalid requiredCredits');
    });

    it('should return 401 when no user on request', async () => {
      const middleware = requireCredits(1);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unauthorized: Authentication required',
        })
      );
    });

    it('should return 402 when user has insufficient credits', async () => {
      mockReq.user = { id: 'user-123', email: 'test@test.com', role: 'user' };
      mockUserCreditsService.getUserCredits.mockResolvedValue({
        id: 'uc-1',
        user_id: 'user-123',
        credits_balance: 5,
        total_purchased: 10,
        total_used: 5,
        subscription_plan: 'free',
        subscription_status: 'active',
        subscription_expires_at: null,
        grace_limit: 0,
        overage_balance: 0,
        grace_started_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const middleware = requireCredits(10);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(402);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Insufficient credits',
          currentCredits: 5,
          requiredCredits: 10,
        })
      );
    });

    it('should call next() when user has enough credits', async () => {
      mockReq.user = { id: 'user-123', email: 'test@test.com', role: 'user' };
      mockUserCreditsService.getUserCredits.mockResolvedValue({
        id: 'uc-1',
        user_id: 'user-123',
        credits_balance: 100,
        total_purchased: 100,
        total_used: 0,
        subscription_plan: 'pro',
        subscription_status: 'active',
        subscription_expires_at: null,
        grace_limit: 0,
        overage_balance: 0,
        grace_started_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const middleware = requireCredits(10);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should create credits record if not found and retry', async () => {
      mockReq.user = { id: 'user-123', email: 'test@test.com', role: 'user' };
      mockUserCreditsService.getUserCredits
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'uc-1',
          user_id: 'user-123',
          credits_balance: 100,
          total_purchased: 100,
          total_used: 0,
          subscription_plan: 'free',
          subscription_status: 'active',
          subscription_expires_at: null,
          grace_limit: 0,
          overage_balance: 0,
          grace_started_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      mockUserCreditsService.getOrCreateUserCredits.mockResolvedValue({
        id: 'uc-1',
        user_id: 'user-123',
        credits_balance: 100,
        total_purchased: 100,
        total_used: 0,
        subscription_plan: 'free',
        subscription_status: 'active',
        subscription_expires_at: null,
        grace_limit: 0,
        overage_balance: 0,
        grace_started_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const middleware = requireCredits(10);

      await middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockUserCreditsService.getOrCreateUserCredits).toHaveBeenCalledWith('user-123');
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
