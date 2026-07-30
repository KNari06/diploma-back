# `src/services/core/` — accounts, plans, credits, referrals, email

> Everything that decides **who a user is, what they may do, and what they're
> charged**. Billing writes funnel through single entry points on purpose — see
> the funnels below before adding a write site.

---

## Plans & credits

**`PlanService.setUserPlan`** ([plan.service.ts](plan.service.ts)) is the SINGLE funnel
for **individual** plan writes. It keeps `users.{plan_id,plan,plan_status}` +
`user_credits.{subscription_plan,subscription_status,grace_limit}` in sync. Stripe
webhooks (individual) and self-serve route through it.

**Admin panel** grants go through
[admin-plan-grant.service.ts](admin-plan-grant.service.ts) (`AdminPlanGrantService.grant`,
behind `POST /api/v1/user/plan/assign`):

| Tier | Path |
| --- | --- |
| individual (`free` / `pro`) | `setUserPlan` |
| B2B (`pilot` / `small_business` / `middle_business` / `enterprise`) | `UserCreditsService.grantBusinessPlan` (credits/grace/**price** → `credit_transactions.cost_usd`, admin can override credits+price for a discount) + `writeUserBusinessPlanMirror` (plan.db) |

`writeUserBusinessPlanMirror` mirrors the slug onto `users.plan`/`plan_status` with
`plan_id=null` (no `pricing_plans` row exists for B2B) so the row stops drifting.

**Credits belong to the USER only.** B2B Stripe invoices AND the ops
`scripts/assign-workspace-plan.ts` grant to the buyer's `user_credits` via
`grantBusinessPlan` (NOT a workspace).

**Paid-feature gating** (`isPaidUser` → `plan-access.db.ts` `userHasPaidBusinessPlan`)
reads the user's own `user_credits.subscription_plan` — binary free-vs-paid, NO per-tier
gate. The `subscription_plan` slug union lives once in
[user-credits.service.ts](user-credits.service.ts) (`SubscriptionPlanSlug`).

**Retired / dead:** the individual `ultra` ("Team") plan is retired (`is_active=false`,
0 users) — real Team/Enterprise = the B2B tiers. The `workspace_credits` /
`workspace_credit_transactions` tables + `deduct_workspace_credits` RPC are now dead
(`workspace-credits.service.ts` removed); a schema-drop migration is deferred to its own PR.

---

## Referrals by link (partner tracking + reward)

[referral.service.ts](referral.service.ts) + [db/referral.db.ts](db/referral.db.ts).
Feature-gated `REFERRALS_ENABLED` (default off). Migrations `20260713_referrals.sql`
+ `20260714_referral_revenue_share.sql` + `20260728_referral_user_bonus_index.sql`.

**Attribution** is first-touch set-once (DB-enforced), applied in `auth.controller`
verify/login/OAuth + `POST /referrals/attribute`. A captured code waits in Redis keyed
by email for `PENDING_TTL_SECONDS` (30 days — a verification mail sitting in spam used
to cost the partner the referral). When a code reaches us but does NOT stick,
`attributeAtAuth` logs a `warn`: every cause is actionable, and without it a systemic
loss is invisible.

**The referral is TWO-SIDED — both sides come out of ONE margin.** Change one side and
the other must move with it.

**Partner side — a revenue share.** `ReferralsFeature` `REFERRAL_REWARD_RATE` (0.50) ×
the real invoice amount, for the referred user's first `REFERRAL_REWARD_MONTHS` (2)
payments, then 0%. `rewardOnPayment` fires from
[../../api/stripe/stripe.controller.ts](../../api/stripe/stripe.controller.ts) on every
paid **B2C** invoice (window enforced by COUNTING prior reward rows, not billing reason),
per-invoice-idempotent via `partner_reward_transactions.stripe_invoice_id`
(append-only ledger, `amount` = cents). The rate is 0.50 rather than the original 0.70
precisely because the user side below now costs us too.

**B2B is EXCLUDED from the reward** (`!isBusinessPlanCode`, matching the user-side
bonus). The 50% rate was sized against B2C tickets — at most ~$99 per referral over the
window — and the same rate on an enterprise invoice is ~$1,495/month. A B2B referral
should be a deliberate, separately-priced arrangement. Skipped B2B invoices are logged,
not dropped silently.

**A disabled partner stops earning.** `getUserRewardConfig` selects `partners.status`
and returns null unless active — the `attributeUser` status gate only runs at signup, so
without this a partner disabled for cause keeps collecting on every renewal of everyone
they had already referred.

**The owed balance is grouped BY CURRENCY, never summed across it.** `amount` is minor
units of the paid invoice's own currency, so adding ¥100 to $1.00 yields a number that
means nothing — and a dashboard rendering one symbol would show a figure the partner is
not owed. `getOwedBalance` returns `Record<currency, minorUnits>`; `PartnerStats` carries
`owedBalance` + `owedCurrency` (the largest, for the headline) and `owedByCurrency` (the
full picture, which both dashboards render as a secondary line). `countRewardsForUser`
counts `paid_conversion` rows ONLY — refund `adjustment` rows would otherwise close the
reward window early, charging the partner twice for one cancelled payment.

**Refunds reverse the reward** — `reverseRewardOnRefund`, wired to `charge.refunded`.
The ledger is append-only, so a refund cannot edit the original row: it writes a NEGATIVE
counter-entry keyed `refund:<invoiceId>` (own unique key → idempotent under Stripe
retries, never collides with the reward row). It mirrors the ORIGINAL row rather than
recomputing — rates are captured per-row and may have changed since — reverses
proportionally on a partial refund, and is capped so an over-refund can't reverse more
than was credited. **Credits are deliberately NOT clawed back:** they may already be
spent, and a negative balance is a worse failure than an unearned grant.

**User side — a per-plan credit bonus on the SAME price.** `REFERRAL_USER_BONUS_PLANS`
(`<planCode>:<multiplier>:<payments>`, default `pro_19:2:inf,pro_49:1.5:2,pro_99:1.25:2`;
`inf` = every invoice while subscribed). The multiplier SHRINKS as the plan grows: 2× on
pro_99 would be 18 000 free credits on an invoice we already share 50% of. It is
unbounded on pro_19 because a bounded bonus would visibly DROP at renewal
(`resetToPlanCredits`), reading to the user as a takeaway. A plan absent from the map
gets NO bonus, so a new plan is opt-in rather than silently expensive; B2B plans are
credited per workspace and never reach this path.

`ReferralService.resolveInvoiceCredits` runs BEFORE the grant in `stripe.controller.ts`
(it changes the amount — unlike the fire-and-forget `rewardOnPayment`) and **degrades to
base credits on ANY fault**, so a referral bug can never withhold paid-for credits.
Idempotency + the per-plan window are counted from `credit_transactions` metadata markers
(`referral_bonus_invoice` / `referral_bonus_plan`) — the welcome-bonus marker pattern, no
new table. The purchase email sends the GRANTED credits, not the plan base. `/auth/me`
returns `referral{isReferred, planBonuses}` so the paywall renders each plan's bonus
without hardcoding multipliers that would drift from what the webhook grants.

**`GET /referrals/bonuses` is PUBLIC** (no auth) and serves the same map. A visitor who
just arrived on a partner link has no token, so `/auth/me` is unavailable — without this
the pricing page shows them ordinary credit counts and the benefit stays invisible until
*after* signup, the wrong side of the buying decision. The frontend calls it only when a
first-touch code is stored and there is no session. Response carries no user or partner
data, only the public offer.

> **Invariant — the `.not(…,'is',null)` clause in `countUserBonusGrants` /
> `hasBonusForInvoice` is load-bearing, not redundant.** The supporting partial indexes
> use an `IS NOT NULL` predicate, and Postgres only uses a partial index when the query
> proves the predicate holds. Dropping the clause silently degrades both reads to a
> sequential scan over every credit transaction ever written — on the Stripe webhook path.

**Partnership is DECOUPLED from `role`.** A partner login is a normal `role='user'`
product user (gets a workspace + trial credits) who ALSO has a linked
`partners.auth_user_id` row. `/auth/me` returns `isPartner` (derived from that link) —
the frontend `/partner` guard keys off `isPartner`, NOT role, so a partner uses the
platform AND the referral dashboard with one account. `markUserAsPartnerLogin` only sets
`status='approved'` (never role); self-serve no longer skips partners.

`attributeUser` has a **self-referral guard** — a user can't be attributed to a partner
whose `auth_user_id` is themselves, so a partner can't earn the revenue share on their
own subscription.

---

## Self-serve "magic first test" (PLG)

Gated by `AUTO_APPROVE_SIGNUP`.

```
Sign up → first auth (verifyEmail / completeOAuthHandler in ../../api/auth/auth.controller.ts)
→ SelfServeProvisioningService.provision()   (self-serve-provisioning.service.ts)
→ POST /api/v1/explorations/start  { url, projectId?, preset? }
→ validate URL + IDOR-guard projectId → QueueManager.addExplorationJob()  ('quick' preset, ~2 min)
→ 202 { explorationId } → poll GET /api/v1/explorations/:id
→ one-click POST /:id/run-discovered
```

`provision()` approves the user + creates workspace+project + grants trial
credits/plan (no-op unless the flag is on; never throws). On the FIRST
pending→approved transition it also fires `EmailService.sendApprovalEmail`
(fire-and-forget) — the ONLY place auto-approved users get the "You're in!" email;
the admin PATCH path is the other.

The start route is gated by `requireApproved` + `requireCredits`. Budget presets live in
[../../agent/core/lite/exploration/types.ts](../../agent/core/lite/exploration/types.ts)
(`EXPLORATION_PRESETS`).

---

## Transactional email (`EmailService`)

[email.service.ts](email.service.ts). Nodemailer over Gmail SMTP
(`smtp.gmail.com:587`, user `yera@qait.dev`, pass `SMTP_PASSWORD`). New transport per
send; `EmailService.verifyConfig()` runs once at boot ([../../index.ts](../../index.ts))
and loudly logs a dead/missing credential (non-fatal).

> Auth-flow emails (magic link / password reset / verification / new-user invite) are
> sent by **Supabase**, NOT this service.

All HTML is built through one shared `buildEmailTemplate()` (light, table-based,
Outlook-safe) + builders (`buildWelcomeHtml` / `buildPlanPurchasedHtml` /
`buildGeneralInfoHtml` / `buildTestFailedEmail` / `buildCriticalIssuesEmail` /
`buildSupportReportEmail` / `buildNewUserSignupEmail`); the `build*Html` variants are
reused by `scripts/preview-email-templates.ts` (`npx tsx`, port 3555).

### Senders + triggers

| Sender | Trigger |
| --- | --- |
| `sendWelcomeEmail` | `POST /auth/signup`. States the configured free grant (`INDIVIDUAL_PLANS.free.credits`), NOT a live balance (the trial grant lands later on verify/login) |
| `sendApprovalEmail` / `sendRejectionEmail` | Admin `PATCH /auth/users/:id/status` (guarded by `prevUser.status !== status`) + self-serve `provision()` |
| `sendWorkspaceInvite` | Workspace invite/resend for EXISTING users ([workspace-members.service.ts](workspace-members.service.ts)); new users go via Supabase invite |
| `sendPlanPurchasedEmail` | Stripe `invoice.payment_succeeded`, AFTER the dedup guards and ONLY for first-purchase/one-off (`billing_reason !== 'subscription_cycle'`) so renewals don't spam |
| `sendGeneralInfoEmail` | Admin broadcast `POST /auth/admin/send-info-email` (`requireAuth + requireAdmin`, capped at 500 recipients/call); also the generic queue path (`addNotificationJob({type:'email'})` → `sendGenericEmail`) |
| `sendPlanExpiringEmail` | Daily `ExpiringPlansJob` sweep → [subscription-lifecycle.service.ts](subscription-lifecycle.service.ts) → `db/subscription-lifecycle.db.ts`, for paid users whose `current_period_end` is within 3 days. Per-period dedup via `users.expiry_reminder_sent_for` |
| `sendPaymentFailedEmail` | Stripe `invoice.payment_failed`, ONLY on the final retry (`next_payment_attempt == null`) so dunning retries don't spam |
| `sendSubscriptionCanceledEmail` | Stripe `customer.subscription.deleted`, or `.updated` with `status === 'canceled'` only (NOT transient past_due/unpaid/paused) |

`sendPlanExpiringEmail` is registered in ALL THREE scheduler paths — see
[../../jobs/CLAUDE.md](../../jobs/CLAUDE.md) § 24h sweeps.

### Invariants

1. **Every send returns `{success,error}` and is fire-and-forget** — callers MUST log a
   resolved `{success:false}`, not only `.catch()` thrown errors. A dead credential
   resolves falsy, it never throws.
2. **Escape everything caller-supplied.** Every caller-supplied string in HTML goes
   through `esc()`; every caller-supplied URL in an `href` goes through `safeUrl()`
   (http/https/mailto only, else `#`).
