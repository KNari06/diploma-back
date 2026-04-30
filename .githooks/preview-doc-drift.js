#!/usr/bin/env node
/**
 * Doc-drift detector for the preview/replay subsystem.
 *
 * Reads the staged file list from git and warns when a hot service file is
 * staged without its sibling api/<service>.md (or when files in a hot folder
 * are staged without the folder's CLAUDE.md).
 *
 * Always exits 0 — never blocks the commit. Prints to stderr so the message
 * is visible in the terminal but doesn't interfere with tooling that captures
 * stdout.
 *
 * Maps live in .claude/hooks/doc-map.js (single source of truth).
 * Run `node .claude/hooks/validate-doc-maps.js` if you suspect drift between
 * the maps and the actual files.
 */

const { execSync } = require("child_process");
const path = require("path");

function loadMaps() {
  // We are at <repo>/.githooks/preview-doc-drift.js; require the shared map.
  const repoRoot = path.resolve(__dirname, "..");
  const docMapPath = path.join(repoRoot, ".claude", "hooks", "doc-map.js");
  try {
    return require(docMapPath);
  } catch (err) {
    process.stderr.write(`[githooks] failed to load ${docMapPath}: ${err.message}\n`);
    return { SERVICE_MAP: [], FOLDER_MAP: [] };
  }
}

function getStagedFiles() {
  try {
    const out = execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function bold(s) {
  return process.stderr.isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}
function yellow(s) {
  return process.stderr.isTTY ? `\x1b[33m${s}\x1b[0m` : s;
}
function dim(s) {
  return process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

function main() {
  const { SERVICE_MAP, FOLDER_MAP } = loadMaps();
  const staged = new Set(getStagedFiles());
  if (staged.size === 0) return;

  const warnings = [];
  const foldersWithSatisfiedService = new Set();

  // Service-level drift
  for (const [src, doc] of SERVICE_MAP) {
    if (!staged.has(src)) continue;
    const owningFolder = FOLDER_MAP.find(([f]) => src.includes(f));
    if (staged.has(doc)) {
      if (owningFolder) foldersWithSatisfiedService.add(owningFolder[0]);
      continue;
    }
    warnings.push({ kind: "service", src, doc });
    if (owningFolder) foldersWithSatisfiedService.add(owningFolder[0]);
  }

  // Folder-level drift (only when no mapped service in that folder produced
  // a warning or satisfied the doc constraint)
  for (const [folder, doc] of FOLDER_MAP) {
    if (foldersWithSatisfiedService.has(folder)) continue;
    if (staged.has(doc)) continue;
    const touchedAnyFile = [...staged].some((p) => p.startsWith(folder));
    if (!touchedAnyFile) continue;
    warnings.push({ kind: "folder", folder, doc });
  }

  if (warnings.length === 0) return;

  process.stderr.write("\n" + yellow(bold("⚠  preview/ doc-drift check — possibly stale docs:")) + "\n\n");
  for (const w of warnings) {
    if (w.kind === "service") {
      process.stderr.write(`  • ${bold(w.src)}\n`);
      process.stderr.write(`    changed but ${bold(w.doc)} is not staged.\n`);
    } else {
      process.stderr.write(`  • Files in ${bold(w.folder)}\n`);
      process.stderr.write(`    changed but ${bold(w.doc)} is not staged.\n`);
    }
  }
  process.stderr.write("\n");
  process.stderr.write(dim("  If your change qualifies (public method, signature, side-effect, invariant,\n"));
  process.stderr.write(dim("  constant, new WS event, renamed/removed file) — update the doc and\n"));
  process.stderr.write(dim("  re-stage it. See .claude/rules/structure.md for the full checklist.\n"));
  process.stderr.write(dim("  This is a warning only — your commit will proceed.\n\n"));
}

main();
