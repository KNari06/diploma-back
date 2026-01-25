import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import Stripe from 'stripe';

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

    logger.debug('[STRIPE_WEBHOOK] Unhandled event type', { type: event.type });
    // Handle different event types      
    await handleSubscriptionEvent(event);

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
  const customerId = subscription.customer as string;

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
  logger.info('[STRIPE_WEBHOOK] Subscription:', { subscription });
  // @ts-ignore
  logger.info('[STRIPE_WEBHOOK] Subscription:', subscription.lines.data[0].pricing.price_details.price);
  // Get price ID from subscription
  // @ts-ignore
  const priceId = subscription.lines.data[0].pricing.price_details.price;
  if (!priceId) {
    logger.error('[STRIPE_WEBHOOK] No price ID in subscription', {
      subscriptionId: subscription.id,
    });
    return;
  }

  // Get plan by stripe_price_id
  const { data: plan } = await supabaseAdmin
    .from('plans')
    .select('*')
    .eq('stripe_price_id', priceId)
    .maybeSingle();

  logger.info('[STRIPE_WEBHOOK] Plan:', { plan });
  if (!plan) {
    logger.error('[STRIPE_WEBHOOK] Plan not found for price', { priceId });
    return;
  }

  // Determine if user is pro
  logger.info('[STRIPE_WEBHOOK] Subscription status:', subscription.status);
  // const isPro =
  //   subscription.status === 'active' ||
  //   (subscription.cancel_at_period_end &&
  //     subscription.current_period_end > Math.floor(Date.now() / 1000));

  const creditsPerPeriod = plan.credits_per_period || 0;
  // @ts-ignore
  const isNowActive = subscription.status === 'active' || subscription.status === 'paid';

  // Get existing subscription to check previous status
  const { data: existingSubscription } = await supabaseAdmin
    .from('subscriptions')
    .select('status')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();

  const wasActive = existingSubscription?.status === 'active';
  const statusChangedToActive = !wasActive && isNowActive;

  // Upsert subscription record
  const subscriptionData = {
    user_id: user.id,
    customer_id: customerId,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    plan_code: plan.code,
    stripe_price_id: priceId,
    credits_per_period: creditsPerPeriod,
    // current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: false,
    updated_at: new Date().toISOString(),
  };

  await supabaseAdmin.from('subscriptions').upsert(subscriptionData, {
    onConflict: 'stripe_subscription_id',
  });

  // Update user plan
  await supabaseAdmin
    .from('users')
    .update({
      plan: 'pro',
      plan_status: subscription.status,
      // current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: false,
      stripe_price_id: priceId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);

  // Add credits when subscription becomes active (after successful payment)
  // This happens when:
  // 1. Subscription is created and immediately active
  // 2. Subscription status changes from non-active to active (payment succeeded)
  if (statusChangedToActive && creditsPerPeriod > 0) {
    logger.info('[STRIPE_WEBHOOK] Adding credits to user_credits', { userId: user.id, credits: creditsPerPeriod, subscriptionId: subscription.id, eventType: event.type });
    const result = await UserCreditsService.addCredits(
      user.id,
      creditsPerPeriod,
      'purchase',
      `Subscription payment - ${plan.code} plan`,
      { subscription_id: subscription.id, event_type: event.type }
    );

    if (result.success) {
      logger.info('[STRIPE_WEBHOOK] Credits added to user_credits after successful payment', {
        userId: user.id,
        credits: creditsPerPeriod,
        newBalance: result.newBalance,
        subscriptionId: subscription.id,
        eventType: event.type,
      });
    } else {
      logger.error('[STRIPE_WEBHOOK] Failed to add credits', {
        userId: user.id,
        credits: creditsPerPeriod,
        subscriptionId: subscription.id,
      });
    }
  }

  logger.info('[STRIPE_WEBHOOK] Subscription updated', {
    userId: user.id,
    planCode: plan.code,
    status: subscription.status,
    eventType: event.type,
  });
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
      .select('plan, plan_status, current_period_end, cancel_at_period_end, stripe_price_id')
      .eq('id', userId)
      .maybeSingle();

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    // Get credits balance
    const userCredits = await UserCreditsService.getOrCreateUserCredits(userId);

    res.json({
      success: true,
      plan: user.plan || 'free',
      plan_status: user.plan_status || 'inactive',
      credits_balance: userCredits.credits_balance,
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
