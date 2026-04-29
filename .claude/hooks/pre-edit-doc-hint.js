#!/usr/bin/env node
/**
 * PreToolUse hook for Edit/Write/MultiEdit.
 *
 * When Claude is about to edit a file in a documented hot zone, print a
 * reminder to stderr so the assistant sees the corresponding api doc and
 * folder CLAUDE.md before making changes.
 *
 * Two layers, in order of specificity:
 *   1. Service-level — editing <service>.ts → "check api/<service>.md".
 *   2. Folder-level  — editing anything in a hot folder → "check CLAUDE.md".
 *
 * Suppresses self-reminders when editing the doc itself.
 *
 * Always exits 0 — never blocks the edit.
 *
 * Maps live in ./doc-map.js (single source of truth). Run
 * `node .claude/hooks/validate-doc-maps.js` if you suspect drift.
 */

const fs = require("fs");
const { SERVICE_MAP, FOLDER_MAP } = require("./doc-map.js");

function main() {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const path = (payload.tool_input && payload.tool_input.file_path) || "";
  if (!path) return;

  // Don't remind when editing the doc itself.
  if (path.endsWith(".md")) return;

  for (const [src, doc] of SERVICE_MAP) {
    if (path.endsWith(src)) {
      process.stderr.write(
        `[structure] Editing ${src}\n` +
          `  → Read ${doc} first to see the documented public API and invariants.\n` +
          `  → If your change adds/renames/changes a public method, side-effect, invariant, or constant — update the API doc in this same change.\n`
      );
      return;
    }
  }

  for (const [folder, doc] of FOLDER_MAP) {
    if (path.includes(folder)) {
      process.stderr.write(
        `[structure] Editing a file in ${folder}\n` +
          `  → Check ${doc} for the folder map, hot flows, and invariants.\n` +
          `  → If your change qualifies (new service, WS event, invariant, renamed/removed file, behavior change) — update the doc in this same change.\n`
      );
      return;
    }
  }
}

main();
