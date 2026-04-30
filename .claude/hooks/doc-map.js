/**
 * Single source of truth for doc-drift hooks.
 *
 * Used by:
 *   - .claude/hooks/pre-edit-doc-hint.js  (Claude PreToolUse)
 *   - .claude/hooks/check-claudemd-updated.js  (Claude Stop)
 *   - .githooks/preview-doc-drift.js  (git pre-commit, requires repo-relative require)
 *
 * Paths are repo-root-relative (POSIX).
 *
 * To add a new mapping:
 *   - Service-level: append to SERVICE_MAP.
 *   - Folder-level:  append to FOLDER_MAP.
 *
 * Run `node .claude/hooks/validate-doc-maps.js` after editing this file
 * to verify every referenced file still exists.
 */

// service file → sibling api doc
const SERVICE_MAP = [
  ["src/services/testing/ui/preview/preview-step-apply.service.ts", "src/services/testing/ui/preview/api/preview-step-apply.md"],
  ["src/services/testing/ui/preview/preview-run.service.ts",        "src/services/testing/ui/preview/api/preview-run.md"],
  ["src/services/testing/ui/preview/recording-capture.service.ts",  "src/services/testing/ui/preview/api/recording-capture.md"],
  ["src/services/testing/ui/preview/element-resolver.service.ts",   "src/services/testing/ui/preview/api/element-resolver.md"],
  ["src/services/testing/ui/preview/intent-step-lint.service.ts",   "src/services/testing/ui/preview/api/intent-step-lint.md"],
  ["src/services/testing/ui/preview/locator-plan-builder.service.ts", "src/services/testing/ui/preview/api/locator-plan-builder.md"],
  ["src/services/testing/ui/preview/step-readiness.service.ts",     "src/services/testing/ui/preview/api/step-readiness.md"],
  ["src/services/testing/ui/preview/dom-analysis-extractor.service.ts", "src/services/testing/ui/preview/api/dom-analysis-extractor.md"],
  ["src/services/testing/ui/preview/preview-session.service.ts",    "src/services/testing/ui/preview/api/preview-session.md"],
  ["src/websocket/handlers/preview.handler.ts",                     "src/services/testing/ui/preview/api/preview-handler.md"],
];

// folder prefix → folder-level CLAUDE.md
const FOLDER_MAP = [
  ["src/services/testing/ui/preview/", "src/services/testing/ui/preview/CLAUDE.md"],
];

module.exports = { SERVICE_MAP, FOLDER_MAP };
