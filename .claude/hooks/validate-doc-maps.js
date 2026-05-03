#!/usr/bin/env node
/**
 * Self-check for the doc-drift maps in doc-map.js.
 *
 * For every entry in SERVICE_MAP and FOLDER_MAP:
 *   - the .ts source file exists
 *   - the .md doc file exists
 *
 * Also checks that markdown links in folder CLAUDE.md files referencing
 * api/*.md and ../<service>.ts resolve to real files.
 *
 * Prints warnings to stderr; never blocks. Exits 0 unless --strict is passed
 * (in which case exits 1 if any warning was emitted — useful in CI).
 *
 * Usage:
 *   node .claude/hooks/validate-doc-maps.js          # warn-only, exit 0
 *   node .claude/hooks/validate-doc-maps.js --strict # CI mode, exit 1 on issue
 */

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const { SERVICE_MAP, FOLDER_MAP } = require("./doc-map.js");

const strict = process.argv.includes("--strict");

function exists(rel) {
  return fs.existsSync(path.join(REPO, rel));
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

function checkLinksInClaudeMd(folder, claudeMdRel) {
  const issues = [];
  const claudeMdPath = path.join(REPO, claudeMdRel);
  if (!fs.existsSync(claudeMdPath)) return issues;

  const text = fs.readFileSync(claudeMdPath, "utf8");
  const folderAbs = path.dirname(claudeMdPath);

  // Find markdown links of form [label](relative/path) — limited to .md and .ts targets
  // we care about. Skip http(s):, anchor-only (#...), and external links.
  const linkRe = /\]\(([^)]+)\)/g;
  let m;
  const seen = new Set();
  while ((m = linkRe.exec(text)) !== null) {
    let target = m[1].trim();
    // Strip optional title: [label](path "title")
    target = target.split(/\s+/)[0];
    // Skip URLs and anchors
    if (/^[a-z]+:/i.test(target)) continue;
    if (target.startsWith("#")) continue;
    // Strip line anchors (file.ts:42 or file.md#section)
    target = target.split("#")[0].split(":")[0];
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);

    // Only validate links to .md, .ts, .js, .json — text/code refs.
    if (!/\.(md|ts|tsx|js|json)$/.test(target)) continue;

    const resolved = path.resolve(folderAbs, target);
    if (!fs.existsSync(resolved)) {
      const relFromRepo = path.relative(REPO, resolved);
      issues.push({ doc: claudeMdRel, target, resolved: relFromRepo });
    }
  }
  return issues;
}

function main() {
  const issues = [];

  // Service-level
  for (const [src, doc] of SERVICE_MAP) {
    if (!exists(src)) issues.push({ kind: "missing-source", src, doc });
    if (!exists(doc)) issues.push({ kind: "missing-doc", src, doc });
  }

  // Folder-level
  for (const [folder, doc] of FOLDER_MAP) {
    const folderAbs = path.join(REPO, folder);
    if (!fs.existsSync(folderAbs)) issues.push({ kind: "missing-folder", folder, doc });
    if (!exists(doc)) issues.push({ kind: "missing-folder-doc", folder, doc });
  }

  // Cross-link checks inside each folder CLAUDE.md
  const linkIssues = [];
  for (const [folder, doc] of FOLDER_MAP) {
    if (!exists(doc)) continue;
    linkIssues.push(...checkLinksInClaudeMd(folder, doc));
  }
  // And inside each api/<service>.md (relative paths are common there too)
  for (const [, doc] of SERVICE_MAP) {
    if (!exists(doc)) continue;
    linkIssues.push(...checkLinksInClaudeMd(path.dirname(doc) + "/", doc));
  }

  if (issues.length === 0 && linkIssues.length === 0) {
    if (!strict) {
      process.stdout.write("✓ doc-map check passed — all source files, docs, and cross-links resolve.\n");
    }
    return 0;
  }

  process.stderr.write("\n" + yellow(bold("⚠  doc-map drift:")) + "\n\n");

  for (const issue of issues) {
    if (issue.kind === "missing-source") {
      process.stderr.write(`  • ${bold(issue.src)} ${dim("(SERVICE_MAP source)")}\n`);
      process.stderr.write(`    file no longer exists. Doc ${issue.doc} may be orphaned.\n`);
      process.stderr.write(`    → if you renamed the source, update SERVICE_MAP in .claude/hooks/doc-map.js.\n`);
      process.stderr.write(`    → if you deleted the source, also delete or repurpose the api doc.\n\n`);
    } else if (issue.kind === "missing-doc") {
      process.stderr.write(`  • ${bold(issue.doc)} ${dim("(SERVICE_MAP doc)")}\n`);
      process.stderr.write(`    api doc no longer exists. Source ${issue.src} is now uncovered.\n`);
      process.stderr.write(`    → restore the doc, or remove the entry from SERVICE_MAP.\n\n`);
    } else if (issue.kind === "missing-folder") {
      process.stderr.write(`  • ${bold(issue.folder)} ${dim("(FOLDER_MAP folder)")}\n`);
      process.stderr.write(`    folder no longer exists.\n`);
      process.stderr.write(`    → update FOLDER_MAP in .claude/hooks/doc-map.js.\n\n`);
    } else if (issue.kind === "missing-folder-doc") {
      process.stderr.write(`  • ${bold(issue.doc)} ${dim("(FOLDER_MAP doc)")}\n`);
      process.stderr.write(`    folder CLAUDE.md no longer exists.\n`);
      process.stderr.write(`    → restore the doc, or remove the entry from FOLDER_MAP.\n\n`);
    }
  }

  if (linkIssues.length > 0) {
    process.stderr.write(yellow(bold("⚠  broken markdown links:")) + "\n\n");
    for (const li of linkIssues) {
      process.stderr.write(`  • ${bold(li.doc)} → ${li.target}\n`);
      process.stderr.write(`    resolved to ${li.resolved} (does not exist)\n\n`);
    }
  }

  return strict ? 1 : 0;
}

process.exit(main());
