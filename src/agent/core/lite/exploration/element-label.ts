/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ELEMENT LABEL — recovering a human name from a discovered step
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A snapshot `ref` (`e7`, `e12`) identifies an element only WITHIN the snapshot
 * that produced it. It is meaningless to a person reading a test case, and it
 * does not survive a re-render, so it must never be the label a user sees.
 *
 * The positive step already carries the real name: `CommandExecutor` writes
 * `Clicked "Sign in" (button)` into the command output, and the step extractor
 * stores that as the step's `description`. So the name can be recovered from
 * the step we are deriving from, rather than invented or looked up again.
 */

/** Matches `Clicked "Sign in" (button)` → `Sign in`. */
const QUOTED = /"([^"]+)"/;

/** `e7`, `E12` — a snapshot ref, never a real element name. */
const EPHEMERAL_REF = /^e\d+$/i;

/**
 * Pull the human-readable element name out of a step description.
 *
 * Returns undefined when the description carries no name, or carries only an
 * ephemeral ref — callers should fall back to a generic noun ("submit button")
 * rather than print `e7`.
 */
export function extractElementLabel(description?: string): string | undefined {
  const match = QUOTED.exec(description ?? '');
  const name = match?.[1]?.trim();
  if (!name || EPHEMERAL_REF.test(name)) return undefined;
  return name;
}

/**
 * The label to show for an element, given the step it came from.
 *
 * `fallback` is a generic description of the element's role, used when no real
 * name is recoverable — "submit button" tells a reader more than `e7` does.
 */
export function elementLabelOr(description: string | undefined, fallback: string): string {
  return extractElementLabel(description) ?? fallback;
}
