/**
 * JiraWebhookService — parses + authorizes an incoming Jira webhook and decides
 * whether it should auto-trigger a QA assessment.
 *
 * Distinct from git-webhook.service.ts (that's for GitHub/GitLab code webhooks).
 * Jira's plain outgoing webhook carries no HMAC signature, so the shared secret
 * is passed in the registered URL's query string (?secret=...) and compared
 * timing-safely against the per-project secret. Business logic only — the
 * project lookup goes through ./db/jira-webhook.db.
 */

import crypto from 'crypto';
import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';
import { findProjectsForJiraKey, effectiveTriggerStatuses, getOwnerJiraSiteHosts } from './db/jira-webhook.db';

/** Cooldown window (seconds) between auto-assessments of the same ticket+status. */
const JIRA_WEBHOOK_COOLDOWN_SECONDS = 120;

export interface JiraWebhookParsed {
  webhookEvent?: string;
  issueKey?: string;
  projectKey?: string;
  /** New status id + name after the change (from fields.status). */
  statusId?: string;
  statusName?: string;
  /** Statuses this update transitioned INTO, per the changelog (id + name). */
  transitionedTo: Array<{ id: string; name: string }>;
  /** Site host from issue.self (e.g. "acme.atlassian.net") — used to guard against
   *  cross-site collisions when two sites share a project key. Undefined if absent. */
  siteHost?: string;
}

export interface JiraWebhookTrigger {
  projectId: string;
  userId: string;
  workspaceId?: string;
  issueKey: string;
  matchedStatus: string;
  /** Stable status id (for the per-ticket assessment cooldown key). */
  matchedStatusId: string;
}

export class JiraWebhookService {
  /** Timing-safe compare of the secret from the webhook URL against the stored one. */
  static verifySecret(provided: string | undefined, expected: string | undefined): boolean {
    if (!provided || !expected) return false;
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Extract the fields we care about from a raw Jira webhook payload. */
  static parse(payload: any): JiraWebhookParsed {
    const issue = payload?.issue;
    const fields = issue?.fields || {};
    const changelog = payload?.changelog;

    const transitionedTo: Array<{ id: string; name: string }> = [];
    const items = Array.isArray(changelog?.items) ? changelog.items : [];
    for (const it of items) {
      // A status-change item has field 'status'; `to` is the new status id,
      // `toString` its name. Capture both so we can match by stable id.
      if (it?.field === 'status' || it?.fieldId === 'status') {
        transitionedTo.push({
          id: typeof it?.to === 'string' ? it.to : '',
          name: typeof it?.toString === 'string' ? it.toString : '',
        });
      }
    }

    return {
      webhookEvent: typeof payload?.webhookEvent === 'string' ? payload.webhookEvent : undefined,
      issueKey: typeof issue?.key === 'string' ? issue.key : undefined,
      projectKey: typeof fields?.project?.key === 'string' ? fields.project.key : undefined,
      statusId: typeof fields?.status?.id === 'string' ? fields.status.id : undefined,
      statusName: typeof fields?.status?.name === 'string' ? fields.status.name : undefined,
      transitionedTo,
      siteHost: this.hostFromUrl(issue?.self),
    };
  }

  /** Lowercased hostname from a URL string, or undefined if unparseable. */
  static hostFromUrl(url: unknown): string | undefined {
    if (typeof url !== 'string' || !url) return undefined;
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return undefined;
    }
  }

  /**
   * Did this update transition the issue INTO one of the configured trigger
   * statuses? Matches by stable status ID first (survives renames), then by
   * name (case-insensitive) — so a config with only a legacy name still works.
   * Returns the matched status, or null. Falls back to the CURRENT status when
   * the changelog is absent (some webhook configs omit it).
   */
  static matchTrigger(
    parsed: JiraWebhookParsed,
    triggers: Array<{ id: string; name: string }>,
  ): { id: string; name: string } | null {
    if (!triggers.length) return null;
    const ids = new Set(triggers.map((t) => t.id).filter(Boolean));
    const names = new Set(triggers.map((t) => t.name.trim().toLowerCase()).filter(Boolean));

    const entered = parsed.transitionedTo.length > 0
      ? parsed.transitionedTo
      : (parsed.statusId || parsed.statusName ? [{ id: parsed.statusId || '', name: parsed.statusName || '' }] : []);

    for (const e of entered) {
      if (e.id && ids.has(e.id)) return { id: e.id, name: e.name };
      if (e.name && names.has(e.name.trim().toLowerCase())) return { id: e.id, name: e.name };
    }
    return null;
  }

  /**
   * Resolve a verified, triggerable assessment from a parsed event + the URL
   * secret. Returns null (no-op) when: not an issue_updated event, no projectKey,
   * no matching project, secret mismatch, or the status didn't transition into
   * any configured trigger status. Never throws. When a project matched by
   * key+secret but NOT by status, logs a forgiving note (aids debugging typos).
   */
  static async resolveTrigger(
    parsed: JiraWebhookParsed,
    providedSecret: string | undefined,
  ): Promise<JiraWebhookTrigger | null> {
    try {
      if (parsed.webhookEvent && parsed.webhookEvent !== 'jira:issue_updated') return null;
      if (!parsed.issueKey || !parsed.projectKey) return null;

      const candidates = await findProjectsForJiraKey(parsed.projectKey);
      for (const p of candidates) {
        const secret = p.jira.webhookSecret;
        if (!secret || !this.verifySecret(providedSecret, secret)) continue;

        const triggers = effectiveTriggerStatuses(p.jira);
        const matched = this.matchTrigger(parsed, triggers);
        if (!matched) {
          logger.info('[JIRA_WEBHOOK] Secret OK but status not a configured trigger — ignoring', {
            issueKey: parsed.issueKey,
            enteredStatus: parsed.transitionedTo.map((t) => t.name).join(',') || parsed.statusName,
            configured: triggers.map((t) => t.name).join(','),
          });
          continue;
        }

        // Defensive cross-site guard: if the payload carries a site host AND the
        // owner has resolvable Jira site host(s), require a match. If either is
        // missing/unresolvable, fall through (no regression) — the secret already
        // authorizes the caller. Only REJECTS on a positive mismatch.
        if (parsed.siteHost) {
          const ownerHosts = await getOwnerJiraSiteHosts(p.user_id);
          if (Array.isArray(ownerHosts) && ownerHosts.length > 0 && !ownerHosts.includes(parsed.siteHost)) {
            logger.warn('[JIRA_WEBHOOK] Site host mismatch — ignoring (cross-site guard)', {
              issueKey: parsed.issueKey, eventHost: parsed.siteHost, ownerHosts: ownerHosts.join(','),
            });
            continue;
          }
        }
        return {
          projectId: p.id,
          userId: p.user_id,
          workspaceId: p.workspace_id ?? undefined,
          issueKey: parsed.issueKey,
          matchedStatus: matched.name || matched.id,
          matchedStatusId: matched.id || matched.name,
        };
      }
      return null;
    } catch (err) {
      logger.warn('[JIRA_WEBHOOK] resolveTrigger failed (non-fatal)', {
        issueKey: parsed.issueKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Atomically claim the right to assess (projectId, issueKey, statusId) for a
   * cooldown window — prevents a Jira webhook burst (several issue_updated for
   * one transition) from firing duplicate assessments (each = an LLM call +
   * Jira comment). Returns true if THIS caller won the claim, false if another
   * already holds it. Fail-open on Redis error (return true) so a Redis outage
   * degrades to "assess anyway", never "silently drop".
   */
  static async claimAssessment(
    projectId: string,
    issueKey: string,
    statusId: string,
    ttlSeconds = JIRA_WEBHOOK_COOLDOWN_SECONDS,
  ): Promise<boolean> {
    const key = `qait:jira-webhook:assess:${projectId}:${issueKey}:${statusId}`;
    try {
      const result = await redisConnection.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      logger.warn('[JIRA_WEBHOOK] cooldown claim failed — proceeding (fail-open)', {
        issueKey, error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }
}
