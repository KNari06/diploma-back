import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { WorkspaceCreditsService } from '@/services/core/workspace-credits.service';
import { SUBSCRIPTION_PLANS } from '@/services/core/token-calculator.service';
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
    .select('id')
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
  const latestInvoiceId =
    typeof subscription.latest_invoice === 'string'
      ? subscription.latest_invoice
      : subscription.latest_invoice?.id || null;

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

  // Update user plan
  const userUpdateData: Record<string, any> = {
    plan: isActive ? 'pro' : 'free',
    plan_status: isActive ? 'paid' : null,
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
    last_credits_invoice_id: latestInvoiceId,
    updated_at: new Date().toISOString(),
  };

  if (isActive && plan?.id) {
    userUpdateData.plan_id = plan.id;
  } else if (!isActive) {
    userUpdateData.plan_id = null;
  }

  await supabaseAdmin
    .from('users')
    .update(userUpdateData)
    .eq('id', user.id);

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
    .select('id, last_credits_invoice_id, stripe_price_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!user) {
    logger.warn('[STRIPE_WEBHOOK] User not found for customer', { customerId });
    return;
  }

  const { data: existingTransaction, error: existingTransactionError } = await supabaseAdmin
    .from('stripe_transactions')
    .select('id')
    .or(`stripe_invoice_id.eq.${invoice.id},stripe_event_id.eq.${event.id}`)
    .maybeSingle();

  if (existingTransactionError) {
    logger.error('[STRIPE_WEBHOOK] Failed to check transaction duplicate', {
      invoiceId: invoice.id,
      eventId: event.id,
      error: existingTransactionError.message,
    });
  }

  if (existingTransaction) {
    logger.info('[STRIPE_WEBHOOK] Duplicate transaction ignored', {
      invoiceId: invoice.id,
      eventId: event.id,
      userId: user.id,
    });
    return;
  }

  if (user.last_credits_invoice_id === invoice.id) {
    logger.info('[STRIPE_WEBHOOK] Invoice already processed', {
      userId: user.id,
      invoiceId: invoice.id,
    });
    return;
  }

  let priceId =
    invoice.lines?.data?.[0]?.price?.id ||
    // @ts-ignore
    invoice.lines?.data?.[0]?.pricing?.price_details?.price?.id ||
    null;

  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id ||
        // @ts-ignore
        invoice.parent?.subscription_details?.subscription ||
        null;

  if (!priceId && subscriptionId) {
    if (!stripe) {
      logger.error('[STRIPE_WEBHOOK] Stripe not configured');
      return;
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
      priceId = subscription.items?.data?.[0]?.price?.id;
    } catch (error) {
      logger.error('[STRIPE_WEBHOOK] Failed to fetch subscription for price', {
        subscriptionId,
        error,
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

  if (!plan && priceId) {
    logger.warn('[STRIPE_WEBHOOK] Plan not found for price', { priceId });
  }

  const creditsPerPeriod = plan?.credits_per_period || 0;
  const planCode = plan?.code || 'unknown';
  const subscriptionPlanLabel = plan?.name || plan?.code || 'pro';

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

  const { error: transactionError } = await supabaseAdmin
    .from('stripe_transactions')
    .upsert(transactionData, { onConflict: 'stripe_invoice_id' });

  if (transactionError) {
    logger.error('[STRIPE_WEBHOOK] Failed to save transaction', {
      invoiceId: invoice.id,
      userId: user.id,
      error: transactionError.message,
    });
  } else {
    logger.info('[STRIPE_WEBHOOK] Transaction saved', {
      invoiceId: invoice.id,
      userId: user.id,
      amount: transactionData.amount,
      currency: transactionData.currency,
    });
  }

  if (creditsPerPeriod > 0) {
    logger.info('[STRIPE_WEBHOOK] Adding credits on invoice payment', {
      userId: user.id,
      credits: creditsPerPeriod,
      invoiceId: invoice.id,
    });

    const result = await UserCreditsService.addCredits(
      user.id,
      creditsPerPeriod,
      'purchase',
      `Subscription payment - ${planCode} plan`,
      { invoice_id: invoice.id, event_type: event.type }
    );

    if (result.success) {
      logger.info('[STRIPE_WEBHOOK] Credits added after invoice payment', {
        userId: user.id,
        credits: creditsPerPeriod,
        newBalance: result.newBalance,
        invoiceId: invoice.id,
      });
    } else {
      logger.error('[STRIPE_WEBHOOK] Failed to add credits', {
        userId: user.id,
        credits: creditsPerPeriod,
        invoiceId: invoice.id,
      });
    }
  }

  // Provision workspace credits for Business plan
  const isBusinessPlan = planCode === 'business' || planCode === 'Business';
  if (isBusinessPlan) {
    try {
      // Find the workspace where this user is the owner
      const { data: ownerMembership } = await supabaseAdmin
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .eq('role', 'owner')
        .eq('status', 'active')
        .maybeSingle();

      if (ownerMembership) {
        const workspaceId = ownerMembership.workspace_id;
        const businessCredits = SUBSCRIPTION_PLANS.business.credits; // 30,000

        // Reset monthly usage and provision fresh credits
        const wsCredits = await WorkspaceCreditsService.getOrCreateWorkspaceCredits(workspaceId);
        const now = new Date();

        const { error: wsUpdateError } = await supabaseAdmin
          .from('workspace_credits')
          .update({
            credits_balance: businessCredits,
            credits_used_this_period: 0,
            monthly_credit_limit: businessCredits,
            period_start_date: now.toISOString().split('T')[0],
            warning_80_sent: false,
            warning_95_sent: false,
            subscription_plan: 'business',
            subscription_status: 'active',
            credits_purchased_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq('workspace_id', workspaceId);

        if (wsUpdateError) {
          logger.error('[STRIPE_WEBHOOK] Failed to provision business plan workspace credits', {
            error: wsUpdateError.message,
            workspaceId,
            userId: user.id,
          });
        } else {
          // Record the provisioning transaction
          await supabaseAdmin.from('workspace_credit_transactions').insert({
            workspace_id: workspaceId,
            user_id: user.id,
            amount: businessCredits,
            balance_after: businessCredits,
            transaction_type: 'purchase',
            description: `Business plan subscription payment`,
            metadata: {
              invoice_id: invoice.id,
              event_type: event.type,
              plan_code: planCode,
              type: 'business_plan_renewal',
              previous_balance: wsCredits.credits_balance,
              previous_used: wsCredits.credits_used_this_period || 0,
            },
          });

          logger.info('[STRIPE_WEBHOOK] Business plan workspace credits provisioned', {
            workspaceId,
            userId: user.id,
            credits: businessCredits,
            invoiceId: invoice.id,
          });
        }
      } else {
        logger.warn('[STRIPE_WEBHOOK] No owned workspace found for business plan user', {
          userId: user.id,
          invoiceId: invoice.id,
        });
      }
    } catch (wsError) {
      logger.error('[STRIPE_WEBHOOK] Exception provisioning business plan workspace credits', {
        error: wsError instanceof Error ? wsError.message : String(wsError),
        userId: user.id,
        invoiceId: invoice.id,
      });
      // Don't fail the webhook - user credits were already handled
    }
  }

  const userUpdateData: Record<string, any> = {
    last_credits_invoice_id: invoice.id,
    updated_at: new Date().toISOString(),
    subscription: {
      plan: subscriptionPlanLabel,
      status: 'active',
      credits_included: creditsPerPeriod,
    },
  };

  if (plan?.id) {
    userUpdateData.plan_id = plan.id;
    userUpdateData.plan = isBusinessPlan ? 'business' : 'pro';
    userUpdateData.plan_status = 'paid';
  }

  if (priceId) {
    userUpdateData.stripe_price_id = priceId;
  }

  await supabaseAdmin.from('users').update(userUpdateData).eq('id', user.id);
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
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (!user) {
    logger.warn('[STRIPE_WEBHOOK] User not found for customer', { customerId });
    return;
  }

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
