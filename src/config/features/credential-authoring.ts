import { env } from '@/config/environment/env';

/**
 * Feature flag for credential-bound test authoring (ADR-0023).
 *
 * When enabled, the chat agent can author a LOGIN test against a saved `secret`:
 * the user names the login, the server resolves it (owner- and project-scoped),
 * injects the real values for the live authoring run, and freezes
 * `{{secrets.<key>}}` into the steps so the SAVED test replays against the
 * encrypted store.
 *
 * Default ON — set `CREDENTIAL_AUTHORING_ENABLED=false` to disable without a
 * deploy. It shipped default-OFF so it could be enabled deliberately from the
 * infra env, but that env lives in a separate repo, and a flag nobody can set
 * leaves working code permanently dark. The path is opt-in by nature: it runs
 * only when a user NAMES a saved login.
 *
 * Three surfaces read this, and they must agree — a flag that
 * gated only the handler would leave the prompts telling the model to use a
 * parameter the tool no longer accepts, turning a disabled feature into a loop
 * of failed tool calls:
 *   1. the tool SCHEMA (`qa.skill.ts`) — stops advertising
 *      `credential_secret_name`, so the model cannot pass it;
 *   2. the PROMPTS (`executor-prompt.ts`, chat `handler.ts`) — fall back to
 *      "ask the user / draft with placeholders", the pre-rung-5 guidance;
 *   3. the HANDLER (`qa-tool-handlers.ts`) — refuses the argument if one
 *      arrives anyway (an older cached prompt, a replayed tool call).
 *
 * NOT gated, deliberately — these are fixes, not the feature, and are correct
 * regardless: the `createResource` project-access check, the default-
 * `ENCRYPTION_SECRET` startup warning, replay interpolation of the two
 * assertion channels, the sanitizer's bound-placeholder guard, and every
 * redaction fix. The binding carry-through (draft cache → saved test case) is
 * also ungated: with the flag OFF nothing produces a binding, so it is inert.
 *
 * NOTE on `ENCRYPTION_SECRET`: stored credentials are encrypted with the schema
 * default (a value public in this repo) until a real one is set — see
 * `.claude/deferred/20260726-encryption-secret-production-key.md`. That is NOT
 * caused by this feature and is not a reason to keep it off: users can already
 * save secrets under Settings → Secrets, and `/test-resource` was never gated.
 * This feature routes more credentials through that store, so it raises the
 * priority of fixing the key — it does not create the exposure.
 */
export const CredentialAuthoringFeature = {
  isEnabled(): boolean {
    return env.CREDENTIAL_AUTHORING_ENABLED;
  },
};
