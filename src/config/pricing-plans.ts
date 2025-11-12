/**
 * Enhanced Pricing Plans Configuration
 */

export type PlanType = 'free' | 'paid' | 'custom';
export type BillingPeriod = 'monthly' | 'yearly' | 'custom';
export type Currency = 'USD' | 'EUR' | 'KZT';

export interface CreditOption {
  credits: number; // -1 for unlimited
  price: number; // -1 for custom
  price_per_credit: number;
  is_default: boolean;
  billing_period: BillingPeriod;
  description: string;
  savings?: number;
}

export interface ContactInfo {
  email: string;
  phone: string;
  calendar_link: string;
}

export interface PricingPlan {
  id: string;
  name: string;
  description: string;
  type: PlanType;
  popular: boolean;
  discount: number;
  currency: Currency;
  features: string[];
  credit_options: CreditOption[];
  limitations: string[];
  contact_required?: boolean;
  contact_info?: ContactInfo;
}

export interface PricingMetadata {
  count: number;
  currency_options: Currency[];
  billing_periods: BillingPeriod[];
  last_updated: string;
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free Plan',
    description: 'Perfect for trying out QAIT',
    type: 'free',
    popular: false,
    discount: 0,
    currency: 'USD',
    features: [
      '5 AI-powered questions per day',
      'Basic document analysis',
      'Email support',
      'Standard response time',
    ],
    credit_options: [
      {
        credits: 150,
        price: 0,
        price_per_credit: 0,
        is_default: true,
        billing_period: 'monthly',
        description: '150 free credits monthly',
      },
    ],
    limitations: [
      'Limited to 5 questions per day',
      'Basic features only',
    ],
  },
  {
    id: 'pro',
    name: 'Pro Plan',
    description: 'For professionals and small teams',
    type: 'paid',
    popular: true,
    discount: 15,
    currency: 'USD',
    features: [
      'Unlimited AI questions',
      'Advanced document analysis',
      'Priority email support',
      'Fast response time',
      'Export results',
      'API access',
    ],
    credit_options: [
      {
        credits: 1000,
        price: 39,
        price_per_credit: 0.039,
        is_default: true,
        billing_period: 'monthly',
        description: '1,000 credits - Most popular',
        savings: 0,
      },
      {
        credits: 1500,
        price: 55,
        price_per_credit: 0.037,
        is_default: false,
        billing_period: 'monthly',
        description: '1,500 credits - Better value',
        savings: 3,
      },
      {
        credits: 2000,
        price: 69,
        price_per_credit: 0.035,
        is_default: false,
        billing_period: 'monthly',
        description: '2,000 credits - Great value',
        savings: 9,
      },
      {
        credits: 2500,
        price: 85,
        price_per_credit: 0.034,
        is_default: false,
        billing_period: 'monthly',
        description: '2,500 credits - Excellent value',
        savings: 12,
      },
      {
        credits: 3000,
        price: 99,
        price_per_credit: 0.033,
        is_default: false,
        billing_period: 'monthly',
        description: '3,000 credits - Best value',
        savings: 18,
      },
    ],
    limitations: [],
  },
  {
    id: 'business',
    name: 'Business Plan',
    description: 'For growing businesses and teams',
    type: 'paid',
    popular: false,
    discount: 20,
    currency: 'USD',
    features: [
      'Everything in Pro',
      'Team collaboration',
      'Advanced analytics',
      'Custom integrations',
      'Dedicated support',
      'SLA guarantee',
      'White-label options',
    ],
    credit_options: [
      {
        credits: 5000,
        price: 159,
        price_per_credit: 0.032,
        is_default: true,
        billing_period: 'monthly',
        description: '5,000 credits - Team starter',
        savings: 20,
      },
      {
        credits: 10000,
        price: 299,
        price_per_credit: 0.030,
        is_default: false,
        billing_period: 'monthly',
        description: '10,000 credits - Team standard',
        savings: 25,
      },
      {
        credits: 15000,
        price: 399,
        price_per_credit: 0.027,
        is_default: false,
        billing_period: 'monthly',
        description: '15,000 credits - Team premium',
        savings: 35,
      },
      {
        credits: 25000,
        price: 599,
        price_per_credit: 0.024,
        is_default: false,
        billing_period: 'monthly',
        description: '25,000 credits - Enterprise ready',
        savings: 45,
      },
    ],
    limitations: [],
  },
  {
    id: 'enterprise',
    name: 'Enterprise Plan',
    description: 'Custom solutions for large organizations',
    type: 'custom',
    popular: false,
    discount: 0,
    currency: 'USD',
    features: [
      'Everything in Business',
      'Unlimited credits',
      'Custom deployment',
      'Advanced security',
      '24/7 phone support',
      'Custom training',
      'Dedicated account manager',
    ],
    credit_options: [
      {
        credits: -1,
        price: -1,
        price_per_credit: 0,
        is_default: true,
        billing_period: 'custom',
        description: 'Unlimited credits - Custom pricing',
        savings: 0,
      },
    ],
    limitations: [],
    contact_required: true,
    contact_info: {
      email: 'enterprise@qait.ai',
      phone: '+1-555-QAIT-ENT',
      calendar_link: 'https://calendly.com/qait-enterprise',
    },
  },
];

export const PRICING_METADATA: PricingMetadata = {
  count: PRICING_PLANS.length,
  currency_options: ['USD', 'EUR', 'KZT'],
  billing_periods: ['monthly', 'yearly', 'custom'],
  last_updated: '2025-11-11T20:00:00.000Z', // Update this when pricing changes
};

/**
 * Get plan by ID
 */
export function getPlanById(planId: string): PricingPlan | undefined {
  return PRICING_PLANS.find((p) => p.id === planId);
}

/**
 * Get default credit option for a plan
 */
export function getDefaultCreditOption(planId: string): CreditOption | undefined {
  const plan = getPlanById(planId);
  return plan?.credit_options.find((opt) => opt.is_default);
}

/**
 * Filter plans by currency
 */
export function filterPlansByCurrency(currency: Currency): PricingPlan[] {
  return PRICING_PLANS.filter((plan) => plan.currency === currency);
}

/**
 * Filter plans by billing period
 */
export function filterPlansByBillingPeriod(billingPeriod: BillingPeriod): PricingPlan[] {
  return PRICING_PLANS.filter((plan) =>
    plan.credit_options.some((opt) => opt.billing_period === billingPeriod)
  );
}
