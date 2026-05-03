/**
 * Lightweight runtime tracer for the editor lint/apply/run pipeline.
 *
 * Wraps individual methods so the dev visualizer (dev-tools/pipeline-viz)
 * can pulse the active node in real time. Off by default — enabled with
 * env var PIPELINE_TRACE=1. POSTs spans to PIPELINE_TRACE_ENDPOINT
 * (default http://localhost:4321/trace), which the viz dev server
 * rebroadcasts to connected browsers via SSE.
 *
 * Usage:
 *   import { traced } from '@/utils/monitoring/pipeline-tracer';
 *
 *   class PreviewStepApplyService {
 *     async applyStep(...) { ... }   // wrap the body call site:
 *   }
 *
 *   // OR at the call-site of a hub:
 *   await traced('PreviewStepApplyService.applyStep', () => doWork());
 *
 * Zero overhead when disabled: traced() short-circuits to fn().
 */

import * as http from 'http';

const ENABLED = process.env.PIPELINE_TRACE === '1' || process.env.PIPELINE_TRACE === 'true';
const ENDPOINT = process.env.PIPELINE_TRACE_ENDPOINT || 'http://localhost:4321/trace';

let endpointParsed: URL | null = null;
try {
  if (ENABLED) endpointParsed = new URL(ENDPOINT);
} catch {
  endpointParsed = null;
}

export interface TraceSpan {
  method: string;          // e.g. "PreviewStepApplyService.applyStep"
  phase: 'start' | 'end' | 'error';
  ts: number;              // epoch ms
  durationMs?: number;     // present for 'end' / 'error'
  traceId?: string;        // optional grouping id (one run / one apply chain)
  err?: string;            // error message if phase==='error'
}

function postSpan(span: TraceSpan): void {
  if (!endpointParsed) return;
  const data = JSON.stringify(span);
  const req = http.request(
    {
      hostname: endpointParsed.hostname,
      port: endpointParsed.port,
      path: endpointParsed.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      timeout: 50,
    },
    (res) => { res.resume(); },
  );
  req.on('error', () => { /* dev-only, swallow */ });
  req.on('timeout', () => req.destroy());
  req.write(data);
  req.end();
}

function emit(span: TraceSpan): void {
  if (!ENABLED) return;
  postSpan(span);
}

export function traced<T>(method: string, fn: () => Promise<T>, traceId?: string): Promise<T>;
export function traced<T>(method: string, fn: () => T, traceId?: string): T;
export function traced<T>(method: string, fn: () => T | Promise<T>, traceId?: string): T | Promise<T> {
  if (!ENABLED) return fn();
  const t0 = Date.now();
  emit({ method, phase: 'start', ts: t0, traceId });
  try {
    const ret = fn();
    if (ret && typeof (ret as Promise<T>).then === 'function') {
      return (ret as Promise<T>).then(
        (v) => {
          emit({ method, phase: 'end', ts: Date.now(), durationMs: Date.now() - t0, traceId });
          return v;
        },
        (e) => {
          emit({
            method,
            phase: 'error',
            ts: Date.now(),
            durationMs: Date.now() - t0,
            traceId,
            err: e instanceof Error ? e.message : String(e),
          });
          throw e;
        },
      );
    }
    emit({ method, phase: 'end', ts: Date.now(), durationMs: Date.now() - t0, traceId });
    return ret;
  } catch (e) {
    emit({
      method,
      phase: 'error',
      ts: Date.now(),
      durationMs: Date.now() - t0,
      traceId,
      err: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/** Marker that the viz UI can use to detect that tracing is active. */
export const TRACER_ENABLED = ENABLED;
