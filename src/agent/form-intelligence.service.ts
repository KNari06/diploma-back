/**
 * FormIntelligenceService
 *
 * Phase 2 of UI Tester Intelligence:
 * Smart form handling with AI-powered analysis
 *
 * Responsibilities:
 * 1. Detect form type (registration, login, checkout, etc.)
 * 2. Analyze field dependencies
 * 3. Generate smart fill sequence
 * 4. Handle conditional/dynamic fields
 * 5. Detect wizard/multi-step forms
 * 6. Fix validation errors intelligently
 */

import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { Page } from 'playwright';
import { DynamicAction } from './types/intelligent-testing.types';
import { FormAnalysis, PreActionAnalyzer } from './pre-action-analyzer';
import { getLocator } from './utils/selector-utils';

// ═══════════════════════════════════════════════════════════════════════════
// AI CLIENT
// ═══════════════════════════════════════════════════════════════════════════

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 15000,
  maxRetries: 1,
});

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type FormType =
  | 'registration'
  | 'login'
  | 'checkout'
  | 'contact'
  | 'search'
  | 'filter'
  | 'settings'
  | 'profile'
  | 'password_reset'
  | 'subscription'
  | 'feedback'
  | 'unknown';

export interface FieldDependency {
  sourceField: string; // selector
  targetField: string; // selector
  triggerValue?: string; // value that triggers dependency
  type: 'shows' | 'hides' | 'enables' | 'disables' | 'populates';
}

export interface WizardStep {
  stepNumber: number;
  stepName?: string;
  fields: string[]; // selectors
  nextButton?: string; // selector
  prevButton?: string; // selector
  isActive: boolean;
  isCompleted: boolean;
}

export interface SmartFillSequence {
  actions: DynamicAction[];
  dependencies: FieldDependency[];
  waitBetweenActions: number; // ms
  formType: FormType;
}

export interface FormIntelligenceResult {
  formType: FormType;
  isWizardForm: boolean;
  wizardSteps?: WizardStep[];
  dependencies: FieldDependency[];
  fillSequence: SmartFillSequence;
  confidence: number;
}

interface FormField {
  selector: string;
  type: string;
  label: string;
  required: boolean;
  value: string;
  isEmpty: boolean;
  hasError: boolean;
  errorMessage?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - Form detection patterns (multi-language)
// ═══════════════════════════════════════════════════════════════════════════

const FORM_TYPE_PATTERNS: Record<FormType, {
  urlPatterns: string[];
  fieldPatterns: string[];
  buttonPatterns: string[];
  actionPatterns: string[];
}> = {
  registration: {
    urlPatterns: ['register', 'signup', 'sign-up', 'join', 'create-account', 'регистрация'],
    fieldPatterns: ['confirm_password', 'password_confirm', 'repeat_password', 'agree', 'terms', 'условия'],
    buttonPatterns: ['register', 'sign up', 'create account', 'join', 'зарегистрироваться', 'создать аккаунт'],
    actionPatterns: ['register', 'signup', 'create'],
  },
  login: {
    urlPatterns: ['login', 'signin', 'sign-in', 'auth', 'вход', 'авторизация'],
    fieldPatterns: ['remember_me', 'remember', 'keep_logged'],
    buttonPatterns: ['log in', 'sign in', 'login', 'войти', 'вход'],
    actionPatterns: ['login', 'signin', 'auth', 'authenticate'],
  },
  checkout: {
    urlPatterns: ['checkout', 'payment', 'pay', 'order', 'cart', 'оплата', 'заказ', 'корзина'],
    fieldPatterns: ['card_number', 'cvv', 'expiry', 'billing', 'shipping', 'карта', 'адрес доставки'],
    buttonPatterns: ['pay', 'place order', 'complete', 'checkout', 'оплатить', 'оформить заказ'],
    actionPatterns: ['checkout', 'payment', 'order', 'pay'],
  },
  contact: {
    urlPatterns: ['contact', 'feedback', 'support', 'help', 'контакты', 'обратная связь'],
    fieldPatterns: ['message', 'subject', 'inquiry', 'сообщение', 'тема'],
    buttonPatterns: ['send', 'submit', 'contact', 'отправить', 'связаться'],
    actionPatterns: ['contact', 'feedback', 'inquiry', 'message'],
  },
  search: {
    urlPatterns: ['search', 'find', 'поиск'],
    fieldPatterns: ['query', 'search', 'q', 'keyword', 'поиск', 'запрос'],
    buttonPatterns: ['search', 'find', 'искать', 'найти'],
    actionPatterns: ['search', 'find', 'query'],
  },
  filter: {
    urlPatterns: ['filter', 'catalog', 'products', 'list', 'каталог', 'фильтр'],
    fieldPatterns: ['price_min', 'price_max', 'category', 'sort', 'цена', 'категория'],
    buttonPatterns: ['apply', 'filter', 'применить', 'фильтровать'],
    actionPatterns: ['filter', 'catalog'],
  },
  settings: {
    urlPatterns: ['settings', 'preferences', 'account', 'настройки', 'аккаунт'],
    fieldPatterns: ['timezone', 'language', 'notification', 'язык', 'уведомления'],
    buttonPatterns: ['save', 'update', 'сохранить', 'обновить'],
    actionPatterns: ['settings', 'update', 'preferences'],
  },
  profile: {
    urlPatterns: ['profile', 'account', 'user', 'профиль', 'личный кабинет'],
    fieldPatterns: ['bio', 'avatar', 'about', 'о себе', 'фото'],
    buttonPatterns: ['save', 'update profile', 'сохранить профиль'],
    actionPatterns: ['profile', 'account', 'user/update'],
  },
  password_reset: {
    urlPatterns: ['reset', 'forgot', 'recover', 'восстановление', 'сброс пароля'],
    fieldPatterns: ['new_password', 'confirm_new_password', 'новый пароль'],
    buttonPatterns: ['reset', 'recover', 'восстановить', 'сбросить'],
    actionPatterns: ['reset', 'forgot', 'recover'],
  },
  subscription: {
    urlPatterns: ['subscribe', 'newsletter', 'подписка', 'рассылка'],
    fieldPatterns: ['email', 'почта'],
    buttonPatterns: ['subscribe', 'join', 'подписаться'],
    actionPatterns: ['subscribe', 'newsletter'],
  },
  feedback: {
    urlPatterns: ['feedback', 'review', 'rate', 'отзыв', 'оценка'],
    fieldPatterns: ['rating', 'review', 'comment', 'рейтинг', 'комментарий'],
    buttonPatterns: ['submit', 'send', 'отправить'],
    actionPatterns: ['feedback', 'review', 'rate'],
  },
  unknown: {
    urlPatterns: [],
    fieldPatterns: [],
    buttonPatterns: [],
    actionPatterns: [],
  },
};

/**
 * Field priority for fill sequence (higher = fill first)
 */
const FIELD_PRIORITY: Record<string, number> = {
  // Identity fields first
  email: 100,
  username: 95,
  login: 95,
  // Personal info
  first_name: 90,
  firstname: 90,
  last_name: 85,
  lastname: 85,
  name: 88,
  fullname: 88,
  // Contact
  phone: 80,
  tel: 80,
  mobile: 80,
  // Password (after email)
  password: 70,
  current_password: 72,
  // Confirm password (after password)
  confirm_password: 65,
  password_confirm: 65,
  password_confirmation: 65,
  repeat_password: 65,
  new_password: 68,
  // Location (cascade: country → region → city)
  country: 60,
  region: 55,
  state: 55,
  city: 50,
  address: 45,
  street: 45,
  zip: 40,
  postal: 40,
  postcode: 40,
  // Other
  company: 35,
  organization: 35,
  message: 30,
  comment: 30,
  subject: 32,
  // Agreements last (before submit)
  terms: 10,
  agree: 10,
  consent: 10,
  privacy: 10,
  newsletter: 5,
  subscribe: 5,
};

/**
 * Field dependency patterns (source → target)
 */
const DEPENDENCY_PATTERNS: Array<{
  sourcePatterns: string[];
  targetPatterns: string[];
  type: FieldDependency['type'];
}> = [
  { sourcePatterns: ['country'], targetPatterns: ['region', 'state', 'city'], type: 'populates' },
  { sourcePatterns: ['region', 'state'], targetPatterns: ['city'], type: 'populates' },
  { sourcePatterns: ['payment_method', 'payment_type'], targetPatterns: ['card', 'bank', 'paypal'], type: 'shows' },
  { sourcePatterns: ['account_type', 'user_type'], targetPatterns: ['company', 'organization', 'vat'], type: 'shows' },
  { sourcePatterns: ['shipping_same'], targetPatterns: ['billing'], type: 'hides' },
  { sourcePatterns: ['password'], targetPatterns: ['confirm_password', 'password_confirm'], type: 'enables' },
];

/**
 * Validation error fix patterns
 */
const ERROR_FIX_PATTERNS: Array<{
  patterns: string[];
  fieldType?: string;
  fix: (currentValue: string, field: FormField) => string;
}> = [
  {
    patterns: ['already exists', 'already taken', 'уже существует', 'занят'],
    fix: (val) => val.includes('@') ? `test.${Date.now()}@example.com` : `${val}_${Date.now()}`,
  },
  {
    patterns: ['too short', 'minimum', 'at least', 'слишком коротк', 'минимум'],
    fieldType: 'password',
    fix: () => 'TestPassword123!@#',
  },
  {
    patterns: ['too weak', 'stronger', 'слабый', 'сложнее'],
    fieldType: 'password',
    fix: () => 'StrongP@ssw0rd!2024',
  },
  {
    patterns: ['invalid email', 'valid email', 'некорректный email', 'неверный email'],
    fieldType: 'email',
    fix: () => `valid.email.${Date.now()}@example.com`,
  },
  {
    patterns: ['invalid phone', 'valid phone', 'некорректный телефон', 'неверный телефон'],
    fieldType: 'tel',
    fix: () => '+1234567890',
  },
  {
    patterns: ['mismatch', 'не совпадает', "don't match", 'не совпадают'],
    fix: (_, field) => field.value, // Use the original field's value
  },
  {
    patterns: ['required', 'обязательн', 'необходимо'],
    fix: (_, field) => PreActionAnalyzer.generateTestValue(field.type, field.label),
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

const cache = {
  formType: new Map<string, CacheEntry<{ type: FormType; confidence: number }>>(),
  dependencies: new Map<string, CacheEntry<FieldDependency[]>>(),
};

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ═══════════════════════════════════════════════════════════════════════════
// AI CONFIGURATION (configurable)
// ═══════════════════════════════════════════════════════════════════════════

const AI_CONFIG = {
  formTypeDetection: {
    model: 'gpt-4o-mini' as const,
    maxTokens: 100, // Increased from 50 for stability
    temperature: 0,
  },
  dependencyDetection: {
    model: 'gpt-4o-mini' as const,
    maxTokens: 500, // Increased from 300 for complex forms
    temperature: 0,
  },
  errorFix: {
    model: 'gpt-4o-mini' as const,
    maxTokens: 150, // Increased from 100
    temperature: 0.3,
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// CONFIDENCE CALCULATION CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const CONFIDENCE_WEIGHTS = {
  URL_MATCH: 3,
  FIELD_MATCH: 2,
  BUTTON_MATCH: 2,
  ACTION_MATCH: 1,
} as const;

// Max possible score = URL(3) + FIELD(2*3 typical) + BUTTON(2) + ACTION(1) = 12
const MAX_CONFIDENCE_SCORE = 12;

// ═══════════════════════════════════════════════════════════════════════════
// FILL PRIORITY THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════

const FILL_THRESHOLDS = {
  /** Minimum priority for optional fields to be filled */
  OPTIONAL_FIELD_MIN_PRIORITY: 30,
  /** Always fill fields with priority above this */
  HIGH_PRIORITY_THRESHOLD: 50,
} as const;

function getCached<T>(cacheMap: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cacheMap.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cacheMap.delete(key);
    return null;
  }
  return entry.value;
}

function setCache<T>(cacheMap: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cacheMap.set(key, { value, timestamp: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════════════
// FORM INTELLIGENCE SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class FormIntelligenceService {
  /**
   * Main entry point: Analyze form and generate smart fill strategy
   */
  static async analyzeForm(
    page: Page,
    formAnalysis: FormAnalysis,
    url: string
  ): Promise<FormIntelligenceResult> {
    const startTime = Date.now();

    try {
      // Step 1: Detect form type
      const { type: formType, confidence } = await this.detectFormType(formAnalysis, url);

      // Step 2: Detect wizard/multi-step form
      const wizardSteps = await this.detectWizardSteps(page, formAnalysis);
      const isWizardForm = wizardSteps.length > 1;

      // Step 3: Analyze field dependencies
      const dependencies = await this.analyzeFieldDependencies(page, formAnalysis);

      // Step 4: Generate smart fill sequence
      const fillSequence = await this.generateSmartFillSequence(
        formAnalysis,
        formType,
        dependencies,
        wizardSteps
      );

      logger.info('[FORM_INTELLIGENCE] Analysis completed', {
        duration: Date.now() - startTime,
        formType,
        confidence,
        isWizardForm,
        stepsCount: wizardSteps.length,
        dependenciesCount: dependencies.length,
        actionsCount: fillSequence.actions.length,
      });

      return {
        formType,
        isWizardForm,
        wizardSteps: isWizardForm ? wizardSteps : undefined,
        dependencies,
        fillSequence,
        confidence,
      };
    } catch (error) {
      logger.error('[FORM_INTELLIGENCE] Analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return safe defaults
      return {
        formType: 'unknown',
        isWizardForm: false,
        dependencies: [],
        fillSequence: {
          actions: this.generateBasicFillActions(formAnalysis),
          dependencies: [],
          waitBetweenActions: 100,
          formType: 'unknown',
        },
        confidence: 0,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORM TYPE DETECTION (Hybrid: Rules + AI)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect form type using hybrid approach
   */
  static async detectFormType(
    form: FormAnalysis,
    url: string
  ): Promise<{ type: FormType; confidence: number }> {
    // Check cache
    const cacheKey = this.generateFormCacheKey(form, url);
    const cached = getCached(cache.formType, cacheKey);
    if (cached) {
      logger.debug('[FORM_INTELLIGENCE] Form type cache hit', { type: cached.type });
      return cached;
    }

    // Step 1: Rule-based detection
    const ruleBased = this.detectFormTypeRuleBased(form, url);

    if (ruleBased.confidence >= 0.8) {
      setCache(cache.formType, cacheKey, ruleBased);
      return ruleBased;
    }

    // Step 2: AI fallback for uncertain cases
    if (ruleBased.confidence < 0.6) {
      const aiResult = await this.detectFormTypeAI(form, url);
      if (aiResult && aiResult.confidence > ruleBased.confidence) {
        setCache(cache.formType, cacheKey, aiResult);
        return aiResult;
      }
    }

    setCache(cache.formType, cacheKey, ruleBased);
    return ruleBased;
  }

  /**
   * Rule-based form type detection
   * ✅ IMPROVED: Normalized confidence calculation
   */
  private static detectFormTypeRuleBased(
    form: FormAnalysis,
    url: string
  ): { type: FormType; confidence: number } {
    const urlLower = url.toLowerCase();
    const fieldNames = form.fields.map(f => f.label.toLowerCase() + ' ' + f.type.toLowerCase()).join(' ');
    const buttonText = form.submitButton?.text?.toLowerCase() || '';
    const formAction = form.formSelector?.toLowerCase() || '';

    const scores: Record<FormType, number> = {} as Record<FormType, number>;
    let maxPossibleScore = 0;

    for (const [formType, patterns] of Object.entries(FORM_TYPE_PATTERNS) as [FormType, typeof FORM_TYPE_PATTERNS[FormType]][]) {
      if (formType === 'unknown') continue;

      let score = 0;
      let typeMaxScore = 0;

      // URL match (weight: CONFIDENCE_WEIGHTS.URL_MATCH)
      typeMaxScore += CONFIDENCE_WEIGHTS.URL_MATCH;
      if (patterns.urlPatterns.some(p => urlLower.includes(p))) {
        score += CONFIDENCE_WEIGHTS.URL_MATCH;
      }

      // Field patterns match (weight: CONFIDENCE_WEIGHTS.FIELD_MATCH per match, max 3 matches)
      const fieldMatches = Math.min(
        patterns.fieldPatterns.filter(p => fieldNames.includes(p)).length,
        3 // Cap at 3 matches
      );
      typeMaxScore += CONFIDENCE_WEIGHTS.FIELD_MATCH * 3;
      score += fieldMatches * CONFIDENCE_WEIGHTS.FIELD_MATCH;

      // Button text match (weight: CONFIDENCE_WEIGHTS.BUTTON_MATCH)
      typeMaxScore += CONFIDENCE_WEIGHTS.BUTTON_MATCH;
      if (patterns.buttonPatterns.some(p => buttonText.includes(p))) {
        score += CONFIDENCE_WEIGHTS.BUTTON_MATCH;
      }

      // Form action match (weight: CONFIDENCE_WEIGHTS.ACTION_MATCH)
      typeMaxScore += CONFIDENCE_WEIGHTS.ACTION_MATCH;
      if (patterns.actionPatterns.some(p => formAction.includes(p))) {
        score += CONFIDENCE_WEIGHTS.ACTION_MATCH;
      }

      scores[formType] = score;
      maxPossibleScore = Math.max(maxPossibleScore, typeMaxScore);
    }

    // Find best match
    let bestType: FormType = 'unknown';
    let bestScore = 0;

    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestType = type as FormType;
      }
    }

    // ✅ IMPROVED: Normalized confidence calculation
    // Use actual max possible score (MAX_CONFIDENCE_SCORE = 12)
    const confidence = maxPossibleScore > 0
      ? Math.min(bestScore / MAX_CONFIDENCE_SCORE, 1)
      : 0;

    return { type: bestType, confidence };
  }

  /**
   * AI-based form type detection (fallback)
   */
  private static async detectFormTypeAI(
    form: FormAnalysis,
    url: string
  ): Promise<{ type: FormType; confidence: number } | null> {
    try {
      const fieldsSummary = form.fields
        .slice(0, 10) // Limit to first 10 fields
        .map(f => `${f.label} (${f.type}${f.required ? ', required' : ''})`)
        .join(', ');

      const response = await openai.chat.completions.create({
        model: AI_CONFIG.formTypeDetection.model,
        temperature: AI_CONFIG.formTypeDetection.temperature,
        max_tokens: AI_CONFIG.formTypeDetection.maxTokens,
        messages: [
          {
            role: 'system',
            content: `You are a form analyzer. Given a URL and form fields, identify the form type.
Respond with JSON: {"type": "<type>", "confidence": <0.0-1.0>}
Valid types: registration, login, checkout, contact, search, filter, settings, profile, password_reset, subscription, feedback, unknown`,
          },
          {
            role: 'user',
            content: `URL: ${url}\nFields: ${fieldsSummary}\nSubmit button: ${form.submitButton?.text || 'N/A'}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const result = JSON.parse(content);
      logger.debug('[FORM_INTELLIGENCE] AI form type detection', { result });

      return {
        type: result.type as FormType,
        confidence: Math.min(result.confidence || 0.7, 1),
      };
    } catch (error) {
      logger.debug('[FORM_INTELLIGENCE] AI form type detection failed', { error });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIELD DEPENDENCIES (Hybrid: Rules + AI)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Analyze dependencies between form fields
   */
  static async analyzeFieldDependencies(
    page: Page,
    form: FormAnalysis
  ): Promise<FieldDependency[]> {
    // Step 1: Rule-based dependency detection
    const ruleBased = this.detectDependenciesRuleBased(form);

    // Step 2: DOM-based dependency detection
    const domBased = await this.detectDependenciesFromDOM(page, form);

    // Merge and deduplicate
    const allDeps = [...ruleBased, ...domBased];
    const uniqueDeps = this.deduplicateDependencies(allDeps);

    // Step 3: AI fallback if no dependencies found but form is complex
    if (uniqueDeps.length === 0 && form.fields.length > 5) {
      const aiDeps = await this.detectDependenciesAI(form);
      return aiDeps;
    }

    return uniqueDeps;
  }

  /**
   * Rule-based dependency detection
   */
  private static detectDependenciesRuleBased(form: FormAnalysis): FieldDependency[] {
    const dependencies: FieldDependency[] = [];

    for (const pattern of DEPENDENCY_PATTERNS) {
      const sourceFields = form.fields.filter(f =>
        pattern.sourcePatterns.some(p =>
          f.label.toLowerCase().includes(p) || f.selector.toLowerCase().includes(p)
        )
      );

      const targetFields = form.fields.filter(f =>
        pattern.targetPatterns.some(p =>
          f.label.toLowerCase().includes(p) || f.selector.toLowerCase().includes(p)
        )
      );

      for (const source of sourceFields) {
        for (const target of targetFields) {
          dependencies.push({
            sourceField: source.selector,
            targetField: target.selector,
            type: pattern.type,
          });
        }
      }
    }

    // Password confirmation dependency
    const passwordField = form.fields.find(f =>
      f.type === 'password' && !f.label.toLowerCase().includes('confirm')
    );
    const confirmField = form.fields.find(f =>
      f.type === 'password' && f.label.toLowerCase().includes('confirm')
    );

    if (passwordField && confirmField) {
      dependencies.push({
        sourceField: passwordField.selector,
        targetField: confirmField.selector,
        type: 'enables',
      });
    }

    return dependencies;
  }

  /**
   * DOM-based dependency detection (data-* attributes, aria-controls)
   * ✅ IMPROVED: Better selector normalization, space-separated IDs handling
   */
  private static async detectDependenciesFromDOM(
    page: Page,
    form: FormAnalysis
  ): Promise<FieldDependency[]> {
    try {
      const selectors = form.fields.map(f => f.selector);

      const rawDeps = await page.evaluate((fieldSelectors: string[]) => {
        const deps: Array<{
          sourceField: string;
          targetField: string;
          type: string;
          triggerValue?: string;
        }> = [];

        /**
         * Normalize selector from aria-controls/data-controls
         * Handles: space-separated IDs, CSS selectors, plain IDs
         */
        const normalizeControlSelector = (value: string): string[] => {
          if (!value || typeof value !== 'string') return [];

          // Split by space (aria-controls can have multiple IDs)
          const parts = value.trim().split(/\s+/);
          const selectors: string[] = [];

          for (const part of parts) {
            if (!part) continue;

            // Already a CSS selector (starts with ., #, or [)
            if (part.startsWith('.') || part.startsWith('#') || part.startsWith('[')) {
              selectors.push(part);
            }
            // Plain ID - add # prefix
            else if (/^[a-zA-Z_][\w-]*$/.test(part)) {
              selectors.push(`#${part}`);
            }
            // Skip invalid values
          }

          return selectors;
        };

        for (const selector of fieldSelectors) {
          try {
            // @ts-expect-error - browser context
            const el = document.querySelector(selector);
            if (!el) continue;

            // Check data-controls / aria-controls (can be space-separated)
            const controls = el.getAttribute('data-controls') ||
                            el.getAttribute('aria-controls') ||
                            el.getAttribute('data-target');

            if (controls) {
              const targetSelectors = normalizeControlSelector(controls);
              for (const targetSel of targetSelectors) {
                deps.push({
                  sourceField: selector,
                  targetField: targetSel,
                  type: 'shows',
                });
              }
            }

            // Check data-depends-on
            const dependsOn = el.getAttribute('data-depends-on') ||
                             el.getAttribute('data-dependency');

            if (dependsOn) {
              const sourceSelectors = normalizeControlSelector(dependsOn);
              for (const sourceSel of sourceSelectors) {
                deps.push({
                  sourceField: sourceSel,
                  targetField: selector,
                  type: 'enables',
                });
              }
            }

            // Check conditional visibility attributes
            const showWhen = el.getAttribute('data-show-when') ||
                            el.getAttribute('data-visible-when');

            if (showWhen && showWhen.includes('=')) {
              // Parse "fieldName=value" format
              const eqIndex = showWhen.indexOf('=');
              const field = showWhen.substring(0, eqIndex).trim();
              const value = showWhen.substring(eqIndex + 1).trim();

              if (field) {
                deps.push({
                  sourceField: `[name="${field}"], #${field}`,
                  targetField: selector,
                  type: 'shows',
                  triggerValue: value || undefined,
                });
              }
            }
          } catch (e) {
            // Skip invalid selectors, log for debugging
            console.debug('[FORM_INTELLIGENCE] Selector error:', selector, e);
          }
        }

        return deps;
      }, selectors);

      // ✅ IMPROVED: Validate returned objects
      return rawDeps
        .filter(d =>
          d &&
          typeof d.sourceField === 'string' &&
          typeof d.targetField === 'string' &&
          typeof d.type === 'string' &&
          d.sourceField.length > 0 &&
          d.targetField.length > 0
        )
        .map(d => ({
          sourceField: d.sourceField,
          targetField: d.targetField,
          type: d.type as FieldDependency['type'],
          triggerValue: d.triggerValue,
        }));
    } catch (error) {
      // ✅ IMPROVED: Better error tracing
      logger.warn('[FORM_INTELLIGENCE] DOM dependency detection failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : undefined,
        fieldsCount: form.fields.length,
      });
      return [];
    }
  }

  /**
   * AI-based dependency detection (fallback)
   */
  private static async detectDependenciesAI(form: FormAnalysis): Promise<FieldDependency[]> {
    try {
      const fieldsSummary = form.fields
        .map(f => `${f.label} (${f.type}, selector: ${f.selector})`)
        .join('\n');

      const response = await openai.chat.completions.create({
        model: AI_CONFIG.dependencyDetection.model,
        temperature: AI_CONFIG.dependencyDetection.temperature,
        max_tokens: AI_CONFIG.dependencyDetection.maxTokens,
        messages: [
          {
            role: 'system',
            content: `You are a form analyzer. Identify field dependencies.
Return JSON: {"dependencies": [{"sourceField": "<selector>", "targetField": "<selector>", "type": "shows|hides|enables|disables|populates"}]}
Common dependencies:
- Country → City (populates)
- Payment method → Card fields (shows)
- Password → Confirm password (enables)
- Account type → Company fields (shows)
Return {"dependencies": []} if no dependencies found.`,
          },
          {
            role: 'user',
            content: `Form fields:\n${fieldsSummary}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return [];

      const result = JSON.parse(content);
      const deps = Array.isArray(result) ? result : result.dependencies || [];

      logger.debug('[FORM_INTELLIGENCE] AI dependency detection', { count: deps.length });
      return deps;
    } catch (error) {
      logger.debug('[FORM_INTELLIGENCE] AI dependency detection failed', { error });
      return [];
    }
  }

  /**
   * Remove duplicate dependencies
   */
  private static deduplicateDependencies(deps: FieldDependency[]): FieldDependency[] {
    const seen = new Set<string>();
    return deps.filter(d => {
      const key = `${d.sourceField}|${d.targetField}|${d.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WIZARD/MULTI-STEP DETECTION (Rule-based only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect wizard/multi-step form structure
   * ✅ IMPROVED: Better button selector generation, validation
   */
  static async detectWizardSteps(
    page: Page,
    form: FormAnalysis
  ): Promise<WizardStep[]> {
    try {
      const rawSteps = await page.evaluate((formSelector: string | undefined) => {
        const steps: Array<{
          stepNumber: number;
          stepName?: string;
          fields: string[];
          nextButton?: string;
          prevButton?: string;
          isActive: boolean;
          isCompleted: boolean;
        }> = [];

        /**
         * Generate precise selector for button element
         * Priority: id > data-* > name > unique class > text-based
         */
        const generateButtonSelector = (btn: any): string | undefined => {
          if (!btn) return undefined;

          // 1. ID (most reliable)
          if (btn.id) {
            return `#${btn.id}`;
          }

          // 2. data-testid or data-cy (test attributes)
          const testId = btn.getAttribute('data-testid') ||
                        btn.getAttribute('data-cy') ||
                        btn.getAttribute('data-test');
          if (testId) {
            return `[data-testid="${testId}"], [data-cy="${testId}"], [data-test="${testId}"]`;
          }

          // 3. data-action attribute
          const dataAction = btn.getAttribute('data-action') ||
                            btn.getAttribute('data-next') ||
                            btn.getAttribute('data-prev');
          if (dataAction) {
            return `[data-action="${dataAction}"]`;
          }

          // 4. name attribute
          const name = btn.getAttribute('name');
          if (name) {
            return `[name="${name}"]`;
          }

          // 5. Unique class combination (avoid generic classes)
          const classList = Array.from(btn.classList) as string[];
          const uniqueClasses = classList.filter((c: string) =>
            !['btn', 'button', 'active', 'disabled', 'primary', 'secondary'].includes(c) &&
            c.length > 2
          );
          if (uniqueClasses.length > 0) {
            return `.${uniqueClasses[0]}`;
          }

          // 6. Text-based selector (last resort)
          const text = btn.textContent?.trim();
          if (text && text.length < 30) {
            const tagName = btn.tagName.toLowerCase();
            return `${tagName}:has-text("${text.substring(0, 20)}")`;
          }

          return undefined;
        };

        /**
         * Generate field selector
         */
        const generateFieldSelector = (f: any): string => {
          if (f.id) return `#${f.id}`;
          if (f.name) return `[name="${f.name}"]`;
          // Fallback to type + placeholder
          const type = f.getAttribute('type') || f.tagName.toLowerCase();
          const placeholder = f.getAttribute('placeholder');
          if (placeholder) return `[type="${type}"][placeholder="${placeholder}"]`;
          return `${f.tagName.toLowerCase()}`;
        };

        // Strategy 1: Look for data-step attributes
        // @ts-expect-error - browser context
        const stepElements = document.querySelectorAll('[data-step], [data-wizard-step]');
        if (stepElements.length > 0) {
          stepElements.forEach((el: any, index: number) => {
            const stepNum = parseInt(el.getAttribute('data-step') || String(index + 1));
            const stepName = el.getAttribute('data-step-name') || el.getAttribute('aria-label');
            const fields = Array.from(el.querySelectorAll('input, select, textarea'))
              .map(generateFieldSelector)
              .filter((s: string) => s.length > 0);

            const nextBtn = el.querySelector('[data-next], .next-step, .btn-next, [type="submit"]');
            const prevBtn = el.querySelector('[data-prev], .prev-step, .btn-prev, .back');

            steps.push({
              stepNumber: stepNum,
              stepName: stepName || undefined,
              fields,
              nextButton: generateButtonSelector(nextBtn),
              prevButton: generateButtonSelector(prevBtn),
              isActive: el.classList.contains('active') || el.getAttribute('aria-current') === 'step',
              isCompleted: el.classList.contains('completed') || el.classList.contains('done'),
            });
          });

          return steps;
        }

        // Strategy 2: Look for step indicators
        // @ts-expect-error - browser context
        const stepIndicators = document.querySelectorAll('.step, .wizard-step, [role="tab"], .nav-step');
        if (stepIndicators.length > 1) {
          stepIndicators.forEach((indicator: any, index: number) => {
            const stepNum = index + 1;
            const stepName = indicator.textContent?.trim();

            // Handle space-separated aria-controls
            const ariaControls = indicator.getAttribute('aria-controls');
            const panelId = ariaControls
              ? ariaControls.split(/\s+/)[0] // Take first ID if multiple
              : indicator.getAttribute('data-target')?.replace('#', '');

            // @ts-expect-error - browser context
            const panel = panelId ? document.getElementById(panelId) : null;
            const fields = panel
              ? Array.from(panel.querySelectorAll('input, select, textarea'))
                  .map(generateFieldSelector)
                  .filter((s: string) => s.length > 0)
              : [];

            // Find next/prev buttons within panel
            const nextBtn = panel?.querySelector('[data-next], .next-step, .btn-next, [type="submit"]');
            const prevBtn = panel?.querySelector('[data-prev], .prev-step, .btn-prev, .back');

            steps.push({
              stepNumber: stepNum,
              stepName: stepName || undefined,
              fields,
              nextButton: generateButtonSelector(nextBtn),
              prevButton: generateButtonSelector(prevBtn),
              isActive: indicator.classList.contains('active') ||
                       indicator.getAttribute('aria-selected') === 'true',
              isCompleted: indicator.classList.contains('completed'),
            });
          });

          return steps;
        }

        // Strategy 3: Look for fieldsets
        const container = formSelector
          // @ts-expect-error - browser context
          ? document.querySelector(formSelector)
          // @ts-expect-error - browser context
          : document.querySelector('form');

        if (container) {
          const fieldsets = Array.from(container.querySelectorAll('fieldset, .form-section, .form-step'));
          if (fieldsets.length > 1) {
            fieldsets.forEach((fieldset: any, index: number) => {
              const legend = fieldset.querySelector('legend, .section-title, h2, h3');
              const stepName = legend?.textContent?.trim();
              const fields = Array.from(fieldset.querySelectorAll('input, select, textarea'))
                .map(generateFieldSelector)
                .filter((s: string) => s.length > 0);

              const nextBtn = fieldset.querySelector('[data-next], .next-step, .btn-next, [type="submit"]');
              const prevBtn = fieldset.querySelector('[data-prev], .prev-step, .btn-prev, .back');

              steps.push({
                stepNumber: index + 1,
                stepName: stepName || undefined,
                fields,
                nextButton: generateButtonSelector(nextBtn),
                prevButton: generateButtonSelector(prevBtn),
                isActive: !fieldset.hidden && fieldset.style?.display !== 'none',
                isCompleted: false,
              });
            });
          }
        }

        return steps;
      }, form.formSelector);

      // ✅ IMPROVED: Validate returned steps
      return rawSteps
        .filter(step =>
          step &&
          typeof step.stepNumber === 'number' &&
          Array.isArray(step.fields) &&
          typeof step.isActive === 'boolean'
        )
        .map(step => ({
          stepNumber: step.stepNumber,
          stepName: step.stepName,
          fields: step.fields.filter(f => typeof f === 'string' && f.length > 0),
          nextButton: step.nextButton,
          prevButton: step.prevButton,
          isActive: step.isActive,
          isCompleted: step.isCompleted,
        }));
    } catch (error) {
      // ✅ IMPROVED: Better error tracing
      logger.warn('[FORM_INTELLIGENCE] Wizard detection failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : undefined,
        formSelector: form.formSelector,
      });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART FILL SEQUENCE GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate optimized fill sequence based on form analysis
   * ✅ IMPROVED: Priority-based optional field filling
   */
  static async generateSmartFillSequence(
    form: FormAnalysis,
    formType: FormType,
    dependencies: FieldDependency[],
    wizardSteps: WizardStep[]
  ): Promise<SmartFillSequence> {
    const actions: DynamicAction[] = [];

    // ✅ IMPROVED: Get fields to fill based on priority threshold
    // - Always fill required fields
    // - Fill optional fields if they have high priority (e.g., email, name)
    // - Skip low-priority optional fields (e.g., newsletter checkbox)
    const fieldsToFill = form.fields.filter(f => {
      if (!f.isEmpty) return false; // Already filled

      // Always fill required fields
      if (f.required) return true;

      // For known form types, fill high-priority optional fields
      if (formType !== 'unknown') {
        const fieldPriority = this.getFieldPriority(f);
        return fieldPriority >= FILL_THRESHOLDS.OPTIONAL_FIELD_MIN_PRIORITY;
      }

      return false;
    });

    if (wizardSteps.length > 1) {
      // Multi-step form: organize by steps
      for (const step of wizardSteps) {
        const stepFields = fieldsToFill.filter(f => step.fields.includes(f.selector));
        const sortedFields = this.sortFieldsByPriority(stepFields, dependencies);

        for (const field of sortedFields) {
          actions.push(this.createFillAction(field, formType));
        }

        // Add next button click if not last step
        if (step.nextButton && step.stepNumber < wizardSteps.length) {
          actions.push({
            action: 'click',
            selector: step.nextButton,
            description: `Go to step ${step.stepNumber + 1}`,
            expectedResult: 'Next step is displayed',
            optional: false,
          });
        }
      }
    } else {
      // Single-step form: sort by priority
      const sortedFields = this.sortFieldsByPriority(fieldsToFill, dependencies);

      for (const field of sortedFields) {
        actions.push(this.createFillAction(field, formType));
      }
    }

    // Add checkbox/agreement actions at the end
    const checkboxes = form.fields.filter(f =>
      f.type === 'checkbox' && f.isEmpty && f.required
    );
    for (const checkbox of checkboxes) {
      actions.push({
        action: 'check',
        selector: checkbox.selector,
        description: `Accept: ${checkbox.label}`,
        expectedResult: 'Checkbox is checked',
        optional: false,
      });
    }

    return {
      actions,
      dependencies,
      waitBetweenActions: this.calculateWaitTime(formType, dependencies.length > 0),
      formType,
    };
  }

  /**
   * Sort fields by priority considering dependencies
   * ✅ IMPROVED: Topological sort with cycle detection
   */
  private static sortFieldsByPriority(
    fields: FormField[],
    dependencies: FieldDependency[]
  ): FormField[] {
    // Build dependency graph
    const dependsOn = new Map<string, string[]>();
    const dependents = new Map<string, string[]>();

    for (const dep of dependencies) {
      // Target depends on source
      const existing = dependsOn.get(dep.targetField) || [];
      existing.push(dep.sourceField);
      dependsOn.set(dep.targetField, existing);

      // Source has dependents
      const deps = dependents.get(dep.sourceField) || [];
      deps.push(dep.targetField);
      dependents.set(dep.sourceField, deps);
    }

    // ✅ IMPROVED: Detect cycles using DFS
    const hasCycle = this.detectDependencyCycle(fields, dependsOn);
    if (hasCycle) {
      logger.warn('[FORM_INTELLIGENCE] Dependency cycle detected, using priority-only sorting');
      // Fallback: ignore dependencies, use priority only
      return this.sortByPriorityOnly(fields);
    }

    // Calculate priority for each field
    const fieldWithPriority = fields.map(field => {
      let priority = 0;

      // Check FIELD_PRIORITY by label and selector
      const labelLower = field.label.toLowerCase();
      const selectorLower = field.selector.toLowerCase();

      for (const [pattern, priorityValue] of Object.entries(FIELD_PRIORITY)) {
        if (labelLower.includes(pattern) || selectorLower.includes(pattern)) {
          priority = Math.max(priority, priorityValue);
        }
      }

      // Boost priority if other fields depend on this one
      const hasDeps = dependents.has(field.selector);
      if (hasDeps) {
        priority += 20;
      }

      // Reduce priority if this field depends on others
      const deps = dependsOn.get(field.selector) || [];
      priority -= deps.length * 5;

      // Default priority for unknown fields
      if (priority === 0) {
        priority = 25; // Middle priority
      }

      return { field, priority, deps: deps.length };
    });

    // ✅ IMPROVED: Topological sort with priority as tiebreaker
    const sorted: FormField[] = [];
    const visited = new Set<string>();
    const inProgress = new Set<string>();

    const visit = (selector: string): void => {
      if (visited.has(selector)) return;
      if (inProgress.has(selector)) {
        // Cycle detected during visit - skip (shouldn't happen after hasCycle check)
        logger.debug('[FORM_INTELLIGENCE] Cycle during visit, skipping', { selector });
        return;
      }

      inProgress.add(selector);

      // Visit dependencies first
      const deps = dependsOn.get(selector) || [];
      for (const dep of deps) {
        // Only visit if it's in our field list
        if (fields.some(f => f.selector === dep)) {
          visit(dep);
        }
      }

      inProgress.delete(selector);
      visited.add(selector);

      const fieldData = fieldWithPriority.find(fp => fp.field.selector === selector);
      if (fieldData) {
        sorted.push(fieldData.field);
      }
    };

    // Sort by priority first, then do topological sort
    fieldWithPriority.sort((a, b) => b.priority - a.priority);

    for (const fp of fieldWithPriority) {
      visit(fp.field.selector);
    }

    return sorted;
  }

  /**
   * Detect cycles in dependency graph using DFS
   */
  private static detectDependencyCycle(
    fields: FormField[],
    dependsOn: Map<string, string[]>
  ): boolean {
    const fieldSelectors = new Set(fields.map(f => f.selector));
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const hasCycleDFS = (selector: string): boolean => {
      if (inStack.has(selector)) return true; // Cycle!
      if (visited.has(selector)) return false;

      visited.add(selector);
      inStack.add(selector);

      const deps = dependsOn.get(selector) || [];
      for (const dep of deps) {
        // Only check if dependency is in our field list
        if (fieldSelectors.has(dep) && hasCycleDFS(dep)) {
          return true;
        }
      }

      inStack.delete(selector);
      return false;
    };

    for (const field of fields) {
      if (hasCycleDFS(field.selector)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Simple priority-only sorting (fallback when cycles detected)
   */
  private static sortByPriorityOnly(fields: FormField[]): FormField[] {
    return [...fields].sort((a, b) => {
      return this.getFieldPriority(b) - this.getFieldPriority(a);
    });
  }

  /**
   * Get priority value for a field
   */
  private static getFieldPriority(field: FormField): number {
    const labelLower = field.label.toLowerCase();
    const selectorLower = field.selector.toLowerCase();
    let priority = 25; // Default

    for (const [pattern, priorityValue] of Object.entries(FIELD_PRIORITY)) {
      if (labelLower.includes(pattern) || selectorLower.includes(pattern)) {
        priority = Math.max(priority, priorityValue);
      }
    }

    return priority;
  }

  /**
   * Create fill action for a field
   */
  private static createFillAction(field: FormField, formType: FormType): DynamicAction {
    const value = this.generateSmartValue(field, formType);

    return {
      action: field.type === 'select' || field.type === 'select-one' ? 'select' : 'fill',
      selector: field.selector,
      value,
      description: `Fill ${field.label}`,
      expectedResult: `${field.label} is filled with valid value`,
      optional: !field.required,
    };
  }

  /**
   * Generate smart value based on field and form type
   */
  private static generateSmartValue(field: FormField, formType: FormType): string {
    // Use PreActionAnalyzer's generateTestValue as base
    const baseValue = PreActionAnalyzer.generateTestValue(field.type, field.label);

    // Customize based on form type
    const labelLower = field.label.toLowerCase();

    // For registration forms, generate unique values
    if (formType === 'registration') {
      if (field.type === 'email' || labelLower.includes('email')) {
        return `test.reg.${Date.now()}@example.com`;
      }
      if (labelLower.includes('username') || labelLower.includes('login')) {
        return `testuser_${Date.now()}`;
      }
    }

    // For checkout, use realistic values
    if (formType === 'checkout') {
      if (labelLower.includes('card') && labelLower.includes('number')) {
        return '4111111111111111'; // Test Visa
      }
      if (labelLower.includes('cvv') || labelLower.includes('cvc')) {
        return '123';
      }
      if (labelLower.includes('expir')) {
        const nextYear = new Date().getFullYear() + 1;
        return `12/${nextYear.toString().slice(-2)}`;
      }
    }

    // For contact forms
    if (formType === 'contact') {
      if (labelLower.includes('subject')) {
        return 'Test inquiry';
      }
      if (labelLower.includes('message')) {
        return 'This is a test message for QA purposes.';
      }
    }

    return baseValue;
  }

  /**
   * Calculate wait time between actions
   */
  private static calculateWaitTime(formType: FormType, hasDependencies: boolean): number {
    // Base wait time
    let wait = 100;

    // Increase for forms with dependencies (AJAX loads)
    if (hasDependencies) {
      wait = 300;
    }

    // Specific form types
    if (formType === 'checkout') {
      wait = 500; // Payment forms often have validation
    }

    return wait;
  }

  /**
   * Generate basic fill actions (fallback)
   */
  private static generateBasicFillActions(form: FormAnalysis): DynamicAction[] {
    return form.fields
      .filter(f => f.required && f.isEmpty)
      .map(field => ({
        action: 'fill' as const,
        selector: field.selector,
        value: PreActionAnalyzer.generateTestValue(field.type, field.label),
        description: `Fill ${field.label}`,
        expectedResult: 'Field filled',
        optional: false,
      }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION ERROR FIXING (Hybrid: Rules + AI)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate fix for validation error
   */
  static async fixValidationError(
    error: string,
    field: FormField,
    relatedFields?: FormField[]
  ): Promise<{ value: string; confidence: number } | null> {
    // Step 1: Rule-based fix
    const ruleBased = this.fixErrorRuleBased(error, field);
    if (ruleBased) {
      return { value: ruleBased, confidence: 0.9 };
    }

    // Step 2: Special handling for mismatch errors
    if (error.toLowerCase().includes('mismatch') || error.toLowerCase().includes('match')) {
      // Find the original field this should match
      const originalField = relatedFields?.find(f =>
        f.type === field.type && !f.label.toLowerCase().includes('confirm')
      );
      if (originalField?.value) {
        return { value: originalField.value, confidence: 0.95 };
      }
    }

    // Step 3: AI fallback for complex errors
    const aiResult = await this.fixErrorAI(error, field);
    return aiResult;
  }

  /**
   * Rule-based error fix
   */
  private static fixErrorRuleBased(error: string, field: FormField): string | null {
    const errorLower = error.toLowerCase();

    for (const pattern of ERROR_FIX_PATTERNS) {
      // Check if error matches pattern
      if (!pattern.patterns.some(p => errorLower.includes(p))) {
        continue;
      }

      // Check if field type matches (if specified)
      if (pattern.fieldType && field.type !== pattern.fieldType) {
        continue;
      }

      return pattern.fix(field.value, field);
    }

    return null;
  }

  /**
   * AI-based error fix (fallback)
   */
  private static async fixErrorAI(
    error: string,
    field: FormField
  ): Promise<{ value: string; confidence: number } | null> {
    try {
      const response = await openai.chat.completions.create({
        model: AI_CONFIG.errorFix.model,
        temperature: AI_CONFIG.errorFix.temperature,
        max_tokens: AI_CONFIG.errorFix.maxTokens,
        messages: [
          {
            role: 'system',
            content: `You are a form fixer. Given an error and field info, generate a valid value.
Return JSON: {"value": "<new_value>", "confidence": <0.0-1.0>}
Generate realistic test values. For unique errors, add timestamp.
For password errors, use strong passwords with uppercase, lowercase, numbers, and symbols.`,
          },
          {
            role: 'user',
            content: `Error: "${error}"\nField: ${field.label} (${field.type})\nCurrent value: "${field.value}"`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const result = JSON.parse(content);
      logger.debug('[FORM_INTELLIGENCE] AI error fix', { error, result });

      return {
        value: result.value || PreActionAnalyzer.generateTestValue(field.type, field.label),
        confidence: result.confidence || 0.7,
      };
    } catch (err) {
      logger.debug('[FORM_INTELLIGENCE] AI error fix failed', { error: err });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONDITIONAL FIELDS HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wait for and handle conditional fields that appear after actions
   */
  static async waitForConditionalFields(
    page: Page,
    action: DynamicAction,
    dependencies: FieldDependency[],
    timeout: number = 3000
  ): Promise<string[]> {
    const newFields: string[] = [];

    // Find dependencies triggered by this action's selector
    const triggeredDeps = dependencies.filter(d =>
      d.sourceField === action.selector && d.type === 'shows'
    );

    if (triggeredDeps.length === 0) {
      return newFields;
    }

    // Wait for each dependent field to appear
    for (const dep of triggeredDeps) {
      try {
        const locator = getLocator(page, dep.targetField);
        await locator.waitFor({ state: 'visible', timeout });
        newFields.push(dep.targetField);
        logger.debug('[FORM_INTELLIGENCE] Conditional field appeared', {
          trigger: action.selector,
          field: dep.targetField,
        });
      } catch {
        // Field didn't appear - might need different trigger value
      }
    }

    return newFields;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate cache key for form
   */
  private static generateFormCacheKey(form: FormAnalysis, url: string): string {
    const fieldKeys = form.fields.map(f => `${f.type}:${f.label}`).sort().join('|');
    return `${url}::${fieldKeys}`;
  }

  /**
   * Clear form intelligence cache
   */
  static clearCache(): void {
    cache.formType.clear();
    cache.dependencies.clear();
    logger.debug('[FORM_INTELLIGENCE] Cache cleared');
  }
}
