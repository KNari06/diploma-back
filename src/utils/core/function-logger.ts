import * as fs from 'fs';
import * as path from 'path';

export interface FunctionLogEntry {
  handlerName: string;
  arguments: any;
  returnValue: any;
  timestamp: string;
  error?: boolean;
}

/**
 * Function logger for tracking function calls
 * Creates separate log files for each handleChat invocation
 */
export class FunctionLogger {
  private logFilePath: string;
  private entries: FunctionLogEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    const logsDir = path.join(process.cwd(), 'logs');
    
    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create filename with ISO timestamp (replace : and . with -)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(logsDir, `${timestamp}.json`);
    
    // Initialize file with empty array
    this.initializeLogFile();
  }

  private initializeLogFile(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        fs.writeFileSync(this.logFilePath, JSON.stringify([], null, 2), 'utf-8');
      }
    } catch (error) {
      console.error(`[FunctionLogger] Failed to initialize log file: ${error}`);
    }
  }

  /**
   * Serialize value safely, avoiding circular references
   */
  private serializeValue(value: any, depth: number = 0, seen: WeakSet<any> = new WeakSet()): any {
    if (depth > 5) {
      return '[Max Depth Reached]';
    }

    // Handle null and undefined
    if (value === null || value === undefined) {
      return value;
    }

    // Handle primitives
    if (typeof value !== 'object') {
      return value;
    }

    // Handle functions
    if (typeof value === 'function') {
      return `[Function: ${value.name || 'anonymous'}]`;
    }

    // Handle Date
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle Error
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    // Handle Request objects
    if (value.constructor?.name === 'IncomingMessage' || value.method || value.url) {
      return '[Request object]';
    }

    // Handle Response objects
    if (value.constructor?.name === 'ServerResponse' || value.statusCode || value.status) {
      return '[Response object]';
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map(item => this.serializeValue(item, depth + 1, seen));
    }

    // Handle objects (avoid circular references)
    if (seen.has(value)) {
      return '[Circular Reference]';
    }
    seen.add(value);

    try {
      const result: any = {};
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          try {
            result[key] = this.serializeValue(value[key], depth + 1, seen);
          } catch (e) {
            result[key] = '[Serialization Error]';
          }
        }
      }
      return result;
    } catch (error) {
      return '[Serialization Failed]';
    }
  }

  /**
   * Serialize function arguments
   */
  private serializeArguments(args: any[]): any {
    if (args.length === 0) {
      return {};
    }

    const result: any = {};
    args.forEach((arg, index) => {
      const key = `arg${index}`;
      result[key] = this.serializeValue(arg);
    });

    return result;
  }

  /**
   * Serialize return value
   */
  private serializeReturnValue(value: any): any {
    return this.serializeValue(value);
  }

  /**
   * Log function call
   */
  public logFunctionCall(
    handlerName: string,
    args: any[],
    returnValue: any,
    error?: Error
  ): void {
    const entry: FunctionLogEntry = {
      handlerName,
      arguments: this.serializeArguments(args),
      returnValue: error
        ? {
            error: true,
            message: error.message,
            stack: error.stack,
            name: error.name,
          }
        : this.serializeReturnValue(returnValue),
      timestamp: new Date().toISOString(),
    };

    if (error) {
      entry.error = true;
    }

    this.entries.push(entry);
    this.flush();
  }

  /**
   * Flush logs to file asynchronously
   */
  private flush(): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const content = JSON.stringify(this.entries, null, 2);
        await fs.promises.writeFile(this.logFilePath, content, 'utf-8');
      } catch (error) {
        console.error(`[FunctionLogger] Failed to write log file: ${error}`);
      }
    });
  }

  /**
   * Force flush and wait for completion
   */
  public async flushSync(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Get log file path
   */
  public getLogFilePath(): string {
    return this.logFilePath;
  }
}

/**
 * Wrap function with logging
 */
export function withFunctionLogging<T extends (...args: any[]) => any>(
  fn: T,
  handlerName: string,
  logger: FunctionLogger
): T {
  const wrappedFn = (...args: any[]) => {
    try {
      const result = fn(...args);
      
      // Check if result is a Promise
      if (result && typeof result.then === 'function') {
        // Async function
        return result
          .then((resolvedValue: any) => {
            logger.logFunctionCall(handlerName, args, resolvedValue);
            return resolvedValue;
          })
          .catch((error: any) => {
            logger.logFunctionCall(
              handlerName,
              args,
              undefined,
              error instanceof Error ? error : new Error(String(error))
            );
            throw error;
          });
      } else {
        // Sync function
        logger.logFunctionCall(handlerName, args, result);
        return result;
      }
    } catch (error) {
      // Sync function threw error
      logger.logFunctionCall(
        handlerName,
        args,
        undefined,
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  };

  return wrappedFn as T;
}

