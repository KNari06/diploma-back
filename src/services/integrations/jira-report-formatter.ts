/**
 * Presentation layer for Jira issues filed from a test report.
 *
 * Pure functions only — no network, no DB, no auth. Everything here turns a
 * `FinalTestReport` (or a fix-prompt string) into an Atlassian Document
 * Format document. Kept separate from `JiraReportService` so the ADF
 * shape can be unit-tested without a Jira connection, and so the service stays
 * orchestration.
 */

import type { AdfDoc } from '@/services/api/jira.service';
import type { FinalTestReport } from '@/types';

/** The issue description, in ADF. */
export function buildDescriptionADF(report: FinalTestReport): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: '🤖 Automated Test Report' }],
      },
      {
        type: 'panel',
        attrs: { panelType: 'info' },
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Test ID: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: report.testId },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'URL: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: report.testUrl },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Status: ', marks: [{ type: 'strong' }] },
              { type: 'text', text: report.status.toUpperCase() },
            ],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: `🐛 Bugs Found: ${report.summary.bugsFound}` }],
      },
      ...report.analysis.bugs.map((bug, i) => ({
        type: 'panel',
        attrs: { panelType: bug.severity === 'critical' || bug.severity === 'high' ? 'error' : 'warning' },
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: `${i + 1}. `, marks: [{ type: 'strong' }] },
              { type: 'text', text: `[${bug.severity.toUpperCase()}] ${bug.message}` },
            ],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Type: ', marks: [{ type: 'strong' }] },
                      { type: 'text', text: bug.type },
                    ],
                  },
                ],
              },
              ...(bug.selector
                ? [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [
                            { type: 'text', text: 'Selector: ', marks: [{ type: 'strong' }] },
                            { type: 'text', text: bug.selector, marks: [{ type: 'code' }] },
                          ],
                        },
                      ],
                    },
                  ]
                : []),
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Fix: ', marks: [{ type: 'strong' }] },
                      { type: 'text', text: bug.recommendation },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })),
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: '🎬 Artifacts' }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `📹 Video: ${report.artifacts.video ? 'Available (see attachments)' : 'Not recorded'}` },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `📊 Trace: ${report.artifacts.trace ? 'Available (see attachments)' : 'Not available'}` },
        ],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `📸 Screenshots: ${report.artifacts.screenshots.length} attached` },
        ],
      },
    ],
  };
}

/**
 * Comment carrying the generated Playwright code.
 * Returns null when there is no code, because ADF rejects an empty text node.
 */
export function buildCodeCommentADF(code: string): AdfDoc | null {
  if (!code?.trim()) return null;

  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: '🧪 Generated Playwright Test Code' }],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: code }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'This code was automatically generated from the test execution. Copy and use it in your test suite.',
            marks: [{ type: 'em' }],
          },
        ],
      },
    ],
  };
}

/**
 * Comment carrying the developer fix prompt — the markdown a developer pastes
 * into an AI coding assistant to fix the bug this issue was filed for.
 *
 * Posted as its own comment rather than folded into the description so the
 * markdown survives verbatim in a code block (ADF paragraphs would mangle it)
 * and can be copied in one action.
 *
 * The code block deliberately carries NO `attrs.language`: the prompt is
 * markdown, and `attrs` is optional in ADF, so omitting it avoids Jira
 * rejecting an unrecognized language identifier.
 *
 * Returns null for an absent or blank prompt — ADF rejects an empty text node,
 * which would turn a best-effort comment into a 400.
 *
 * NOT truncated here: `DeveloperFixPromptService` already caps the markdown at
 * its own limit and appends an ellipsis, so a second slice would only strip
 * that marker.
 */
export function buildFixPromptCommentADF(fixPrompt: string | undefined): AdfDoc | null {
  const prompt = fixPrompt?.trim();
  if (!prompt) return null;

  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: '🛠 Developer fix prompt' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Paste this into your AI coding assistant (Copilot, Cursor, Claude) to fix the bug above.',
            marks: [{ type: 'em' }],
          },
        ],
      },
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: prompt }],
      },
    ],
  };
}
