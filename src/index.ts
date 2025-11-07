import apiConfigRoutes from '@/api/apiConfig/apiConfig.routes';
import apiTestRoutes from '@/api/apiTest/apiTest.route';
import authRoutes from '@/api/auth/auth.route';
import chatRoutes from '@/api/chat/chat.route';
import jiraRoutes from '@/api/jira/jira.route';
import kbRoutes from '@/api/kb/kb.route';
import manualTestRoutes from '@/api/manualTest/manualTest.route';
import playwrightRoutes from '@/api/playwright/playwright.route';
import testVisualizationRoutes from '@/api/testVisualization/testVisualization.route';
import userRoutes from '@/api/user/user.routes';
import workspaceRoutes from '@/api/workspace/workspace.routes';
import { env, isDevelopment } from '@/config/env';
import { QueueManager } from '@/config/queues';
import { swaggerSpec } from '@/config/swagger';
import { testSupabaseConnection } from '@/db/supabase';
import { errorHandler, notFoundHandler } from '@/utils/error-handler';
import { logger, morganStream } from '@/utils/logger';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
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
app.use(cors({
  origin: isDevelopment ? true : process.env.ALLOWED_ORIGINS?.split(',') || false,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID'],
}));

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
  customSiteTitle: 'QAI API Documentation',
  swaggerOptions: {
    persistAuthorization: true,
  },
}));

// Swagger JSON endpoint
app.get('/api/docs.json', (req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Проверка состояния сервисов (БД, очередь)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Все сервисы работают
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
 *         description: Один или несколько сервисов недоступны
 */
// Health check endpoint
app.get('/health', async (req: express.Request, res: express.Response) => {
  try {
    // Use Promise.allSettled to handle individual service failures gracefully
    const [dbResult, queueResult] = await Promise.allSettled([
      testSupabaseConnection(),
      QueueManager.healthCheck(),
    ]);

    const dbHealth = dbResult.status === 'fulfilled' ? dbResult.value : false;
    const queueHealth = queueResult.status === 'fulfilled'
      ? queueResult.value
      : { status: 'unhealthy', error: queueResult.reason instanceof Error ? queueResult.reason.message : String(queueResult.reason) };

    if (dbResult.status === 'rejected') {
      logger.warn('Health check: Database check failed', { error: dbResult.reason });
    }
    if (queueResult.status === 'rejected') {
      logger.warn('Health check: Queue check failed', { error: queueResult.reason });
    }

    const health = {
      status: dbHealth && queueHealth.status === 'healthy' ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealth ? 'healthy' : 'unhealthy',
        queue: queueHealth.status,
      },
      version: process.env.npm_package_version || '1.0.0',
      environment: env.NODE_ENV,
    };

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
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
app.use(`/api/${env.API_VERSION}/manual-test`, manualTestRoutes);
app.use(`/api/${env.API_VERSION}/chat`, chatRoutes);
app.use(`/api/${env.API_VERSION}/api-test`, apiTestRoutes);
app.use(`/api/${env.API_VERSION}/api-config`, apiConfigRoutes);
app.use(`/api/${env.API_VERSION}/jira`, jiraRoutes);
app.use(`/api/${env.API_VERSION}/kb`, kbRoutes);
app.use(`/api/${env.API_VERSION}/playwright`, playwrightRoutes);
app.use(`/api/${env.API_VERSION}/test-visualization`, testVisualizationRoutes);
app.use(`/api/${env.API_VERSION}/user`, userRoutes);

// Root endpoint
app.get('/', (req: express.Request, res: express.Response) => {
  res.json({
    success: true,
    message: 'QAI Backend API',
    version: process.env.npm_package_version || '1.0.0',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: `/api/${env.API_VERSION}/auth`,
      workspaces: `/api/${env.API_VERSION}/workspaces`,
      manualTest: `/api/${env.API_VERSION}/manual-test`,
      chat: `/api/${env.API_VERSION}/chat`,
      apiTest: `/api/${env.API_VERSION}/api-test`,
      jira: `/api/${env.API_VERSION}/jira`,
      kb: `/api/${env.API_VERSION}/kb`,
      playwright: `/api/${env.API_VERSION}/playwright`,
      testVisualization: `/api/${env.API_VERSION}/test-visualization`,
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
  try {
    // Initialize global KB (load into memory)
    try {
      const { initializeGlobalKB } = await import('@/services/localKB.service');
      await initializeGlobalKB();
    } catch (kbError) {
      logger.warn('Failed to initialize global KB, continuing without it', { error: kbError });
    }

    // Test database connection
    const dbConnected = await testSupabaseConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database. Exiting...');
      process.exit(1);
    }

    // Test queue connection (non-blocking in development)
    const queueHealth = await QueueManager.healthCheck();
    if (queueHealth.status !== 'healthy') {
      if (env.NODE_ENV === 'development') {
        logger.warn('⚠️  Queue service is unavailable. Running in limited mode.');
        logger.warn('💡 To enable full functionality, start Redis: redis-server');
      } else {
        logger.error('Queue service is unhealthy. Exiting...');
        process.exit(1);
      }
    }

    // Start HTTP server
    const server = app.listen(env.PORT, () => {
      logger.info(`🚀 QAI Backend API started on port ${env.PORT}`);
      logger.info(`📊 Environment: ${env.NODE_ENV}`);
      logger.info(`🔗 Health check: http://localhost:${env.PORT}/health`);
      logger.info(`📚 API docs: http://localhost:${env.PORT}/api/docs`);
    });

    // Initialize WebSocket server
    try {
      const { initializeWebSocket } = await import('@/websocket/server');
      initializeWebSocket(server);
      logger.info('🌐 WebSocket server initialized');
    } catch (wsError) {
      logger.error('Failed to initialize WebSocket server:', wsError);
      // Continue without WebSocket in development
      if (env.NODE_ENV !== 'development') {
        process.exit(1);
      }
    }

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          // Close browser pool
          const { browserPool } = await import('@/agent');
          await browserPool.closeAll();
          logger.info('Browser pool closed');
        } catch (error) {
          logger.error('Error closing browsers:', error);
        }

        try {
          // Close queue connections
          await import('@/config/queues').then(module => module.gracefulShutdown());
          logger.info('Queue connections closed');
        } catch (error) {
          logger.error('Error during queue shutdown:', error);
        }

        try {
          // Close WebSocket server
          const { shutdownWebSocket } = await import('@/websocket/server');
          await shutdownWebSocket();
          logger.info('WebSocket server closed');
        } catch (error) {
          logger.error('Error closing WebSocket:', error);
        }

        logger.info('Graceful shutdown completed');
        process.exit(0);
      });
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer();

export default app;
