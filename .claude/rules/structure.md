# Structure & Documentation Rules

## CLAUDE.md hierarchy

The repo has a layered navigation map:
- `/CLAUDE.md` — root map. Always loaded. ~300 lines, points to subfolders.
- `<hot folder>/CLAUDE.md` — auto-loaded when working in that folder. Detailed file table, flows, invariants.

Current per-folder docs:
- `src/services/testing/ui/preview/CLAUDE.md` — editor / preview / replay / recording (navigation map)
- `src/services/testing/ui/preview/api/<service>.md` — per-service API reference (one file per major service)

Folders that should get a CLAUDE.md when next touched (>8 files, frequent edits):
- `src/agent/core/lite/` — LiteEngine + multi-agent
- `src/services/ai/` — LLM clients + intent + cost
- `src/ai/prompts/` — prompt builders
- `src/jobs/` — BullMQ handlers
- `src/api/` — REST controllers
- `src/websocket/` — WS handlers

## When to update a CLAUDE.md

After making a code change, update the relevant doc **in the same change** if any of:

### CLAUDE.md (navigation map)
1. **New top-level service or class** in a documented folder → add a row.
2. **New WebSocket event** or **new REST route** → update events list / hot flow.
3. **New invariant** ("never do X here", "always pass through Y") → add under "Invariants".
4. **Renamed / moved / deleted file** referenced in any CLAUDE.md → update or remove reference.
5. **New baseline / milestone** (V-something) → append to recent baselines.
6. **Behavior change of a documented flow** → fix the flow description.

### `api/<service>.md` (per-method reference) — when editing a service that has one
1. **Public method added / removed / renamed** → add/remove/rename the section.
2. **Method signature changed** (params, return type) → update the signature block.
3. **Side-effect changed** (new WS emit, new DB write, new throw) → update the side-effects/throws bullets.
4. **New invariant or gotcha discovered** → add under "Invariants / gotchas".
5. **Constant value changed** (timeout, threshold, debounce) → update the constants table.

If unsure — err on the side of updating. A wrong doc is worse than a thin one because it actively misleads.

## When NOT to update

- Renamed an internal helper that nobody references in CLAUDE.md.
- Refactored implementation without changing exports / behavior.
- Added a private method to an already-listed service.
- Bug fix that doesn't change the contract.

## Format rules for CLAUDE.md files

- **Per-folder file** caps at ~400 lines. Past that, split into sub-folder CLAUDE.md files.
- **File tables**: `| file | purpose | key exports |`. One line per file. No prose paragraphs replacing tables.
- **Flows**: pseudocode with `→` arrows. No code blocks longer than ~15 lines.
- **Invariants**: numbered list. State the rule first, then *why* in the same sentence.
- **Link to actual files** with markdown links — `[name](relative/path.ts)` — so users can click through.
- **No dates in file headers.** Git log is the source of truth for "when". Mention dates only in explicit milestone sections.

## Memory vs CLAUDE.md

- **Code facts** (where things live, how flows wire up, invariants) → CLAUDE.md, evolves with PRs.
- **User/project facts** (preferences, incidents, decisions, who-said-what) → `~/.claude/projects/.../memory/`, persists across sessions.

If you find code-shaped knowledge in memory, move it to the right CLAUDE.md and remove from memory.

## When CLAUDE.md goes stale

If you read a CLAUDE.md statement and the actual code disagrees:
1. Trust the code.
2. Fix the CLAUDE.md in the same response (don't defer).
3. If the deviation is large (whole flow rewritten), tell the user — they may want to do a deeper audit.
