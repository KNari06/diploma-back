#!/usr/bin/env node
/**
 * Stop hook: after the assistant finishes a turn, scan the transcript for
 * Edit/Write/MultiEdit tool calls in hot folders or hot service files. If a
 * hot file was edited but its sibling doc was NOT, print a reminder to
 * stderr.
 *
 * Two layers, in order of specificity:
 *   1. Service-level — touched <service>.ts but not api/<service>.md.
 *   2. Folder-level  — touched a file in a hot folder but not CLAUDE.md.
 *
 * If a service-level reminder fires (or its api doc was touched), the
 * folder-level reminder is suppressed for that folder — the user is plainly
 * already aware they're working on documented code.
 *
 * Always exits 0 — never blocks the assistant.
 *
 * Maps live in ./doc-map.js (single source of truth).
 */

const fs = require("fs");
const { SERVICE_MAP, FOLDER_MAP } = require("./doc-map.js");

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
  const foldersWithSatisfiedService = new Set();

  // Service-level checks
  for (const [tsFile, apiDoc] of SERVICE_MAP) {
    const touchedTs = editedPaths.some((p) => p.endsWith(tsFile));
    if (!touchedTs) continue;
    const touchedDoc = editedPaths.some((p) => p.endsWith(apiDoc));
    const owningFolder = FOLDER_MAP.find(([folder]) => tsFile.includes(folder));

    if (touchedDoc) {
      if (owningFolder) foldersWithSatisfiedService.add(owningFolder[0]);
      continue;
    }

    reminders.push(
      `[structure] You edited ${tsFile} this turn but did not update ${apiDoc}. ` +
        `If a public method was added/renamed/changed signature, side-effect changed, new invariant, or constant value changed — update the API doc in this same turn.`
    );
    if (owningFolder) foldersWithSatisfiedService.add(owningFolder[0]);
  }

  // Folder-level checks
  for (const [folder, doc] of FOLDER_MAP) {
    const touchedFolder = editedPaths.some((p) => p.includes(folder));
    if (!touchedFolder) continue;
    const touchedDoc = editedPaths.some((p) => p.includes(doc));
    if (touchedDoc) continue;
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
