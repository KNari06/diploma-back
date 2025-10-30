import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env, isDevelopment } from '@/config/env';
import { logger, morganStream } from '@/utils/logger';
import { errorHandler, notFoundHandler } from '@/utils/error-handler';
import { testSupabaseConnection } from '@/db/supabase';
import { QueueManager } from '@/config/queues';
import testRoutes from '@/api/test.routes';

// Create Express app
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS configuration
app.use(cors({
  origin: isDevelopment ? true : process.env.ALLOWED_ORIGINS?.split(',') || false,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  message: {
    success: false,
    error: 'Too many requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use(morgan(env.LOG_FORMAT, { stream: morganStream }));

// Health check endpoint
app.get('/health', async (req: express.Request, res: express.Response) => {
  try {
    const [dbHealth, queueHealth] = await Promise.all([
      testSupabaseConnection(),
      QueueManager.healthCheck(),
    ]);

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
app.use(`/api/${env.API_VERSION}/tests`, testRoutes);

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
      tests: `/api/${env.API_VERSION}/tests`,
      docs: '/api/docs', // Future: API documentation
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
    // Test database connection
    const dbConnected = await testSupabaseConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database. Exiting...');
      process.exit(1);
    }

    // Test queue connection
    const queueHealth = await QueueManager.healthCheck();
    if (queueHealth.status !== 'healthy') {
      logger.error('Queue service is unhealthy. Exiting...');
      process.exit(1);
    }

    // Start HTTP server
    const server = app.listen(env.PORT, () => {
      logger.info(`🚀 QAI Backend API started on port ${env.PORT}`);
      logger.info(`📊 Environment: ${env.NODE_ENV}`);
      logger.info(`🔗 Health check: http://localhost:${env.PORT}/health`);
      logger.info(`📚 API docs: http://localhost:${env.PORT}/api/${env.API_VERSION}/tests`);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);
      
      server.close(async () => {
        logger.info('HTTP server closed');
        
        try {
          // Close queue connections
          await import('@/config/queues').then(module => module.gracefulShutdown());
          logger.info('Queue connections closed');
        } catch (error) {
          logger.error('Error during queue shutdown:', error);
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
