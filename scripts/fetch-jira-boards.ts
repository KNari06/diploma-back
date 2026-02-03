/**
 * Fetch Jira board content - columns, issues, tasks per column.
 * Requires at least one user with Jira connected.
 *
 * Usage: npx ts-node -r tsconfig-paths/register scripts/fetch-jira-boards.ts [boardId]
 *        boardId defaults to first board from list
 */

import { supabaseAdmin } from '../src/db/supabase';
import {
  ensureValidToken,
  getJiraBoards,
  getBoardConfiguration,
  getBoardIssues,
  getJiraStatuses,
  getProjectStatuses,
} from '../src/services/api/jira.service';

async function main(): Promise<void> {
  const boardIdArg = process.argv[2];

  const { data: tokenRow, error } = await supabaseAdmin
    .from('jira_tokens')
    .select('user_id, cloud_id, access_token, refresh_token, expires_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !tokenRow) {
    console.error('No Jira token found. Connect Jira first via OAuth.');
    process.exit(1);
  }

  const accessToken = await ensureValidToken(tokenRow as any);
  const cloudId = tokenRow.cloud_id;

  let boardId = boardIdArg ? Number(boardIdArg) || boardIdArg : null;
  if (!boardId) {
    const boards = await getJiraBoards(accessToken, cloudId);
    if (boards.length === 0) {
      console.error('No boards found.');
      process.exit(1);
    }
    boardId = boards[0].id;
    console.log(`Using board: ${boards[0].name} (id=${boardId})\n`);
  }

  let columns: { name: string; statusNames: string[] }[] = [];
  try {
    const [config, statusMap] = await Promise.all([
      getBoardConfiguration(accessToken, cloudId, boardId),
      getJiraStatuses(accessToken, cloudId),
    ]);
    columns = (config.columns || []).map((col) => {
      const statusNames = (col.statuses || [])
        .map((s) => statusMap[s.id] ?? s.id)
        .filter(Boolean);
      return {
        name: col.name ?? '',
        statusNames: statusNames.length > 0 ? statusNames : [col.name ?? ''],
      };
    });
  } catch {
    console.warn('Board config unavailable (scope?), using project statuses\n');
  }

  const { issues, total } = await getBoardIssues(accessToken, cloudId, boardId, 0, 100);
  const projectKey = issues[0]?.project?.key ?? (boardId === 2 ? 'KAN' : 'SAM1');
  if (columns.length === 0 && projectKey) {
    const statusNames = await getProjectStatuses(accessToken, cloudId, projectKey);
    for (const name of statusNames) {
      columns.push({ name, statusNames: [name] });
    }
  }
  const statusNamesInColumns = new Set(columns.flatMap((c) => c.statusNames));
  for (const issue of issues) {
    const sn = issue.status?.name;
    if (sn && !statusNamesInColumns.has(sn)) {
      columns.push({ name: sn, statusNames: [sn] });
      statusNamesInColumns.add(sn);
    }
  }

  const columnsWithIssues = columns.map((col) => ({
    ...col,
    issues: issues.filter((i) => col.statusNames.includes(i.status?.name ?? '')),
  }));

  console.log('=== Board content: columns + issues per column ===');
  console.log(JSON.stringify({ columns: columnsWithIssues, total }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
