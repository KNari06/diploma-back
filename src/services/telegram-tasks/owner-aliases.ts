/**
 * Owner aliasing. The same person appears under several names — the @username
 * used in the digest (@bekn_ur) and nicknames used in chat (Beka). Without a map
 * the bot treats them as different people, so a nickname report never closes the
 * @username's task. This canonicalizes any owner string to the @username.
 *
 * Config via env.TELEGRAM_TASK_ALIASES (semicolon-separated groups,
 * "canonical = alias, alias"):
 *   TELEGRAM_TASK_ALIASES=@bekn_ur = Beka, bekn_ur; @ndarkhans = Dara
 * Canonical may be written with or without @; aliases match case-insensitively
 * and ignore a leading @.
 */
import { env } from '@/config/environment/env';

function norm(s: string): string {
  return s.trim().replace(/^@/, '').toLowerCase();
}

// alias(normalized) -> canonical "@username"
const aliasToCanonical = new Map<string, string>();

function load(): void {
  aliasToCanonical.clear();
  const raw = env.TELEGRAM_TASK_ALIASES;
  if (!raw) return;
  for (const group of raw.split(';')) {
    const [canonicalRaw, ...aliasParts] = group.split('=');
    if (!canonicalRaw || aliasParts.length === 0) continue;
    const canonicalUser = canonicalRaw.trim().replace(/^@/, '');
    if (!canonicalUser) continue;
    const canonical = `@${canonicalUser}`;
    aliasToCanonical.set(norm(canonicalUser), canonical); // canonical is an alias of itself
    for (const alias of aliasParts.join('=').split(',')) {
      const key = norm(alias);
      if (key) aliasToCanonical.set(key, canonical);
    }
  }
}
load();

/** Resolve an owner string to its canonical @username, or return it unchanged
 *  (trimmed) if no alias is configured. null/empty passes through. */
export function canonicalOwner(owner: string | null | undefined): string | null {
  if (!owner) return null;
  const hit = aliasToCanonical.get(norm(owner));
  return hit ?? owner.trim();
}

/** A human-readable "X = also known as a, b" block for the LLM prompt, so the
 *  model maps nicknames to the right @username when reading chat. '' if none. */
export function aliasHint(): string {
  if (aliasToCanonical.size === 0) return '';
  const byCanonical = new Map<string, Set<string>>();
  for (const [alias, canonical] of aliasToCanonical) {
    if (norm(canonical) === alias) continue; // skip the self-entry
    (byCanonical.get(canonical) ?? byCanonical.set(canonical, new Set()).get(canonical)!).add(alias);
  }
  if (byCanonical.size === 0) return '';
  const lines = [...byCanonical.entries()].map(
    ([canonical, aliases]) => `  ${canonical} is also called: ${[...aliases].join(', ')}`,
  );
  return 'KNOWN PEOPLE (use the @username as owner regardless of which name appears):\n' + lines.join('\n');
}

/** Set of manager @usernames (lowercase, no @) allowed to close/reopen anyone's
 *  task. From env.TELEGRAM_TASK_MANAGERS (comma-separated). */
const managers = new Set(
  (env.TELEGRAM_TASK_MANAGERS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean),
);

export function isManagerUsername(username: string | undefined): boolean {
  if (!username) return false;
  return managers.has(username.replace(/^@/, '').toLowerCase());
}
