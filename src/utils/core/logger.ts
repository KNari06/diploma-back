import { env } from '@/config/environment/env';
import * as fs from 'fs';
import * as path from 'path';
import winston from 'winston';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
} catch (error) {
  // If we can't create logs directory, log to console and continue
  // This prevents app crash if there are permission issues
  console.error('Failed to create logs directory:', error);
  console.warn('Logging to files will be disabled. Logs will only go to console.');
}

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
const transports: winston.transport[] = [
  // Console transport
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
      winston.format.errors({ stack: true }), // ← FIX: Extract error.stack
      winston.format.colorize({ all: true }),
      winston.format.printf((info) => {
        // Include all metadata fields (error details, context, etc.)
        const { timestamp, level, message, stack, ...meta } = info;
        let logMessage = `${timestamp} ${level}: ${message}`;

        // If error stack exists, append it
        if (stack) {
          logMessage += `\n${stack}`;
        }

        // If there's additional metadata, stringify it
        if (Object.keys(meta).length > 0) {
          logMessage += `\n${JSON.stringify(meta, null, 2)}`;
        }

        return logMessage;
      })
    ),
  }),
];

// Always create error.log file (critical for production monitoring)
// Other log files only in production to save disk space in development
// Wrap in try-catch to handle permission errors gracefully
try {
  const errorLogTransport = new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5, // Keep last 5 files
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
  });

  // Handle file transport errors (permissions, disk full, etc.)
  errorLogTransport.on('error', (error) => {
    console.error('Error writing to error.log:', error);
  });

  transports.push(errorLogTransport);
} catch (error) {
  console.error('Failed to create error.log transport:', error);
  console.warn('Error logging to file will be disabled. Errors will only go to console.');
}

// Add additional file transports in production
if (env.NODE_ENV === 'production') {
  try {
    const fileTransports: winston.transport[] = [
      // Warnings and errors
      new winston.transports.File({
        filename: path.join(logsDir, 'warn.log'),
        level: 'warn',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      }),
      // All logs (combined)
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 20 * 1024 * 1024, // 20MB
        maxFiles: 10, // Keep last 10 files
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      }),
    ];

    // Add error handlers for each transport
    fileTransports.forEach(transport => {
      transport.on('error', (error) => {
        console.error(`Error writing to ${(transport as any).filename}:`, error);
      });
    });

    transports.push(...fileTransports);
  } catch (error) {
    console.error('Failed to create production log transports:', error);
    console.warn('Production file logging will be disabled. Logs will only go to console.');
  }
}

// Create the logger
export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  levels,
  transports,
  // Do not exit on handled exceptions
  exitOnError: false,
});

// Handle logger errors (e.g., when file transport fails)
logger.on('error', (error) => {
  // Fallback to console if logger itself fails
  console.error('Logger error:', error);
});

// Create a stream object with a 'write' function that will be used by Morgan
export const morganStream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};

// Log unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error({
    message: 'Unhandled Rejection at',
    promise: String(promise),
    reason: reason instanceof Error ? {
      message: reason.message,
      stack: reason.stack,
      name: reason.name,
    } : String(reason),
  });

  // Don't exit - log and continue
  // Only exit in production for critical errors
  // Use env.NODE_ENV for consistency
  if (env.NODE_ENV === 'production' && reason instanceof Error) {
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
  logger.error({
    message: 'Uncaught Exception',
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
  });

  // Only exit for critical errors in production
  // In development, log and continue to help debugging
  // Use env.NODE_ENV for consistency
  if (env.NODE_ENV === 'production') {
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
  // Validate inputs
  if (!testId || typeof testId !== 'string') {
    logger.warn('Invalid testId in logAIAnalysis', { testId });
    testId = 'unknown';
  }

  if (!analysis || typeof analysis !== 'object') {
    logger.warn('Invalid analysis object in logAIAnalysis', { testId });
    return;
  }

  // Safely extract summary
  const summary = analysis.summary && typeof analysis.summary === 'string'
    ? (analysis.summary.length > 100 ? analysis.summary.substring(0, 100) + '...' : analysis.summary)
    : 'No summary available';

  logger.info({
    event: 'ai.analysis',
    testId,
    analysis: {
      summary,
      bugsCount: Array.isArray(analysis.bugs) ? analysis.bugs.length : 0,
      severity: analysis.severity || 'unknown',
      confidence: typeof analysis.confidence === 'number' ? analysis.confidence : 0,
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
