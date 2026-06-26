import { env } from '@/config/environment/env';
import * as fs from 'fs';
import * as path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';
import LokiTransport from 'winston-loki';
import { logBuffer } from './log-buffer';
import { PROCESS_KIND, publishLogEntry } from './log-bridge';

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

// Hard cap for individual log fields to protect against accidental huge dumps
// (e.g. upstream Cloudflare HTML pages stuffed into error.message). Anything
// larger gets truncated with a marker. Applies to BOTH console transport
// (via safeStringifyMeta) AND file transports (via truncateLargeFields format).
const LOG_FIELD_MAX_LENGTH = 4 * 1024;       // per-string field cap
const LOG_META_MAX_BYTES = 8 * 1024;          // per-line cap for console pretty-print

function safeStringifyMeta(meta: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(meta, null, 2);
  } catch {
    // Circular reference or non-serializable value — fall back to a shallow string
    try {
      json = String(meta);
    } catch {
      return '[unserializable meta]';
    }
  }
  if (json.length > LOG_META_MAX_BYTES) {
    return json.slice(0, LOG_META_MAX_BYTES) + `\n…[truncated ${json.length - LOG_META_MAX_BYTES} bytes]`;
  }
  return json;
}

/**
 * Recursively truncate any string field in a log info object that exceeds
 * LOG_FIELD_MAX_LENGTH. Mutates a clone of the input — never the original.
 *
 * Why this exists separately from safeStringifyMeta: console transport uses
 * `printf` and produces pretty-printed JSON, while file transports use
 * `winston.format.json()` which serialises the info object directly and
 * bypasses our printf. Without this pre-format, a 5 KB Cloudflare HTML page
 * would still land in error.log even though console is capped.
 */
const RESERVED_LOG_KEYS = new Set(['level', 'message', 'timestamp', 'stack', 'label', 'service']);

const truncateLargeFields = winston.format((info) => {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 6) return '[depth-limit]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      if (value.length > LOG_FIELD_MAX_LENGTH) {
        return value.slice(0, LOG_FIELD_MAX_LENGTH) + `…[truncated ${value.length - LOG_FIELD_MAX_LENGTH}b]`;
      }
      return value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v) => visit(v, depth + 1));
    }
    // Object — copy first 50 keys, recursively visiting each value.
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (count++ >= 50) break;
      out[key] = visit((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  };

  // Walk top-level fields except reserved winston meta. Mutate info in place
  // (winston format functions are expected to do that).
  for (const key of Object.keys(info)) {
    if (RESERVED_LOG_KEYS.has(key)) continue;
    (info as Record<string, unknown>)[key] = visit((info as Record<string, unknown>)[key], 0);
  }
  // Also guard the top-level message in case someone logs a giant string directly
  if (typeof info.message === 'string' && info.message.length > LOG_FIELD_MAX_LENGTH) {
    info.message = info.message.slice(0, LOG_FIELD_MAX_LENGTH) + `…[truncated ${info.message.length - LOG_FIELD_MAX_LENGTH}b]`;
  }
  return info;
});

/**
 * Ring-buffer transport — captures every log entry into an in-memory buffer
 * that powers the System Logs tab in the AI activity modal. Cheap (last 1k
 * entries), bypasses the file system, and works the same in dev and prod.
 */
class RingBufferTransport extends Transport {
  log(info: winston.Logform.TransformableInfo, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    try {
      const { level, message, timestamp, stack, ...meta } = info as Record<string, unknown>;
      const summary =
        typeof message === 'string'
          ? message
          : (() => {
              try { return JSON.stringify(message); }
              catch { return String(message); }
            })();
      const entry = {
        timestamp:
          typeof timestamp === 'string' && timestamp.length > 0
            ? timestamp
            : new Date().toISOString(),
        level: String(level),
        message: stack ? `${summary}\n${stack}` : summary,
        meta: Object.keys(meta).length > 0 ? (meta as Record<string, unknown>) : undefined,
        source: PROCESS_KIND,
      };
      // Always push to the local buffer (powers same-process tail).
      logBuffer.push(entry);
      // Publish to the cross-process bridge — no-op when this IS the API process,
      // because the API is the only subscriber and would get its own messages back.
      publishLogEntry(entry);
    } catch {
      // Buffer must never break logging.
    }
    callback();
  }
}

// Define which transports the logger must use
const transports: winston.transport[] = [
  new RingBufferTransport({
    // Capture everything so the operator can pick what to display in the UI.
    level: 'debug',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      truncateLargeFields(),
    ),
  }),
  // V25 — Console transport with level-aware noise filter.
  // Each suppressed tag fires every 1-10s during a session and
  // crowds out the lines we actually care about. Suppression here
  // is TERMINAL-ONLY — the file transports (v25-debug.log,
  // etap2-cdp.log, combined.log) still receive these entries, so
  // post-mortem analysis is unaffected.
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format((info) => {
        const msg = typeof info.message === 'string' ? info.message : String(info.message);

        // Suppress only at debug level — these are pure noise in the terminal.
        if (info.level === 'debug') {
          const NOISY_DEBUG_TAGS = [
            '[PREVIEW_VIDEO] Stats',
            '[PREVIEW_VIDEO] Injected manual frame',
            '[PREVIEW_VIDEO] First frame guaranteed',
            '[WebSocketService] Emitted to user',
            '[STEP_READINESS] Skipped',
            '[STEP_READINESS] Starting lookahead',
            '[STEP_READINESS] Element ready',
            '[STEP_READINESS] Unknown locator',
            '[PreviewRun] Lookahead skipped',
            '[PreviewRun] Evidence policy check',
            '[SNAPSHOT_REJECTS] filter rejection summary',
            '[ELEMENT_RESOLVER] Starting resolution',
            '[ELEMENT_RESOLVER] Built allowed sets',
            '[ELEMENT_RESOLVER] Allowed sets built',
            '[COMPILED_EXECUTOR] Compiled signature is base64',
            '[INTENT_LINT] Linting step',
            '[AI_USAGE] Untracked AI call',
            '[AI_PROVIDER] Generating text',
            '[BLOCKER_DIAGNOSIS] Requesting LLM diagnosis',
            '[BLOCKER_DIAGNOSIS] Wait timed out',
            '[INTENT_LINT_V23] Clarification LLM resolved',
            '[INTENT_LINT_V4] Degraded mode: fingerprint',
          ];
          return NOISY_DEBUG_TAGS.some((t) => msg.includes(t)) ? false : info;
        }

        // Suppress only at warn level — high-frequency Etap 2 shadow-mode
        // divergence warnings during preview ramp-up. They fire on every
        // preview-tick (~2/sec) on dense pages and drown the terminal,
        // but they are essential signal — that's why they keep landing in
        // logs/etap2-cdp.log via the dedicated file transport. The
        // terminal does not need them.
        if (info.level === 'warn') {
          const NOISY_WARN_TAGS = [
            '[SNAPSHOT_SHADOW_DIVERGENCE]',
            // `[SNAPSHOT_COLLECTOR] page.evaluate returned 0 elements` —
            // fires on canvas-only / blank intermediate pages (e.g. 360°
            // panorama viewer at panoDIV) where there are physically no
            // interactive nodes to collect. Not a bug; the resolver will
            // just see an empty allowed set and bail. Kept in combined.log
            // for postmortem because the debugStats payload is rich.
            '[SNAPSHOT_COLLECTOR] page.evaluate returned 0 elements',
          ];
          return NOISY_WARN_TAGS.some((t) => msg.includes(t)) ? false : info;
        }

        // info / error — always pass through.
        return info;
      })(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
      winston.format.errors({ stack: true }), // ← FIX: Extract error.stack
      truncateLargeFields(), // V21: cap individual fields before colorize/printf
      winston.format.colorize({ all: true }),
      winston.format.printf((info) => {
        // Include all metadata fields (error details, context, etc.)
        const { timestamp, level, message, stack, ...meta } = info;
        let logMessage = `${timestamp} ${level}: ${message}`;

        // If error stack exists, append it
        if (stack) {
          logMessage += `\n${stack}`;
        }

        // If there's additional metadata, stringify it (with size cap)
        if (Object.keys(meta).length > 0) {
          logMessage += `\n${safeStringifyMeta(meta as Record<string, unknown>)}`;
        }

        return logMessage;
      })
    ),
  }),
  // Grafana Loki push — only when LOKI_HOST is configured (prod). Labels let us
  // split streams by process (api / worker / scheduler) in Grafana. The transport
  // batches and ships over HTTP; a connection error is logged once to the console
  // and never breaks the app (telemetry must never take down the host process).
  ...(process.env.LOKI_HOST
    ? [
        new LokiTransport({
          host: process.env.LOKI_HOST,
          basicAuth: process.env.LOKI_BASIC_AUTH,
          labels: { app: PROCESS_KIND, env: 'prod' },
          json: true,
          replaceTimestamp: true,
          onConnectionError: (e) => console.error('[loki]', e),
        }),
      ]
    : []),
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
      truncateLargeFields(), // V21: cap fields before json() so HTML payloads don't bloat error.log
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

// V25 — dedicated debug log for resolver + builder + token-extraction events.
//
// Why a separate file instead of using the console transport: in dev mode
// info-level lines go ONLY to stdout, so we can't post-mortem them without
// piping the entire dev session through `tee`. This transport always writes
// to disk regardless of NODE_ENV, but filters to ONLY our V25 tags so the
// file stays small and grep-friendly. Kill switch: rm logs/v25-debug.log.
try {
  // Tags whose log lines we want preserved on disk for post-mortem. Each
  // entry is matched as a substring against the message string (winston
  // passes message + meta separately, so we lift `[TAG]` from message).
  const V25_TAGS = [
    '[STABLE_TOKENS_LLM]',
    '[LOCATOR_PLAN_BUILDER]',
    '[LLM_SELECT]',
    '[ELEMENT_RESOLVER]',
    '[CANDIDATE_PRUNER]',
    '[PREVIEW_APPLY] Rejecting',
    '[PREVIEW_APPLY] Cleared parasitic',
    '[PREVIEW_APPLY] LLM cache invalidated',
    '[PREVIEW_APPLY] Token cache invalidated',
    '[PREVIEW_APPLY] Pre-click guard',
    '[INTENT_LINT_TIMING]',
    '[COMPILED_EXECUTOR]',
  ];
  const v25Filter = winston.format((info) => {
    const msg = typeof info.message === 'string' ? info.message : String(info.message);
    return V25_TAGS.some(tag => msg.includes(tag)) ? info : false;
  });

  // Custom format that bypasses truncateLargeFields — we WANT the full
  // candidate dump / token list / fingerprint object preserved, otherwise
  // post-mortem becomes guesswork. Tag-filter ensures we only catch our
  // diagnostic lines so the file stays small even without truncation.
  const v25LogTransport = new winston.transports.File({
    filename: path.join(logsDir, 'v25-debug.log'),
    // debug grabs `[COMPILED_EXECUTOR] Trying locator` and `[ELEMENT_RESOLVER]
    // Starting resolution` which are key for understanding plan execution.
    // The tag filter still narrows volume so we don't drown in PREVIEW_VIDEO
    // / SNAPSHOT_REJECTS / WebSocketService chatter at debug level.
    level: 'debug',
    maxsize: 20 * 1024 * 1024, // 20MB — enough for several full test runs
    maxFiles: 3,                // rotate, keep last 3
    format: winston.format.combine(
      v25Filter(),
      winston.format.timestamp(),
      // INTENTIONALLY SKIP truncateLargeFields — diagnostic dumps need
      // full fidelity. The tag filter already keeps total volume bounded.
      winston.format.json()
    ),
  });

  v25LogTransport.on('error', (error) => {
    console.error('Error writing to v25-debug.log:', error);
  });

  transports.push(v25LogTransport);
} catch (error) {
  console.error('Failed to create v25-debug.log transport:', error);
}

// ── Etap 2 CDP snapshot diagnostic log ──────────────────────────────
// Tag-filtered file mirror of all Etap 2 logging. Why a separate file:
//   1. Dev console gets clipped under load — long debug lines from
//      preview-tick (~2/sec) push earlier diagnostic lines off the
//      visible buffer before the operator can read them.
//   2. `combined.log` is prod-only AND mixes tags from across the
//      whole codebase; finding the SNAPSHOT_ROUTER thread is a chore.
//   3. `error.log` only catches errors, missing the info-level `source:
//      'cdp'` confirmation that's most useful during ramp-up.
// This transport ALWAYS writes (dev + prod), level=debug, NO field
// truncation (we want full phase timings + shape stats). Tag filter
// keeps file small. Kill switch: rm logs/etap2-cdp.log.
try {
  const ETAP2_TAGS = [
    '[SNAPSHOT_ROUTER]',
    '[SNAPSHOT_HEALTH]',
    '[SNAPSHOT_SHADOW_DIVERGENCE]',
    '[CDP_SNAPSHOT]',
  ];
  const etap2Filter = winston.format((info) => {
    const msg = typeof info.message === 'string' ? info.message : String(info.message);
    return ETAP2_TAGS.some((tag) => msg.includes(tag)) ? info : false;
  });

  const etap2LogTransport = new winston.transports.File({
    filename: path.join(logsDir, 'etap2-cdp.log'),
    level: 'debug',
    maxsize: 20 * 1024 * 1024, // 20MB — enough for ~24h of dense-page
                                // ramp-up testing including Phase 5b
                                // diagnostic dumps.
    maxFiles: 3,
    format: winston.format.combine(
      etap2Filter(),
      winston.format.timestamp(),
      // SKIP truncateLargeFields — `[CDP_SNAPSHOT] Collected` carries
      // full phase timings + runtime stats that we WANT readable
      // post-mortem. Tag filter already bounds total volume.
      winston.format.json(),
    ),
  });

  etap2LogTransport.on('error', (error) => {
    console.error('Error writing to etap2-cdp.log:', error);
  });

  transports.push(etap2LogTransport);
} catch (error) {
  console.error('Failed to create etap2-cdp.log transport:', error);
}

// ── Mobile session lifecycle log ────────────────────────────────────
// Why a separate file: the editor's "start session" (warmup) flow, the
// mobile regression run path, and the preview stream all log at info/warn.
// In dev those lines go ONLY to each service's own Terminal window (see
// run-dev.sh — every process gets its own window, nothing is tee'd to
// disk), so a "Failed to start session" in the editor leaves NO trace the
// next morning: error.log only catches `error` level, and a warmup that
// fails via a guard `res.status(4xx/5xx).json()` return never throws, so
// it never reaches the catch that logs at error. This transport ALWAYS
// writes (dev + prod), level=info, tag-filtered so the file stays small
// and grep-friendly. Kill switch: rm logs/mobile-session.log.
try {
  const MOBILE_TAGS = [
    '[MOBILE_SESSION]',
    '[MOBILE_APP_PREP]',
    '[MOBILE-TEST]',
    '[MOBILE_TEST_WORKER]',
    '[MOBILE_STREAM]',
  ];
  const mobileFilter = winston.format((info) => {
    const msg = typeof info.message === 'string' ? info.message : String(info.message);
    return MOBILE_TAGS.some((tag) => msg.includes(tag)) ? info : false;
  });

  const mobileLogTransport = new winston.transports.File({
    filename: path.join(logsDir, 'mobile-session.log'),
    // info captures the per-phase warmup breadcrumbs + the guard-return
    // warns; we don't need debug-level stream chatter here.
    level: 'info',
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 3,                // rotate, keep last 3
    format: winston.format.combine(
      mobileFilter(),
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      truncateLargeFields(),
      winston.format.json(),
    ),
  });

  mobileLogTransport.on('error', (error) => {
    console.error('Error writing to mobile-session.log:', error);
  });

  transports.push(mobileLogTransport);
} catch (error) {
  console.error('Failed to create mobile-session.log transport:', error);
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
          truncateLargeFields(), // V21: same field cap as error.log
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
          truncateLargeFields(), // V21: same field cap as error.log
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

// Guard against recursive logging (e.g. write EIO cascade).
// If logger itself throws (broken stdout pipe), we fall back to stderr only.
let _isHandlingException = false;

function _safeLog(level: 'error' | 'warn', payload: object | string): void {
  if (_isHandlingException) {
    // Already inside a handler — write directly to stderr to avoid infinite loop
    try {
      process.stderr.write(`[SAFE_LOG fallback] ${JSON.stringify(payload)}\n`);
    } catch {
      // stderr also broken — nothing we can do
    }
    return;
  }
  _isHandlingException = true;
  try {
    logger[level](payload as any);
  } catch {
    try {
      process.stderr.write(`[LOGGER_ERROR] Failed to log: ${JSON.stringify(payload)}\n`);
    } catch {
      // completely broken — ignore
    }
  } finally {
    _isHandlingException = false;
  }
}

// Suppress broken-pipe / closed-stdout errors from Winston Console transport.
// These are NOT real app errors — they happen when the terminal is closed while
// the process keeps running. Without this guard they trigger uncaughtException
// which tries to log → write EIO again → infinite storm of 70k+ entries.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EIO' || err.code === 'EPIPE' || err.code === 'EBADF') {
    // stdout is gone (terminal closed / pipe broken) — silently ignore
    return;
  }
  // Unexpected stdout error — surface via stderr only
  try {
    process.stderr.write(`[STDOUT_ERROR] ${err.message}\n`);
  } catch {
    // ignore
  }
});

// Log unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  _safeLog('error', {
    message: 'Unhandled Rejection at',
    promise: String(promise),
    reason: reason instanceof Error ? {
      message: reason.message,
      stack: reason.stack,
      name: reason.name,
    } : String(reason),
  });

  if (env.NODE_ENV === 'production' && reason instanceof Error) {
    const criticalErrors = ['ECONNREFUSED', 'ENOTFOUND', 'EADDRINUSE'];
    const isCritical = criticalErrors.some(code =>
      reason.message.includes(code) || (reason as any).code === code
    );

    if (isCritical) {
      _safeLog('error', 'Critical unhandled rejection, exiting...');
      process.exit(1);
    }
  }
});

// Log uncaught exceptions
process.on('uncaughtException', (error) => {
  // Ignore write EIO / EPIPE — these are broken-pipe errors from Winston Console
  // transport when stdout is closed (terminal closed, pipe gone). They are NOT
  // real application errors and must not re-enter the logger.
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EIO' || code === 'EPIPE' || code === 'EBADF') {
    return;
  }

  _safeLog('error', {
    message: 'Uncaught Exception',
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
  });

  if (env.NODE_ENV === 'production') {
    const criticalErrors = ['ECONNREFUSED', 'ENOTFOUND', 'EADDRINUSE', 'EACCES'];
    const isCritical = criticalErrors.some(code =>
      error.message.includes(code) || (error as any).code === code
    );

    if (isCritical) {
      _safeLog('error', 'Critical uncaught exception, exiting...');
      process.exit(1);
    } else {
      _safeLog('warn', 'Non-critical uncaught exception, continuing...');
    }
  } else {
    _safeLog('warn', 'Uncaught exception in development, continuing...');
  }
});

/**
 * Compact, log-safe representation of an arbitrary error value.
 *
 * Why this exists: third-party clients (Supabase, fetch, etc.) sometimes throw
 * "errors" whose `.message` is the entire HTML body of an upstream gateway
 * page (Cloudflare 520, nginx 502, etc.). Logging the raw object via
 * `logger.error('...', { error })` then dumps multi-KB of HTML into stdout and
 * the error.log file, which is useless and noisy.
 *
 * This helper:
 *  - Detects HTML payloads and replaces them with `{host, statusCode}` summary
 *  - Truncates message to 500 chars
 *  - Preserves common useful fields (name, code, status, statusCode, hint, details)
 *  - Never throws — falls back to a string snapshot for exotic shapes
 */
const ERROR_MESSAGE_MAX = 500;
const ERROR_HTML_SNIFF = /^\s*<(?:!doctype|html|head|body)/i;
const ERROR_CF_STATUS = /Error code (\d{3})/i;
const ERROR_CF_HOST = /<title>([^|<]+)\s*\|/i;

export function formatError(err: unknown): Record<string, unknown> {
  if (err === null || err === undefined) {
    return { message: String(err) };
  }

  if (typeof err === 'string') {
    return { message: err.length > ERROR_MESSAGE_MAX ? err.slice(0, ERROR_MESSAGE_MAX) + '…' : err };
  }

  if (typeof err !== 'object') {
    return { message: String(err) };
  }

  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Extract message (the field that usually contains HTML in upstream errors)
  let rawMessage: string | undefined;
  if (typeof e.message === 'string') rawMessage = e.message;
  else if (e instanceof Error) rawMessage = e.message;

  if (rawMessage) {
    if (ERROR_HTML_SNIFF.test(rawMessage)) {
      // HTML payload — extract gateway summary instead of dumping the page
      const statusMatch = rawMessage.match(ERROR_CF_STATUS);
      const hostMatch = rawMessage.match(ERROR_CF_HOST);
      out.message = '[upstream gateway HTML response]';
      if (statusMatch) out.upstreamStatus = Number(statusMatch[1]);
      if (hostMatch) out.upstreamHost = hostMatch[1].trim();
    } else if (rawMessage.length > ERROR_MESSAGE_MAX) {
      out.message = rawMessage.slice(0, ERROR_MESSAGE_MAX) + '…';
    } else {
      out.message = rawMessage;
    }
  }

  // Preserve common useful fields
  for (const key of ['name', 'code', 'status', 'statusCode', 'hint', 'details'] as const) {
    if (e[key] !== undefined && e[key] !== null) {
      const val = e[key];
      // Recursively guard nested string fields
      if (typeof val === 'string' && val.length > ERROR_MESSAGE_MAX) {
        out[key] = val.slice(0, ERROR_MESSAGE_MAX) + '…';
      } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        out[key] = val;
      }
    }
  }

  // Stack only for real Error instances, capped to first 10 lines
  if (e instanceof Error && e.stack) {
    const lines = e.stack.split('\n').slice(0, 10);
    out.stack = lines.join('\n');
  }

  // If we extracted nothing usable, fall back to a short JSON snapshot
  if (Object.keys(out).length === 0) {
    try {
      const json = JSON.stringify(e);
      out.message = json.length > ERROR_MESSAGE_MAX ? json.slice(0, ERROR_MESSAGE_MAX) + '…' : json;
    } catch {
      out.message = String(e);
    }
  }

  return out;
}

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
