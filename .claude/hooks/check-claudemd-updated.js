#!/usr/bin/env node
/**
 * Stop hook: after the assistant finishes a turn, scan the transcript for
 * Edit/Write tool calls in hot folders or hot service files. If a hot file
 * was edited but its sibling doc was NOT, print a reminder to stderr.
 *
 * Two layers:
 *   1. Folder-level — touched <folder>/<file> but not <folder>/CLAUDE.md.
 *   2. Service-level — touched <folder>/<service>.ts but not <folder>/api/<service>.md.
 *
 * Hook contract: receives JSON on stdin with { transcript_path, ... }.
 * Writing to stderr surfaces the message to the assistant. Always exit 0.
 *
 * Add a hot folder by appending to FOLDER_MAP.
 * Add a hot service file by appending to SERVICE_MAP.
 */

const fs = require("fs");

// Folder-level: editing anywhere in the folder triggers a reminder for CLAUDE.md.
const FOLDER_MAP = [
  ["src/services/testing/ui/preview/", "src/services/testing/ui/preview/CLAUDE.md"],
];

// Service-level: editing the .ts file triggers a reminder for api/<service>.md.
const SERVICE_MAP = [
  ["src/services/testing/ui/preview/preview-step-apply.service.ts", "src/services/testing/ui/preview/api/preview-step-apply.md"],
  ["src/services/testing/ui/preview/preview-run.service.ts", "src/services/testing/ui/preview/api/preview-run.md"],
  ["src/services/testing/ui/preview/recording-capture.service.ts", "src/services/testing/ui/preview/api/recording-capture.md"],
  ["src/services/testing/ui/preview/element-resolver.service.ts", "src/services/testing/ui/preview/api/element-resolver.md"],
  ["src/services/testing/ui/preview/intent-step-lint.service.ts", "src/services/testing/ui/preview/api/intent-step-lint.md"],
  ["src/services/testing/ui/preview/locator-plan-builder.service.ts", "src/services/testing/ui/preview/api/locator-plan-builder.md"],
  ["src/services/testing/ui/preview/step-readiness.service.ts", "src/services/testing/ui/preview/api/step-readiness.md"],
  ["src/services/testing/ui/preview/dom-analysis-extractor.service.ts", "src/services/testing/ui/preview/api/dom-analysis-extractor.md"],
  ["src/services/testing/ui/preview/preview-session.service.ts", "src/services/testing/ui/preview/api/preview-session.md"],
  ["src/websocket/handlers/preview.handler.ts", "src/services/testing/ui/preview/api/preview-handler.md"],
];

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readTranscript(path) {
  if (!path || !fs.existsSync(path)) return [];
  try {
    return fs
      .readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectEditedPaths(events) {
  const paths = new Set();
  for (const ev of events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const name = block.name;
      if (name !== "Edit" && name !== "Write" && name !== "MultiEdit") continue;
      const fp = block.input?.file_path;
      if (typeof fp === "string" && fp.length > 0) paths.add(fp);
    }
  }
  return [...paths];
}

function main() {
  const raw = readStdin();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }

  const events = readTranscript(payload.transcript_path);
  if (events.length === 0) return;

  // Stop hooks fire on every assistant Stop. Only scan the current turn —
  // find the last user message and look at events after it.
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.message?.role === "user" || events[i]?.type === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const turnEvents = lastUserIdx >= 0 ? events.slice(lastUserIdx) : events;

  const editedPaths = collectEditedPaths(turnEvents);
  if (editedPaths.length === 0) return;

  const reminders = [];

  // Track which folders had at least one mapped service that was satisfied
  // (touched both .ts and api/<service>.md OR only the api doc), so the
  // folder-level reminder can be suppressed for those — the user is plainly
  // already aware they're working on documented code.
  const foldersWithSatisfiedService = new Set();

  // Service-level checks (most specific)
  for (const [tsFile, apiDoc] of SERVICE_MAP) {
    const touchedTs = editedPaths.some((p) => p.endsWith(tsFile));
    if (!touchedTs) continue;
    const touchedDoc = editedPaths.some((p) => p.endsWith(apiDoc));

    // Find the folder this service belongs to (if any in FOLDER_MAP)
    const owningFolder = FOLDER_MAP.find(([folder]) => tsFile.includes(folder));

    if (touchedDoc) {
      // Doc was updated — suppress folder reminder for this folder
      if (owningFolder) foldersWithSatisfiedService.add(owningFolder[0]);
      continue;
    }

    reminders.push(
      `[structure] You edited ${tsFile} this turn but did not update ${apiDoc}. ` +
        `If a public method was added/renamed/changed signature, side-effect changed, new invariant, or constant value changed — update the API doc in this same turn.`
    );
    // Service reminder counts as covering the folder concern too
    if (owningFolder) foldersWithSatisfiedService.add(owningFolder[0]);
  }

  // Folder-level checks (only fire when no mapped service for the folder was touched)
  for (const [folder, doc] of FOLDER_MAP) {
    const touchedFolder = editedPaths.some((p) => p.includes(folder));
    if (!touchedFolder) continue;
    const touchedDoc = editedPaths.some((p) => p.includes(doc));
    if (touchedDoc) continue;
    // Suppress if a service in this folder already produced a reminder OR
    // its service-level api doc was touched (intent signal).
    if (foldersWithSatisfiedService.has(folder)) continue;
    reminders.push(
      `[structure] You edited files in ${folder} this turn but did not update ${doc}. ` +
        `If your change qualifies (new service, new WS event, new invariant, renamed/removed file, behavior change of a documented flow — see .claude/rules/structure.md), update the doc in this same turn.`
    );
  }

  if (reminders.length > 0) {
    process.stderr.write(reminders.join("\n") + "\n");
  }
}

main();
