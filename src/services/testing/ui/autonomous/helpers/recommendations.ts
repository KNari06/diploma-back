import { env } from '@/config/env';
import { DOMAnalysisResult } from '@/services/testing/ui/autonomous/dom-analyzer.service';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';

/**
 * Visual analysis result structure
 */
interface VisualAnalysis {
  elements?: Array<{
    type?: string;
    purpose?: string;
    location?: string;
    required?: boolean;
  }>;
  layout?: string;
  suggestions?: string[];
}

/**
 * Page context for intelligent scope detection
 */
interface PageContext {
  url?: string;
  title?: string;
  forms?: Array<{
    action?: string;
    method?: string;
    fields?: Array<{ name?: string; type?: string; required?: boolean }>;
  }>;
  buttons?: Array<{ text?: string; type?: string }>;
  links?: Array<{ text?: string; href?: string }>;
}

/**
 * Detected page type based on analysis
 */
type DetectedPageType =
  | 'registration'
  | 'login'
  | 'checkout'
  | 'payment'
  | 'search'
  | 'profile'
  | 'settings'
  | 'contact'
  | 'newsletter'
  | 'comment'
  | 'review'
  | 'general';

/**
 * Recommendation with priority for sorting
 */
interface PrioritizedRecommendation {
  text: string;
  priority: number; // Higher = more important
  source: 'form' | 'button' | 'visual' | 'scope' | 'context';
}

/**
 * Unified form analysis result
 */
interface FormSummary {
  hasEmail: boolean;
  hasPassword: boolean;
  hasConfirmPassword: boolean;
  hasCreditCard: boolean;
  hasFileUpload: boolean;
  hasSearchInput: boolean;
  hasRating: boolean;
  hasCommentField: boolean;
  hasAddressFields: boolean;
  hasPhoneField: boolean;
  fieldCount: number;
  requiredFieldCount: number;
  allRequiredFields: string[];
  allFieldTypes: Set<string>;
  hasCheckbox: boolean;
  hasRadio: boolean;
  passwordFieldsCount: number;
}

/**
 * Check if field is honeypot/hidden (should be excluded from analysis)
 */
function isHoneypotField(field: { name?: string; type?: string }): boolean {
  if (!field) return true;

  const fieldName = (field.name || '').toLowerCase();
  const fieldType = (field.type || '').toLowerCase();

  // Type-based detection
  if (fieldType === 'hidden') {
    return true;
  }

  // Name-based detection (common honeypot patterns)
  const honeypotPatterns = [
    'honeypot',
    'hp-',
    'website', // common honeypot name
    'url', // common honeypot name
    'bot',
    'spam',
    'captcha',
    'verify-human',
  ];

  for (const pattern of honeypotPatterns) {
    if (fieldName.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Unified form structure analyzer
 * Filters honeypot fields and provides comprehensive form analysis
 * Used by both detectPageType and generateFormRecommendations
 */
function analyzeFormStructure(forms: PageContext['forms']): FormSummary {
  const result: FormSummary = {
    hasEmail: false,
    hasPassword: false,
    hasConfirmPassword: false,
    hasCreditCard: false,
    hasFileUpload: false,
    hasSearchInput: false,
    hasRating: false,
    hasCommentField: false,
    hasAddressFields: false,
    hasPhoneField: false,
    fieldCount: 0,
    requiredFieldCount: 0,
    allRequiredFields: [],
    allFieldTypes: new Set<string>(),
    hasCheckbox: false,
    hasRadio: false,
    passwordFieldsCount: 0,
  };

  if (!forms || !Array.isArray(forms)) {
    return result;
  }

  for (const form of forms) {
    if (!form.fields || !Array.isArray(form.fields)) continue;

    // Track password fields separately for confirm password detection
    const passwordFields: Array<{ name: string; type: string }> = [];

    for (const field of form.fields) {
      if (!field) continue;

      // ✅ FIX 2: Filter honeypot/hidden fields
      if (isHoneypotField(field)) {
        continue; // Skip honeypot fields
      }

      result.fieldCount++;

      if (field.required) {
        result.requiredFieldCount++;
        if (field.name) {
          result.allRequiredFields.push(field.name);
        }
      }

      const fieldName = (field.name || '').toLowerCase();
      const fieldType = (field.type || '').toLowerCase();

      if (fieldType) {
        result.allFieldTypes.add(fieldType);
      }

      // Email detection (flexible - by type or name)
      if (fieldType === 'email' || fieldName.includes('email') || fieldName.includes('e-mail')) {
        result.hasEmail = true;
      }

      // ✅ FIX 1: Password detection - count password fields
      if (fieldType === 'password') {
        result.hasPassword = true;
        result.passwordFieldsCount++;
        passwordFields.push({ name: fieldName, type: fieldType });
      }

      // Credit card detection (by field names/types)
      if (
        fieldName.includes('card') ||
        fieldName.includes('credit') ||
        fieldName.includes('cvv') ||
        fieldName.includes('cvc') ||
        fieldName.includes('expir') ||
        (fieldType === 'tel' && (fieldName.includes('card') || fieldName.includes('number')))
      ) {
        result.hasCreditCard = true;
      }

      // File upload detection
      if (fieldType === 'file' || fieldName.includes('upload') || fieldName.includes('attach')) {
        result.hasFileUpload = true;
      }

      // Search input detection
      if (
        fieldType === 'search' ||
        fieldName.includes('search') ||
        fieldName.includes('query') ||
        fieldName.includes('find')
      ) {
        result.hasSearchInput = true;
      }

      // Rating detection
      if (fieldName.includes('rating') || fieldName.includes('rate') || fieldType === 'range') {
        result.hasRating = true;
      }

      // Comment/review field detection (textarea-like fields)
      if (
        fieldName.includes('comment') ||
        fieldName.includes('review') ||
        fieldName.includes('message') ||
        fieldName.includes('feedback') ||
        fieldType === 'textarea'
      ) {
        result.hasCommentField = true;
      }

      // Address fields detection
      if (
        fieldName.includes('address') ||
        fieldName.includes('street') ||
        fieldName.includes('city') ||
        fieldName.includes('zip') ||
        fieldName.includes('postal') ||
        fieldName.includes('country') ||
        fieldName.includes('state')
      ) {
        result.hasAddressFields = true;
      }

      // Phone field detection
      if (fieldType === 'tel' || fieldName.includes('phone') || fieldName.includes('mobile')) {
        result.hasPhoneField = true;
      }
    }

    // ✅ FIX 1: Detect confirm password by:
    // 1. Count password fields: if >= 2, likely has confirm
    // 2. OR check if any password field name contains confirm/repeat/verify
    if (result.passwordFieldsCount >= 2) {
      result.hasConfirmPassword = true;
    } else if (passwordFields.some(pf =>
      pf.name.includes('confirm') ||
      pf.name.includes('repeat') ||
      pf.name.includes('verify')
    )) {
      result.hasConfirmPassword = true;
    }
  }

  // ✅ FIX 1: Check across all forms for separate confirm field (not password type)
  if (!result.hasConfirmPassword && result.hasPassword) {
    for (const form of forms) {
      if (!form.fields || !Array.isArray(form.fields)) continue;
      for (const field of form.fields) {
        if (!field || isHoneypotField(field)) continue;
        const fieldName = (field.name || '').toLowerCase();
        const fieldType = (field.type || '').toLowerCase();
        // Check for confirm/repeat/verify in field name related to password
        if (
          (fieldName.includes('confirm') || fieldName.includes('repeat') || fieldName.includes('verify')) &&
          (fieldName.includes('password') || fieldName.includes('pass') || fieldName.includes('pwd')) &&
          fieldType !== 'password' // Not already counted as password field
        ) {
          result.hasConfirmPassword = true;
          break;
        }
      }
      if (result.hasConfirmPassword) break;
    }
  }

  return result;
}

/**
 * Analyze button text and types to infer page purpose
 */
function analyzeButtons(buttons: PageContext['buttons']): {
  hasSubmit: boolean;
  hasCancel: boolean;
  hasDelete: boolean;
  hasSearch: boolean;
  hasSubscribe: boolean;
  buttonTexts: string[];
} {
  const result = {
    hasSubmit: false,
    hasCancel: false,
    hasDelete: false,
    hasSearch: false,
    hasSubscribe: false,
    buttonTexts: [] as string[],
  };

  if (!buttons || !Array.isArray(buttons)) {
    return result;
  }

  for (const button of buttons) {
    if (!button) continue;

    const buttonType = (button.type || '').toLowerCase();
    const buttonText = (button.text || '').toLowerCase();

    result.buttonTexts.push(buttonText);

    if (buttonType === 'submit') {
      result.hasSubmit = true;
    }

    // Analyze button text for purpose (flexible matching)
    if (buttonText.includes('cancel') || buttonText.includes('reset') || buttonText.includes('clear')) {
      result.hasCancel = true;
    }

    if (buttonText.includes('delete') || buttonText.includes('remove') || buttonText.includes('удалить')) {
      result.hasDelete = true;
    }

    if (buttonText.includes('search') || buttonText.includes('find') || buttonText.includes('искать')) {
      result.hasSearch = true;
    }

    if (buttonText.includes('subscribe') || buttonText.includes('sign up') || buttonText.includes('join')) {
      result.hasSubscribe = true;
    }
  }

  return result;
}

/**
 * Rule-based page type detection with confidence score
 * Returns type and confidence (0.0-1.0)
 */
function detectPageTypeRuleBased(
  scope: string | null | undefined,
  context: PageContext
): { type: DetectedPageType; confidence: number } {
  // ✅ FIX 3: Use unified form analysis
  const formStructure = analyzeFormStructure(context.forms);
  const buttonAnalysis = analyzeButtons(context.buttons);

  // Registration detection: email + password + confirm password (high confidence)
  if (
    formStructure.hasEmail &&
    formStructure.hasPassword &&
    formStructure.hasConfirmPassword
  ) {
    return { type: 'registration', confidence: 0.95 };
  }

  // Registration: email + password + multiple required fields
  if (
    formStructure.hasEmail &&
    formStructure.hasPassword &&
    formStructure.requiredFieldCount >= 3 &&
    formStructure.fieldCount >= 4
  ) {
    return { type: 'registration', confidence: 0.85 };
  }

  // Login detection: email + password (simple, 2-4 fields total)
  if (
    formStructure.hasEmail &&
    formStructure.hasPassword &&
    !formStructure.hasConfirmPassword &&
    formStructure.fieldCount <= 4
  ) {
    return { type: 'login', confidence: 0.90 };
  }

  // Payment detection: credit card fields (high confidence)
  if (formStructure.hasCreditCard) {
    return { type: 'payment', confidence: 0.95 };
  }

  // Checkout detection: address fields + phone
  if (formStructure.hasAddressFields && formStructure.hasPhoneField) {
    return { type: 'checkout', confidence: 0.85 };
  }

  // Checkout: address fields + multiple required fields
  if (formStructure.hasAddressFields && formStructure.requiredFieldCount >= 3) {
    return { type: 'checkout', confidence: 0.80 };
  }

  // Search detection: search input OR search button
  if (formStructure.hasSearchInput || buttonAnalysis.hasSearch) {
    return { type: 'search', confidence: 0.90 };
  }

  // Newsletter detection: email field + subscribe button (simple form)
  if (formStructure.hasEmail && buttonAnalysis.hasSubscribe && formStructure.fieldCount <= 2) {
    return { type: 'newsletter', confidence: 0.85 };
  }

  // Comment/Review detection: comment field + rating
  if (formStructure.hasCommentField && formStructure.hasRating) {
    return { type: 'review', confidence: 0.85 };
  }

  // Comment detection: comment field without rating
  if (formStructure.hasCommentField && !formStructure.hasRating) {
    return { type: 'comment', confidence: 0.75 };
  }

  // Contact detection: email + comment field + phone
  if (formStructure.hasEmail && formStructure.hasCommentField && formStructure.hasPhoneField) {
    return { type: 'contact', confidence: 0.85 };
  }

  // Profile/Settings detection: multiple fields, email present, no password
  if (
    formStructure.hasEmail &&
    !formStructure.hasPassword &&
    formStructure.fieldCount >= 3 &&
    formStructure.requiredFieldCount >= 2
  ) {
    // Check URL/title for hints
    const url = (context.url || '').toLowerCase();
    const title = (context.title || '').toLowerCase();
    const combined = `${url} ${title}`;

    if (combined.includes('setting') || combined.includes('preference') || combined.includes('config')) {
      return { type: 'settings', confidence: 0.80 };
    }

    return { type: 'profile', confidence: 0.75 };
  }

  // Fallback: use scope if provided (low confidence)
  if (scope) {
    const normalizedScope = scope.toLowerCase().trim();
    if (normalizedScope.includes('register') || normalizedScope.includes('signup')) {
      return { type: 'registration', confidence: 0.60 };
    }
    if (normalizedScope.includes('login') || normalizedScope.includes('signin')) {
      return { type: 'login', confidence: 0.60 };
    }
  }

  return { type: 'general', confidence: 0.50 };
}

/**
 * AI-based page type detection
 * Uses OpenAI to analyze page structure and determine type
 */
async function detectPageTypeAI(
  scope: string | null | undefined,
  context: PageContext
): Promise<{ type: DetectedPageType; confidence: number } | null> {
  try {
    const openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: 10000, // 10 seconds timeout
      maxRetries: 1,
    });

    // Prepare context summary
    const formStructure = analyzeFormStructure(context.forms);
    const buttonAnalysis = analyzeButtons(context.buttons);

    const contextSummary = {
      url: context.url || 'unknown',
      title: context.title || 'unknown',
      scope: scope || 'not specified',
      formsCount: context.forms?.length || 0,
      buttonsCount: context.buttons?.length || 0,
      formStructure: {
        hasEmail: formStructure.hasEmail,
        hasPassword: formStructure.hasPassword,
        hasConfirmPassword: formStructure.hasConfirmPassword,
        hasCreditCard: formStructure.hasCreditCard,
        hasFileUpload: formStructure.hasFileUpload,
        hasSearchInput: formStructure.hasSearchInput,
        hasRating: formStructure.hasRating,
        hasCommentField: formStructure.hasCommentField,
        hasAddressFields: formStructure.hasAddressFields,
        hasPhoneField: formStructure.hasPhoneField,
        fieldCount: formStructure.fieldCount,
        requiredFieldCount: formStructure.requiredFieldCount,
      },
      buttons: {
        hasSubmit: buttonAnalysis.hasSubmit,
        hasCancel: buttonAnalysis.hasCancel,
        hasDelete: buttonAnalysis.hasDelete,
        hasSearch: buttonAnalysis.hasSearch,
        hasSubscribe: buttonAnalysis.hasSubscribe,
      },
    };

    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2, // Low temperature for consistency
      max_tokens: 400, // ✅ FIX 4: Increased from 200 to 400 for complex structures
      messages: [
        {
          role: 'system',
          content: `You are a page type analyzer. Analyze the page structure and determine its type.
Respond with JSON: {"type": "<type>", "confidence": <0.0-1.0>}
Valid types: registration, login, checkout, payment, search, profile, settings, contact, newsletter, comment, review, general

Analyze based on:
- Form field combinations (email+password+confirm = registration, email+password = login)
- Field types (credit card = payment, address = checkout)
- Button purposes (subscribe = newsletter, search = search)
- Overall page structure and context`,
        },
        {
          role: 'user',
          content: `Analyze this page:
${JSON.stringify(contextSummary, null, 2)}

Determine the page type based on structure, not text patterns.`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    // ✅ FIX 4: Safe parsing - handle both object and string responses
    let result: any;
    try {
      if (typeof content === 'string') {
        result = JSON.parse(content);
      } else if (typeof content === 'object' && content !== null) {
        result = content; // Already parsed
      } else {
        logger.warn('[RECOMMENDATIONS] Unexpected content type from AI', {
          contentType: typeof content,
        });
        return null;
      }
    } catch (parseError) {
      logger.error('[RECOMMENDATIONS] Failed to parse AI response', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        contentPreview: typeof content === 'string' ? content.slice(0, 200) : String(content).slice(0, 200),
      });
      return null;
    }

    // ✅ FIX 4: Sanitize URL in logs (remove sensitive tokens)
    const sanitizedUrl = contextSummary.url && typeof contextSummary.url === 'string'
      ? contextSummary.url.replace(/[?&](token|key|auth|password|secret)=[^&]*/gi, '[REDACTED]')
      : contextSummary.url;

    logger.debug('[RECOMMENDATIONS] AI page type detection', {
      type: result.type,
      confidence: result.confidence,
      url: sanitizedUrl, // ✅ FIX 4: Sanitized URL
    });

    return {
      type: (result.type || 'general') as DetectedPageType,
      confidence: Math.min(Math.max(result.confidence || 0.7, 0), 1), // Clamp 0-1
    };
  } catch (error) {
    logger.debug('[RECOMMENDATIONS] AI page type detection failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Detect page type using hybrid approach (rules + AI)
 * Uses rule-based first, AI fallback if confidence is low
 */
async function detectPageType(
  scope: string | null | undefined,
  context: PageContext
): Promise<DetectedPageType> {
  // Step 1: Rule-based detection (fast, free)
  const ruleBased = detectPageTypeRuleBased(scope, context);

  // If high confidence, return immediately
  if (ruleBased.confidence >= 0.8) {
    logger.debug('[RECOMMENDATIONS] Page type detected (rule-based)', {
      type: ruleBased.type,
      confidence: ruleBased.confidence,
    });
    return ruleBased.type;
  }

  // Step 2: AI fallback for uncertain cases (confidence < 0.8)
  if (ruleBased.confidence < 0.8) {
    const aiResult = await detectPageTypeAI(scope, context);
    if (aiResult && aiResult.confidence > ruleBased.confidence) {
      logger.debug('[RECOMMENDATIONS] Page type detected (AI)', {
        type: aiResult.type,
        confidence: aiResult.confidence,
        ruleBasedConfidence: ruleBased.confidence,
      });
      return aiResult.type;
    }
  }

  // Fallback to rule-based result
  logger.debug('[RECOMMENDATIONS] Page type detected (rule-based fallback)', {
    type: ruleBased.type,
    confidence: ruleBased.confidence,
  });
  return ruleBased.type;
}

/**
 * Generate form-based recommendations
 * Processes ALL forms, not just the first one
 * ✅ REFACTORED: Uses unified FormSummary to avoid duplication
 */
function generateFormRecommendations(
  domAnalysis: DOMAnalysisResult | null | undefined
): PrioritizedRecommendation[] {
  const recommendations: PrioritizedRecommendation[] = [];

  // Safe check
  if (!domAnalysis?.forms || !Array.isArray(domAnalysis.forms) || domAnalysis.forms.length === 0) {
    return recommendations;
  }

  // ✅ FIX 3: Use unified form analysis (no duplication)
  const pageContext: PageContext = {
    forms: domAnalysis.forms,
  };
  const formSummary = analyzeFormStructure(pageContext.forms);

  // General form recommendations (high priority)
  recommendations.push({
    text: 'Test form validation (empty fields, invalid data)',
    priority: 90,
    source: 'form',
  });
  recommendations.push({
    text: 'Test successful form submission',
    priority: 85,
    source: 'form',
  });

  // Checkboxes and radios from separate arrays
  const hasCheckbox = domAnalysis.checkboxes && domAnalysis.checkboxes.length > 0;
  const hasRadio = domAnalysis.radios && domAnalysis.radios.length > 0;

  // Specific recommendations based on found elements (using FormSummary)
  if (formSummary.allRequiredFields.length > 0) {
    const uniqueRequiredFields = Array.from(new Set(formSummary.allRequiredFields)).slice(0, 5);
    recommendations.push({
      text: `Test required fields: ${uniqueRequiredFields.join(', ')}`,
      priority: 80,
      source: 'form',
    });
  }

  // Email field validation
  if (formSummary.hasEmail) {
    recommendations.push({
      text: 'Test email format validation',
      priority: 75,
      source: 'form',
    });
  }

  // Password field validation
  if (formSummary.hasPassword) {
    recommendations.push({
      text: 'Test password strength validation',
      priority: 75,
      source: 'form',
    });
    recommendations.push({
      text: 'Test password visibility toggle (if present)',
      priority: 60,
      source: 'form',
    });
  }

  // File upload
  if (formSummary.hasFileUpload) {
    recommendations.push({
      text: 'Test file upload (valid formats, size limits)',
      priority: 70,
      source: 'form',
    });
  }

  // Checkboxes
  if (hasCheckbox || formSummary.hasCheckbox) {
    recommendations.push({
      text: 'Test checkbox interactions (select/deselect)',
      priority: 65,
      source: 'form',
    });
  }

  // Radio buttons
  if (hasRadio || formSummary.hasRadio) {
    recommendations.push({
      text: 'Test radio button selection (mutual exclusivity)',
      priority: 65,
      source: 'form',
    });
  }

  // Multiple forms
  if (domAnalysis.forms.length > 1) {
    recommendations.push({
      text: `Test all ${domAnalysis.forms.length} forms independently`,
      priority: 70,
      source: 'form',
    });
  }

  return recommendations;
}

/**
 * Generate button-based recommendations
 */
function generateButtonRecommendations(
  domAnalysis: DOMAnalysisResult | null | undefined
): PrioritizedRecommendation[] {
  const recommendations: PrioritizedRecommendation[] = [];

  // Safe check
  if (!domAnalysis?.buttons || !Array.isArray(domAnalysis.buttons) || domAnalysis.buttons.length === 0) {
    return recommendations;
  }

  // Find submit buttons safely
  const submitButtons = domAnalysis.buttons.filter(button => {
    if (!button) return false;
    const buttonType = button.type?.toLowerCase() || '';
    const buttonText = button.text?.toLowerCase() || '';
    return buttonType === 'submit' || buttonText.includes('submit');
  });

  if (submitButtons.length > 0) {
    recommendations.push({
      text: 'Test button click and response',
      priority: 85,
      source: 'button',
    });
  }

  // Check for cancel/reset buttons
  const cancelButtons = domAnalysis.buttons.filter(button => {
    if (!button) return false;
    const buttonText = button.text?.toLowerCase() || '';
    return buttonText.includes('cancel') || buttonText.includes('reset') || buttonText.includes('clear');
  });

  if (cancelButtons.length > 0) {
    recommendations.push({
      text: 'Test cancel/reset button functionality',
      priority: 70,
      source: 'button',
    });
  }

  // Check for delete buttons
  const deleteButtons = domAnalysis.buttons.filter(button => {
    if (!button) return false;
    const buttonText = button.text?.toLowerCase() || '';
    return buttonText.includes('delete') || buttonText.includes('remove') || buttonText.includes('удалить');
  });

  if (deleteButtons.length > 0) {
    recommendations.push({
      text: 'Test delete button with confirmation',
      priority: 75,
      source: 'button',
    });
  }

  return recommendations;
}

/**
 * Generate scope-specific recommendations based on detected page type
 */
function generateScopeRecommendations(
  pageType: DetectedPageType,
  context: PageContext
): PrioritizedRecommendation[] {
  const recommendations: PrioritizedRecommendation[] = [];

  switch (pageType) {
    case 'registration':
      recommendations.push(
        { text: 'Test password strength validation', priority: 85, source: 'scope' },
        { text: 'Test email format validation', priority: 85, source: 'scope' },
        { text: 'Test redirect after successful registration', priority: 80, source: 'scope' },
        { text: 'Test duplicate email/username handling', priority: 75, source: 'scope' },
        { text: 'Test terms and conditions acceptance', priority: 70, source: 'scope' }
      );
      break;

    case 'login':
      recommendations.push(
        { text: 'Test login with invalid credentials', priority: 90, source: 'scope' },
        { text: 'Test "Forgot password" link functionality', priority: 80, source: 'scope' },
        { text: 'Test "Remember me" checkbox (if present)', priority: 70, source: 'scope' },
        { text: 'Test redirect after successful login', priority: 85, source: 'scope' },
        { text: 'Test account lockout after multiple failed attempts', priority: 75, source: 'scope' }
      );
      break;

    case 'checkout':
      recommendations.push(
        { text: 'Test checkout flow end-to-end', priority: 95, source: 'scope' },
        { text: 'Test shipping address validation', priority: 85, source: 'scope' },
        { text: 'Test payment method selection', priority: 85, source: 'scope' },
        { text: 'Test order summary accuracy', priority: 80, source: 'scope' }
      );
      break;

    case 'payment':
      recommendations.push(
        { text: 'Test payment form security (HTTPS, PCI compliance)', priority: 95, source: 'scope' },
        { text: 'Test credit card number validation', priority: 90, source: 'scope' },
        { text: 'Test CVV and expiry date validation', priority: 90, source: 'scope' },
        { text: 'Test payment gateway integration', priority: 85, source: 'scope' }
      );
      break;

    case 'search':
      recommendations.push(
        { text: 'Test search with empty query', priority: 80, source: 'scope' },
        { text: 'Test search with special characters', priority: 75, source: 'scope' },
        { text: 'Test search result filtering and sorting', priority: 80, source: 'scope' }
      );
      break;

    case 'profile':
    case 'settings':
      recommendations.push(
        { text: 'Test profile data update and persistence', priority: 85, source: 'scope' },
        { text: 'Test password change functionality', priority: 80, source: 'scope' },
        { text: 'Test profile picture upload (if present)', priority: 70, source: 'scope' }
      );
      break;

    case 'contact':
      recommendations.push(
        { text: 'Test contact form submission and email delivery', priority: 85, source: 'scope' },
        { text: 'Test form field validation', priority: 80, source: 'scope' }
      );
      break;

    case 'newsletter':
      recommendations.push(
        { text: 'Test email subscription and confirmation', priority: 85, source: 'scope' },
        { text: 'Test unsubscribe functionality', priority: 75, source: 'scope' }
      );
      break;

    case 'comment':
    case 'review':
      recommendations.push(
        { text: 'Test comment/review submission', priority: 85, source: 'scope' },
        { text: 'Test rating system (if present)', priority: 80, source: 'scope' },
        { text: 'Test comment moderation/approval flow', priority: 70, source: 'scope' }
      );
      break;

    default:
      // General recommendations
      break;
  }

  return recommendations;
}

/**
 * Generate test recommendations based on exploration
 * Fixed: All safety issues, removed hardcoded strings, processes all forms
 * Uses hybrid AI approach for page type detection
 */
export async function generateTestRecommendations(
  visualAnalysis: VisualAnalysis | null | undefined,
  domAnalysis: DOMAnalysisResult | null | undefined,
  scope: string | null | undefined,
  url?: string | null | undefined,
  title?: string | null | undefined
): Promise<string[]> {
  const recommendations: PrioritizedRecommendation[] = [];

  // Build page context for intelligent detection
  const context: PageContext = {
    url: url || undefined,
    title: title || undefined,
    forms: domAnalysis?.forms || undefined,
    buttons: domAnalysis?.buttons || undefined,
    links: domAnalysis?.links || undefined,
  };

  // Detect page type intelligently (hybrid: rules + AI)
  const pageType = await detectPageType(scope, context);

  logger.debug('[RECOMMENDATIONS] Detected page type', {
    pageType,
    scope: scope || 'none',
    url: url || 'none',
    formsCount: domAnalysis?.forms?.length || 0,
    buttonsCount: domAnalysis?.buttons?.length || 0,
  });

  // 1. Form-based recommendations (high priority)
  const formRecs = generateFormRecommendations(domAnalysis);
  recommendations.push(...formRecs);

  // 2. Button-based recommendations
  const buttonRecs = generateButtonRecommendations(domAnalysis);
  recommendations.push(...buttonRecs);

  // 3. Visual analysis recommendations (from AI)
  if (visualAnalysis?.suggestions && Array.isArray(visualAnalysis.suggestions)) {
    const visualRecs = visualAnalysis.suggestions
      .slice(0, 5) // Limit to top 5
      .filter((suggestion): suggestion is string => typeof suggestion === 'string' && suggestion.length > 0)
      .map(text => ({
        text,
        priority: 70, // Medium priority (AI suggestions)
        source: 'visual' as const,
      }));
    recommendations.push(...visualRecs);
  }

  // 4. Scope-specific recommendations based on detected page type
  const scopeRecs = generateScopeRecommendations(pageType, context);
  recommendations.push(...scopeRecs);

  // 5. Additional context-based recommendations
  if (domAnalysis?.links && Array.isArray(domAnalysis.links)) {
    const hasForgotPasswordLink = domAnalysis.links.some(
      link => link.text?.toLowerCase().includes('forgot') || link.text?.toLowerCase().includes('password')
    );
    if (hasForgotPasswordLink && pageType === 'login') {
      recommendations.push({
        text: 'Test "Forgot password" link navigation',
        priority: 80,
        source: 'context',
      });
    }
  }

  // Sort by priority (highest first), then deduplicate
  recommendations.sort((a, b) => b.priority - a.priority);

  // Deduplicate: keep first occurrence (highest priority)
  const seen = new Set<string>();
  const uniqueRecommendations: PrioritizedRecommendation[] = [];
  for (const rec of recommendations) {
    const normalized = rec.text.toLowerCase().trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueRecommendations.push(rec);
    }
  }

  // Return top 8 recommendations as strings
  return uniqueRecommendations.slice(0, 8).map(rec => rec.text);
}
