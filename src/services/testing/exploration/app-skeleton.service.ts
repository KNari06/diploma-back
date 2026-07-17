/**
 * App-skeleton service — turns a finished mobile exploration's screen graph into
 * a durable, per-app map that later requests can consult (chat brief, resolver)
 * instead of re-crawling from zero.
 *
 * Ingest (mergeRunIntoSkeleton): fold one run's `mobile.graph` into the stored
 * skeleton, keyed (project, platform, package). Merge — not overwrite — by
 * fingerprint, so the map accumulates across runs. Read (getAppModel /
 * summariseForPrompt): serve it back.
 *
 * IT IS A PRIOR, NOT TRUTH — the live crawl always wins. Best-effort on ingest:
 * a failure must never fail the exploration run (same discipline as the mobile
 * chat-history sink). Orchestration only — all DB access goes through
 * ./db/app-skeleton.db.ts.
 */
import { logger } from '@/utils/core/logger';
import { redactPii } from '@/services/chat/pii-redactor';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import {
  fetchAppSkeleton,
  fetchProjectAccessRow,
  upsertAppSkeleton,
  type SkeletonKey,
  type SkeletonPlatform,
  type SkeletonScreen,
  type SkeletonTransition,
  type AppSkeletonRow,
} from './db/app-skeleton.db';

/** The wire `mobile.graph` shape the runner emits (loosely — we read defensively). */
interface WireGraph {
  nodes?: Array<{
    title?: string;
    mobile?: {
      fingerprint?: string;
      visitCount?: number;
      isTerminal?: boolean;
      scenarios?: Array<{ name?: string; kind?: string; status?: string; checks?: string[] }>;
    };
    pageType?: string;
  }>;
  edges?: Array<{
    fromFingerprint?: string;
    toFingerprint?: string;
    action?: string;
    description?: string;
  }>;
}

export interface MergeRunInput extends SkeletonKey {
  /** The runner's fingerprint algorithm version. `undefined` (older runner that
   *  doesn't send it) is treated as "same as stored" → merge, NOT rebuild. */
  fingerprintVersion?: number;
  /** The runner's `mobile.graph`. Typed `unknown` because it crosses an
   *  untyped wire boundary; every field is read defensively below. */
  graph: unknown;
  rootFingerprint?: string;
  domainGuess?: string;
  coverageScore?: number;
  runId?: string;
}

/** The read model served to consumers. */
export interface AppModel {
  screens: SkeletonScreen[];
  transitions: SkeletonTransition[];
  rootFingerprint: string | null;
  domainGuess: string | null;
  screenCount: number;
  runCount: number;
  bestCoverageScore: number;
  updatedAt: string;
}

/** Cap so a pathological app can't bloat the stored blob unbounded. */
const MAX_SCREENS = 200;
const MAX_TRANSITIONS = 600;

export class AppSkeletonService {
  /**
   * Fold a finished run's graph into the app's stored skeleton. Best-effort:
   * logs and swallows on error — NEVER throws into the exploration path.
   */
  static async mergeRunIntoSkeleton(input: MergeRunInput): Promise<void> {
    if (!input.projectId || !input.packageName) return;
    try {
      const prev = await fetchAppSkeleton({
        projectId: input.projectId,
        platform: input.platform,
        packageName: input.packageName,
      });

      // Version guard: a fingerprint-algorithm bump makes old keys incomparable
      // with new ones — discard the stored graph and start from this run rather
      // than merge incompatible fingerprints. An UNDEFINED incoming version
      // (older runner that doesn't send it) is treated as "same as stored" so we
      // still MERGE — forcing a rebuild on undefined would mean the skeleton
      // never accumulates across runs.
      const versionMismatch =
        prev != null &&
        input.fingerprintVersion != null &&
        prev.fingerprintVersion !== input.fingerprintVersion;
      const base: AppSkeletonRow | null = prev && !versionMismatch ? prev : null;

      // The root the brief reaches from — keep it (and its outgoing edges)
      // pinned through the MAX cap so a >MAX_SCREENS app doesn't silently drop
      // the entry screen and lose its root-reachability line.
      const rootFingerprint = input.rootFingerprint ?? base?.rootFingerprint ?? null;

      const graph = (input.graph ?? {}) as WireGraph;
      const screens = mergeScreens(base?.screens ?? [], graph.nodes ?? [], rootFingerprint);
      const transitions = mergeTransitions(base?.transitions ?? [], graph.edges ?? [], rootFingerprint);

      // Persisted version: the incoming one if given, else keep the stored one,
      // else default to 1 (a fresh row with an unknown-version runner).
      const storedVersion = input.fingerprintVersion ?? base?.fingerprintVersion ?? prev?.fingerprintVersion ?? 1;

      await upsertAppSkeleton({
        projectId: input.projectId,
        platform: input.platform,
        packageName: input.packageName,
        fingerprintVersion: storedVersion,
        screens,
        transitions,
        rootFingerprint,
        domainGuess: input.domainGuess ?? base?.domainGuess ?? null,
        screenCount: screens.length,
        runCount: (base?.runCount ?? 0) + 1,
        bestCoverageScore: Math.max(base?.bestCoverageScore ?? 0, input.coverageScore ?? 0),
        lastRunId: input.runId ?? null,
      });

      logger.debug('[APP_SKELETON] merged run', {
        projectId: input.projectId,
        packageName: input.packageName,
        screens: screens.length,
        transitions: transitions.length,
        runCount: (base?.runCount ?? 0) + 1,
      });
    } catch (err) {
      logger.warn('[APP_SKELETON] merge failed (non-fatal)', {
        projectId: input.projectId,
        packageName: input.packageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load the stored model for one app, or null if none. Never throws.
   *
   * `userId` is REQUIRED for structural authz: the skeleton is keyed by
   * project_id and has no user_id, and the read runs on the service role
   * (RLS bypassed), so a caller could otherwise read another workspace's app
   * map. When `userId` is given we re-check project access (owner OR workspace
   * member) at this boundary and return null on denial — the guarantee is
   * structural, not caller-dependent. It is optional only so a trusted
   * server-side caller can opt out explicitly; the chat handler always passes it.
   */
  static async getAppModel(key: SkeletonKey, userId?: string): Promise<AppModel | null> {
    try {
      if (userId && !(await hasProjectAccess(key.projectId, userId))) {
        logger.warn('[APP_SKELETON] getAppModel denied — no project access', {
          projectId: key.projectId,
        });
        return null;
      }
      const row = await fetchAppSkeleton(key);
      if (!row) return null;
      return {
        screens: row.screens,
        transitions: row.transitions,
        rootFingerprint: row.rootFingerprint,
        domainGuess: row.domainGuess,
        screenCount: row.screenCount,
        runCount: row.runCount,
        bestCoverageScore: row.bestCoverageScore,
        updatedAt: row.updatedAt,
      };
    } catch (err) {
      logger.warn('[APP_SKELETON] getAppModel failed', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * A compact natural-language brief for an agent/chat system prompt: what the
   * app is, how many screens are known, which scenarios are covered vs pending,
   * and where the entry screen leads. Returns '' when there's nothing useful.
   */
  static summariseForPrompt(model: AppModel | null): string {
    if (!model || model.screens.length === 0) return '';

    const domain = model.domainGuess && model.domainGuess !== 'unknown' ? `${model.domainGuess} app` : 'App';
    const lines: string[] = [
      `${domain}. ${model.screens.length} screen(s) mapped from ${model.runCount} prior run(s).`,
    ];

    // Scenario roll-up across screens, deduped by name, covered listed first.
    const covered = new Set<string>();
    const pending = new Set<string>();
    for (const s of model.screens) {
      for (const sc of s.scenarios ?? []) {
        // Skip nameless scenarios — a legacy/hand-edited row could carry
        // { status } with no name, which would render "undefined (covered)".
        if (!sc?.name) continue;
        (sc.status === 'covered' ? covered : pending).add(sc.name);
      }
    }
    // A pending name that is also covered somewhere is covered — drop it.
    for (const n of covered) pending.delete(n);
    if (covered.size || pending.size) {
      const fmt = (set: Set<string>, tag: string) =>
        [...set].slice(0, 8).map((n) => `${n} (${tag})`);
      lines.push(`Known flows: ${[...fmt(covered, 'covered'), ...fmt(pending, 'pending')].join(', ')}.`);
    }

    // Where the entry screen leads (root's outgoing transitions).
    if (model.rootFingerprint) {
      const rootName = model.screens.find((s) => s.fingerprint === model.rootFingerprint)?.name;
      const dests = model.transitions
        .filter((t) => t.from === model.rootFingerprint)
        .map((t) => model.screens.find((s) => s.fingerprint === t.to)?.name)
        .filter((n): n is string => Boolean(n));
      if (rootName && dests.length) {
        lines.push(`From "${rootName}" you can reach: ${[...new Set(dests)].slice(0, 6).join(', ')}.`);
      }
    }
    return lines.join(' ');
  }
}

// ────────────────────────────────────────────────────────────────────
// Merge helpers (pure)
// ────────────────────────────────────────────────────────────────────

/** Redact PII out of a device-derived label before it is stored/re-prompted.
 *  Screen/scenario names and transition descriptions come from live app UI
 *  text (a header can show a logged-in user's name/email), and the brief is
 *  fed back into an LLM prompt that may quote it — so this sink must redact,
 *  same as the mobile chat history sink (invariant #10). Empty/undefined pass
 *  through untouched. */
function scrub(text: string | undefined): string {
  return text ? redactPii(text) : (text ?? '');
}

/** Cap a list but keep the root's own entry preferentially — a >MAX app must
 *  not lose the root (its reachability line is the most useful part of the
 *  brief). Root-keyed items are moved to the front before the slice. */
function capKeepingRoot<T>(items: T[], max: number, isRoot: (t: T) => boolean): T[] {
  if (items.length <= max) return items;
  const roots = items.filter(isRoot);
  const rest = items.filter((t) => !isRoot(t));
  return [...roots, ...rest].slice(0, max);
}

/** Union screens by fingerprint. Existing wins on firstSeen, but a later run
 *  upgrades a placeholder name / empty purpose and the richer scenario set; a
 *  `covered` scenario status is sticky over `pending`. Names/purposes are
 *  PII-scrubbed. The root screen survives the MAX cap. */
function mergeScreens(
  prev: SkeletonScreen[],
  wireNodes: NonNullable<WireGraph['nodes']>,
  rootFingerprint: string | null,
): SkeletonScreen[] {
  const byFp = new Map<string, SkeletonScreen>(prev.map((s) => [s.fingerprint, { ...s }]));

  for (const n of wireNodes) {
    const fp = n.mobile?.fingerprint;
    if (!fp) continue;
    const incoming: SkeletonScreen = {
      fingerprint: fp,
      name: scrub((n.title || '').trim()) || fp,
      purpose: n.pageType && n.pageType !== 'screen' ? scrub(n.pageType) : undefined,
      isTerminal: n.mobile?.isTerminal,
      visitCount: n.mobile?.visitCount ?? 1,
      scenarios: (n.mobile?.scenarios ?? [])
        .filter((s) => s?.name)
        .map((s) => ({
          name: scrub(s.name),
          kind: s.kind ?? 'other',
          status: s.status ?? 'pending',
          // checks embed the control's label → device text → scrub each; omit
          // when empty so a simple scenario doesn't carry an empty array.
          ...(s.checks && s.checks.length ? { checks: s.checks.map((c) => scrub(c)) } : {}),
        })),
    };
    const existing = byFp.get(fp);
    if (!existing) {
      byFp.set(fp, incoming);
    } else {
      byFp.set(fp, {
        fingerprint: fp,
        // Upgrade a placeholder ("Screen N" / bare fingerprint) name.
        name: isPlaceholderName(existing.name) && !isPlaceholderName(incoming.name) ? incoming.name : existing.name,
        purpose: existing.purpose ?? incoming.purpose,
        isTerminal: existing.isTerminal || incoming.isTerminal,
        visitCount: existing.visitCount + incoming.visitCount,
        scenarios: mergeScenarios(existing.scenarios, incoming.scenarios),
      });
    }
  }
  return capKeepingRoot([...byFp.values()], MAX_SCREENS, (s) => s.fingerprint === rootFingerprint);
}

function mergeScenarios(
  a: SkeletonScreen['scenarios'],
  b: SkeletonScreen['scenarios'],
): SkeletonScreen['scenarios'] {
  const byName = new Map<string, SkeletonScreen['scenarios'][number]>();
  for (const s of [...a, ...b]) {
    // Guard nameless scenarios (legacy / hand-edited rows) — a bare
    // `.toLowerCase()` here would TypeError on undefined.
    if (!s?.name) continue;
    const key = s.name.toLowerCase();
    const prev = byName.get(key);
    // covered is sticky; otherwise keep the incoming status. Either way, never
    // lose `checks`: carry over whichever side actually has them (a later run
    // that flips status→covered but omits checks must not erase the spec).
    if (!prev) {
      byName.set(key, { ...s });
    } else {
      const winner = prev.status !== 'covered' && s.status === 'covered' ? s : prev;
      const checks = (prev.checks?.length ? prev.checks : undefined) ?? (s.checks?.length ? s.checks : undefined);
      byName.set(key, { ...winner, ...(checks ? { checks } : {}) });
    }
  }
  return [...byName.values()];
}

/** Union transitions by (from,to,action); duplicates collapse. Descriptions
 *  are PII-scrubbed. Edges leaving the root survive the MAX cap. */
function mergeTransitions(
  prev: SkeletonTransition[],
  wireEdges: NonNullable<WireGraph['edges']>,
  rootFingerprint: string | null,
): SkeletonTransition[] {
  const byKey = new Map<string, SkeletonTransition>();
  const add = (t: SkeletonTransition) => {
    if (!t.from || !t.to) return;
    byKey.set(`${t.from}→${t.to}→${t.action}`, t);
  };
  for (const t of prev) add(t);
  for (const e of wireEdges) {
    add({
      from: e.fromFingerprint ?? '',
      to: e.toFingerprint ?? '',
      action: e.action ?? '',
      description: scrub(e.description),
    });
  }
  return capKeepingRoot([...byKey.values()], MAX_TRANSITIONS, (t) => t.from === rootFingerprint);
}

function isPlaceholderName(name: string): boolean {
  return !name || /^Screen \d+$/.test(name) || /^[0-9a-f]{8,}$/i.test(name);
}

/** Read-side access gate: owner OR any workspace member, mirroring
 *  RegressionRunService.verifyProjectAccess. Fail-closed — a missing project
 *  or any error denies. */
async function hasProjectAccess(projectId: string, userId: string): Promise<boolean> {
  try {
    const project = await fetchProjectAccessRow(projectId);
    if (!project) return false;
    if (project.userId === userId) return true;
    if (project.workspaceId) {
      const role = await WorkspaceAccessService.getRole(userId, project.workspaceId);
      if (role != null) return true;
    }
    return false;
  } catch (err) {
    logger.warn('[APP_SKELETON] project access check failed (deny)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export type { SkeletonPlatform };
