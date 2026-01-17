/**
 * Semantic Keywords Configuration
 *
 * Centralized keyword lists for semantic weight heuristics in Lite mode.
 * These are used as a FAST PATH before AI audit for gray zone elements.
 *
 * All keywords are normalized and matched via token/boundary-aware matching
 * to prevent false positives (e.g. "catalog" should NOT match "log").
 */

// ═══════════════════════════════════════════════════════════════════════════
// ERROR DETECTION KEYWORDS (Weight 0.95 - Highest Priority)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keywords that indicate an error/alert/warning element
 * NOTE: ARIA role="alert" takes precedence (checked before keywords)
 */
export const ERROR_KEYWORDS = [
  // English
  'error', 'alert', 'warning', 'danger', 'invalid', 'failed', 'failure',
  'incorrect', 'wrong', 'required', 'missing', 'validation',
  // Russian
  'ошибка', 'предупреждение', 'неверно', 'некорректно', 'отказ',
  'неправильно', 'обязательно', 'отсутствует',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// PRIMARY ACTION KEYWORDS (Weight 0.9)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keywords that indicate a primary action button (Submit, Login, Pay, etc.)
 * Used for fast-path heuristic before AI audit
 */
export const PRIMARY_ACTION_KEYWORDS = [
  // English - core actions
  'submit', 'login', 'pay', 'register', 'checkout', 'order',
  'confirm', 'save', 'send', 'continue', 'next', 'create',
  'add', 'delete', 'remove', 'update', 'apply', 'proceed',
  // English - multi-word (matched as token sequences)
  'sign up', 'sign in', 'log in', 'log out', 'sign out',
  // Russian - core actions
  'войти', 'зарегистрироваться', 'оплатить', 'подтвердить',
  'сохранить', 'отправить', 'далее', 'продолжить', 'создать',
  'добавить', 'удалить', 'обновить', 'применить',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION KEYWORDS (Weight 0.5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keywords that indicate navigation links (Profile, Account, etc.)
 */
export const NAVIGATION_KEYWORDS = [
  // English
  'profile', 'account', 'menu', 'settings', 'dashboard', 'home',
  // Russian
  'профиль', 'аккаунт', 'кабинет', 'меню', 'настройки', 'главная',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// GOAL SYNONYM MAP (for parseGoalKeywords)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maps goal categories to their synonym keywords
 * Used to expand user's goal text into relevant keywords for dynamic priority
 */
export const GOAL_KEYWORD_MAP: Record<string, readonly string[]> = {
  // English
  login: ['login', 'sign in', 'signin', 'log in', 'auth', 'authenticate'],
  register: ['register', 'sign up', 'signup', 'create account', 'join', 'new account'],
  checkout: ['checkout', 'payment', 'pay', 'order', 'purchase', 'buy', 'cart', 'basket'],
  search: ['search', 'find', 'look for', 'query', 'lookup'],
  profile: ['profile', 'account', 'settings', 'preferences'],
  logout: ['logout', 'sign out', 'log out', 'exit'],
  // Russian
  вход: ['вход', 'войти', 'авторизация', 'логин', 'авторизоваться'],
  регистрация: ['регистрация', 'зарегистрироваться', 'создать аккаунт', 'новый аккаунт'],
  оплата: ['оплата', 'заказ', 'купить', 'корзина', 'оформить', 'платёж'],
  поиск: ['поиск', 'найти', 'искать'],
  профиль: ['профиль', 'аккаунт', 'настройки'],
  выход: ['выход', 'выйти'],
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// DECORATIVE KEYWORDS (Weight 0.05)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keywords that indicate decorative/low-importance elements
 */
export const DECORATIVE_KEYWORDS = [
  'icon', 'social', 'footer', 'copyright', 'logo', 'banner',
  'иконка', 'соцсети', 'футер', 'копирайт', 'логотип', 'баннер',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// FUNNEL ANALYSIS PATTERNS (for FunnelAnalyzer)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * URL patterns for detecting funnel phases
 * Used by FunnelAnalyzer to determine user journey stage from page URL
 */
export const FUNNEL_URL_PATTERNS = {
  /** Conversion phase: checkout, payment, final submission */
  conversion: [
    'checkout', 'payment', 'pay', 'confirm', 'order', 'complete',
    'оплата', 'заказ', 'подтвержд', 'оформл',
  ],
  /** Pre-action phase: cart, review, summary */
  pre_action: [
    'cart', 'basket', 'bag', 'review', 'summary',
    'корзина', 'итого', 'проверк',
  ],
  /** Selection phase: product details, item view */
  selection: [
    'product', 'item', 'detail', 'view',
    'товар', 'продукт',
  ],
} as const;

/**
 * Element text patterns for categorizing buttons/links
 * Used by FunnelAnalyzer.categorizeElement() and phase detection
 */
export const FUNNEL_ELEMENT_PATTERNS = {
  /** Add to cart buttons */
  add_to_cart: [
    'add to cart', 'add to bag', 'buy now', 'add to basket',
    'в корзину', 'купить', 'добавить',
  ],
  /** Checkout/proceed buttons */
  checkout: [
    'checkout', 'proceed', 'continue to', 'place order',
    'оформить', 'продолжить', 'заказать',
  ],
  /** Submit/confirm buttons */
  submit: [
    'submit', 'confirm', 'pay', 'complete', 'send', 'finish',
    'отправить', 'подтвердить', 'оплатить', 'завершить',
  ],
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export type ErrorKeyword = typeof ERROR_KEYWORDS[number];
export type PrimaryActionKeyword = typeof PRIMARY_ACTION_KEYWORDS[number];
export type NavigationKeyword = typeof NAVIGATION_KEYWORDS[number];
export type DecorativeKeyword = typeof DECORATIVE_KEYWORDS[number];
