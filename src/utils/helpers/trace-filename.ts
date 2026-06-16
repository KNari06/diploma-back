/**
 * Local-time timestamp parts for trace log FILENAMES.
 *
 * Trace files are named `<date>_<time>_<testId>.jsonl`. The date/time must be
 * LOCAL wall-clock so a file is easy to find by the time you saw something
 * happen. Using UTC (`toISOString`) put an offset name on non-UTC logs — e.g. a
 * 22:23:35 local event (UTC+5) landed as `17-23-35`, which is confusing when
 * you go looking for it. The `ts` fields INSIDE each line stay UTC ISO
 * (machine-parseable); only the human-facing filename is local.
 *
 * Returns zero-padded `datePart` (YYYY-MM-DD) and `timePart` (HH-MM-SS,
 * colon-free so it's filesystem-safe). Shared by every JSONL trace writer so
 * the naming convention stays in one place.
 */
export function localTraceFilenameParts(date: Date = new Date()): { datePart: string; timePart: string } {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return { datePart, timePart };
}
