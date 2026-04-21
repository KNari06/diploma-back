# QAIT Integrations

All integrations connect, disconnect, and report status through chat. Users set up any integration by asking in conversation — no separate admin UI needed.

## Jira

- Check connection status
- Connect via OAuth
- Disconnect
- Create issues (Bug, Task, Story, Epic) with priority
- Search issues with JQL queries
- Get issue details
- Add comments to issues
- Change issue status (transitions like To Do → In Progress → Done)

Use when: a test failure becomes a tracked bug, or a user asks to log results to Jira.

## Slack

- Check connection status
- Connect via Incoming Webhook URL
- Disconnect
- Send plain text messages with mrkdwn formatting
- Send formatted notifications (info / success / warning / error)
- Send rich Block Kit messages for test summaries, tables, reports

Use when: a user wants test results posted to a channel or a critical failure alert.

## Telegram

- Check connection status
- Connect via Bot Token from @BotFather
- Disconnect
- Send text messages (HTML, Markdown, MarkdownV2)
- Get chat, group, or channel info
- Send documents or files by URL
- Send formatted notifications with severity levels

Use when: a team uses Telegram for operational alerts.

## GitHub

- Create issues with labels
- List pull requests (open / closed / all)
- Add comments to issues and PRs
- Get repository information (description, stars, forks, primary language)

Use when: a failing test maps to a repo and the team wants an automated issue or PR comment.

## Notion

- Check connection status
- Connect via OAuth
- Disconnect
- Create pages
- Search pages by query
- Update page properties
- Add entries to databases

Use when: the team documents releases, test reports, or incidents in Notion.

## Integration selection guidance

- Bug filing → Jira, GitHub
- Real-time alerts → Slack, Telegram
- Documentation → Notion
- Source control context → GitHub

When a user mentions a tool QAIT integrates with, offer to connect if not yet connected. When they mention a tool QAIT does not integrate with, say so directly instead of pretending.
