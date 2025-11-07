import { env } from '@/config/env';
import winston from 'winston';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Tell winston that you want to link the colors
winston.addColors(colors);

// Define which transports the logger must use
const transports = [
  // Console transport
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
      winston.format.colorize({ all: true }),
      winston.format.printf(
        (info) => `${info.timestamp} ${info.level}: ${info.message}`
      )
    ),
  }),
];

// Add file transport in production
if (env.NODE_ENV === 'production') {
  const fileTransports: any[] = [
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  ];

  transports.push(...fileTransports);
}

// Create the logger
export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  levels,
  transports,
  // Do not exit on handled exceptions
  exitOnError: false,
});

// Create a stream object with a 'write' function that will be used by Morgan
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};

// Log unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', {
    promise: String(promise),
    reason: reason instanceof Error ? {
      message: reason.message,
      stack: reason.stack,
      name: reason.name,
    } : String(reason),
  });

  // Don't exit - log and continue
  // Only exit in production for critical errors
  if (process.env.NODE_ENV === 'production' && reason instanceof Error) {
    // Check if it's a critical error that should crash the app
    const criticalErrors = ['ECONNREFUSED', 'ENOTFOUND', 'EADDRINUSE'];
    const isCritical = criticalErrors.some(code =>
      reason.message.includes(code) || (reason as any).code === code
    );

    if (isCritical) {
      logger.error('Critical unhandled rejection, exiting...');
      process.exit(1);
    }
  }
});

// Log uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', {
    message: error.message,
    stack: error.stack,
    name: error.name,
  });

  // Only exit for critical errors in production
  // In development, log and continue to help debugging
  if (process.env.NODE_ENV === 'production') {
    const criticalErrors = ['ECONNREFUSED', 'ENOTFOUND', 'EADDRINUSE', 'EACCES'];
    const isCritical = criticalErrors.some(code =>
      error.message.includes(code) || (error as any).code === code
    );

    if (isCritical) {
      logger.error('Critical uncaught exception, exiting...');
      process.exit(1);
    } else {
      logger.warn('Non-critical uncaught exception, continuing...');
    }
  } else {
    logger.warn('Uncaught exception in development, continuing...');
  }
});

// Helper functions for structured logging
export const logRequest = (req: any, res: any, next: any) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, url, ip } = req;
    const { statusCode } = res;

    logger.http(`${method} ${url} ${statusCode} - ${duration}ms - ${ip}`);
  });

  next();
};

export const logError = (error: Error, context?: any) => {
  logger.error({
    message: error.message,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString(),
  });
};

export const logTestEvent = (event: string, testId: string, data?: any) => {
  logger.info({
    event,
    testId,
    data,
    timestamp: new Date().toISOString(),
  });
};

export const logQueueEvent = (event: string, jobId: string, data?: any) => {
  logger.info({
    event: `queue.${event}`,
    jobId,
    data,
    timestamp: new Date().toISOString(),
  });
};

export const logAIAnalysis = (testId: string, analysis: any) => {
  logger.info({
    event: 'ai.analysis',
    testId,
    analysis: {
      summary: analysis.summary?.substring(0, 100) + '...',
      bugsCount: analysis.bugs?.length || 0,
      severity: analysis.severity,
      confidence: analysis.confidence,
    },
    timestamp: new Date().toISOString(),
  });
};

export const logAgentCommunication = (action: string, agentUrl: string, data?: any) => {
  logger.info({
    event: 'agent.communication',
    action,
    agentUrl,
    data,
    timestamp: new Date().toISOString(),
  });
};

export const logDatabaseOperation = (operation: string, table: string, data?: any) => {
  logger.debug({
    event: 'database.operation',
    operation,
    table,
    data,
    timestamp: new Date().toISOString(),
  });
};

export const logPerformance = (operation: string, duration: number, metadata?: any) => {
  logger.info({
    event: 'performance',
    operation,
    duration,
    metadata,
    timestamp: new Date().toISOString(),
  });
};
