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
  // English - auth/session/common blockers
  'unauthorized', 'forbidden', 'expired', 'timeout', 'timed out', 'blocked',
  'too many attempts', 'rate limit', 'captcha', '2fa', 'otp',
  // Russian
  'ошибка', 'предупреждение', 'неверно', 'некорректно', 'отказ',
  'неправильно', 'обязательно', 'отсутствует',
  // Russian - auth/session/common blockers
  'не удалось', 'доступ запрещен', 'нет доступа', 'истек', 'истекло',
  'таймаут', 'превышено', 'заблокирован', 'слишком много попыток',
  'капча', 'подтвердите', 'код подтверждения', 'одноразовый код',
  // Kazakh (KZ)
  'қате', 'қателік', 'дұрыс емес', 'міндетті', 'толтырылмаған',
  'сәтсіз', 'ескерту',
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
  // English - additional high-signal actions
  'verify', 'approve', 'accept', 'agree', 'finish', 'done',
  'start', 'launch', 'open', 'close', 'dismiss',
  'reset', 'change', 'retry', 'try again',
  // English - multi-word (matched as token sequences)
  'sign up', 'sign in', 'log in', 'log out', 'sign out',
  // Russian - core actions
  'войти', 'зарегистрироваться', 'оплатить', 'подтвердить',
  'сохранить', 'отправить', 'далее', 'продолжить', 'создать',
  'добавить', 'удалить', 'обновить', 'применить',
  // Russian - additional high-signal actions
  'подтверждаю', 'принять', 'согласиться', 'разрешить',
  'начать', 'завершить', 'готово', 'проверить',
  'сбросить', 'сменить', 'повторить', 'попробовать снова',
  // Kazakh (KZ) - core actions
  'кіру', 'тіркелу', 'төлеу', 'растау', 'сақтау', 'жіберу',
  'жалғастыру', 'келесі', 'қосу', 'жою', 'жаңарту',
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
  'help', 'support', 'faq', 'contact', 'about',
  'pricing', 'plans', 'billing', 'docs', 'documentation',
  'terms', 'privacy',
  // Russian
  'профиль', 'аккаунт', 'кабинет', 'меню', 'настройки', 'главная',
  'помощь', 'поддержка', 'вопросы', 'контакты', 'о нас',
  'цены', 'тарифы', 'оплата', 'документы', 'документация',
  'условия', 'политика',
  // Kazakh (KZ) - minimal, high-confidence only
  'жеке кабинет', 'профиль', 'параметрлер', 'басты бет',
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
  login: [
    'login', 'logon', 'sign in', 'signin', 'log in',
    'auth', 'authenticate', 'authorization', 'session',
    'password', 'username',
  ],
  register: [
    'register', 'sign up', 'signup', 'create account', 'create profile',
    'join', 'new account',
  ],
  checkout: [
    'checkout', 'payment', 'pay', 'order', 'purchase', 'buy',
    'cart', 'basket', 'billing', 'shipping', 'delivery', 'address',
    'place order',
  ],
  search: ['search', 'find', 'look for', 'query', 'lookup', 'filter', 'sort'],
  profile: ['profile', 'account', 'my account', 'settings', 'preferences', 'personal info'],
  logout: ['logout', 'sign out', 'log out', 'signoff', 'exit'],
  // Russian
  вход: ['вход', 'войти', 'авторизация', 'логин', 'авторизоваться', 'войти в аккаунт'],
  регистрация: ['регистрация', 'зарегистрироваться', 'создать аккаунт', 'новый аккаунт', 'создать профиль'],
  оплата: [
    'оплата', 'заказ', 'купить', 'корзина', 'оформить', 'оформление',
    'платёж', 'платеж', 'доставка', 'адрес', 'оформление заказа',
  ],
  поиск: ['поиск', 'найти', 'искать', 'фильтр', 'сортировка'],
  профиль: ['профиль', 'аккаунт', 'кабинет', 'настройки', 'личные данные'],
  выход: ['выход', 'выйти', 'выйти из аккаунта'],
  // Kazakh (KZ)
  кіру: ['кіру', 'жүйеге кіру', 'авторизация', 'логин'],
  тіркелу: ['тіркелу', 'тіркеу', 'аккаунт ашу', 'жаңа аккаунт'],
  төлем: ['төлем', 'төлеу', 'тапсырыс', 'себет', 'сатып алу', 'ресімдеу'],
  іздеу: ['іздеу', 'табу', 'қарау'],
  профиль_kz: ['жеке кабинет', 'профиль', 'параметрлер'],
  шығу: ['шығу', 'шығып кету', 'жүйеден шығу'],
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// DECORATIVE KEYWORDS (Weight 0.05)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keywords that indicate decorative/low-importance elements
 */
export const DECORATIVE_KEYWORDS = [
  // English
  'icon', 'social', 'footer', 'copyright', 'logo', 'banner',
  // Russian
  'иконка', 'соцсети', 'футер', 'копирайт', 'логотип', 'баннер',
  // Kazakh (KZ) - minimal
  'белгіше', 'логотип', 'төменгі колонтитул',
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
    'billing', 'shipping', 'delivery', 'address',
    'оплата', 'заказ', 'подтвержд', 'оформл', 'доставка', 'адрес',
    // KZ (high-confidence only)
    'төлем', 'тапсырыс', 'растау',
  ],
  /** Pre-action phase: cart, review, summary */
  pre_action: [
    'cart', 'basket', 'bag', 'review', 'summary',
    'корзина', 'итого', 'проверк', 'обзор', 'сводка',
    // KZ
    'себет', 'қорытынды',
  ],
  /** Selection phase: product details, item view */
  selection: [
    'product', 'item', 'detail', 'view', 'catalog', 'category',
    'товар', 'продукт', 'каталог', 'категория',
    // KZ
    'тауар', 'өнім',
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
    'buy', 'purchase',
    'в корзину', 'купить', 'добавить', 'добавить в корзину',
    // KZ
    'себетке қосу', 'сатып алу',
  ],
  /** Checkout/proceed buttons */
  checkout: [
    'checkout', 'proceed', 'continue to', 'place order',
    'review order', 'go to checkout',
    'оформить', 'продолжить', 'заказать', 'перейти к оплате', 'оформление заказа',
    // KZ
    'ресімдеу', 'жалғастыру', 'тапсырыс беру',
  ],
  /** Submit/confirm buttons */
  submit: [
    'submit', 'confirm', 'pay', 'complete', 'send', 'finish',
    'save', 'done', 'approve', 'verify',
    'отправить', 'подтвердить', 'оплатить', 'завершить', 'сохранить', 'готово',
    // KZ
    'жіберу', 'растау', 'төлеу', 'аяқтау',
  ],
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export type ErrorKeyword = typeof ERROR_KEYWORDS[number];
export type PrimaryActionKeyword = typeof PRIMARY_ACTION_KEYWORDS[number];
export type NavigationKeyword = typeof NAVIGATION_KEYWORDS[number];
export type DecorativeKeyword = typeof DECORATIVE_KEYWORDS[number];
