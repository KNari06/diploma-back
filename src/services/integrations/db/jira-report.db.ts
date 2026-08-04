/**
 * Data-access for Jira issues filed from a test report. Query only, no logic.
 */

import { supabaseAdmin } from '@/db/supabase';

/**
 * Record the link between a run and the Jira issue filed for it.
 * Returns the Supabase error (or null) — the caller decides how loud to be.
 */
export async function insertTestJiraIssueLink(input: {
  testId: string;
  issueKey: string;
  issueUrl: string;
}): Promise<{ error: unknown | null }> {
  const { error } = await supabaseAdmin
    .from('test_jira_issues')
    .insert({
      test_id: input.testId,
      jira_issue_key: input.issueKey,
      jira_issue_url: input.issueUrl,
      created_at: new Date().toISOString(),
    });

  return { error };
}
