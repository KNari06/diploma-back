/**
 * PreActionAnalyzer
 *
 * Phase 1 of UI Tester Intelligence:
 * Analyzes page state BEFORE executing actions to prevent failures
 *
 * Responsibilities:
 * 1. Check element state (disabled, hidden, loading)
 * 2. Detect blocking factors (empty required fields, validation errors)
 * 3. Suggest prerequisite actions (fill fields before submit)
 * 4. Read and understand validation messages
 */

import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { OpenAI } from 'openai';
import { Page } from 'playwright';
import { DynamicAction } from '../types/intelligent-testing.types';
import { getLocator, normalizeSelector } from '../utils/selectors/selector-utils';

// Lazy import to avoid circular dependency
let FormIntelligenceService: typeof import('../execution/form-intelligence.service').FormIntelligenceService | null = null;
async function getFormIntelligence() {
  if (!FormIntelligenceService) {
    const module = await import('../execution/form-intelligence.service');
    FormIntelligenceService = module.FormIntelligenceService;
  }
  return FormIntelligenceService;
}

// ═══════════════════════════════════════════════════════════════════════════
// AI CLIENT (for fallback when rule-based fails)
// ═══════════════════════════════════════════════════════════════════════════

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 10000, // Fast timeout for quick decisions
  maxRetries: 1,
});

// ═══════════════════════════════════════════════════════════════════════════
// AI WRAPPER - Unified AI calls with error handling
// ═══════════════════════════════════════════════════════════════════════════

interface AICallOptions {
  model?: 'gpt-4o-mini' | 'gpt-4o';
  maxTokens?: number;
  temperature?: number;
  systemPrompt: string;
  userPrompt: string;
  cacheKey?: string;
  cacheMap?: Map<string, { result: string; timestamp: number }>;
}

/**
 * Unified AI call wrapper with:
 * - Timeout handling
 * - Error recovery
 * - Caching
 * - Sanitized logging
 */
async function callAI(options: AICallOptions): Promise<string | null> {
  const {
    model = 'gpt-4o-mini',
    maxTokens = 50,
    temperature = 0,
    systemPrompt,
    userPrompt,
    // cacheKey and cacheMap are intentionally unused (cache is disabled)
    // cacheKey,
    // cacheMap,
  } = options;

  // ═══════════════════════════════════════════════════════════════════════════
  // 🚫 CACHE DISABLED: In-Memory AI Cache (pre-action-analyzer)
  // ═══════════════════════════════════════════════════════════════════════════
  // TODO: Uncomment to enable AI call caching
  // Check cache
  // if (cacheKey && cacheMap) {
  //   const cached = cacheMap.get(cacheKey);
  //   if (cached && Date.now() - cached.timestamp < AI_CACHE_TTL) {
  //     logger.debug('[AI_WRAPPER] Cache hit', { cacheKey: cacheKey.substring(0, 30) + '...' });
  //     return cached.result;
  //   }
  // }

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const result = response.choices[0]?.message?.content?.trim() || null;

    // ═══════════════════════════════════════════════════════════════════════════
    // 🚫 CACHE DISABLED: In-Memory AI Cache Save
    // ═══════════════════════════════════════════════════════════════════════════
    // TODO: Uncomment to enable saving AI results to cache
    // Cache result
    // if (result && cacheKey && cacheMap) {
    //   cacheMap.set(cacheKey, { result, timestamp: Date.now() });
    // }

    return result;
  } catch (error) {
    // Don't log full error - may contain sensitive data
    logger.debug('[AI_WRAPPER] AI call failed', {
      model,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - Extensible patterns for rule-based detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Submit button keywords by language
 * Easy to extend with new languages/keywords
 */
const SUBMIT_BUTTON_KEYWORDS: Record<string, string[]> = {
  en: [
    'submit', 'sign in', 'sign up', 'log in', 'login', 'register',
    'create', 'send', 'save', 'continue', 'proceed', 'next', 'confirm',
    'done', 'finish', 'complete', 'apply', 'ok', 'yes', 'go', 'start',
    'buy', 'order', 'checkout', 'pay', 'subscribe', 'join', 'add',
  ],
  ru: [
    'войти', 'вход', 'регистрация', 'зарегистрироваться', 'отправить',
    'сохранить', 'продолжить', 'далее', 'подтвердить', 'готово',
    'завершить', 'применить', 'да', 'ок', 'начать', 'купить',
    'заказать', 'оформить', 'оплатить', 'подписаться', 'добавить',
  ],
  de: ['absenden', 'anmelden', 'registrieren', 'weiter', 'speichern', 'bestätigen'],
  es: ['enviar', 'iniciar sesión', 'registrarse', 'continuar', 'guardar', 'confirmar'],
  fr: ['envoyer', 'connexion', 'inscription', 'continuer', 'sauvegarder', 'confirmer'],
  zh: ['提交', '登录', '注册', '继续', '保存', '确认'],
  ja: ['送信', 'ログイン', '登録', '続ける', '保存', '確認'],
  ko: ['제출', '로그인', '가입', '계속', '저장', '확인'],
};

// NOTE: Disabled/loading class pattern constants were removed (unused; caused lint errors).

/**
 * CSS class patterns for error/invalid state
 */
const ERROR_CLASS_PATTERNS = [
  'error', 'is-error', 'has-error', 'invalid', 'is-invalid',
  'field-error', 'input-error', 'form-error',
  'Mui-error', 'ant-form-item-has-error',
  'border-red', 'text-red', 'text-danger',
];

/**
 * Error message container selectors
 */
const ERROR_SELECTORS = [
  '.error-message', '.error', '.invalid-feedback', '.form-error',
  '.validation-error', '.field-error', '.help-block.error',
  '[role="alert"]', '.alert-danger', '.alert-error',
  '.text-danger', '.text-red-500', '.text-red-600',
  '.Mui-error', '.MuiFormHelperText-root.Mui-error',
  '.ant-form-item-explain-error',
];

/**
 * Field type detection patterns
 */
const FIELD_TYPE_PATTERNS: Record<string, { patterns: string[]; type: string }> = {
  email: {
    patterns: ['email', 'e-mail', 'почта', 'почт', 'correo', 'メール', '이메일', '邮箱'],
    type: 'email',
  },
  password: {
    patterns: ['password', 'пароль', 'парол', 'contraseña', 'mot de passe', 'パスワード', '비밀번호', '密码'],
    type: 'password',
  },
  phone: {
    patterns: ['phone', 'tel', 'mobile', 'телефон', 'мобильный', 'teléfono', '電話', '전화', '手机'],
    type: 'tel',
  },
  name: {
    patterns: ['name', 'имя', 'nombre', 'nom', '名前', '이름', '姓名'],
    type: 'text',
  },
  firstName: {
    patterns: ['first name', 'firstname', 'имя', 'prénom', 'vorname', '名', '이름'],
    type: 'text',
  },
  lastName: {
    patterns: ['last name', 'lastname', 'surname', 'фамилия', 'nom', 'nachname', '姓', '성'],
    type: 'text',
  },
  username: {
    patterns: ['username', 'user name', 'login', 'логин', 'usuario', 'ユーザー名', '用户名'],
    type: 'text',
  },
  url: {
    patterns: ['url', 'website', 'site', 'сайт', 'sitio', 'サイト', '网址'],
    type: 'url',
  },
  company: {
    patterns: ['company', 'organization', 'компания', 'организация', 'empresa', '会社', '公司'],
    type: 'text',
  },
  address: {
    patterns: ['address', 'адрес', 'dirección', 'adresse', '住所', '주소', '地址'],
    type: 'text',
  },
  city: {
    patterns: ['city', 'город', 'ciudad', 'ville', '都市', '도시', '城市'],
    type: 'text',
  },
  country: {
    patterns: ['country', 'страна', 'país', 'pays', '国', '나라', '国家'],
    type: 'text',
  },
  zip: {
    patterns: ['zip', 'postal', 'postcode', 'индекс', 'código postal', '郵便番号', '우편번호', '邮编'],
    type: 'text',
  },
};

/**
 * Test value generators by field type
 */
const TEST_VALUES: Record<string, () => string> = {
  email: () => `test.user.${Date.now()}@example.com`,
  password: () => 'TestPassword123!',
  tel: () => '+1234567890',
  text: () => 'Test Value',
  firstName: () => 'John',
  lastName: () => 'Doe',
  fullName: () => 'John Doe',
  username: () => `testuser_${Date.now()}`,
  url: () => 'https://example.com',
  number: () => '42',
  date: () => new Date().toISOString().split('T')[0],
  company: () => 'Test Company Inc.',
  address: () => '123 Test Street',
  city: () => 'Test City',
  country: () => 'United States',
  zip: () => '12345',
};

// ═══════════════════════════════════════════════════════════════════════════
// AI CACHE - Prevent repeated AI calls for same questions
// ✅ IMPROVED: Namespace support for parallel tests, normalized cache keys
// ═══════════════════════════════════════════════════════════════════════════

interface AICache {
  isSubmitButton: Map<string, { result: boolean; timestamp: number }>;
  fieldType: Map<string, { result: string; timestamp: number }>;
}

const aiCache: AICache = {
  isSubmitButton: new Map(),
  fieldType: new Map(),
};

const AI_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ✅ IMPROVED: Current namespace for parallel test isolation
let currentCacheNamespace = '';

/**
 * Set cache namespace for test isolation
 * Call this at the start of each test run
 */
export function setCacheNamespace(namespace: string): void {
  currentCacheNamespace = namespace;
}

/**
 * Clear cache for current namespace or all
 */
export function clearCache(namespaceOnly = true): void {
  if (namespaceOnly && currentCacheNamespace) {
    // Clear only entries with current namespace
    for (const cache of [aiCache.isSubmitButton, aiCache.fieldType]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${currentCacheNamespace}|`)) {
          cache.delete(key);
        }
      }
    }
  } else {
    // Clear all
    aiCache.isSubmitButton.clear();
    aiCache.fieldType.clear();
  }
}

/**
 * ✅ IMPROVED: Normalize cache key - trim, collapse whitespace, add namespace
 */
function normalizeCacheKey(key: string): string {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' '); // Collapse multiple whitespace to single space

  return currentCacheNamespace
    ? `${currentCacheNamespace}|${normalized}`
    : normalized;
}

function getCachedResult<T>(cache: Map<string, { result: T; timestamp: number }>, key: string): T | null {
  const normalizedKey = normalizeCacheKey(key);
  const cached = cache.get(normalizedKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > AI_CACHE_TTL) {
    cache.delete(normalizedKey);
    return null;
  }
  return cached.result;
}

function setCachedResult<T>(cache: Map<string, { result: T; timestamp: number }>, key: string, result: T): void {
  const normalizedKey = normalizeCacheKey(key);
  cache.set(normalizedKey, { result, timestamp: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR BASELINE (pre-action -> post-action diff)
// Prevents false positives when the page already had validation errors
// ═══════════════════════════════════════════════════════════════════════════

const PRE_ACTION_ERROR_BASELINE_TTL = 30 * 1000; // 30s - enough for one action cycle

const preActionErrorBaseline = new Map<string, { errors: string[]; timestamp: number }>();

function getErrorBaselineKey(pageUrl: string, action: DynamicAction): string {
  const sel = action.selector ? normalizeSelector(action.selector) : '';
  return `${pageUrl}|${action.action}|${sel}`;
}

function normalizeErrorList(errors: string[]): string[] {
  const unique: string[] = [];
  for (const e of errors) {
    const cleaned = (e || '').trim();
    if (!cleaned) continue;
    if (!unique.includes(cleaned)) unique.push(cleaned);
  }
  return unique;
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ElementState {
  exists: boolean;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  checked?: boolean;
  value?: string;
  text?: string;
  tagName?: string;
  type?: string;
  isLoading?: boolean;
  ariaDisabled?: boolean;
  disabledReason?: string;
}

export interface BlockingFactor {
  type: 'disabled' | 'hidden' | 'loading' | 'required_fields' | 'validation_error' | 'covered' | 'not_found';
  description: string;
  selector?: string;
  suggestedActions?: DynamicAction[];
  priority?: 'critical' | 'high' | 'medium' | 'low';
  context?: {
    pageUrl?: string;
    formType?: string;
    relatedFields?: Array<{ selector: string; label: string; state: string }>;
    errorMessages?: string[];
    elementContext?: {
      isInForm: boolean;
      formHasErrors: boolean;
      nearbyElements?: Array<{ type: string; selector: string; state: string }>;
    };
  };
}

export interface PreActionAnalysis {
  canProceed: boolean;
  elementState?: ElementState;
  blockingFactors: BlockingFactor[];
  suggestedActions: DynamicAction[];
  validationErrors: string[];
  requiredFields: Array<{ selector: string; label: string; isEmpty: boolean }>;
  context?: {
    pageUrl: string;
    pageType?: string;
    formContext?: {
      formType?: string;
      totalFields: number;
      filledFields: number;
      requiredFieldsCount: number;
      emptyRequiredFieldsCount: number;
    };
    elementContext?: {
      isInForm: boolean;
      formHasErrors: boolean;
      nearbyElements?: Array<{ type: string; selector: string; state: string }>;
    };
  };
}

export interface FormAnalysis {
  formSelector?: string;
  /** True if this is a real <form> element or pseudo-form container */
  isForm?: boolean;
  /** True if this is a pseudo-form (div/section acting as form container) */
  isPseudoForm?: boolean;
  fields: Array<{
    selector: string;
    type: string;
    label: string;
    required: boolean;
    value: string;
    isEmpty: boolean;
    hasError: boolean;
    errorMessage?: string;
  }>;
  submitButton?: {
    selector: string;
    text: string;
    disabled: boolean;
    disabledReason?: string;
  };
  validationErrors: string[];
  canSubmit: boolean;
  missingRequiredFields: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-ACTION ANALYZER
// ═══════════════════════════════════════════════════════════════════════════

export class PreActionAnalyzer {
  /**
   * Analyze element state before executing action
   * Returns analysis with blocking factors and suggested actions
   */
  static async analyzeBeforeAction(
    page: Page,
    action: DynamicAction
  ): Promise<PreActionAnalysis> {
    const startTime = Date.now();
    const pageUrl = page.url();

    logger.debug('[PRE_ACTION] Starting pre-action analysis', {
      action: action.action,
      selector: action.selector,
      description: action.description,
      pageUrl,
    });

    const analysis: PreActionAnalysis = {
      canProceed: true,
      blockingFactors: [],
      suggestedActions: [],
      validationErrors: [],
      requiredFields: [],
      context: {
        pageUrl,
      },
    };

    try {
      // Skip analysis for actions without selectors
      if (!action.selector) {
        return analysis;
      }

      const normalizedSelector = normalizeSelector(action.selector);

      // Step 1: Get element state
      const elementState = await this.getElementState(page, normalizedSelector);
      analysis.elementState = elementState;

      // Step 2: Check if element exists
      if (!elementState.exists) {
        analysis.canProceed = false;
        analysis.blockingFactors.push({
          type: 'not_found',
          description: `Element not found: ${normalizedSelector}`,
          selector: normalizedSelector,
          priority: 'critical',
          context: {
            pageUrl,
          },
        });
        return analysis;
      }

      // Step 3: Check visibility
      if (!elementState.visible) {
        analysis.canProceed = false;
        const suggestedActions = await this.getSuggestedActionsForHidden(page, normalizedSelector);
        analysis.blockingFactors.push({
          type: 'hidden',
          description: `Element is hidden: ${normalizedSelector}`,
          selector: normalizedSelector,
          suggestedActions,
          priority: 'high',
          context: {
            pageUrl,
            elementContext: {
              isInForm: false, // Will be updated if form found
              formHasErrors: false,
            },
          },
        });
      }

      // Step 4: Check if element is disabled (CRITICAL for buttons)
      if (!elementState.enabled && ['click', 'fill', 'type', 'select', 'check'].includes(action.action)) {
        analysis.canProceed = false;

        // Analyze WHY it's disabled with enhanced context
        const disabledAnalysis = await this.analyzeDisabledReason(page, normalizedSelector);
        // Persist reason on elementState for downstream (logging/UI)
        if (analysis.elementState) {
          analysis.elementState.disabledReason = disabledAnalysis.disabledReason;
        }

        // Get form context if available
        const formContext = await this.getFormContext(page, normalizedSelector);

        analysis.blockingFactors.push({
          type: 'disabled',
          description: `Element is disabled: ${disabledAnalysis.disabledReason || elementState.disabledReason || 'Unknown reason'}`,
          selector: normalizedSelector,
          suggestedActions: disabledAnalysis.suggestedActions,
          priority: 'critical',
          context: {
            pageUrl,
            formType: formContext?.formType,
            relatedFields: disabledAnalysis.requiredFields.map(f => ({
              selector: f.selector,
              label: f.label,
              state: f.isEmpty ? 'empty' : 'filled',
            })),
            errorMessages: disabledAnalysis.validationErrors || [],
          },
        });

        // Add required fields info
        analysis.requiredFields = disabledAnalysis.requiredFields;
        analysis.suggestedActions = disabledAnalysis.suggestedActions;

        // Update context with form information
        if (formContext && analysis.context) {
          analysis.context = {
            ...analysis.context,
            pageUrl: analysis.context.pageUrl || pageUrl,
            formContext: {
              formType: formContext.formType,
              totalFields: formContext.totalFields,
              filledFields: formContext.filledFields,
              requiredFieldsCount: formContext.requiredFieldsCount,
              emptyRequiredFieldsCount: formContext.emptyRequiredFieldsCount,
            },
            elementContext: {
              isInForm: true,
              formHasErrors: formContext.hasErrors,
            },
          };
        }
      }

      // Step 5: Check for loading state
      if (elementState.isLoading) {
        analysis.canProceed = false;
        analysis.blockingFactors.push({
          type: 'loading',
          description: 'Element or page is in loading state',
          selector: normalizedSelector,
          priority: 'high',
          context: { pageUrl },
        });
        // Orchestrator executes prerequisites only when suggestedActions exist
        analysis.suggestedActions.push({
          action: 'wait',
          timeout: 800,
          description: 'Wait for loading to finish',
          expectedResult: 'Loading indicators disappear / UI becomes stable',
          optional: false,
        });
      }

      // Step 6: For submit/click actions, check if this is a form submit
      if (action.action === 'click' && await this.isSubmitButton(page, normalizedSelector)) {
        // Use Form Intelligence for smart form handling
        const formAnalysis = await this.analyzeFormBeforeSubmit(page, normalizedSelector, {
          useIntelligence: true,
          url: pageUrl,
        });

        if (!formAnalysis.canSubmit) {
          analysis.canProceed = false;
          const emptyRequired = formAnalysis.fields.filter(f => f.required && f.isEmpty);
          const filledRequired = formAnalysis.fields.filter(f => f.required && !f.isEmpty);

          analysis.blockingFactors.push({
            type: 'required_fields',
            description: `Cannot submit: ${formAnalysis.missingRequiredFields.length} required fields are empty`,
            priority: 'critical',
            context: {
              pageUrl,
              formType: formAnalysis.isForm ? 'form' : 'pseudo-form',
              relatedFields: [
                ...emptyRequired.map(f => ({ selector: f.selector, label: f.label, state: 'empty' })),
                ...filledRequired.map(f => ({ selector: f.selector, label: f.label, state: 'filled' })),
              ],
              errorMessages: formAnalysis.validationErrors,
            },
          });
          analysis.requiredFields = formAnalysis.fields
            .filter(f => f.required)
            .map(f => ({ selector: f.selector, label: f.label, isEmpty: f.isEmpty }));

          // Use smart sequence from Form Intelligence if available, otherwise basic
          if (formAnalysis.smartSequence && formAnalysis.smartSequence.length > 0) {
            // Add priority to smart sequence actions
            analysis.suggestedActions = formAnalysis.smartSequence.map((act, idx) => ({
              ...act,
              priority: idx === 0 ? 'critical' : idx < 3 ? 'high' : 'medium',
            }));
            logger.debug('[PRE_ACTION] Using smart fill sequence', {
              actionsCount: formAnalysis.smartSequence.length,
            });
          } else {
            analysis.suggestedActions = this.generateFillActionsForForm(formAnalysis);
          }
        }

        analysis.validationErrors = formAnalysis.validationErrors;

        // Update context with form information
        if (formAnalysis.fields.length > 0 && analysis.context) {
          analysis.context = {
            ...analysis.context,
            pageUrl: analysis.context.pageUrl || pageUrl,
            formContext: {
              formType: formAnalysis.isForm ? 'form' : 'pseudo-form',
              totalFields: formAnalysis.fields.length,
              filledFields: formAnalysis.fields.filter(f => !f.isEmpty).length,
              requiredFieldsCount: formAnalysis.fields.filter(f => f.required).length,
              emptyRequiredFieldsCount: formAnalysis.fields.filter(f => f.required && f.isEmpty).length,
            },
            elementContext: {
              isInForm: true,
              formHasErrors: formAnalysis.validationErrors.length > 0,
            },
          };
        }
      }

      // Step 7: Check for existing validation errors on page
      const pageErrors = await this.getValidationErrors(page);
      analysis.validationErrors.push(...pageErrors);

      // Store baseline errors for post-action diff (to avoid false positives)
      {
        const key = getErrorBaselineKey(pageUrl, { ...action, selector: normalizedSelector });
        preActionErrorBaseline.set(key, { errors: normalizeErrorList(analysis.validationErrors), timestamp: Date.now() });
      }

      // Sort suggested actions by priority (critical first)
      analysis.suggestedActions.sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        const aPriority = (a as any).priority || 'medium';
        const bPriority = (b as any).priority || 'medium';
        return (priorityOrder[aPriority as keyof typeof priorityOrder] || 2) -
               (priorityOrder[bPriority as keyof typeof priorityOrder] || 2);
      });

      // Enhanced logging for AI understanding
      logger.info('[PRE_ACTION] Analysis completed with context', {
        duration: Date.now() - startTime,
        canProceed: analysis.canProceed,
        blockingFactorsCount: analysis.blockingFactors.length,
        suggestedActionsCount: analysis.suggestedActions.length,
        context: {
          pageUrl: analysis.context?.pageUrl,
          formContext: analysis.context?.formContext,
          elementContext: analysis.context?.elementContext,
        },
        blockingFactors: analysis.blockingFactors.map(bf => ({
          type: bf.type,
          priority: bf.priority || 'medium',
          description: bf.description,
          hasSuggestedActions: (bf.suggestedActions?.length || 0) > 0,
        })),
      });

      return analysis;
    } catch (error) {
      logger.error('[PRE_ACTION] Analysis failed', {
        error: error instanceof Error ? error.message : String(error),
        action: action.action,
        selector: action.selector,
      });

      // On error, allow to proceed (don't block test)
      return analysis;
    }
  }

  /**
   * Get detailed element state
   * Uses extensible class patterns for disabled/loading detection
   * ✅ IMPROVED: Protection against detached elements, grouped evaluate calls
   * ✅ IMPROVED: Proper class pattern matching, safe CSS selectors, specialized value extraction
   */
  static async getElementState(page: Page, selector: string): Promise<ElementState> {
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const locator = getLocator(page, selector);

        // ✅ IMPROVED: Wrap count() in try-catch for detached elements
        let count = 0;
        try {
          count = await locator.count();
        } catch (countError) {
          // Element may have been detached during count - retry
          if (attempt < MAX_RETRIES - 1) {
            await page.waitForTimeout(100);
            continue;
          }
          logger.debug('[PRE_ACTION] Element detached during count', {
            selector: selector.substring(0, 50),
          });
          return { exists: false, visible: false, enabled: false, editable: false };
        }

        if (count === 0) {
          return { exists: false, visible: false, enabled: false, editable: false };
        }

        const firstLocator = locator.first();

        // ✅ IMPROVED: Separate exact matches and substring matches for class patterns
        const exactDisabledClasses = ['disabled', 'Mui-disabled', 'ant-btn-disabled', 'ant-input-disabled'];
        const substringDisabledPatterns = ['is-disabled', 'btn-disabled', '--disabled', 'chakra-button__disabled'];
        const exactLoadingClasses = ['loading', 'spinner', 'submitting', 'processing', 'pending'];
        const substringLoadingPatterns = ['is-loading', 'is-spinner', 'btn-loading', 'Mui-loading', 'ant-btn-loading'];

        // ✅ IMPROVED: Wrap evaluate in try-catch for detached elements with retry
        let state: any;
        try {
          // Get all state in one evaluate call for performance
          state = await firstLocator.evaluate((el, patterns) => {
            // ✅ IMPROVED: Check if element is still connected to DOM
            if (!el || !el.isConnected) {
              return null;
            }

            const {
              exactDisabledClasses,
              substringDisabledPatterns,
              exactLoadingClasses,
              substringLoadingPatterns,
            } = patterns;

            const htmlEl = el as any;
            const inputEl = el as any;

            // Check computed styles
            let style: any;
            try {
              // @ts-expect-error - browser context
              style = window.getComputedStyle(htmlEl);
            } catch {
              // Element may be detached
              return null;
            }

            const isHidden = style.display === 'none' ||
                            style.visibility === 'hidden' ||
                            style.opacity === '0';

            // ✅ IMPROVED: Avoid false "hidden" for fixed/sticky positioned elements
            const position = (style.position || '').toLowerCase();
            const rect = htmlEl.getBoundingClientRect ? htmlEl.getBoundingClientRect() : { width: 0, height: 0 };
            const isZeroSize = !rect || rect.width === 0 || rect.height === 0;
            const offsetParentHidden = htmlEl.offsetParent === null && position !== 'fixed' && position !== 'sticky';
            const computedHidden = isHidden || isZeroSize || offsetParentHidden;

            // ✅ IMPROVED: Proper class matching - exact + substring separately
            const classList = Array.from(htmlEl.classList || []) as string[];

            // Check disabled: exact match first, then substring
            const hasExactDisabledClass = classList.some((cls: string) =>
              exactDisabledClasses.includes(cls)
            );
            const hasSubstringDisabledClass = substringDisabledPatterns.some((pattern: string) =>
              classList.some((cls: string) => cls.indexOf(pattern) !== -1)
            );
            const hasDisabledClass = hasExactDisabledClass || hasSubstringDisabledClass;

            // ✅ IMPROVED: Better aria-disabled check (handles 'true', 'TRUE', boolean-like)
            const ariaDisabledAttr = htmlEl.getAttribute('aria-disabled');
            const isAriaDisabled = ariaDisabledAttr !== null &&
              ['true', '1', 'disabled'].includes(String(ariaDisabledAttr).toLowerCase());

            const isDisabled = inputEl.disabled ||
                              htmlEl.getAttribute('disabled') !== null ||
                              isAriaDisabled ||
                              hasDisabledClass ||
                              style.pointerEvents === 'none' ||
                              style.cursor === 'not-allowed';

            // ✅ IMPROVED: Proper loading class matching
            const hasExactLoadingClass = classList.some((cls: string) =>
              exactLoadingClasses.includes(cls)
            );
            const hasSubstringLoadingClass = substringLoadingPatterns.some((pattern: string) =>
              classList.some((cls: string) => cls.indexOf(pattern) !== -1)
            );
            const hasLoadingClass = hasExactLoadingClass || hasSubstringLoadingClass;

            // ✅ IMPROVED: Safe loading selector - only use valid CSS class names
            const safeLoadingClasses = exactLoadingClasses.filter((c: string) =>
              /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c) // Valid CSS class name
            );
            const loadingSelector = safeLoadingClasses.map((p: string) => `.${p}`).join(', ') + ', [aria-busy="true"]';

            let isLoading = hasLoadingClass || htmlEl.getAttribute('aria-busy') === 'true';
            try {
              if (loadingSelector && loadingSelector !== ', [aria-busy="true"]') {
                isLoading = isLoading || htmlEl.querySelector(loadingSelector) !== null;
              }
            } catch {
              // querySelector may fail on invalid selectors
            }

            // ✅ IMPROVED: Specialized value extraction for different input types
            const tagName = el.tagName.toLowerCase();
            const inputType = (inputEl.type || '').toLowerCase();
            let hasValue = false;
            let valueLength = 0;
            let checked: boolean | undefined = undefined;

            if (tagName === 'select') {
              // Select: check selectedIndex and selectedOptions
              hasValue = inputEl.selectedIndex >= 0 && inputEl.value !== '';
              valueLength = inputEl.selectedOptions?.length || 0;
            } else if (tagName === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
              // Checkbox/Radio: use checked state
              checked = inputEl.checked;
              hasValue = inputEl.checked;
            } else if (tagName === 'input' || tagName === 'textarea') {
              // Text inputs: use value
              hasValue = !!inputEl.value;
              valueLength = inputEl.value?.length || 0;
            } else {
              // Other elements: use textContent
              const text = htmlEl.textContent?.trim() || '';
              hasValue = text.length > 0;
              valueLength = text.length;
            }

            return {
              visible: !computedHidden,
              enabled: !isDisabled,
              isLoading,
              tagName,
              type: inputType,
              hasValue,
              valueLength,
              textLength: htmlEl.textContent?.trim()?.length || 0,
              checked,
              ariaDisabled: isAriaDisabled,
            };
          }, {
            exactDisabledClasses,
            substringDisabledPatterns,
            exactLoadingClasses,
            substringLoadingPatterns,
          });
        } catch (evalError) {
          // ✅ IMPROVED: Handle detached element during evaluate - retry
          const errorMsg = evalError instanceof Error ? evalError.message : String(evalError);
          const isDetachedError = errorMsg.includes('detached') ||
                                  errorMsg.includes('not attached') ||
                                  errorMsg.includes('Node is detached') ||
                                  errorMsg.includes('stale');

          if (isDetachedError && attempt < MAX_RETRIES - 1) {
            await page.waitForTimeout(100);
            continue; // Retry
          }

          logger.debug('[PRE_ACTION] Evaluate failed', {
            selector: selector.substring(0, 50),
            errorType: evalError instanceof Error ? evalError.name : 'Unknown',
            attempt,
          });
          return { exists: false, visible: false, enabled: false, editable: false };
        }

        // ✅ IMPROVED: Handle null state (element was detached) - retry
        if (!state) {
          if (attempt < MAX_RETRIES - 1) {
            await page.waitForTimeout(100);
            continue;
          }
          return { exists: false, visible: false, enabled: false, editable: false };
        }

        return {
          exists: true,
          visible: state.visible,
          enabled: state.enabled,
          editable: state.enabled && ['input', 'textarea', 'select'].includes(state.tagName),
          isLoading: state.isLoading,
          tagName: state.tagName,
          type: state.type,
          // ✅ IMPROVED: Don't expose actual values (PII protection)
          value: state.hasValue ? '[REDACTED]' : '',
          text: state.textLength > 0 ? `[${state.textLength} chars]` : '',
          checked: state.checked,
          ariaDisabled: state.ariaDisabled,
        };
      } catch (error) {
        if (attempt < MAX_RETRIES - 1) {
          await page.waitForTimeout(100);
          continue;
        }
        logger.debug('[PRE_ACTION] Failed to get element state', {
          selector: selector.substring(0, 50),
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
        return { exists: false, visible: false, enabled: false, editable: false };
      }
    }

    // Should not reach here, but fallback
    return { exists: false, visible: false, enabled: false, editable: false };
  }

  /**
   * Analyze why element is disabled and suggest actions to enable it
   * Enhanced with context for better AI understanding
   */
  static async analyzeDisabledReason(
    page: Page,
    selector: string
  ): Promise<{ disabledReason: string; suggestedActions: DynamicAction[]; requiredFields: Array<{ selector: string; label: string; isEmpty: boolean }>; validationErrors?: string[] }> {
    const suggestedActions: DynamicAction[] = [];
    const requiredFields: Array<{ selector: string; label: string; isEmpty: boolean }> = [];
    let disabledReason = 'Unknown';
    let validationErrors: string[] = [];

    try {
      // Find the form containing this element (if any)
      const formAnalysis = await this.findParentForm(page, selector);

      if (formAnalysis) {
        // Check for empty required fields
        const emptyRequired = formAnalysis.fields.filter(f => f.required && f.isEmpty);

        if (emptyRequired.length > 0) {
          disabledReason = `${emptyRequired.length} required field(s) are empty: ${emptyRequired.map(f => f.label).join(', ')}`;

          // Generate fill actions for empty required fields with priority
          emptyRequired.forEach((field, idx) => {
            requiredFields.push({
              selector: field.selector,
              label: field.label,
              isEmpty: true,
            });

            suggestedActions.push({
              action: 'fill',
              selector: field.selector,
              value: this.generateTestValue(field.type, field.label),
              description: `Fill required field: ${field.label}`,
              expectedResult: 'Field is filled',
              optional: false,
              priority: idx === 0 ? 'critical' : idx < 3 ? 'high' : 'medium',
            } as DynamicAction & { priority?: string });
          });

          validationErrors = formAnalysis.validationErrors;
          return { disabledReason, suggestedActions, requiredFields, validationErrors };
        }

        // Check for validation errors
        if (formAnalysis.validationErrors.length > 0) {
          disabledReason = `Validation errors: ${formAnalysis.validationErrors.join(', ')}`;
          validationErrors = formAnalysis.validationErrors;
          return { disabledReason, suggestedActions, requiredFields, validationErrors };
        }
      }

      // Check if it's waiting for some checkbox/agreement
      const checkboxes = await this.findUncheckedRequiredCheckboxes(page);
      if (checkboxes.length > 0) {
        disabledReason = `Required checkbox(es) not checked: ${checkboxes.map(c => c.label).join(', ')}`;

        checkboxes.forEach((checkbox) => {
          suggestedActions.push({
            action: 'check',
            selector: checkbox.selector,
            description: `Check required checkbox: ${checkbox.label}`,
            expectedResult: 'Checkbox is checked',
            optional: false,
            priority: 'high',
          } as DynamicAction & { priority?: string });
        });

        return { disabledReason, suggestedActions, requiredFields, validationErrors };
      }

      // ✅ IMPROVED: Check if page is still loading with safe selectors and better detection
      try {
        const isPageLoading = await page.evaluate(() => {
          // @ts-expect-error - browser context
          if (document.readyState !== 'complete') {
            return true;
          }

          // ✅ IMPROVED: Safe loading indicators check
          const loadingIndicators = [
            '.loading', '.spinner', '.loader',
            '[aria-busy="true"]',
            '[data-loading="true"]',
            '.is-loading', '.is-spinner',
          ];

          for (const selector of loadingIndicators) {
            try {
              // @ts-expect-error - browser context
              if (document.querySelector(selector)) {
                return true;
              }
            } catch {
              // Invalid selector, skip
            }
          }

          return false;
        });

        if (isPageLoading) {
          disabledReason = 'Page is still loading';
          return { disabledReason, suggestedActions, requiredFields };
        }
      } catch {
        // Ignore page loading check errors
      }

    } catch (error) {
      logger.debug('[PRE_ACTION] Failed to analyze disabled reason', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { disabledReason, suggestedActions, requiredFields, validationErrors };
  }

  /**
   * Get form context for better AI understanding
   */
  private static async getFormContext(
    page: Page,
    selector: string
  ): Promise<{
    formType?: string;
    totalFields: number;
    filledFields: number;
    requiredFieldsCount: number;
    emptyRequiredFieldsCount: number;
    hasErrors: boolean;
  } | null> {
    try {
      const formAnalysis = await this.findParentForm(page, selector);
      if (!formAnalysis) return null;

      return {
        formType: formAnalysis.isForm ? 'form' : 'pseudo-form',
        totalFields: formAnalysis.fields.length,
        filledFields: formAnalysis.fields.filter(f => !f.isEmpty).length,
        requiredFieldsCount: formAnalysis.fields.filter(f => f.required).length,
        emptyRequiredFieldsCount: formAnalysis.fields.filter(f => f.required && f.isEmpty).length,
        hasErrors: formAnalysis.validationErrors.length > 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Find parent form and analyze its fields
   * Uses extensible ERROR_CLASS_PATTERNS for error detection
   * ✅ IMPROVED: Validates selectors, exact text matching, contenteditable support, unique form selectors
   */
  static async findParentForm(page: Page, buttonSelector: string): Promise<FormAnalysis | null> {
    try {
      // Pass patterns to browser context
      const errorPatterns = ERROR_CLASS_PATTERNS;
      const errorSelectors = ERROR_SELECTORS;

      const formData = await page.evaluate((params: {
        selector: string;
        errorPatterns: string[];
        errorSelectors: string[];
      }) => {
        const { selector, errorPatterns, errorSelectors } = params;

        // ✅ IMPROVED: Helper to generate valid selector with fallback to unique path
        const generateValidSelector = (input: any, index?: number): string | null => {
          // Priority 1: ID (most reliable)
          if (input.id && typeof input.id === 'string' && input.id.trim()) {
            return `#${input.id}`;
          }

          // Priority 2: name attribute
          const name = input.getAttribute('name');
          if (name && typeof name === 'string' && name.trim() && name !== 'null' && name !== 'undefined') {
            return `[name="${name}"]`;
          }

          // Priority 3: data-testid / data-cy / data-test
          const testId = input.getAttribute('data-testid') ||
                        input.getAttribute('data-cy') ||
                        input.getAttribute('data-test');
          if (testId && typeof testId === 'string' && testId.trim()) {
            const attr = input.hasAttribute('data-testid') ? 'data-testid' :
                        input.hasAttribute('data-cy') ? 'data-cy' : 'data-test';
            return `[${attr}="${testId}"]`;
          }

          // Priority 4: type + placeholder combination
          const type = input.type || input.tagName?.toLowerCase();
          const placeholder = input.getAttribute('placeholder');
          if (type && placeholder && placeholder.trim()) {
            const tag = input.tagName?.toLowerCase() || 'input';
            return `${tag}[type="${type}"][placeholder="${placeholder}"]`;
          }

          // Priority 5: aria-label
          const ariaLabel = input.getAttribute('aria-label');
          if (ariaLabel && ariaLabel.trim()) {
            return `[aria-label="${ariaLabel}"]`;
          }

          // ✅ IMPROVED: Priority 6: Fallback to indexed selector within form
          if (typeof index === 'number') {
            const tag = input.tagName?.toLowerCase() || 'input';
            const inputType = input.type || '';
            if (inputType) {
              return `${tag}[type="${inputType}"]:nth-of-type(${index + 1})`;
            }
            return `${tag}:nth-of-type(${index + 1})`;
          }

          // Cannot generate valid selector
          return null;
        };

        // ✅ IMPROVED: Helper to generate unique form selector
        const generateFormSelector = (form: any): string => {
          // Priority 1: ID
          if (form.id && form.id.trim()) {
            return `#${form.id}`;
          }

          // Priority 2: name attribute
          const name = form.getAttribute('name');
          if (name && name.trim()) {
            return `form[name="${name}"]`;
          }

          // Priority 3: data-testid
          const testId = form.getAttribute('data-testid') || form.getAttribute('data-cy');
          if (testId && testId.trim()) {
            return `form[data-testid="${testId}"]`;
          }

          // Priority 4: action attribute (if unique)
          const action = form.getAttribute('action');
          if (action && action.trim() && action !== '#') {
            return `form[action="${action}"]`;
          }

          // Priority 5: class-based selector (first unique class)
          const classList = Array.from(form.classList || []) as string[];
          const uniqueClass = classList.find((c: string) =>
            c.length > 2 && !['form', 'active', 'visible'].includes(c)
          );
          if (uniqueClass) {
            return `form.${uniqueClass}`;
          }

          // Priority 6: nth-of-type fallback
          // @ts-expect-error - browser context
          const allForms = Array.from(document.querySelectorAll('form'));
          const formIndex = allForms.indexOf(form);
          if (formIndex >= 0) {
            return `form:nth-of-type(${formIndex + 1})`;
          }

          return 'form';
        };

        // Helper to check if element has error class
        const hasErrorClass = (el: any): boolean => {
          const classList = Array.from(el.classList || []) as string[];
          return errorPatterns.some((pattern: string) =>
            classList.some((cls: string) => cls.includes(pattern))
          ) || el.getAttribute('aria-invalid') === 'true';
        };

        // ✅ IMPROVED: Helper for exact text matching (word boundaries)
        const textMatchesExact = (elementText: string, searchText: string): boolean => {
          const normalizedElement = elementText.trim().toLowerCase();
          const normalizedSearch = searchText.trim().toLowerCase();

          // Exact match
          if (normalizedElement === normalizedSearch) return true;

          // Word boundary match (search text is a complete word in element)
          const wordBoundaryRegex = new RegExp(`\\b${normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordBoundaryRegex.test(normalizedElement);
        };

        // Find the button element
        let button: any = null;

        // Try different selector methods
        if (selector.startsWith('text=')) {
          const text = selector.replace('text=', '').replace(/"/g, '').trim();
          // @ts-expect-error - browser context
          const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));

          // ✅ IMPROVED: Prefer exact match over partial match
          button = buttons.find((b: any) => textMatchesExact(b.textContent || '', text)) ||
                   buttons.find((b: any) => (b.textContent || '').toLowerCase().includes(text.toLowerCase())) ||
                   null;
        } else if (selector.startsWith('role=')) {
          // Parse role selector
          const match = selector.match(/role=(\w+)(?:\[name="([^"]+)"\])?/);
          if (match) {
            const [, role, name] = match;
            // @ts-expect-error - browser context
            const elements = Array.from(document.querySelectorAll(`[role="${role}"]`));
            button = name
              ? elements.find((el: any) =>
                  textMatchesExact(el.textContent || '', name) ||
                  textMatchesExact(el.getAttribute('aria-label') || '', name)
                ) || elements.find((el: any) =>
                  (el.textContent || '').includes(name) ||
                  (el.getAttribute('aria-label') || '').includes(name)
                ) || null
              : elements[0] || null;
          }
        } else {
          try {
            // @ts-expect-error - browser context
            button = document.querySelector(selector);
          } catch {
            // Invalid selector
            return null;
          }
        }

        if (!button) return null;

        // Find parent form
        const form = button.closest('form');
        if (!form) {
          // Look for nearby form or fieldset
          const parent = button.parentElement?.closest('div, section, fieldset');
          if (!parent) return null;

          // ✅ IMPROVED: Treat parent container as pseudo-form, include contenteditable
          const inputs = Array.from(parent.querySelectorAll(
            'input, select, textarea, [contenteditable="true"], [contenteditable=""]'
          ));
          if (inputs.length === 0) return null;

          // Filter out fields without valid selectors
          const validFields = inputs
            .map((input: any, idx: number) => {
              const validSelector = generateValidSelector(input, idx);
              if (!validSelector) return null;

              const inputEl = input;
              const isContentEditable = input.hasAttribute('contenteditable');

              const label = input.getAttribute('aria-label') ||
                           input.getAttribute('placeholder') ||
                           // @ts-expect-error - browser context
                           document.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() ||
                           input.getAttribute('name') ||
                           (isContentEditable ? 'Editable field' : 'Unknown field');

              // ✅ IMPROVED: Handle contenteditable value
              const value = isContentEditable
                ? (input.textContent?.trim() || '')
                : (inputEl.value || '');

              return {
                selector: validSelector,
                type: isContentEditable ? 'contenteditable' : (inputEl.type || input.tagName.toLowerCase()),
                label: typeof label === 'string' ? label : 'Unknown field',
                required: inputEl.required || input.getAttribute('aria-required') === 'true',
                value,
                isEmpty: !value.trim(),
                hasError: hasErrorClass(input),
              };
            })
            .filter((f: any): f is NonNullable<typeof f> => f !== null);

          if (validFields.length === 0) return null;

          // ✅ IMPROVED: Return isForm: true for consistency (pseudo-form acts like form)
          return {
            isForm: true, // Changed from false - downstream expects this
            isPseudoForm: true, // New flag to indicate it's not a real <form>
            fields: validFields,
            validationErrors: [],
          };
        }

        // ✅ IMPROVED: Analyze form fields including contenteditable
        const formInputs = Array.from(form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]), select, textarea, [contenteditable="true"], [contenteditable=""]'
        ));

        // Filter out fields without valid selectors
        const fields = formInputs
          .map((input: any, idx: number) => {
            const validSelector = generateValidSelector(input, idx);
            if (!validSelector) return null;

            const inputEl = input;
            const isContentEditable = input.hasAttribute('contenteditable');

            const labelEl = form.querySelector(`label[for="${input.id}"]`) ||
                           input.closest('label');

            const label = labelEl?.textContent?.trim() ||
                         input.getAttribute('aria-label') ||
                         input.getAttribute('placeholder') ||
                         input.getAttribute('name') ||
                         (isContentEditable ? 'Editable field' : 'Unknown field');

            // Find error message for this field using patterns
            const errorSelectorStr = errorSelectors.slice(0, 5).join(', '); // Use first 5 selectors
            const errorEl = input.nextElementSibling && hasErrorClass(input.nextElementSibling)
              ? input.nextElementSibling
              : input.parentElement?.querySelector(errorSelectorStr);

            // ✅ IMPROVED: Handle contenteditable value
            const value = isContentEditable
              ? (input.textContent?.trim() || '')
              : (inputEl.value || '');

            return {
              selector: validSelector,
              type: isContentEditable ? 'contenteditable' : (inputEl.type || input.tagName.toLowerCase()),
              label: (typeof label === 'string' ? label : 'Unknown field').replace(/\*/g, '').trim(),
              required: inputEl.required ||
                       input.getAttribute('aria-required') === 'true' ||
                       (typeof label === 'string' && label.includes('*')),
              value,
              isEmpty: !value.trim(),
              hasError: hasErrorClass(input),
              errorMessage: errorEl?.textContent?.trim(),
            };
          })
          .filter((f: any): f is NonNullable<typeof f> => f !== null);

        // Get validation errors using selectors
        const errorSelectorStr = errorSelectors.join(', ');
        let validationErrors: string[] = [];
        try {
          const errorElements = form.querySelectorAll(errorSelectorStr);
          validationErrors = Array.from(errorElements)
            .map((el: any) => el.textContent?.trim())
            .filter((text: any): text is string => !!text && text.length > 2);
        } catch {
          // Invalid error selector
        }

        return {
          isForm: true,
          formSelector: generateFormSelector(form), // ✅ IMPROVED: Use unique selector
          fields,
          validationErrors,
        };
      }, { selector: buttonSelector, errorPatterns, errorSelectors });

      if (!formData) return null;

      const missingRequiredFields = formData.fields
        .filter((f: any) => f.required && f.isEmpty)
        .map((f: any) => f.label);

      // ✅ IMPROVED: Include isForm and isPseudoForm in return to match FormAnalysis interface
      return {
        formSelector: formData.formSelector,
        isForm: formData.isForm,
        isPseudoForm: formData.isPseudoForm,
        fields: formData.fields,
        submitButton: {
          selector: buttonSelector,
          text: '',
          disabled: false,
        },
        validationErrors: formData.validationErrors || [],
        canSubmit: missingRequiredFields.length === 0,
        missingRequiredFields,
      };
    } catch (error) {
      logger.debug('[PRE_ACTION] Failed to find parent form', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Check if selector points to a submit button
   * Uses hybrid approach: rule-based first, then AI fallback
   */
  static async isSubmitButton(page: Page, selector: string): Promise<boolean> {
    try {
      const locator = getLocator(page, selector);
      const count = await locator.count();
      if (count === 0) return false;

      // Step 1: Get element info
      const elementInfo = await locator.first().evaluate((el: any) => {
        return {
          tagName: el.tagName.toLowerCase(),
          type: el.type?.toLowerCase() || '',
          text: el.textContent?.trim() || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          formAction: el.getAttribute('formaction') || '',
          isInForm: !!el.closest('form'),
        };
      });

      // Step 2: Rule-based detection (fast, free)
      const ruleBasedResult = this.isSubmitButtonRuleBased(elementInfo);

      // If confident (definite yes or definite no), return immediately
      if (ruleBasedResult.confidence >= 0.9) {
        return ruleBasedResult.isSubmit;
      }

      // Step 3: If uncertain, use AI fallback with context
      if (ruleBasedResult.confidence < 0.7 && elementInfo.text) {
        const aiResult = await this.isSubmitButtonAI(elementInfo.text, elementInfo.ariaLabel, {
          isInForm: elementInfo.isInForm,
        });
        if (aiResult !== null) {
          return aiResult;
        }
      }

      // Fallback to rule-based result
      return ruleBasedResult.isSubmit;
    } catch (error) {
      logger.debug('[PRE_ACTION] isSubmitButton failed', { error });
      return false;
    }
  }

  /**
   * Rule-based submit button detection
   */
  private static isSubmitButtonRuleBased(info: {
    tagName: string;
    type: string;
    text: string;
    ariaLabel: string;
    role: string;
    formAction: string;
    isInForm: boolean;
  }): { isSubmit: boolean; confidence: number } {
    // Definite submit: input[type="submit"]
    if (info.tagName === 'input' && info.type === 'submit') {
      return { isSubmit: true, confidence: 1.0 };
    }

    // Definite submit: button[type="submit"]
    if (info.tagName === 'button' && info.type === 'submit') {
      return { isSubmit: true, confidence: 1.0 };
    }

    // Definite NOT submit: button[type="button"] or button[type="reset"]
    if (info.tagName === 'button' && (info.type === 'button' || info.type === 'reset')) {
      return { isSubmit: false, confidence: 1.0 };
    }

    // Has formaction = likely submit
    if (info.formAction) {
      return { isSubmit: true, confidence: 0.95 };
    }

    // Check text against keywords
    const textLower = info.text.toLowerCase();
    const labelLower = info.ariaLabel.toLowerCase();
    const searchText = `${textLower} ${labelLower}`;

    // Check all language keywords
    for (const [, keywords] of Object.entries(SUBMIT_BUTTON_KEYWORDS)) {
      for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
          // If in form, high confidence
          if (info.isInForm) {
            return { isSubmit: true, confidence: 0.95 };
          }
          return { isSubmit: true, confidence: 0.8 };
        }
      }
    }

    // Button in form without type = default submit in HTML5
    if (info.tagName === 'button' && !info.type && info.isInForm) {
      return { isSubmit: true, confidence: 0.7 };
    }

    // Unknown - low confidence
    return { isSubmit: false, confidence: 0.5 };
  }

  /**
   * AI fallback for submit button detection
   * Enhanced with better context for AI understanding
   */
  private static async isSubmitButtonAI(text: string, ariaLabel: string, context?: { pageUrl?: string; isInForm?: boolean }): Promise<boolean | null> {
    // Sanitize text for cache key (don't log full text)
    const cacheKey = `submit|${text.substring(0, 30)}|${ariaLabel.substring(0, 20)}`.toLowerCase().trim();

    // Check cache first
    const cached = getCachedResult(aiCache.isSubmitButton, cacheKey);
    if (cached !== null) {
      return cached;
    }

    // Enhanced prompt with context for better AI understanding
    const contextInfo = context ? `
Context:
- Page URL: ${context.pageUrl || 'unknown'}
- Is in form: ${context.isInForm ? 'yes' : 'no'}
` : '';

    const result = await callAI({
      maxTokens: 10,
      systemPrompt: 'You are a UI analyzer specializing in form interactions. Analyze button context carefully. Answer only "yes" or "no".',
      userPrompt: `Is this button text for a form submit/login/register/action button (not a cancel/close/navigation button)?
${contextInfo}
Button text: "${text.substring(0, 50)}"
${ariaLabel ? `Aria label: "${ariaLabel.substring(0, 30)}"` : ''}

Common submit button patterns: "Submit", "Sign In", "Login", "Register", "Create Account", "Continue", "Next", "Save", "Confirm", "Buy", "Order", "Checkout"
Common non-submit buttons: "Cancel", "Close", "Back", "Previous", "Skip", "X", "×"

Answer only "yes" or "no".`,
    });

    if (!result) return null;

    const isSubmit = result.toLowerCase().trim() === 'yes';

    // Cache the result
    setCachedResult(aiCache.isSubmitButton, cacheKey, isSubmit);

    return isSubmit;
  }

  /**
   * Analyze form before submit with intelligent form handling
   * Uses FormIntelligenceService for smart analysis when available
   */
  static async analyzeFormBeforeSubmit(
    page: Page,
    submitSelector: string,
    options: { useIntelligence?: boolean; url?: string } = {}
  ): Promise<FormAnalysis & { smartSequence?: DynamicAction[] }> {
    const analysis = await this.findParentForm(page, submitSelector);

    if (!analysis) {
      return {
        fields: [],
        validationErrors: [],
        canSubmit: true,
        missingRequiredFields: [],
      };
    }

    // Use Form Intelligence if enabled and form has fields
    if (options.useIntelligence && analysis.fields.length > 0) {
      try {
        const FormIntelligence = await getFormIntelligence();
        const url = options.url || page.url();

        const intelligenceResult = await FormIntelligence.analyzeForm(page, analysis, url);

        logger.debug('[PRE_ACTION] Form intelligence analysis', {
          formType: intelligenceResult.formType,
          isWizard: intelligenceResult.isWizardForm,
          actionsCount: intelligenceResult.fillSequence.actions.length,
          confidence: intelligenceResult.confidence,
        });

        // Return enhanced analysis with smart fill sequence
        return {
          ...analysis,
          smartSequence: intelligenceResult.fillSequence.actions,
        };
      } catch (error) {
        logger.debug('[PRE_ACTION] Form intelligence failed, using basic analysis', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return analysis;
  }

  /**
   * Get validation errors from page
   * Uses extensible ERROR_SELECTORS constant
   */
  static async getValidationErrors(page: Page): Promise<string[]> {
    try {
      // Pass selectors to browser context
      const selectors = ERROR_SELECTORS;

      return await page.evaluate((errorSelectors: string[]) => {
        const errors: string[] = [];

        for (const selector of errorSelectors) {
          // @ts-expect-error - browser context
          const elements = document.querySelectorAll(selector);
          elements.forEach((el: any) => {
            const text = el.textContent?.trim();
            // Filter out empty and duplicate errors
            if (text && text.length > 2 && !errors.includes(text)) {
              errors.push(text);
            }
          });
        }

        return errors;
      }, selectors);
    } catch {
      return [];
    }
  }

  /**
   * Find unchecked required checkboxes
   */
  static async findUncheckedRequiredCheckboxes(page: Page): Promise<Array<{ selector: string; label: string }>> {
    try {
      return await page.evaluate(() => {
        // @ts-ignore - browser context has document
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        const unchecked: Array<{ selector: string; label: string }> = [];

        checkboxes.forEach((cb: any) => {
          const inputEl = cb;
          if (inputEl.required && !inputEl.checked) {
            // @ts-ignore - browser context
            const label = document.querySelector(`label[for="${cb.id}"]`)?.textContent?.trim() ||
                         cb.closest('label')?.textContent?.trim() ||
                         cb.getAttribute('aria-label') ||
                         'Agreement checkbox';

            unchecked.push({
              selector: cb.id ? `#${cb.id}` : `input[type="checkbox"][name="${cb.getAttribute('name')}"]`,
              label,
            });
          }
        });

        return unchecked;
      });
    } catch {
      return [];
    }
  }

  /**
   * Generate test value based on field type and label
   * Uses hybrid approach: rule-based first, then AI fallback
   */
  static generateTestValue(type: string, label: string): string {
    // Step 1: Try rule-based detection
    const ruleBasedResult = this.generateTestValueRuleBased(type, label);
    if (ruleBasedResult.confidence >= 0.7) {
      return ruleBasedResult.value;
    }

    // Step 2: For low confidence, check AI cache
    const cacheKey = `${type}|${label}`.toLowerCase().trim();
    const cached = getCachedResult(aiCache.fieldType, cacheKey);
    if (cached !== null) {
      const generator = TEST_VALUES[cached] || TEST_VALUES.text;
      return generator();
    }

    // Step 3: Return rule-based result (async AI will be used next time)
    // Schedule async AI detection for cache warming
    this.detectFieldTypeAI(type, label).catch(() => {});

    return ruleBasedResult.value;
  }

  /**
   * Rule-based test value generation
   */
  private static generateTestValueRuleBased(type: string, label: string): { value: string; confidence: number } {
    const labelLower = label.toLowerCase();
    const typeLower = type.toLowerCase();

    // Direct type match (highest confidence)
    if (typeLower === 'email') return { value: TEST_VALUES.email(), confidence: 1.0 };
    if (typeLower === 'password') return { value: TEST_VALUES.password(), confidence: 1.0 };
    if (typeLower === 'tel') return { value: TEST_VALUES.tel(), confidence: 1.0 };
    if (typeLower === 'url') return { value: TEST_VALUES.url(), confidence: 1.0 };
    if (typeLower === 'number') return { value: TEST_VALUES.number(), confidence: 1.0 };
    if (typeLower === 'date') return { value: TEST_VALUES.date(), confidence: 1.0 };

    // Check label against all field type patterns
    for (const [fieldType, config] of Object.entries(FIELD_TYPE_PATTERNS)) {
      for (const pattern of config.patterns) {
        if (labelLower.includes(pattern)) {
          // Special handling for name fields
          if (fieldType === 'firstName') return { value: TEST_VALUES.firstName(), confidence: 0.9 };
          if (fieldType === 'lastName') return { value: TEST_VALUES.lastName(), confidence: 0.9 };
          if (fieldType === 'name') {
            // Check if it's first or last name
            if (labelLower.includes('first') || labelLower.includes('имя')) {
              return { value: TEST_VALUES.firstName(), confidence: 0.9 };
            }
            if (labelLower.includes('last') || labelLower.includes('фамил') || labelLower.includes('surname')) {
              return { value: TEST_VALUES.lastName(), confidence: 0.9 };
            }
            return { value: TEST_VALUES.fullName(), confidence: 0.85 };
          }

          // Get generator for this field type
          const generator = TEST_VALUES[fieldType] || TEST_VALUES[config.type] || TEST_VALUES.text;
          return { value: generator(), confidence: 0.85 };
        }
      }
    }

    // Low confidence - use generic text
    return { value: TEST_VALUES.text(), confidence: 0.4 };
  }

  /**
   * AI fallback for field type detection (async, for cache warming)
   * ✅ IMPROVED: Uses unified AI wrapper, sanitized logging
   */
  private static async detectFieldTypeAI(type: string, label: string): Promise<string> {
    // ✅ IMPROVED: Sanitize cache key
    const cacheKey = `fieldType|${type.substring(0, 20)}|${label.substring(0, 30)}`.toLowerCase().trim();

    // Check cache first
    const cached = getCachedResult(aiCache.fieldType, cacheKey);
    if (cached !== null) {
      return cached;
    }

    // ✅ IMPROVED: Use unified AI wrapper
    const result = await callAI({
      maxTokens: 20,
      systemPrompt: `You are a form field analyzer. Given a field type and label, respond with ONE of these field types:
email, password, tel, firstName, lastName, fullName, username, url, company, address, city, country, zip, number, date, text
Respond with only the field type, nothing else.`,
      userPrompt: `Field type: "${type}"\nLabel: "${label.substring(0, 50)}"`, // ✅ IMPROVED: Truncate label
    });

    const fieldType = result?.toLowerCase().trim() || 'text';

    // Cache the result
    setCachedResult(aiCache.fieldType, cacheKey, fieldType);

    return fieldType;
  }

  /**
   * Generate test value with async AI support
   * Use this when you can await the result
   */
  static async generateTestValueAsync(type: string, label: string): Promise<string> {
    // Step 1: Try rule-based detection
    const ruleBasedResult = this.generateTestValueRuleBased(type, label);
    if (ruleBasedResult.confidence >= 0.7) {
      return ruleBasedResult.value;
    }

    // Step 2: Use AI for uncertain cases
    const detectedType = await this.detectFieldTypeAI(type, label);
    const generator = TEST_VALUES[detectedType] || TEST_VALUES.text;
    return generator();
  }

  /**
   * Generate fill actions for form fields with priority based on field dependencies
   * Prioritizes fields that might unlock other fields (e.g., country → state/city)
   */
  static generateFillActionsForForm(formAnalysis: FormAnalysis): DynamicAction[] {
    const actions: DynamicAction[] = [];
    const emptyRequired = formAnalysis.fields.filter(f => f.required && f.isEmpty);

    // Sort fields by likely dependency order (country/region first, then dependent fields)
    const dependencyOrder: Record<string, number> = {
      country: 1,
      region: 2,
      state: 2,
      city: 3,
      zip: 4,
      address: 3,
      email: 1,
      username: 1,
      password: 2,
      'password-confirm': 3,
      'confirm-password': 3,
    };

    const sortedFields = emptyRequired.sort((a, b) => {
      const aOrder = dependencyOrder[a.label.toLowerCase().replace(/\s+/g, '-')] || 5;
      const bOrder = dependencyOrder[b.label.toLowerCase().replace(/\s+/g, '-')] || 5;
      return aOrder - bOrder;
    });

    sortedFields.forEach((field, idx) => {
      actions.push({
        action: 'fill',
        selector: field.selector,
        value: this.generateTestValue(field.type, field.label),
        description: `Fill required field: ${field.label}`,
        expectedResult: 'Field is filled with valid value',
        optional: false,
        priority: idx === 0 ? 'critical' : idx < 3 ? 'high' : 'medium',
      } as DynamicAction & { priority?: string });
    });

    return actions;
  }

  /**
   * Get suggested actions for hidden element
   */
  static async getSuggestedActionsForHidden(page: Page, selector: string): Promise<DynamicAction[]> {
    const actions: DynamicAction[] = [];

    try {
      // Check if element is in a collapsed section
      const expandTrigger = await page.evaluate((sel: string) => {
        // @ts-expect-error - browser context
        const el = document.querySelector(sel);
        if (!el) return null;

        // Find parent accordion/collapse
        const parent = el.closest('.collapse, .accordion-collapse, [aria-expanded="false"]');
        if (parent) {
          // @ts-expect-error - browser context
          const trigger = document.querySelector(`[aria-controls="${parent.id}"]`) ||
                         // @ts-expect-error - browser context
                         document.querySelector(`[data-target="#${parent.id}"]`);
          if (trigger) {
            return (trigger as any).id ? `#${(trigger as any).id}` : null;
          }
        }

        // Check for tab content
        const tabContent = el.closest('.tab-pane, [role="tabpanel"]');
        if (tabContent && (tabContent as any).id) {
          // @ts-expect-error - browser context
          const tab = document.querySelector(`[aria-controls="${(tabContent as any).id}"], [href="#${(tabContent as any).id}"]`);
          if (tab) {
            return (tab as any).id ? `#${(tab as any).id}` : `[aria-controls="${(tabContent as any).id}"]`;
          }
        }

        return null;
      }, selector);

      if (expandTrigger) {
        actions.push({
          action: 'click',
          selector: expandTrigger,
          description: 'Expand collapsed section',
          expectedResult: 'Section is expanded and element is visible',
          optional: false,
        });
      }

      // Suggest scrolling into view
      actions.push({
        action: 'scroll',
        selector: selector,
        description: 'Scroll element into view',
        expectedResult: 'Element is visible in viewport',
        optional: true,
      });

    } catch (error) {
      logger.debug('[PRE_ACTION] Failed to get suggested actions for hidden', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return actions;
  }

  /**
   * Analyze page after action to detect errors
   * Uses hybrid approach for error detection and suggestion generation
   */
  static async analyzeAfterAction(
    page: Page,
    action: DynamicAction,
    actionSucceeded: boolean
  ): Promise<{
    hasNewErrors: boolean;
    errors: string[];
    suggestions: string[];
  }> {
    // If the action already failed, don't spend extra time and don't create more noise.
    if (!actionSucceeded) {
      return { hasNewErrors: false, errors: [], suggestions: [] };
    }

    const pageUrl = page.url();
    const errors = await this.getValidationErrors(page);

    // Pass patterns to browser context
    const errorPatterns = ERROR_CLASS_PATTERNS;

    // Check for toast/notification errors with extensible patterns
    const toastErrors = await page.evaluate((patterns: string[]) => {
      // @ts-expect-error - browser context
      const toasts = document.querySelectorAll('.toast, .notification, .snackbar, .alert, [role="alert"], .Toastify__toast, .ant-message, .chakra-toast');
      const errors: string[] = [];

      toasts.forEach((toast: any) => {
        const classList = Array.from(toast.classList || []) as string[];
        const hasErrorClass = patterns.some((pattern: string) =>
          classList.some((cls: string) => cls.includes(pattern))
        );

        const textLower = toast.textContent?.toLowerCase() || '';
        const hasErrorText = textLower.includes('error') ||
                            textLower.includes('failed') ||
                            textLower.includes('ошибка') ||
                            textLower.includes('неверн') ||
                            textLower.includes('неправильн');

        if (hasErrorClass || hasErrorText) {
          const text = toast.textContent?.trim();
          if (text && text.length > 2) errors.push(text);
        }
      });

      return errors;
    }, errorPatterns);

    errors.push(...toastErrors);

    const normalizedCurrent = normalizeErrorList(errors);

    // Compare against baseline captured in analyzeBeforeAction (same page+action+selector)
    const baselineKey = getErrorBaselineKey(pageUrl, action);
    const baseline = preActionErrorBaseline.get(baselineKey);
    const baselineValid = baseline && (Date.now() - baseline.timestamp) <= PRE_ACTION_ERROR_BASELINE_TTL;
    const baselineErrors = baselineValid ? baseline!.errors : [];

    const newErrors = normalizedCurrent.filter(e => !baselineErrors.includes(e));

    // Update baseline to current for safety (in case post-analysis is called multiple times)
    preActionErrorBaseline.set(baselineKey, { errors: normalizedCurrent, timestamp: Date.now() });

    const suggestions: string[] = [];

    if (newErrors.length > 0) {
      suggestions.push('Fix the validation errors before continuing');

      // Analyze specific error types using rule-based patterns
      const errorSuggestions = this.generateErrorSuggestionsRuleBased(newErrors);
      suggestions.push(...errorSuggestions);
    }

    return {
      hasNewErrors: newErrors.length > 0,
      errors: newErrors,
      suggestions,
    };
  }

  /**
   * Generate suggestions based on error messages
   * Uses extensible patterns for multi-language support
   */
  private static generateErrorSuggestionsRuleBased(errors: string[]): string[] {
    const suggestions: string[] = [];
    const seen = new Set<string>();

    // Error patterns with suggestions (multi-language)
    const ERROR_SUGGESTION_PATTERNS: Array<{
      patterns: string[];
      suggestion: string;
    }> = [
      {
        patterns: ['email', 'e-mail', 'почт', 'correo', 'メール', '이메일', '邮箱'],
        suggestion: 'Enter a valid email address',
      },
      {
        patterns: ['password', 'пароль', 'парол', 'contraseña', 'パスワード', '비밀번호', '密码'],
        suggestion: 'Check password requirements (length, special characters)',
      },
      {
        patterns: ['required', 'обязательн', 'requerido', 'erforderlich', '必須', '필수', '必填'],
        suggestion: 'Fill all required fields',
      },
      {
        patterns: ['match', 'совпад', 'coincid', 'übereinstimm', '一致', '일치', '匹配'],
        suggestion: 'Ensure password confirmation matches',
      },
      {
        patterns: ['invalid', 'неверн', 'некорректн', 'inválido', 'ungültig', '無効', '잘못', '无效'],
        suggestion: 'Check the format of entered values',
      },
      {
        patterns: ['too short', 'слишком коротк', 'muy corto', 'zu kurz', '短すぎ', '너무 짧', '太短'],
        suggestion: 'Enter a longer value',
      },
      {
        patterns: ['too long', 'слишком длинн', 'muy largo', 'zu lang', '長すぎ', '너무 길', '太长'],
        suggestion: 'Enter a shorter value',
      },
      {
        patterns: ['already exists', 'уже существ', 'ya existe', 'existiert bereits', '既に存在', '이미 존재', '已存在'],
        suggestion: 'Use a different value, this one is already taken',
      },
      {
        patterns: ['not found', 'не найден', 'no encontrad', 'nicht gefunden', '見つかりません', '찾을 수 없', '未找到'],
        suggestion: 'Check if the entered value exists',
      },
      {
        patterns: ['phone', 'телефон', 'teléfono', 'telefon', '電話', '전화', '手机'],
        suggestion: 'Enter a valid phone number',
      },
      {
        patterns: ['format', 'формат', 'formato', '形式', '형식', '格式'],
        suggestion: 'Check the format of the entered value',
      },
      {
        patterns: ['captcha', 'капч'],
        suggestion: 'Complete the captcha verification',
      },
      {
        patterns: ['agree', 'соглас', 'accept', 'принят'],
        suggestion: 'Accept the terms and conditions',
      },
    ];

    for (const error of errors) {
      const errorLower = error.toLowerCase();

      for (const { patterns, suggestion } of ERROR_SUGGESTION_PATTERNS) {
        if (patterns.some(p => errorLower.includes(p)) && !seen.has(suggestion)) {
          suggestions.push(suggestion);
          seen.add(suggestion);
          break; // Only one suggestion per error
        }
      }
    }

    return suggestions;
  }
}
