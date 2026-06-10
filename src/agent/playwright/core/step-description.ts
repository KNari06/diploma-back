/**
 * Build the human-readable step description that gets persisted and shown in
 * the run report's steps timeline.
 *
 * Historically the executor used `intentMeta?.elementDescription || action`, but
 * `elementDescription` is never populated on the regression/editor path, so it
 * always collapsed to the bare action verb (`goto`, `click`, `type`) with no
 * target — leaving the report useless ("goto" with nothing else).
 *
 * Preference order (first non-empty wins):
 *   1. elementDescription   — element-level NL descriptor (set by some flows)
 *   2. intentDescription    — the user's full intent text (e.g. "Click Sign in")
 *   3. command.description  — converter's plain-text description ("Navigate to …")
 *   4. action + target      — composed fallback: verb + url/value/selector
 *      so even an un-described step reads as `click #submit` / `goto https://…`.
 *
 * Kept in its own dependency-free module so it is trivially unit-testable
 * without importing the heavy Playwright executor module graph.
 */
export function composeStepDescription(command: unknown, action: string): string {
  const c = (command || {}) as {
    description?: string;
    url?: string;
    value?: string;
    selector?: string;
    intentMeta?: { elementDescription?: string; intentDescription?: string };
  };
  const meta = c.intentMeta || {};
  const fromMeta = meta.elementDescription || meta.intentDescription || c.description;
  if (fromMeta && fromMeta.trim()) return fromMeta.trim();

  const target = c.url || c.value || c.selector;
  return target ? `${action} ${target}` : action;
}
