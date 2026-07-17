import type { MobileAppBriefing } from './mobile-runner.types';

/**
 * Normalize a client-supplied briefing into the safe MobileAppBriefing shape:
 * only description/region (strings, capped) + keyFlows/avoid (string arrays,
 * capped). Everything else is DROPPED — critically, any credential-ish payload
 * (password/token/etc.) never survives, so this blob can never become a
 * plaintext-credential sink (credentials ride the runner's answer/redaction
 * seam, never the briefing). Returns undefined when nothing useful is present.
 *
 * Pure + defensive: safe on any untrusted input shape.
 */
export function normalizeMobileBriefing(raw: unknown): MobileAppBriefing | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, cap: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : undefined;
  const arr = (v: unknown, cap: number): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().slice(0, 120))
      .slice(0, cap);
    return out.length ? out : undefined;
  };
  const b: MobileAppBriefing = {
    description: str(r.description, 2000),
    region: str(r.region, 120),
    keyFlows: arr(r.keyFlows, 20),
    avoid: arr(r.avoid, 20),
    dataHints: str(r.dataHints, 2000),
    successCriteria: arr(r.successCriteria, 20),
  };
  return b.description || b.region || b.keyFlows || b.avoid || b.dataHints || b.successCriteria
    ? b : undefined;
}
