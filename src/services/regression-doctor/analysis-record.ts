/**
 * Regression Doctor — "this run has been analyzed" record.
 *
 * The run report has to tell three states apart: never analyzed, analyzed and
 * found nothing, analyzed and failed. An empty `regression_doctor_findings` is
 * the same row count for all three, so the outcome has to be stored somewhere
 * of its own.
 *
 * It was first read straight off the completed BullMQ job (`doctor-<runId>`),
 * which already carried the numbers. That works until the job ages out: the
 * queue keeps `removeOnComplete: 25` and is shared by the whole deployment, so
 * after 25 further analyses anywhere the record vanished and a run that had
 * been analyzed silently reverted to "Analysis is not automatic — start it when
 * you want" — the exact confusion the message existed to prevent.
 *
 * Redis with a long TTL instead: no schema change (migrations here are applied
 * by hand), and it outlives both the queue history and the 30-day screenshot
 * retention that bounds how useful re-analysis would be anyway. Fail-safe like
 * everything else on this path — a miss degrades the wording, and the queue is
 * still consulted as a fallback for analyses recorded before this existed.
 */

import { cache } from '@/utils/core/redis-cache';

/** 90 days — comfortably past `SCREENSHOT_RETENTION_DAYS` (30). */
const ANALYSIS_RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface DoctorAnalysisRecord {
  /** `completed` or `failed` — mirrors the BullMQ vocabulary the panel reads. */
  state: 'completed' | 'failed';
  findingsCreated: number | null;
  skipped: number | null;
  skipReasons: Record<string, number> | null;
  cappedOut: number | null;
  finishedAt: string | null;
}

function key(runId: string): string {
  return `qait:doctor:analysis:${runId}`;
}

export async function recordAnalysis(
  runId: string,
  record: Omit<DoctorAnalysisRecord, 'finishedAt'>,
): Promise<void> {
  await cache.set(
    key(runId),
    { ...record, finishedAt: new Date().toISOString() },
    ANALYSIS_RECORD_TTL_SECONDS,
  );
}

export async function readAnalysis(runId: string): Promise<DoctorAnalysisRecord | null> {
  return cache.get<DoctorAnalysisRecord>(key(runId));
}
