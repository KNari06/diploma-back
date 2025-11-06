/**
 * Pricing plans configuration
 */

export interface PricingPlan {
  id: string;
  name: string;
  description: string;
  credits: number;
  price: number;
  currency: string;
  features: string[];
  popular?: boolean;
  discount?: number;
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    description: 'Для знакомства с сервисом',
    credits: 0,
    price: 0,
    currency: 'USD',
    features: [
      '3 бесплатных запроса (без регистрации)',
      'Базовое тестирование API',
      'Доступ к чату с AI',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    description: 'Для небольших проектов',
    credits: 100,
    price: 9.99,
    currency: 'USD',
    features: [
      '100 кредитов',
      'API тестирование',
      'UI тестирование',
      'История запросов',
      'Email поддержка',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Для профессионалов',
    credits: 500,
    price: 39.99,
    currency: 'USD',
    popular: true,
    discount: 20,
    features: [
      '500 кредитов',
      'Приоритетная поддержка',
      'Расширенное API тестирование',
      'Playwright интеграция',
      'Autonomous тестирование',
      'Экспорт результатов',
      'Jira интеграция',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Для команд и компаний',
    credits: 2000,
    price: 129.99,
    currency: 'USD',
    discount: 30,
    features: [
      '2000 кредитов',
      'Все функции Pro',
      'Приоритетная поддержка 24/7',
      'Кастомные интеграции',
      'Dedicated менеджер',
      'SLA гарантии',
      'Тренинги для команды',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Индивидуальные решения',
    credits: -1, // unlimited
    price: -1, // custom pricing
    currency: 'USD',
    features: [
      'Неограниченные кредиты',
      'Все функции Business',
      'On-premise deployment',
      'Custom SLA',
      'Персональный аккаунт менеджер',
      'Кастомная разработка',
      'Security audit',
    ],
  },
];

/**
 * Get plan by ID
 */
export function getPlanById(planId: string): PricingPlan | undefined {
  return PRICING_PLANS.find((p) => p.id === planId);
}

/**
 * Get plan price with discount
 */
export function getPlanPrice(planId: string): number {
  const plan = getPlanById(planId);
  if (!plan || plan.price === -1) return 0;

  if (plan.discount) {
    return plan.price * (1 - plan.discount / 100);
  }

  return plan.price;
}
