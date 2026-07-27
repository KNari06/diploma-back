/**
 * Data-access for the Jira webhook: find the QAIT project(s) configured to
 * auto-assess a given Jira project key. Query + row mapping only.
 */

import { supabaseAdmin } from '@/db/supabase';

export interface JiraWebhookProjectRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  jira: {
    projectKey?: string;
    qaTriggerStatuses?: Array<{ id?: string; name?: string }>;
    /** @deprecated legacy single trigger-column name — still honored. */
    qaColumnName?: string;
    webhookSecret?: string;
    [key: string]: unknown;
  };
}

/**
 * The Jira site host(s) a user's tokens are bound to (from integration_tokens
 * external_url, e.g. "acme.atlassian.net"). Used to verify a webhook event's
 * site matches the project owner's connection. Empty array if none / on error.
 */
export async function getOwnerJiraSiteHosts(userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('integration_tokens')
      .select('external_url')
      .eq('user_id', userId)
      .eq('provider', 'jira')
      .eq('enabled', true);
    if (error) return [];
    const hosts: string[] = [];
    for (const row of data || []) {
      const u = (row as any)?.external_url;
      if (typeof u !== 'string' || !u) continue;
      try { hosts.push(new URL(u).host.toLowerCase()); } catch { /* skip unparseable */ }
    }
    return hosts;
  } catch {
    return [];
  }
}

/** Effective trigger statuses: new array + legacy name-only entry, de-duped. */
export function effectiveTriggerStatuses(jira: JiraWebhookProjectRow['jira']): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const push = (id?: string, name?: string) => {
    const i = (id || '').trim();
    const n = (name || '').trim();
    if (!i && !n) return;
    const key = i || n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: i, name: n });
  };
  for (const s of jira.qaTriggerStatuses || []) push(s?.id, s?.name);
  if (jira.qaColumnName) push('', jira.qaColumnName);
  return out;
}

/**
 * Return projects whose settings.integrations.jira.projectKey matches the given
 * Jira project key AND that have BOTH qaColumnName and webhookSecret set
 * (auto-assess is opt-in). Filtered in-DB by projectKey via JSONB path, then
 * the caller confirms cloud_id + secret. Owner-scoped fields returned for the
 * assessment run identity.
 */
export async function findProjectsForJiraKey(projectKey: string): Promise<JiraWebhookProjectRow[]> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, user_id, workspace_id, settings')
    .eq('settings->integrations->jira->>projectKey', projectKey);

  if (error) throw error;

  return (data || [])
    .map((row: any) => {
      const jira = row.settings?.integrations?.jira || {};
      return {
        id: row.id,
        user_id: row.user_id,
        workspace_id: row.workspace_id ?? null,
        jira,
      } as JiraWebhookProjectRow;
    })
    // Auto-assess is active only when a secret AND at least one trigger status exist.
    .filter((r) => !!r.jira.webhookSecret && effectiveTriggerStatuses(r.jira).length > 0);
}
