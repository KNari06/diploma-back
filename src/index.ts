import apiConfigRoutes from '@/api/apiConfig/apiConfig.routes';
import apiTestRoutes from '@/api/apiTest/apiTest.route';
import authRoutes from '@/api/auth/auth.route';
import chatRoutes from '@/api/chat/chat.route';
import feedbackRoutes from '@/api/chat/feedback.route';
import intelligentTestRoutes from '@/api/intelligentTest/intelligentTest.route';
import jiraRoutes from '@/api/jira/jira.route';
import kbRoutes from '@/api/kb/kb.route';
import rulesReloadRoutes from '@/api/kb/rules-reload.route';
import manualTestRoutes from '@/api/manualTest/manualTest.route';
import queueStatusRoutes from '@/api/manualTest/queue-status.route';
import notificationsRoutes from '@/api/notifications/notifications.routes';
import playwrightRoutes from '@/api/playwright/playwright.route';
import projectRoutes from '@/api/project/project.routes';
import reportsRoutes from '@/api/reports/reports.route';
import testVisualizationRoutes from '@/api/testVisualization/testVisualization.route';
import userRoutes from '@/api/user/user.routes';
import workspaceRoutes from '@/api/workspace/workspace.routes';
import { env, isDevelopment } from '@/config/env';
import { QueueManager } from '@/config/queues';
import { swaggerSpec } from '@/config/swagger';
import { testSupabaseAuthHealth, testSupabaseConnection } from '@/db/supabase';
import { errorHandler, notFoundHandler } from '@/utils/error-handler';
import { logger, morganStream } from '@/utils/logger';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

// Create Express app
const app = express();

// Trust proxy for correct IP detection (important for IP-based anonymous identification)
app.set('trust proxy', true);

// Security middleware with Swagger-friendly CSP
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Disable strict CSP for Swagger UI
  if (req.path.startsWith('/api/docs')) {
    return next();
  }

  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })(req, res, next);
});

// Relaxed security for Swagger UI
app.use('/api/docs', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  })(req, res, next);
}, swaggerUi.serve);

// CORS configuration
const getCorsOrigins = (): boolean | string[] => {
  if (isDevelopment) {
    return true;
  }

  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  if (!allowedOrigins || typeof allowedOrigins !== 'string') {
    return false;
  }

  try {
    const origins = allowedOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
    return origins.length > 0 ? origins : false;
  } catch (error) {
    logger.warn('Failed to parse ALLOWED_ORIGINS, disabling CORS', {
      error: error instanceof Error ? error.message : String(error),
      ALLOWED_ORIGINS: allowedOrigins, // Use local variable instead of undefined
    });
    return false;
  }
};

// ✅ FIX: CORS middleware with guaranteed headers on all responses
app.use(cors({
  origin: getCorsOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID'],
}));

// ✅ FIX: Helper function to check if origin is allowed
const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return false;

  const corsOrigins = getCorsOrigins();
  if (corsOrigins === true) return true; // Development mode - allow all
  if (corsOrigins === false) return false; // CORS disabled

  return Array.isArray(corsOrigins) && corsOrigins.includes(origin);
};

// ✅ FIX: Additional middleware to ensure CORS headers on all responses (including errors)
// This prevents CORS errors when backend returns 502/503 during deployment
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const origin = req.headers.origin;
  const allowedOrigin = isOriginAllowed(origin);

  if (allowedOrigin && origin) {
    // Store original send/end methods
    const originalSend = res.send;
    const originalJson = res.json;
    const originalStatus = res.status;

    // Override res.status to ensure CORS headers are set
    res.status = function(code: number) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
      return originalStatus.call(this, code);
    };

    // Override res.json to ensure CORS headers
    res.json = function(body: any) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
      return originalJson.call(this, body);
    };

    // Override res.send to ensure CORS headers
    res.send = function(body?: any) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
      return originalSend.call(this, body);
    };
  }
  next();
});

// Rate limiting - disable express-rate-limit since we use custom rate limiter
// const limiter = rateLimit({
//   windowMs: env.RATE_LIMIT_WINDOW_MS,
//   max: env.RATE_LIMIT_MAX_REQUESTS,
//   message: {
//     success: false,
//     error: 'Too many requests, please try again later',
//     code: 'RATE_LIMIT_EXCEEDED',
//     timestamp: new Date().toISOString(),
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// app.use(limiter); // Disabled - using custom rate limiter in middleware

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use(morgan(env.LOG_FORMAT, { stream: morganStream }));

// Swagger documentation setup (middleware already registered above)
app.use('/api/docs', swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'QAIT API Documentation',
  swaggerOptions: {
    persistAuthorization: true,
  },
}));

// Swagger JSON endpoint
app.get('/api/docs.json', (req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Features documentation (password protected)
import { docsLogin, docsLogout, requireDocsAuth } from '@/middleware/docs-auth.middleware';
import path from 'path';

// Get correct path for static files (works in both dev and production)
const getDocsPath = () => {
  // In production, __dirname points to dist/
  // In development, we need to go up from dist/ to root
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    // In production: dist/ -> root -> docs/features
    return path.join(__dirname, '../../docs/features');
  } else {
    // In development: dist/ -> root -> docs/features (same)
    return path.join(process.cwd(), 'docs/features');
  }
};

const docsPath = getDocsPath();

// Login/logout routes for documentation
app.post('/api/features/login', express.urlencoded({ extended: true }), docsLogin);
app.post('/api/features/logout', docsLogout);

// Serve features documentation with password protection
app.use('/api/features', requireDocsAuth, express.static(docsPath, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));

// Redirect root /api/features to index
app.get('/api/features', requireDocsAuth, (req: express.Request, res: express.Response) => {
  const indexPath = path.join(docsPath, 'index.html');
  res.sendFile(indexPath);
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Health check for services (database, queue)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: All services are operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: healthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 services:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: string
 *                       example: healthy
 *                     queue:
 *                       type: string
 *                       example: healthy
 *       503:
 *         description: One or more services are unavailable
 */
// Health check endpoint
app.get('/health', async (req: express.Request, res: express.Response) => {
  // ✅ FIX: Ensure CORS headers are set for health check (important for frontend monitoring)
  // Only for allowed origins to avoid security issues
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
  }

  try {
    // Use Promise.allSettled with timeout to handle individual service failures gracefully
    const healthCheckPromise = Promise.allSettled([
      Promise.race([
        testSupabaseConnection(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Database check timeout')), 5000)),
      ]),
      Promise.race([
        testSupabaseAuthHealth(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Auth check timeout')), 5000)),
      ]),
      Promise.race([
        QueueManager.healthCheck(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Queue check timeout')), 5000)),
      ]),
    ]);

    const [dbResult, authResult, queueResult] = await healthCheckPromise;

    // Safely extract results
    const dbHealth = dbResult.status === 'fulfilled' ? dbResult.value : false;
    const authHealth = authResult.status === 'fulfilled'
      ? authResult.value
      : { healthy: false, error: 'Auth check failed' };
    const queueHealth = queueResult.status === 'fulfilled'
      ? queueResult.value
      : {
          status: 'unhealthy' as const,
          error: queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason),
        };

    // Log failures
    if (dbResult.status === 'rejected') {
      logger.warn('[HEALTH] Database check failed', {
        error: dbResult.reason instanceof Error ? dbResult.reason.message : String(dbResult.reason),
      });
    }
    if (authResult.status === 'rejected') {
      logger.warn('[HEALTH] Auth check failed', {
        error: authResult.reason instanceof Error ? authResult.reason.message : String(authResult.reason),
      });
    }
    if (queueResult.status === 'rejected') {
      logger.warn('[HEALTH] Queue check failed', {
        error: queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason),
      });
    }

    const isHealthy = dbHealth && authHealth.healthy && queueHealth.status === 'healthy';
    const health = {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealth ? 'healthy' : 'unhealthy',
        auth: authHealth.healthy ? 'healthy' : 'unhealthy',
        authLatency: authHealth.latency ? `${authHealth.latency}ms` : undefined,
        queue: queueHealth.status || 'unhealthy',
      },
      version: process.env.npm_package_version || '1.0.0',
      environment: env.NODE_ENV,
    };

    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error('[HEALTH] Health check failed:', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

// API routes
app.use(`/api/${env.API_VERSION}/auth`, authRoutes);
app.use(`/api/${env.API_VERSION}/workspaces`, workspaceRoutes);
app.use(`/api/${env.API_VERSION}/projects`, projectRoutes);
app.use(`/api/${env.API_VERSION}/manual-test`, manualTestRoutes);
app.use(`/api/${env.API_VERSION}/intelligent-test`, intelligentTestRoutes);
app.use(`/api/${env.API_VERSION}/chat`, chatRoutes);
app.use(`/api/${env.API_VERSION}/chat/feedback`, feedbackRoutes);
app.use(`/api/${env.API_VERSION}/api-test`, apiTestRoutes);
app.use(`/api/${env.API_VERSION}/api-config`, apiConfigRoutes);
app.use(`/api/${env.API_VERSION}/jira`, jiraRoutes);
app.use(`/api/${env.API_VERSION}/kb`, kbRoutes);
app.use(`/api/${env.API_VERSION}/kb`, rulesReloadRoutes);
app.use(`/api/${env.API_VERSION}/playwright`, playwrightRoutes);
app.use(`/api/${env.API_VERSION}/reports`, reportsRoutes); // ✅ NEW: Test reports & Jira integration
app.use(`/api/${env.API_VERSION}/test-visualization`, testVisualizationRoutes);
app.use(`/api/${env.API_VERSION}/user`, userRoutes);
app.use(`/api/${env.API_VERSION}/notifications`, notificationsRoutes); // User notifications
app.use(`/api/${env.API_VERSION}/queue`, queueStatusRoutes); // Queue monitoring

// Root endpoint
app.get('/', (req: express.Request, res: express.Response) => {
  res.json({
    success: true,
    message: 'QAIT Backend API',
    version: process.env.npm_package_version || '1.0.0',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: `/api/${env.API_VERSION}/auth`,
      workspaces: `/api/${env.API_VERSION}/workspaces`,
      projects: `/api/${env.API_VERSION}/projects`,
      manualTest: `/api/${env.API_VERSION}/manual-test`,
      chat: `/api/${env.API_VERSION}/chat`,
      apiTest: `/api/${env.API_VERSION}/api-test`,
      jira: `/api/${env.API_VERSION}/jira`,
      kb: `/api/${env.API_VERSION}/kb`,
      playwright: `/api/${env.API_VERSION}/playwright`,
      testVisualization: `/api/${env.API_VERSION}/test-visualization`,
      notifications: `/api/${env.API_VERSION}/notifications`,
      docs: '/api/docs',
      docsJson: '/api/docs.json',
    },
  });
});

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Start server
const startServer = async () => {
  let server: ReturnType<typeof app.listen> | null = null;
  let isShuttingDown = false;

  // ✅ FIX: Middleware to handle requests during deployment/shutdown
  // Returns 503 Service Unavailable with CORS headers when server is shutting down
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isShuttingDown) {
      // Server is shutting down - return 503 with CORS headers
      const origin = req.headers.origin;
      if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
      }
      res.status(503).json({
        success: false,
        error: 'Service temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
        details: 'The service is currently being updated. Please try again in a few moments.',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next();
  });

  try {
    // Validate PORT
    if (!env.PORT || !Number.isFinite(env.PORT) || env.PORT < 1 || env.PORT > 65535) {
      logger.error(`Invalid PORT: ${env.PORT}. Must be between 1 and 65535`);
      process.exit(1);
    }

    // Initialize global KB (load into memory)
    try {
      const { initializeGlobalKB } = await import('@/services/kb/localKB.service');
      await initializeGlobalKB();
      logger.info('✓ Global KB initialized successfully');
    } catch (kbError) {
      logger.warn('[SERVER] Failed to initialize global KB, continuing without it', {
        error: kbError instanceof Error ? kbError.message : String(kbError),
      });
    }

    // Initialize Rules Cache (load AI response rules into memory)
    try {
      const { RulesCacheService } = await import('@/services/kb/rules-cache.service');
      await RulesCacheService.init();
      logger.info('✓ Rules cache initialized successfully');
    } catch (rulesCacheError) {
      logger.warn('[SERVER] Failed to initialize rules cache, continuing without it', {
        error: rulesCacheError instanceof Error ? rulesCacheError.message : String(rulesCacheError),
      });
    }

    // Test database connection with timeout
    try {
      const dbCheckPromise = testSupabaseConnection();
      const dbTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Database connection timeout')), 10000)
      );

      const dbConnected = await Promise.race([dbCheckPromise, dbTimeoutPromise]);
      if (!dbConnected) {
        logger.error('[SERVER] Failed to connect to database. Exiting...');
        process.exit(1);
      }
      logger.info('✓ Database connection verified');
    } catch (dbError) {
      logger.error('[SERVER] Database connection failed', {
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
      process.exit(1);
    }

    // Test queue connection (non-blocking in development)
    try {
      const queueCheckPromise = QueueManager.healthCheck();
      const queueTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Queue connection timeout')), 5000)
      );

      const queueHealth = await Promise.race([queueCheckPromise, queueTimeoutPromise]);
      if (queueHealth.status !== 'healthy') {
        if (env.NODE_ENV === 'development') {
          logger.warn('[SERVER] ⚠️  Queue service is unavailable. Running in limited mode.');
          logger.warn('[SERVER] 💡 To enable full functionality, start Redis: redis-server');
        } else {
          logger.error('[SERVER] Queue service is unhealthy. Exiting...');
          process.exit(1);
        }
      } else {
        logger.info('✓ Queue connection verified');
      }
    } catch (queueError) {
      if (env.NODE_ENV === 'development') {
        logger.warn('[SERVER] Queue health check failed, continuing in development mode', {
          error: queueError instanceof Error ? queueError.message : String(queueError),
        });
      } else {
        logger.error('[SERVER] Queue health check failed', {
          error: queueError instanceof Error ? queueError.message : String(queueError),
        });
        process.exit(1);
      }
    }

    // Start HTTP server
    try {
      server = app.listen(env.PORT, () => {
        logger.info(`🚀 QAIT Backend API started on port ${env.PORT}`);
        logger.info(`📊 Environment: ${env.NODE_ENV}`);
        logger.info(`🔗 Health check: http://localhost:${env.PORT}/health`);
        logger.info(`📚 API docs: http://localhost:${env.PORT}/api/docs`);
      });

      /**
       * ✅ FIX: Configure server timeouts to prevent premature connection closure
       * - timeout: 180s (3 minutes) - allows long AI requests to complete
       * - keepAliveTimeout: 65s - longer than typical load balancer timeout (60s)
       * - headersTimeout: 66s - must be > keepAliveTimeout to avoid race conditions
       *
       * Why these values:
       * - OpenAI requests can take 30-60s for large contexts
       * - Load balancers (Nginx, Cloudflare) typically timeout at 60s
       * - We need buffer time for retries and error handling
       */
      server.timeout = 180000; // 3 minutes (default is 120s)
      server.keepAliveTimeout = 65000; // 65 seconds (default is 5s)
      server.headersTimeout = 66000; // 66 seconds (must be > keepAliveTimeout)

      // Handle server errors
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`[SERVER] Port ${env.PORT} is already in use`);
        } else {
          logger.error('[SERVER] HTTP server error:', {
            error: error.message,
            code: error.code,
          });
        }
        process.exit(1);
      });
    } catch (serverError) {
      logger.error('[SERVER] Failed to start HTTP server:', {
        error: serverError instanceof Error ? serverError.message : String(serverError),
      });
      process.exit(1);
    }

    // Initialize WebSocket server
    try {
      const { initializeWebSocket } = await import('@/websocket/server');
      if (server) {
        initializeWebSocket(server);
        logger.info('🌐 WebSocket server initialized');

        // ✅ NEW: Start Redis subscriber for worker events
        // This bridges worker process events to WebSocket clients
        try {
          const { webSocketRedisSubscriber } = await import('@/websocket/redis-subscriber');
          await webSocketRedisSubscriber.start();
          logger.info('📡 WebSocket Redis subscriber started (worker → WebSocket bridge)');
        } catch (subError) {
          logger.error('[SERVER] Failed to start WebSocket Redis subscriber:', {
            error: subError instanceof Error ? subError.message : String(subError),
          });
          // Continue without subscriber - events from workers will be lost
          if (env.NODE_ENV !== 'development') {
            logger.warn('[SERVER] Running without Redis subscriber - worker events will not reach clients!');
          }
        }
      }
    } catch (wsError) {
      logger.error('[SERVER] Failed to initialize WebSocket server:', {
        error: wsError instanceof Error ? wsError.message : String(wsError),
      });
      // Continue without WebSocket in development
      if (env.NODE_ENV !== 'development') {
        process.exit(1);
      }
    }

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      // Prevent multiple shutdown attempts
      if (isShuttingDown) {
        logger.warn(`[SERVER] Shutdown already in progress, ignoring ${signal}`);
        return;
      }

      isShuttingDown = true;
      logger.info(`[SERVER] Received ${signal}. Starting graceful shutdown...`);

      const SHUTDOWN_TIMEOUT = 30000; // 30 seconds
      const shutdownTimeout = setTimeout(() => {
        logger.error('[SERVER] Shutdown timeout exceeded, forcing exit');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT);

      try {
        // Stop accepting new connections
        if (server) {
          server.close(async () => {
            logger.info('[SERVER] HTTP server closed');

            // Close services in parallel with error handling
            const cleanupResults = await Promise.allSettled([
              // ✅ NEW: Stop Redis subscriber
              (async () => {
                try {
                  const { webSocketRedisSubscriber } = await import('@/websocket/redis-subscriber');
                  await webSocketRedisSubscriber.stop();
                  logger.info('[SERVER] WebSocket Redis subscriber stopped');
                } catch (error) {
                  logger.error('[SERVER] Error stopping Redis subscriber:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),

              // Close browser pool
              (async () => {
                try {
                  const { browserPool } = await import('@/agent');
                  await browserPool.closeAll();
                  logger.info('[SERVER] Browser pool closed');
                } catch (error) {
                  logger.error('[SERVER] Error closing browsers:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),
              // Close queue connections
              (async () => {
                try {
                  const queuesModule = await import('@/config/queues');
                  await queuesModule.gracefulShutdown();
                  logger.info('[SERVER] Queue connections closed');
                } catch (error) {
                  logger.error('[SERVER] Error during queue shutdown:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),
              // Close WebSocket server
              (async () => {
                try {
                  const { shutdownWebSocket } = await import('@/websocket/server');
                  await shutdownWebSocket();
                  logger.info('[SERVER] WebSocket server closed');
                } catch (error) {
                  logger.error('[SERVER] Error closing WebSocket:', {
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              })(),
            ]);

            // Log any failures
            cleanupResults.forEach((result, index) => {
              if (result.status === 'rejected') {
                const serviceNames = ['browser pool', 'queues', 'websocket'];
                logger.warn(`[SERVER] Failed to close ${serviceNames[index]}`, {
                  error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
              }
            });

            clearTimeout(shutdownTimeout);
            logger.info('[SERVER] Graceful shutdown completed');
            process.exit(0);
          });
        } else {
          clearTimeout(shutdownTimeout);
          logger.warn('[SERVER] Server was not initialized, exiting');
          process.exit(0);
        }
      } catch (error) {
        clearTimeout(shutdownTimeout);
        logger.error('[SERVER] Error during shutdown:', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Prevent process from exiting on unhandled errors (log only)
    process.on('uncaughtException', (error) => {
      logger.error('[SERVER] Uncaught exception:', {
        error: error.message,
        stack: error.stack,
      });
      // Don't exit immediately - let graceful shutdown handle it
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('[SERVER] Unhandled rejection:', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
      // Don't exit immediately - let graceful shutdown handle it
    });
  } catch (error) {
    logger.error('[SERVER] Failed to start server:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
};

// Start the server
startServer();

export default app;
