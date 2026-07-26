/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NAMED CREDENTIAL SECRET — resolve "the login the user named in chat" into
 * the two things iterative authoring needs:
 *
 *   1. `credentials`      — real VALUES, held in memory only, so the agent can
 *                           actually log in while authoring (without them it
 *                           fabricates or fails, and there is nothing to freeze)
 *   2. `credentialSecret` — key NAMES only, so each credential fill is frozen
 *                           as `{{secrets.<key>}}` and the saved test replays
 *                           against the encrypted store
 *
 * plus `valueToKey`, used to template a credential the app renders back into an
 * authored assertion.
 *
 * WHY BY NAME. The user says "use the demo login"; the LLM passes that NAME and
 * never a resource id. Resolution happens here, server-side, scoped to the
 * preview session's project and the caller's own `userId` — so a hallucinated
 * or hostile id cannot reach the store.
 *
 * FAILS CLOSED, ALWAYS. Unknown name, ambiguous name, ambiguous key→kind
 * mapping, or no password-shaped key all return an error instead of a guess.
 * Binding the wrong value into a password field is worse than not binding: the
 * test would type a real credential into the wrong app field.
 *
 * NEVER LOGS A VALUE. Every log line here carries key names, resource names and
 * counts only (test-resource invariant #2).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { CredentialKind } from '@/config/testing/credential-field-patterns';
import { KEY_RE as SECRET_KEY_RE } from '@/services/test-resource/adapters/secret.adapter';
import { listResources, loadDecrypted } from '@/services/test-resource/test-resource.service';
import { logger } from '@/utils/core/logger';
import type { CredentialSecretBinding } from './editor-iterative-author.service';

/** Credential values passed to the pipeline so the agent can log in live. */
export interface ResolvedCredentialValues {
  email?: string;
  username?: string;
  password: string;
  phone?: string;
}

export interface ResolvedNamedCredentialSecret {
  resourceId: string;
  resourceName: string;
  credentials: ResolvedCredentialValues;
  credentialSecret: CredentialSecretBinding;
  /**
   * Credential VALUE → secret key, for templating a value the app echoes back
   * into an authored assertion. Never persisted, never logged.
   */
  valueToKey: Map<string, string>;
}

export type NamedCredentialSecretFailure =
  | { reason: 'not_found'; availableNames: string[] }
  | { reason: 'ambiguous'; availableNames: string[] }
  | { reason: 'no_values'; availableNames: string[] }
  | { reason: 'no_password_key'; availableNames: string[]; keyNames: string[] }
  | { reason: 'ambiguous_password_key'; availableNames: string[]; collidingKeys: string[] };

export type NamedCredentialSecretResult =
  | ({ ok: true } & ResolvedNamedCredentialSecret)
  | ({ ok: false } & NamedCredentialSecretFailure);

/**
 * Strongest-first. A single key name routinely matches several sets —
 * `login_email` reads as both `username` ("login") and `email` — so
 * "first match wins" would classify the whole map as `username`. Precedence
 * resolves that deterministically: the most specific role a key can plausibly
 * be, wins.
 */
const KIND_PRECEDENCE: readonly CredentialKind[] = ['password', 'email', 'phone', 'username'];

/**
 * Key-name vocabulary — deliberately NOT `CREDENTIAL_FALLBACK_PATTERNS`.
 *
 * That dictionary is tuned for DOM field LABELS, where surrounding words give
 * context, and it is far too loose for a key-value store: its `password` list
 * contains the bare tokens `secret`, `code`, `pin` and `pass`. A `secret`
 * resource is this codebase's general-purpose store for API keys — the adapter
 * advertises "Stripe test keys, Twilio sandbox tokens" — so under that
 * dictionary `client_secret`, `otp_code` and `totp_secret` all read as
 * PASSWORDS, and (via substring matching) so does `shipping_address`, because
 * "shi-PPIN-g" contains `pin`.
 *
 * Two consequences, both observed: a real login carrying a TOTP seed
 * (`{login_email, login_password, totp_secret}` — the documented shape) has its
 * `password` kind claimed twice and DROPPED, so the agent tells the user their
 * login "has no password-like key (found: … login_password …)", which is false
 * and unactionable; and a lone API-key secret resolves as a login, so the agent
 * types a live key into the app's password field.
 *
 * So: an explicit, narrow vocabulary, matched on WORD BOUNDARIES rather than
 * substrings. Under-matching here is safe — the resolver fails closed and asks.
 */
const KEY_NAME_VOCABULARY: Record<CredentialKind, readonly string[]> = {
  password: ['password', 'passwd', 'pwd', 'pass', 'пароль', 'құпиясөз', 'şifre', 'parola', 'senha', 'contraseña', 'clave', 'hasło', 'passwort', 'kennwort', '密码', 'パスワード'],
  email: ['email', 'mail', 'e-mail', 'почта', 'емейл', 'eposta', 'correo', 'courriel', '邮箱'],
  phone: ['phone', 'tel', 'telephone', 'mobile', 'msisdn', 'телефон', 'номер', 'telefon', '电话'],
  // No bare `account`: `account_number` / `account_id` / `account_secret` are
  // common non-identity keys, and typing an account NUMBER into a login field
  // is the same misrouting this vocabulary exists to prevent.
  username: ['username', 'user', 'login', 'userid', 'логин', 'пользователь', 'kullanici', 'benutzer', 'usuario'],
};

/** Split a key into comparable word tokens: `login_email` → ['login','email']. */
function keyTokens(key: string): string[] {
  // camelCase must be split BEFORE lowercasing — otherwise `loginPassword` has
  // already become one indivisible token by the time we look for the boundary.
  return key
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((t) => t.split(/(?<=\p{Ll})(?=\p{Lu})/u))
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * Classify ONE secret key name into a credential kind, or null.
 *
 * A key matches a kind when one of its TOKENS is in that kind's vocabulary, so
 * `login_password` → password, `пароль` → password, but `shipping_address` and
 * `client_secret` → null.
 */
export function classifySecretKeyName(key: string): CredentialKind | null {
  const tokens = new Set(keyTokens(key));
  for (const kind of KIND_PRECEDENCE) {
    if (KEY_NAME_VOCABULARY[kind].some((word) => tokens.has(word))) return kind;
  }
  return null;
}

/**
 * How strongly a key claims its kind. An exact whole-key match (`password`)
 * beats a decorated one (`login_password`), which is what lets two claimants be
 * arbitrated instead of both being thrown away.
 */
function claimStrength(key: string, kind: CredentialKind): number {
  const lower = key.toLowerCase();
  if (KEY_NAME_VOCABULARY[kind].includes(lower)) return 2;
  return 1;
}

/**
 * Build kind → key from a secret's value map.
 *
 * Two keys claiming one kind are ARBITRATED by claim strength; only a genuine
 * tie is dropped, because dropping is user-visible as "this login has no
 * password" and a `secret` legitimately holds extra material next to the login.
 */
export function mapSecretKeysToKinds(keyNames: string[]): {
  byKind: Partial<Record<CredentialKind, string>>;
  droppedKinds: CredentialKind[];
  /** Keys that tied for a dropped kind — named in the failure message. */
  ambiguousKeys: Partial<Record<CredentialKind, string[]>>;
} {
  const claims = new Map<CredentialKind, string[]>();
  for (const key of keyNames) {
    // A key the secret adapter itself would reject can never round-trip into a
    // resolvable `{{secrets.<key>}}` — skip it rather than freeze a
    // placeholder that would be TYPED into the app under test.
    if (!SECRET_KEY_RE.test(key)) continue;
    const kind = classifySecretKeyName(key);
    if (!kind) continue;
    claims.set(kind, [...(claims.get(kind) ?? []), key]);
  }

  const byKind: Partial<Record<CredentialKind, string>> = {};
  const droppedKinds: CredentialKind[] = [];
  const ambiguousKeys: Partial<Record<CredentialKind, string[]>> = {};

  for (const [kind, keys] of claims) {
    if (keys.length === 1) {
      byKind[kind] = keys[0];
      continue;
    }
    const best = Math.max(...keys.map((k) => claimStrength(k, kind)));
    const winners = keys.filter((k) => claimStrength(k, kind) === best);
    if (winners.length === 1) byKind[kind] = winners[0];
    else {
      droppedKinds.push(kind);
      ambiguousKeys[kind] = winners;
    }
  }
  return { byKind, droppedKinds, ambiguousKeys };
}

/**
 * Resolve a user-spoken secret NAME into credentials + a binding.
 *
 * `projectId` MUST come from the preview session (server-derived), never from
 * the LLM's arguments.
 */
export async function resolveNamedCredentialSecret(params: {
  userId: string;
  projectId: string;
  name: string;
}): Promise<NamedCredentialSecretResult> {
  const { userId, projectId } = params;
  const wanted = params.name.trim().toLowerCase();

  const secrets = await listResources(userId, projectId, { kind: 'secret' });
  const availableNames = secrets.map((s) => s.name);

  const matches = secrets.filter((s) => s.name.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    return { ok: false, reason: 'not_found', availableNames };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', availableNames };
  }

  const summary = matches[0];
  const resource = await loadDecrypted(summary.id, userId);
  // `values` is declared sensitive, so `loadDecrypted` returns it under
  // `sensitive` and leaves `config` empty — reading `config.values` here is the
  // exact bug that made {{secrets.X}} silently never resolve (invariant #9 /
  // L-0031). Do not "helpfully" fall back to config.
  const rawValues = (resource?.sensitive as { values?: unknown } | undefined)?.values;
  const values: Record<string, string> = {};
  if (rawValues && typeof rawValues === 'object') {
    for (const [k, v] of Object.entries(rawValues as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) values[k] = v;
    }
  }

  const keyNames = Object.keys(values);
  if (keyNames.length === 0) {
    return { ok: false, reason: 'no_values', availableNames };
  }

  const { byKind, droppedKinds, ambiguousKeys } = mapSecretKeysToKinds(keyNames);
  if (droppedKinds.length > 0) {
    logger.warn('[NAMED_CREDENTIAL] Ambiguous key mapping — kinds dropped', {
      resourceId: summary.id,
      droppedKinds,
      keyNames,
    });
  }

  const passwordKey = byKind.password;
  if (!passwordKey) {
    // PipelineConfig.credentials requires a password, and a login the agent
    // cannot complete is worse than one it declines to attempt. Distinguish
    // "there is no password key" from "two keys both look like the password":
    // telling a user whose secret plainly contains `login_password` that it has
    // none is false, and following that advice cannot fix anything.
    if (ambiguousKeys.password) {
      return {
        ok: false, reason: 'ambiguous_password_key', availableNames,
        collidingKeys: ambiguousKeys.password,
      };
    }
    return { ok: false, reason: 'no_password_key', availableNames, keyNames };
  }

  // Mirror the executor's own cascade. `overrideCredentialFillValue` falls back
  // `username -> email -> phone`, but an `email`-classified FIELD has no
  // fallback: it fills only from `credentials.email` and otherwise leaves the
  // model's throwaway value in place, so the live login fails. A secret keyed
  // `{login, password}` on a form with `input[type=email]` is common enough
  // that not cascading here makes it unauthorable. Symmetric on both sides —
  // the freeze side already does `usernameKey ?? emailKey`.
  // One direction only: `email` needs the fallback, `username` already has one
  // in the executor (`username || email || phone`), so filling it here too
  // would be redundant.
  const emailKey = byKind.email ?? byKind.username;
  const credentials: ResolvedCredentialValues = { password: values[passwordKey] };
  if (emailKey) credentials.email = values[emailKey];
  if (byKind.username) credentials.username = values[byKind.username];
  if (byKind.phone) credentials.phone = values[byKind.phone];

  const credentialSecret: CredentialSecretBinding = {
    resourceId: summary.id,
    ...(byKind.password ? { passwordKey: byKind.password } : {}),
    ...(byKind.email ? { emailKey: byKind.email } : {}),
    ...(byKind.username ? { usernameKey: byKind.username } : {}),
    ...(byKind.phone ? { phoneKey: byKind.phone } : {}),
  };

  const valueToKey = new Map<string, string>();
  for (const kind of KIND_PRECEDENCE) {
    const key = byKind[kind];
    if (key && values[key]) valueToKey.set(values[key], key);
  }

  logger.info('[NAMED_CREDENTIAL] Resolved secret for authoring', {
    resourceId: summary.id,
    resourceName: summary.name,
    mappedKinds: Object.keys(byKind),
    keyCount: keyNames.length,
  });

  return {
    ok: true,
    resourceId: summary.id,
    resourceName: summary.name,
    credentials,
    credentialSecret,
    valueToKey,
  };
}

/**
 * Agent-facing message for a failed resolution. Names only — never values.
 * Written so the model's next move is to ASK the user, not to retry blindly.
 */
export function describeCredentialSecretFailure(failure: NamedCredentialSecretFailure, name: string): string {
  const list = failure.availableNames.length > 0
    ? ` Saved logins in this project: ${failure.availableNames.map((n) => `"${n}"`).join(', ')}.`
    : ' This project has no saved logins yet — the user can add one in Settings → Secrets.';

  switch (failure.reason) {
    case 'not_found':
      return `No saved login named "${name}" in this project.${list} Ask the user which one to use.`;
    case 'ambiguous':
      return `More than one saved login is named "${name}".${list} Ask the user to disambiguate.`;
    case 'no_values':
      return `The saved login "${name}" has no stored values yet.${list} Ask the user to fill it in under Settings → Secrets.`;
    case 'no_password_key':
      return `The saved login "${name}" has no password-like key (found: ${failure.keyNames.join(', ')}), so a login cannot be performed with it. Ask the user which saved login to use, or to add a password key.`;
    case 'ambiguous_password_key':
      return `The saved login "${name}" has more than one key that could be the password (${failure.collidingKeys.join(', ')}), so it is not safe to guess which one to type. Ask the user which key holds the login password.`;
  }
}
