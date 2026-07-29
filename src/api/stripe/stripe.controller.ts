import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { EmailService } from '@/services/core/email.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { PlanService } from '@/services/core/plan.service';
import { ReferralService } from '@/services/core/referral.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { NotificationService } from '@/services/notifications/notification.service';

// Initialize Stripe
const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null;

/**
 * POST /api/billing/checkout
 * Create Stripe Checkout Session
 */
export const createCheckoutSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    if (!stripe) {
      res.status(500).json({
        success: false,
        error: 'Stripe not configured',
        message: 'STRIPE_SECRET_KEY is not set',
      });
      return;
    }

    const { plan_code } = req.body;

    if (!plan_code || typeof plan_code !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Invalid plan_code',
        message: 'plan_code is required',
      });
      return;
    }

    logger.info('[STRIPE_CHECKOUT] Creating checkout session', { userId, plan_code });

    // 1. Check plan in pricing_plans table (is_active=true)
    const { data: plan, error: planError } = await supabaseAdmin
      .from('plans')
      .select('*')
      .eq('code', plan_code)
      .eq('is_active', true)
      .maybeSingle();

    if (planError || !plan) {
      logger.error('[STRIPE_CHECKOUT] Plan not found', { plan_code, error: planError });
      res.status(404).json({
        success: false,
        error: 'Plan not found',
        message: `Plan with code ${plan_code} not found or inactive`,
      });
      return;
    }

    // Check if plan has stripe_price_id
    if (!plan.stripe_price_id) {
      res.status(400).json({
        success: false,
        error: 'Plan not configured for Stripe',
        message: 'Plan does not have stripe_price_id configured',
      });
      return;
    }

    // 2. Get or create Stripe Customer
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, email, stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    let customerId = user.stripe_customer_id;

    // Create Stripe customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          user_id: userId,
        },
      });

      customerId = customer.id;

      // Save customer ID to database
      await supabaseAdmin
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // 3. Create Checkout Session
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: plan.stripe_price_id,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/billing/cancel`,
      metadata: {
        user_id: userId,
        plan_code: plan_code,
      },
    });

    logger.info('[STRIPE_CHECKOUT] Checkout session created', {
      userId,
      sessionId: session.id,
      plan_code,
    });

    res.json({
      success: true,
      url: session.url,
      session_id: session.id,
    });
  } catch (error) {
    logger.error('[STRIPE_CHECKOUT] Error creating checkout session', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to create checkout session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * POST /api/billing/portal
 * Create Stripe Customer Portal Session
 */
export const createPortalSession = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    if (!stripe) {
      res.status(500).json({
        success: false,
        error: 'Stripe not configured',
        message: 'STRIPE_SECRET_KEY is not set',
      });
      return;
    }

    logger.info('[STRIPE_PORTAL] Creating portal session', { userId });

    // Get user's Stripe customer ID
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();

    if (!user || !user.stripe_customer_id) {
      res.status(404).json({
        success: false,
        error: 'No Stripe customer found',
        message: 'User does not have an active Stripe subscription',
      });
      return;
    }

    // Create portal session
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${frontendUrl}/billing`,
    });

    logger.info('[STRIPE_PORTAL] Portal session created', {
      userId,
      sessionId: session.id,
    });

    res.json({
      success: true,
      url: session.url,
    });
  } catch (error) {
    logger.error('[STRIPE_PORTAL] Error creating portal session', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to create portal session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhook events
 */
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!stripe) {
      logger.error('[STRIPE_WEBHOOK] Stripe not configured');
      res.status(500).json({
        success: false,
        error: 'Stripe not configured',
      });
      return;
    }

    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      logger.error('[STRIPE_WEBHOOK] No signature provided');
      res.status(400).json({
        success: false,
        error: 'No signature provided',
      });
      return;
    }

    if (!env.STRIPE_WEBHOOK_SECRET) {
      logger.error('[STRIPE_WEBHOOK] Webhook secret not configured');
      res.status(500).json({
        success: false,
        error: 'Webhook secret not configured',
      });
      return;
    }

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.error('[STRIPE_WEBHOOK] Signature verification failed', { error: err });
      res.status(400).json({
        success: false,
        error: 'Invalid signature',
      });
      return;
    }

    logger.info('[STRIPE_WEBHOOK] Event received', {
      type: event.type,
      id: event.id,
    });

    const handledEventTypes = new Set([
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_succeeded',
      'invoice.payment_failed',
    ]);

    if (!handledEventTypes.has(event.type)) {
      logger.info('[STRIPE_WEBHOOK] Event type ignored', { type: event.type });
      res.json({ received: true });
      return;
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionEvent(event);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event);
        break;
      default:
        logger.info('[STRIPE_WEBHOOK] Event type ignored', { type: event.type });
        break;
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('[STRIPE_WEBHOOK] Error handling webhook', { error });
    res.status(500).json({
      success: false,
      error: 'Webhook handling failed',
    });
  }
};

/**
 * Handle subscription events (created/updated/deleted)
 */
async function handleSubscriptionEvent(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;

  if (!customerId) {
    logger.warn('[STRIPE_WEBHOOK] Subscription missing customer', {
      subscriptionId: subscription.id,
      eventType: event.type,
    });
    return;
  }

  logger.info('[STRIPE_WEBHOOK] Processing subscription event', {
    type: event.type,
    subscriptionId: subscription.id,
    customerId,
    status: subscription.status,
  });

  // Get user by Stripe customer ID
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, email, name')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  logger.info('[STRIPE_WEBHOOK] User found:', { user });
  if (!user) {
    logger.warn('[STRIPE_WEBHOOK] User not found for customer', { customerId });
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) {
    logger.error('[STRIPE_WEBHOOK] No price ID in subscription', {
      subscriptionId: subscription.id,
    });
    return;
  }

  // Get plan by stripe_price_id (plan may be missing)
  const { data: plan } = await supabaseAdmin
    .from('plans')
    .select('*')
    .eq('stripe_price_id', priceId)
    .maybeSingle();

  if (!plan) {
    logger.warn('[STRIPE_WEBHOOK] Plan not found for price', { priceId });
  } else {
    logger.info('[STRIPE_WEBHOOK] Plan:', { plan });
  }

  const isActive = subscription.status === 'active' || subscription.status === 'trialing';
  const creditsPerPeriod = plan?.credits_per_period || 0;
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
  const subscriptionPlanLabel = plan?.name || plan?.code || 'pro';

  // Upsert subscription record
  const subscriptionData: Record<string, any> = {
    user_id: user.id,
    customer_id: customerId,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    stripe_price_id: priceId,
    credits_per_period: creditsPerPeriod,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };

  if (plan?.code) {
    subscriptionData.plan_code = plan.code;
  }

  await supabaseAdmin.from('subscriptions').upsert(subscriptionData, {
    onConflict: 'stripe_subscription_id',
  });

  // Update Stripe-specific user columns. The plan/tier mirrors
  // (plan_id / plan / plan_status + user_credits) are owned by the single
  // funnel PlanService.setUserPlan, called below — NOT written inline here.
  const userUpdateData: Record<string, any> = {
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    stripe_price_id: priceId,
    subscription: isActive
      ? {
          plan: subscriptionPlanLabel,
          status: 'active',
          credits_included: creditsPerPeriod,
        }
      : {
          plan: 'free',
          status: 'inactive',
          credits_included: 0,
        },
    // Intentionally does NOT write last_credits_invoice_id: that field belongs to
    // the invoice-payment handler's bookkeeping, and this handler never grants
    // credits. Writing it here previously could falsely mark an invoice as
    // "already credited" before the grant ran.
    updated_at: new Date().toISOString(),
  };

  await supabaseAdmin
    .from('users')
    .update(userUpdateData)
    .eq('id', user.id);

  // Funnel the plan/tier mirror through PlanService so users.{plan_id,plan,
  // plan_status} and user_credits.{subscription_plan,subscription_status,
  // grace_limit} stay in sync. Active → 'pro' (paid). Inactive only downgrades
  // to 'free' on a TERMINAL state (canceled / incomplete_expired); transient
  // dunning (past_due / unpaid) keeps the plan intact so the user retains
  // access during the retry window — Stripe sends another event if it
  // ultimately cancels.
  if (isActive) {
    await PlanService.setUserPlan(user.id, 'pro', { status: 'paid', source: 'stripe:subscription' });
  } else if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
    await PlanService.setUserPlan(user.id, 'free', {
      status: null,
      skipDowngradeGuard: true,
      source: 'stripe:subscription:terminal',
    });
  }

  const planCode = plan?.code || 'unknown';

  logger.info('[STRIPE_WEBHOOK] Subscription updated', {
    userId: user.id,
    planCode,
    status: subscription.status,
    eventType: event.type,
  });

  // Create in-app notifications for subscription changes
  try {
    if (event.type === 'customer.subscription.deleted' || 
        (event.type === 'customer.subscription.updated' && !isActive)) {
      // Subscription cancelled or became inactive
      const endsOn = currentPeriodEnd ? currentPeriodEnd.slice(0, 10) : null; // YYYY-MM-DD
      await NotificationService.createNotification({
        userId: user.id,
        type: 'personal',
        category: 'billing',
        title: 'Subscription cancelled',
        message: subscription.cancel_at_period_end
          ? (endsOn ? `Your subscription will end on ${endsOn}` : 'Your subscription will end soon')
          : 'Your subscription has been cancelled',
        metadata: {
          subscriptionId: subscription.id,
          status: subscription.status,
          planCode,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          currentPeriodEnd: currentPeriodEnd,
          dedupeKey: `subscription:${subscription.id}:${event.id}:cancelled`,
        },
      });
    } else if (event.type === 'customer.subscription.updated' && isActive) {
      // Subscription updated (plan change, reactivation, etc.)
      await NotificationService.createNotification({
        userId: user.id,
        type: 'personal',
        category: 'billing',
        title: 'Subscription updated',
        message: `Your subscription has been updated to ${subscriptionPlanLabel}`,
        metadata: {
          subscriptionId: subscription.id,
          status: subscription.status,
          planCode,
          creditsPerPeriod,
          dedupeKey: `subscription:${subscription.id}:${event.id}:updated`,
        },
      });
    }
  } catch (notifError) {
    logger.error('[STRIPE_WEBHOOK] Failed to create subscription notification', {
      error: notifError instanceof Error ? notifError.message : String(notifError),
      userId: user.id,
      eventType: event.type,
    });
    // Don't throw - notification failure shouldn't break webhook processing
  }

  // Branded "plan canceled" email — fire-and-forget, only for a GENUINE
  // cancellation: a hard delete, or an updated event whose status is actually
  // 'canceled'. We deliberately do NOT email on transient inactive states
  // (past_due / unpaid / paused / incomplete_expired) — those are dunning, not
  // a cancellation, and the payment-failed handler covers them. Stripe's
  // notification block above is in-app only.
  const wasCanceled =
    event.type === 'customer.subscription.deleted' ||
    (event.type === 'customer.subscription.updated' && subscription.status === 'canceled');
  // Only surface an end date that's still in the future (a hard delete often
  // carries a past current_period_end → "access until <past date>" reads wrong).
  const endsOn = currentPeriodEnd && new Date(currentPeriodEnd) > new Date() ? currentPeriodEnd : null;
  if (user.email && wasCanceled) {
    EmailService.sendSubscriptionCanceledEmail({
      recipientEmail: user.email,
      recipientName: user.name || undefined,
      planName: subscriptionPlanLabel,
      endsOn,
      frontendUrl: env.FRONTEND_URL || 'http://localhost:3000',
    })
      .then((result) => {
        if (!result.success) {
          logger.error('[STRIPE_WEBHOOK] Cancellation email not sent', {
            userId: user.id,
            error: result.error,
          });
        }
      })
      .catch((err) =>
        logger.error('[STRIPE_WEBHOOK] Failed to send cancellation email', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }
}

async function handleInvoicePaymentSucceeded(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  logger.info('[STRIPE_WEBHOOK] Invoice payment succeeded', { invoice });
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;

  if (!customerId) {
    logger.warn('[STRIPE_WEBHOOK] Invoice missing customer', {
      invoiceId: invoice.id,
      eventType: event.type,
    });
    return;
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, email, name, last_credits_invoice_id, stripe_price_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!user) {
    logger.warn('[STRIPE_WEBHOOK] User not found for customer', { customerId });
    return;
  }

  // NOTE: idempotency is enforced solely by the stripe_transactions
  // UNIQUE(stripe_invoice_id) barrier + credits_granted flag below. We do NOT
  // gate on user.last_credits_invoice_id here: that field is also written by the
  // subscription-event handler (which never grants credits), so a same-invoice
  // subscription event arriving first could falsely short-circuit the grant.

  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id ||
        // @ts-ignore
        invoice.parent?.subscription_details?.subscription ||
        null;

  // Resolve the priceId that determines which plan's credits to grant.
  // Order matters for correctness, NOT just for null-filling:
  // 1) For a subscription invoice, the SUBSCRIPTION's current item price is
  //    authoritative. invoice.lines.data[0] is unreliable — on a plan change /
  //    proration the invoice carries multiple lines (an unused-time credit line
  //    for the old price + a remaining-time line for the new price) and Stripe
  //    does not guarantee the line you want is index [0]. Trusting [0] can grant
  //    the WRONG tier's credits.
  // 2) Only for a one-off (no subscription) do we read invoice lines, and even
  //    then we skip proration/credit/$0 lines.
  // 3) Last resort: the user's stored price id.
  let priceId: string | null = null;

  if (subscriptionId && stripe) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
      priceId = subscription.items?.data?.[0]?.price?.id ?? null;
    } catch (error) {
      logger.error('[STRIPE_WEBHOOK] Failed to fetch subscription for price', {
        subscriptionId,
        error,
      });
    }
  }

  if (!priceId) {
    const lines = invoice.lines?.data ?? [];
    const lineprice = (l: any) => l?.price?.id || l?.pricing?.price_details?.price?.id || null;
    // Prefer a positive-amount, non-proration line; fall back progressively.
    const chosen =
      lines.find((l: any) => (l.amount ?? 0) > 0 && !l.proration && lineprice(l)) ||
      lines.find((l: any) => (l.amount ?? 0) > 0 && lineprice(l)) ||
      lines[0];
    priceId = chosen ? lineprice(chosen) : null;

    if (lines.length > 1) {
      logger.info('[STRIPE_WEBHOOK] Multi-line invoice — chosen priceId for grant', {
        invoiceId: invoice.id,
        chosenPriceId: priceId,
        candidates: lines.map((l: any) => ({ price: lineprice(l), amount: l.amount, proration: l.proration })),
      });
    }
  }

  if (!priceId && user.stripe_price_id) {
    priceId = user.stripe_price_id;
  }

  const { data: plan } = priceId
    ? await supabaseAdmin
        .from('plans')
        .select('*')
        .eq('stripe_price_id', priceId)
        .maybeSingle()
    : { data: null };

  // plans-desync guard: a PAID invoice whose price has no matching plans row
  // means the plans table is out of sync with Stripe (new/rotated price, or an
  // un-replaced placeholder price id). The old code only warned and continued —
  // which recorded the transaction as 'succeeded' and granted ZERO credits, and
  // because the barrier row was then committed, no retry could ever heal it.
  // THROW here (BEFORE the transaction INSERT below) so Stripe retries with
  // backoff (~3 days), giving an operator time to seed/fix the plans row so a
  // later retry grants correctly — and crucially no 'succeeded' row is recorded.
  if (priceId && !plan && (invoice.amount_paid ?? 0) > 0) {
    logger.error('[STRIPE_WEBHOOK] Paid invoice for unknown price — plans table desync; failing for retry', {
      priceId,
      invoiceId: invoice.id,
      userId: user.id,
      eventId: event.id,
      amountPaid: invoice.amount_paid,
    });
    throw new Error(`No plan row for paid Stripe price ${priceId} (invoice ${invoice.id})`);
  }
  if (!plan && priceId) {
    // Non-paid (e.g. $0/trial) invoice with no plan — log but don't hard-fail.
    logger.warn('[STRIPE_WEBHOOK] Plan not found for price (non-paid invoice)', { priceId, invoiceId: invoice.id });
  }

  const creditsPerPeriod = plan?.credits_per_period || 0;
  const planCode = plan?.code || 'unknown';
  const subscriptionPlanLabel = plan?.name || plan?.code || 'pro';

  // B2B plans are credited at the WORKSPACE level (renewPlan/upgradeToPlan below),
  // not as personal user credits. Today B2B plans carry credits_per_period=0 so
  // the personal-credit block is naturally skipped, but guard explicitly so a
  // future B2B plan with credits_per_period>0 can't double-grant (personal + workspace).
  const isBusinessPlanCode = ['business', 'Business', 'small_business', 'middle_business', 'enterprise'].includes(planCode);

  // A recurring renewal must RESET credits to the period allotment, not stack
  // them. The first charge / upgrade adds; every `subscription_cycle` resets.
  const billingReason = (invoice as Stripe.Invoice).billing_reason;

  const transactionData: Record<string, any> = {
    user_id: user.id,
    stripe_customer_id: customerId,
    stripe_invoice_id: invoice.id,
    stripe_event_id: event.id,
    stripe_subscription_id: subscriptionId || null,
    stripe_payment_intent_id:
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent?.id || null,
    stripe_charge_id:
      typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id || null,
    stripe_price_id: priceId || null,
    amount: invoice.amount_paid ?? 0,
    currency: invoice.currency || 'usd',
    status: 'succeeded',
    created_at: invoice.created
      ? new Date(invoice.created * 1000).toISOString()
      : new Date().toISOString(),
  };

  // Idempotency lock: INSERT (not upsert) the transaction row BEFORE granting
  // any credits. The unique constraint on stripe_invoice_id makes this the
  // atomic barrier — only the FIRST delivery of an invoice inserts a row; a
  // concurrent retry hits a 23505 unique violation and bows out WITHOUT
  // granting. (The old code did a separate SELECT-then-act check and granted
  // before the upsert, so two concurrent retries could both pass the check and
  // double-grant.)
  // Insert the barrier row with credits_granted=false. The row existing is NOT
  // proof credits landed; credits_granted is the real "delivered" flag so a
  // failed/crashed grant self-heals on Stripe's retry instead of being swallowed.
  const { error: transactionError } = await supabaseAdmin
    .from('stripe_transactions')
    .insert({ ...transactionData, credits_granted: false });

  if (transactionError) {
    if (transactionError.code === '23505') {
      // A row already exists for this invoice. If its grant already completed,
      // this is a true duplicate. If not, fall through and re-attempt the grant
      // (recovers a prior transient failure or crash between INSERT and grant).
      const { data: existing } = await supabaseAdmin
        .from('stripe_transactions')
        .select('credits_granted')
        .eq('stripe_invoice_id', invoice.id)
        .maybeSingle();

      if (existing?.credits_granted) {
        logger.info('[STRIPE_WEBHOOK] Duplicate invoice ignored (credits already granted)', {
          invoiceId: invoice.id,
          eventId: event.id,
          userId: user.id,
        });
        return;
      }
      logger.warn('[STRIPE_WEBHOOK] Invoice row exists but credits not granted — re-attempting', {
        invoiceId: invoice.id,
        userId: user.id,
      });
      // fall through to grant
    } else {
      // Could not record the transaction — throw so Stripe retries the whole event.
      logger.error('[STRIPE_WEBHOOK] Failed to record transaction', {
        invoiceId: invoice.id,
        userId: user.id,
        error: transactionError.message,
      });
      throw new Error(`Failed to record stripe transaction for invoice ${invoice.id}`);
    }
  }

  // First charge / one-off ADDS the allotment; a recurring/period event RESETS
  // to the allotment (no rollover). subscription_update (proration / mid-period
  // plan change) is a period event too — reset, NOT a second full add.
  const isPeriodReset =
    billingReason === 'subscription_cycle' || billingReason === 'subscription_update';

  // Referred users get a per-plan credit bonus on the SAME money (2x on pro_19,
  // less on the larger plans). Resolved BEFORE the grant because it changes the
  // amount — unlike the partner reward below, which is fire-and-forget. Degrades
  // to `creditsPerPeriod` on any fault, so a referral fault never withholds the
  // credits the user paid for. The `referral_bonus_*` metadata below is what
  // makes the per-plan window count work — dropping it re-bonuses forever.
  const bonus = invoice.id && creditsPerPeriod > 0 && !isBusinessPlanCode
    ? await ReferralService.resolveInvoiceCredits({
        userId: user.id,
        invoiceId: invoice.id,
        planCode,
        planCredits: creditsPerPeriod,
      })
    : { credits: creditsPerPeriod, bonusApplied: false, multiplier: 1 };

  const creditsToGrant = bonus.credits;

  if (creditsToGrant > 0 && !isBusinessPlanCode) {
    const grantMetadata: Record<string, unknown> = {
      invoice_id: invoice.id,
      event_type: event.type,
      ...(bonus.bonusApplied
        ? {
            referral_bonus_invoice: invoice.id,
            referral_bonus_plan: planCode,
            referral_bonus_multiplier: bonus.multiplier,
            referral_base_credits: creditsPerPeriod,
          }
        : {}),
    };
    const bonusSuffix = bonus.bonusApplied ? ` (referral ${bonus.multiplier}x)` : '';

    const result = isPeriodReset
      ? await UserCreditsService.resetToPlanCredits(
          user.id,
          creditsToGrant,
          `Subscription renewal - ${planCode} plan${bonusSuffix}`,
          grantMetadata
        )
      : await UserCreditsService.addCredits(
          user.id,
          creditsToGrant,
          'purchase',
          `Subscription payment - ${planCode} plan${bonusSuffix}`,
          grantMetadata
        );

    // On failure THROW so handleWebhook returns 500 and Stripe retries; the
    // credits_granted flag stays false so the retry re-attempts (not swallowed).
    if (!result.success) {
      logger.error('[STRIPE_WEBHOOK] Credit grant failed — throwing for Stripe retry', {
        userId: user.id,
        credits: creditsToGrant,
        invoiceId: invoice.id,
      });
      throw new Error(`Credit grant failed for invoice ${invoice.id}`);
    }
    logger.info('[STRIPE_WEBHOOK] Credits granted', {
      userId: user.id,
      credits: creditsToGrant,
      baseCredits: creditsPerPeriod,
      referralBonus: bonus.bonusApplied,
      newBalance: result.newBalance,
      invoiceId: invoice.id,
      mode: isPeriodReset ? 'reset' : 'add',
    });
  }

  // Provision B2B plan credits on the USER account (credits belong to the user,
  // NOT the workspace). Maps plan codes from the Stripe `plans` table to
  // WORKSPACE_PLANS slugs for the credit + grace allotment.
  // Supports both legacy 'business' and new B2B plan codes.
  // Pilot is admin-only (assignPilot), not purchasable via Stripe.
  const B2B_PLAN_MAP: Record<string, 'small_business' | 'middle_business' | 'enterprise'> = {
    business: 'small_business',         // Legacy business → Small Business (29K)
    Business: 'small_business',
    small_business: 'small_business',   // $1,000/mo → 29K credits
    middle_business: 'middle_business', // $1,590/mo → 79K credits
    enterprise: 'enterprise',           // $2,990/mo → 200K credits
  };

  const b2bPlanSlug = B2B_PLAN_MAP[planCode];
  const isBusinessPlan = !!b2bPlanSlug;

  if (isBusinessPlan) {
    const { WORKSPACE_PLANS } = await import('@/services/core/token-calculator.service');
    const planConfig = WORKSPACE_PLANS[b2bPlanSlug];

    // First charge / upgrade ADDS; a recurring/period event RESETS to allotment.
    const result = await UserCreditsService.grantBusinessPlan(
      user.id,
      b2bPlanSlug,
      planConfig.credits,
      planConfig.graceLimit,
      isPeriodReset ? 'renew' : 'upgrade',
      isPeriodReset
        ? `Subscription renewal - ${b2bPlanSlug} plan`
        : `Subscription payment - ${b2bPlanSlug} plan`,
      { invoice_id: invoice.id, event_type: event.type }
    );

    // On failure THROW so handleWebhook returns 500 and Stripe retries; the
    // credits_granted flag stays false so the retry re-attempts (not swallowed).
    if (!result.success) {
      logger.error('[STRIPE_WEBHOOK] B2B credit grant failed — throwing for Stripe retry', {
        userId: user.id,
        plan: b2bPlanSlug,
        invoiceId: invoice.id,
      });
      throw new Error(`B2B credit grant failed for invoice ${invoice.id}`);
    }

    logger.info('[STRIPE_WEBHOOK] B2B plan credits granted to user', {
      userId: user.id,
      plan: b2bPlanSlug,
      mode: isPeriodReset ? 'renew' : 'upgrade',
      credits: planConfig.credits,
      graceLimit: planConfig.graceLimit,
      newBalance: result.newBalance,
      invoiceId: invoice.id,
    });
  }

  // Grant succeeded (or nothing to grant). Flip the barrier row to granted so a
  // future duplicate delivery short-circuits, and only THEN finalize plan state.
  await supabaseAdmin
    .from('stripe_transactions')
    .update({ credits_granted: true })
    .eq('stripe_invoice_id', invoice.id);

  // Stripe-specific user columns only. The plan/tier mirror is funneled
  // through PlanService.setUserPlan below for the personal (non-B2B) case.
  const userUpdateData: Record<string, any> = {
    last_credits_invoice_id: invoice.id,
    updated_at: new Date().toISOString(),
    subscription: {
      plan: subscriptionPlanLabel,
      status: 'active',
      credits_included: creditsPerPeriod,
    },
  };

  if (priceId) {
    userUpdateData.stripe_price_id = priceId;
  }

  // B2B credits/tier now live on the USER account (granted above via
  // grantBusinessPlan, which also set user_credits.subscription_plan). But
  // pricing_plans only knows free/pro/ultra, so a B2B slug can't be resolved by
  // the PlanService facade — keep the legacy users.{plan,plan_status} text mirror
  // inline for B2B; route the personal 'pro' plan through the single funnel so
  // plan_id + user_credits.subscription_plan stay in sync.
  if (plan && isBusinessPlan) {
    userUpdateData.plan = b2bPlanSlug || 'business';
    userUpdateData.plan_status = 'paid';
  }

  await supabaseAdmin.from('users').update(userUpdateData).eq('id', user.id);

  if (plan && !isBusinessPlan) {
    await PlanService.setUserPlan(user.id, 'pro', { status: 'paid', source: 'stripe:invoice' });
  }

  // Branded purchase confirmation — fire-and-forget so a mail failure never
  // breaks webhook processing (Stripe still sends its own receipt).
  // Only on the FIRST charge of a subscription (`subscription_create`) or a
  // one-off (`manual`/`subscription_update`) — NOT on monthly renewals
  // (`subscription_cycle`), which would spam "Payment confirmed" every cycle.
  // Stripe still sends its own receipt for every charge.
  const isFirstOrOneOff =
    !billingReason || billingReason === 'subscription_create' || billingReason === 'manual' || billingReason === 'subscription_update';

  // Referral reward — revenue share: the referring partner earns a % (default
  // 70%) of the REAL amount paid, for the referred user's first N monthly
  // payments (default 2), then 0%. Fires on EVERY paid invoice (first charge AND
  // renewals — personal OR B2B, all reach here); the window is enforced inside
  // the service by COUNTING prior reward rows, not by the billing reason, and
  // per-invoice idempotency is the ledger's ON CONFLICT on stripe_invoice_id.
  // Best-effort: never fails the webhook (service swallows). No-op unless enabled.
  if (invoice.id && (invoice.amount_paid ?? 0) > 0) {
    void ReferralService.rewardOnPayment({
      userId: user.id,
      invoiceId: invoice.id,
      amountPaidMinorUnits: invoice.amount_paid ?? 0,
      currency: invoice.currency || 'usd',
    });
  }

  if (user.email && isFirstOrOneOff) {
    EmailService.sendPlanPurchasedEmail({
      recipientEmail: user.email,
      recipientName: user.name || undefined,
      planName: subscriptionPlanLabel,
      amountCents: transactionData.amount,
      currency: transactionData.currency,
      // The GRANTED amount, not the plan's base — a referred user's receipt must
      // match the credits actually in their balance.
      creditsIncluded: creditsToGrant || undefined,
      frontendUrl: env.FRONTEND_URL || 'http://localhost:3000',
    })
      .then((result) => {
        if (!result.success) {
          logger.error('[STRIPE_WEBHOOK] Purchase email not sent', {
            userId: user.id,
            invoiceId: invoice.id,
            error: result.error,
          });
        }
      })
      .catch((err) =>
        logger.error('[STRIPE_WEBHOOK] Failed to send purchase email', {
          userId: user.id,
          invoiceId: invoice.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }
}

async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;

  if (!customerId) {
    logger.warn('[STRIPE_WEBHOOK] Invoice missing customer', {
      invoiceId: invoice.id,
      eventType: event.type,
    });
    return;
  }

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, email, name')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!user) {
    logger.warn('[STRIPE_WEBHOOK] User not found for customer', { customerId });
    return;
  }

  // Payment failure is dunning, NOT a plan change: deliberately clear ONLY the
  // plan_status flag (and the subscription JSON) while leaving users.plan_id and
  // the user_credits mirror intact, so the user retains access during Stripe's
  // retry window. A genuine cancellation arrives later as a subscription event
  // (handleSubscriptionEvent → PlanService.setUserPlan('free')). This is NOT
  // routed through the plan facade on purpose — the facade owns full plan/tier
  // transitions, not a transient status flag flip.
  await supabaseAdmin
    .from('users')
    .update({
      plan_status: null,
      subscription: {
        plan: 'free',
        status: 'inactive',
        credits_included: 0,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;

  if (subscriptionId) {
    await supabaseAdmin
      .from('subscriptions')
      .update({
        status: 'past_due',
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', subscriptionId);
  }

  // Create in-app notification for payment failure
  try {
    const amount = invoice.amount_due ? (invoice.amount_due / 100).toFixed(2) : '0.00';
    const currency = (invoice.currency || 'usd').toUpperCase();

    await NotificationService.createNotification({
      userId: user.id,
      type: 'personal',
      category: 'billing',
      title: 'Payment failed',
      message: `Your payment of ${currency} ${amount} failed. Please update your payment method.`,
      metadata: {
        invoiceId: invoice.id,
        amount: invoice.amount_due || 0,
        currency: invoice.currency || 'usd',
        subscriptionId,
        dedupeKey: `invoice:${invoice.id}:failed`,
      },
    });

    logger.info('[STRIPE_WEBHOOK] Created payment failed notification', {
      userId: user.id,
      invoiceId: invoice.id,
    });
  } catch (notifError) {
    logger.error('[STRIPE_WEBHOOK] Failed to create payment failed notification', {
      error: notifError instanceof Error ? notifError.message : String(notifError),
      userId: user.id,
      invoiceId: invoice.id,
    });
    // Don't throw - notification failure shouldn't break webhook processing
  }

  // Branded payment-failed email — fire-and-forget (the in-app notification
  // above is separate). Stripe retries a failed invoice several times and
  // fires invoice.payment_failed on EACH attempt; only email on the FINAL
  // failure (next_payment_attempt === null) so the user gets one email per
  // invoice, not one per retry. Stripe also runs its own dunning if configured.
  const isFinalAttempt = invoice.next_payment_attempt == null;
  if (user.email && isFinalAttempt) {
    EmailService.sendPaymentFailedEmail({
      recipientEmail: user.email,
      recipientName: user.name || undefined,
      amountCents: invoice.amount_due || 0,
      currency: invoice.currency || 'usd',
      frontendUrl: env.FRONTEND_URL || 'http://localhost:3000',
    })
      .then((result) => {
        if (!result.success) {
          logger.error('[STRIPE_WEBHOOK] Payment failed email not sent', {
            userId: user.id,
            invoiceId: invoice.id,
            error: result.error,
          });
        }
      })
      .catch((err) =>
        logger.error('[STRIPE_WEBHOOK] Failed to send payment failed email', {
          userId: user.id,
          invoiceId: invoice.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
  }
}

/**
 * GET /api/billing/status
 * Get billing status for current user
 */
export const getBillingStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    logger.info('[BILLING_STATUS] Getting billing status', { userId });

    // Get user with subscription info
    const { data: user } = await supabaseAdmin
      .from('users')
      .select(`
        plan,
        plan_status,
        stripe_price_id,
        current_period_end,
        cancel_at_period_end
      `)
      .eq('id', userId)
      .maybeSingle();

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    const { data: plan } = user.stripe_price_id
      ? await supabaseAdmin
          .from('plans')
          .select('credits_per_period')
          .eq('stripe_price_id', user.stripe_price_id)
          .maybeSingle()
      : { data: null };

    // Get credits balance
    const userCredits = await UserCreditsService.getOrCreateUserCredits(userId);

    const creditsPerPeriod = plan?.credits_per_period ?? 0;

    const resolvedPlan = plan ? 'pro' : user.plan || 'free';

    res.json({
      success: true,
      plan: resolvedPlan,
      plan_status: user.plan_status || null,
      stripe_price_id: user.stripe_price_id || null,
      credits_balance: userCredits.credits_balance,
      credits_per_period: creditsPerPeriod,
      current_period_end: user.current_period_end,
      cancel_at_period_end: user.cancel_at_period_end || false,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[BILLING_STATUS] Error getting billing status', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get billing status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * GET /api/billing/transactions
 * Get user's Stripe transactions
 */
export const getBillingTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('stripe_transactions')
      .select('created_at, stripe_invoice_id, amount, currency')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[BILLING_TRANSACTIONS] Error fetching transactions', {
        error: error.message,
        userId,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch transactions',
      });
      return;
    }

    const transactions = (data || []).map((item) => ({
      date: item.created_at,
      invoice: item.stripe_invoice_id,
      amount: item.currency === 'usd' ? (item.amount || 0) / 100 : (item.amount || 0) / 100,
      status: 'paid'
    }));

    res.json({
      success: true,
      transactions,
    });
  } catch (error) {
    logger.error('[BILLING_TRANSACTIONS] Error fetching transactions', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
