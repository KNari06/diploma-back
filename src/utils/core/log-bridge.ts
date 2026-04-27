/**
 * Log Bridge — forwards Winston log entries between processes via Redis pub/sub
 * so the API process's ring buffer (and therefore the System Logs tab) sees
 * everything from the worker and scheduler too.
 *
 * Architecture:
 *   worker/scheduler → publish to `system:logs` channel
 *   api             → subscribe to channel, push received entries into local ring buffer
 *
 * Each process also keeps writing to its OWN local ring buffer for its own
 * console/file transports — this bridge is just the cross-process aggregation.
 *
 * The bridge is fire-and-forget. Errors never propagate to the logger that
 * called us — bad telemetry must never break the app.
 *
 * Cannot import from logger.ts (cycle) — uses direct `console.warn` for
 * its own internal diagnostics.
 */

import Redis from 'ioredis';
import { connection } from '@/config/infrastructure/queues';
import { logBuffer, type BufferedLogEntry } from './log-buffer';

const CHANNEL = 'system:logs';
const PUBLISH_PAYLOAD_MAX_BYTES = 64 * 1024; // hard cap per entry to protect Redis

/**
 * Detect what kind of process we're running in by inspecting `process.argv[1]`.
 * Matches both ts-node (`src/worker/index.ts`) and built (`dist/worker/index.js`)
 * paths. Defaults to 'api' so the receiver is always the HTTP server.
 */
function detectProcessKind(): 'api' | 'worker' | 'scheduler' {
  const argv = (process.argv[1] || '').replace(/\\/g, '/');
  if (/\/worker\/index\.(ts|js)$/.test(argv)) return 'worker';
  if (/\/scheduler\/index\.(ts|js)$/.test(argv)) return 'scheduler';
  return 'api';
}

export const PROCESS_KIND: 'api' | 'worker' | 'scheduler' = detectProcessKind();

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let isInitialised = false;

function getPublisher(): Redis | null {
  if (publisher) return publisher;
  try {
    publisher = new Redis(connection as any);
    publisher.on('error', () => { /* swallow — bad pub MUST NOT break logging */ });
    return publisher;
  } catch {
    return null;
  }
}

/**
 * Publish a buffered log entry to the cross-process channel.
 * No-op when running in the API process (no need to round-trip to itself).
 * No-op on Redis errors — telemetry never breaks the host process.
 */
export function publishLogEntry(entry: Omit<BufferedLogEntry, 'seq'>): void {
  if (PROCESS_KIND === 'api') return;
  const pub = getPublisher();
  if (!pub) return;
  try {
    const enriched = { ...entry, source: entry.source ?? PROCESS_KIND };
    const json = JSON.stringify(enriched);
    if (json.length > PUBLISH_PAYLOAD_MAX_BYTES) {
      // Truncate the message field rather than dropping the entry.
      const truncated = {
        ...enriched,
        message:
          typeof enriched.message === 'string'
            ? enriched.message.slice(0, 4_000) + '…[bridge-truncated]'
            : enriched.message,
        meta: undefined,
      };
      pub.publish(CHANNEL, JSON.stringify(truncated)).catch(() => {});
      return;
    }
    pub.publish(CHANNEL, json).catch(() => {});
  } catch {
    // ignore — never throw from logger path
  }
}

/**
 * Initialise the bridge. Idempotent. Called once at startup of any process.
 * On the API process this also starts the subscriber that ingests entries
 * from worker/scheduler into the local ring buffer.
 */
export function initLogBridge(): void {
  if (isInitialised) return;
  isInitialised = true;

  if (PROCESS_KIND !== 'api') {
    // Eagerly create the publisher so the first log entry doesn't pay
    // connection latency.
    getPublisher();
    return;
  }

  // API process — subscribe and feed received entries into the local buffer.
  try {
    subscriber = new Redis(connection as any);
    subscriber.on('error', () => { /* swallow */ });
    subscriber.subscribe(CHANNEL).catch(() => { /* swallow */ });
    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        const parsed = JSON.parse(raw) as Omit<BufferedLogEntry, 'seq'>;
        if (
          parsed &&
          typeof parsed.timestamp === 'string' &&
          typeof parsed.level === 'string' &&
          typeof parsed.message === 'string'
        ) {
          logBuffer.push(parsed);
        }
      } catch {
        // ignore malformed messages
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[LOG_BRIDGE] Failed to start subscriber', err);
  }
}
