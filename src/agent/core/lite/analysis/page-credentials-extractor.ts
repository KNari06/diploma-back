/**
 * Page Credentials Extractor
 *
 * Extracts demo/test credentials from visible page text (no LLM involved).
 * Used for login goals when no credentials are provided/saved.
 *
 * SECURITY:
 * - Extracted credentials are never logged, traced, or sent to LLM
 * - Only metadata (lengths, confidence, source patterns) is logged
 */

import { logger } from '@/utils/core/logger';
import type { ElementBounds, LiteElement, LiteSnapshot } from '../lite-types';

/**
 * Result of page credentials extraction
 */
export interface PageCredentialsResult {
  /** Extracted username/email (undefined if not found) */
  username?: string;
  /** Extracted password (undefined if not found) */
  password?: string;
  /** Confidence level based on extraction quality */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Sample of source text pattern (for debugging, no actual values) */
  sourcePattern?: string;
}

/**
 * Regex patterns for extracting credentials from page text
 * Multilingual support: EN, RU, TR, KZ, UK, DE, FR, ES, PT, IT, PL, ZH, JA, AR
 * Covers common demo page formats like:
 * - "username is student" / "Логин: admin" / "Kullanıcı adı: test"
 * - "password = Password123" / "Пароль: 123456" / "Şifre: demo"
 */
const USERNAME_PATTERNS = [
  // English: username, user, login, email, user id, userid
  /(?:username|user|login|email|user\s*id|userid)\s*(?:is|:|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,
  /(?:^|\s)(?:user|login|email|userid|user\s*id)\s*:\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Russian: логин, пользователь, имя пользователя, почта, емейл
  /(?:логин|пользователь|имя\s+пользователя|почта|емейл|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Turkish: kullanıcı adı, kullanıcı, giriş, e-posta
  /(?:kullanıcı\s+adı|kullanıcı|giriş|e-posta|eposta)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Kazakh: пайдаланушы, кіру, электрондық пошта
  /(?:пайдаланушы|кіру|электрондық\s+пошта)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Ukrainian: користувач, логін, електронна пошта
  /(?:користувач|логін|електронна\s+пошта|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // German: benutzername, benutzer, anmelden, e-mail
  /(?:benutzername|benutzer|anmelden|e-mail)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // French: nom d'utilisateur, utilisateur, connexion, e-mail
  /(?:nom\s+d'utilisateur|nom\s+utilisateur|utilisateur|connexion|e-mail|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Spanish: nombre de usuario, usuario, iniciar sesión, correo
  /(?:nombre\s+de\s+usuario|usuario|iniciar\s+sesión|correo|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Portuguese: nome de usuário, usuário, login, e-mail
  /(?:nome\s+de\s+usuário|usuário|login|e-mail|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Italian: nome utente, utente, accesso, e-mail
  /(?:nome\s+utente|utente|accesso|e-mail|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Polish: nazwa użytkownika, użytkownik, login, e-mail
  /(?:nazwa\s+użytkownika|użytkownik|login|e-mail|email)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Chinese: 用户名, 用户, 登录, 邮箱
  /(?:用户名|用户|登录|邮箱)\s*(?::|：|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Japanese: ユーザー名, ユーザー, ログイン, メール
  /(?:ユーザー名|ユーザー|ログイン|メール)\s*(?::|：|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Arabic: اسم المستخدم, المستخدم, تسجيل الدخول, البريد الإلكتروني
  /(?:اسم\s+المستخدم|المستخدم|تسجيل\s+الدخول|البريد\s+الإلكتروني)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,
];

const PASSWORD_PATTERNS = [
  // English: password, pass, pwd, pin, passcode, secret
  /(?:password|pass|pwd|pin|passcode|secret)\s*(?:is\s*:?|:|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,
  /(?:^|\s)(?:password|pass|pwd|pin|passcode)\s*:\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Russian: пароль, пасс, секрет, код
  /(?:пароль|пасс|секрет|код)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Turkish: şifre, parola, gizli kod
  /(?:şifre|parola|gizli\s+kod)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Kazakh: құпия сөз, пароль, код
  /(?:құпия\s+сөз|пароль|код)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Ukrainian: пароль, секретний код
  /(?:пароль|секретний\s+код)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // German: passwort, kennwort, geheimcode
  /(?:passwort|kennwort|geheimcode)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // French: mot de passe, code secret
  /(?:mot\s+de\s+passe|code\s+secret)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Spanish: contraseña, clave, código secreto
  /(?:contraseña|clave|código\s+secreto)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Portuguese: senha, código secreto
  /(?:senha|código\s+secreto)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Italian: password, parola d'ordine, codice segreto
  /(?:password|parola\s+d'ordine|codice\s+segreto)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Polish: hasło, kod tajny
  /(?:hasło|kod\s+tajny)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Chinese: 密码, 口令
  /(?:密码|口令)\s*(?::|：|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Japanese: パスワード, 暗証番号
  /(?:パスワード|暗証番号)\s*(?::|：|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,

  // Arabic: كلمة المرور, كلمة السر, الرمز السري
  /(?:كلمة\s+المرور|كلمة\s+السر|الرمز\s+السري)\s*(?::|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i,
];

// Only used when we know the field kind (e.g., placeholder of a username/password input).
// Keeps this conservative to avoid extracting random tokens from arbitrary text.
const DEMO_MARKER_VALUE_PATTERN =
  /(?:demo|test|example|sample)\s*(?:is|:|=|–|-)\s*["']?([^\s"'<>]{2,50})["']?/i;

/**
 * Clean extracted credential value
 * Removes trailing punctuation and common artifacts
 * Note: Keeps ! at end since it's common in passwords
 */
function cleanCredentialValue(value: string, isPassword = false): string {
  let cleaned = value
    .trim()
    .replace(/^['"]+|['"]+$/g, ''); // Remove surrounding quotes

  // For passwords, keep ! since it's commonly used
  // For usernames, remove trailing punctuation
  if (!isPassword) {
    cleaned = cleaned.replace(/[.,;:!?]+$/, '');
  } else {
    // Only remove clearly sentence-ending punctuation for passwords
    cleaned = cleaned.replace(/[.,;:?]+$/, '');
  }

  return cleaned.slice(0, 100); // Cap length for safety
}

/**
 * Extract a credential from text using multiple patterns
 */
function extractWithPatterns(text: string, patterns: RegExp[], isPassword = false): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const cleaned = cleanCredentialValue(match[1], isPassword);
      if (cleaned.length >= 2) {
        return cleaned;
      }
    }
  }
  return undefined;
}

/**
 * Extract credentials from a single text string
 */
function extractFromText(text: string): { username?: string; password?: string; pattern?: string } {
  const username = extractWithPatterns(text, USERNAME_PATTERNS, false);
  const password = extractWithPatterns(text, PASSWORD_PATTERNS, true);

  // Determine which pattern matched for debugging
  let pattern: string | undefined;
  if (username && password) {
    pattern = 'username+password in same text';
  } else if (username) {
    pattern = 'username only';
  } else if (password) {
    pattern = 'password only';
  }

  return { username, password, pattern };
}

type ProximityTier = 'strong' | 'medium';
type CandidateSource = 'nearby_text' | 'global_text' | 'placeholder' | 'title';

type FieldKind = 'username' | 'password';

interface TextCandidate {
  text: string;
  source: CandidateSource;
  tag?: string;
  context?: string;
  weight: number;
  proximity?: { kind: FieldKind; tier: ProximityTier };
}

interface ExtractionEvidence {
  source: CandidateSource;
  tag?: string;
  context?: string;
  proximity?: { kind: FieldKind; tier: ProximityTier };
  usedPlaceholder?: boolean;
  usedPreCode?: boolean;
  inLowSignalContext?: boolean;
}

function isLowSignalContext(context?: string): boolean {
  if (!context) return false;
  return /inside:\s*(footer|navigation|aside)/i.test(context);
}

function tagBoost(tag?: string): number {
  if (!tag) return 0;
  const t = tag.toLowerCase();
  if (t === 'pre' || t === 'code') return 2;
  if (t === 'li' || t === 'td' || t === 'th') return 1;
  return 0;
}

function contextPenalty(context?: string): number {
  return isLowSignalContext(context) ? -2 : 0;
}

function getCenter(bounds: ElementBounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distanceBetween(a: ElementBounds, b: ElementBounds): number {
  const ca = getCenter(a);
  const cb = getCenter(b);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function classifyInputKind(el: LiteElement): FieldKind | null {
  const type = (el.type || '').toLowerCase();
  const autocomplete = (el.autocomplete || '').toLowerCase();
  const htmlName = (el.htmlName || '').toLowerCase();
  const htmlId = (el.htmlId || '').toLowerCase();
  const name = (el.name || '').toLowerCase();

  if (
    type === 'password' ||
    autocomplete.includes('password') ||
    /password|passwd|pwd/.test(htmlName) ||
    /password|passwd|pwd/.test(htmlId)
  ) {
    return 'password';
  }

  if (
    type === 'email' ||
    autocomplete.includes('username') ||
    autocomplete.includes('email') ||
    /user|username|login|email/.test(htmlName) ||
    /user|username|login|email/.test(htmlId) ||
    /user|username|login|email/.test(name)
  ) {
    return 'username';
  }

  if (type === 'text') {
    // Treat generic text inputs as potential username fields (low confidence)
    return 'username';
  }

  return null;
}

function extractFromKnownField(text: string, kind: FieldKind): { username?: string; password?: string; pattern?: string } {
  // Try normal patterns first
  const base = extractFromText(text);
  if (kind === 'username' && base.username) return base;
  if (kind === 'password' && base.password) return base;

  // If placeholder-like text is "Demo: student", allow demo marker pattern, but only for known kind
  const demoValue = extractWithPatterns(text, [DEMO_MARKER_VALUE_PATTERN], kind === 'password');
  if (!demoValue) return base;

  if (kind === 'username') {
    return { username: demoValue, pattern: 'demo marker value (username)' };
  }
  return { password: demoValue, pattern: 'demo marker value (password)' };
}

/**
 * Extract demo credentials from page snapshot
 *
 * Scans visible text elements (non-inputs) for credential patterns.
 * Returns extracted credentials with confidence level.
 *
 * @param snapshot - Current page snapshot
 * @param testId - Test ID for logging context (no credential values logged)
 * @returns Extraction result with username, password, and confidence
 */
export function extractPageCredentials(
  snapshot: LiteSnapshot,
  testId?: string
): PageCredentialsResult {
  // Radii for proximity search (pixels)
  const STRONG_RADIUS_PX = 120;
  const MEDIUM_RADIUS_PX = 250;

  // 1) Identify credential-relevant inputs
  const inputs = snapshot.elements
    .filter(el => el.visible && !el.disabled && el.tag === 'input')
    .map(el => ({ el, kind: classifyInputKind(el) }))
    .filter((x): x is { el: LiteElement; kind: FieldKind } => !!x.kind);

  // 2) Build candidate pool (proximity + global + placeholder + title + pageText)
  const candidates: TextCandidate[] = [];

  // 2a) Page text for extraction (highest priority if available)
  // This is the full visible text captured specifically for credential extraction
  if (snapshot.pageTextForExtraction) {
    // Split into lines and process each that might contain credentials
    const lines = snapshot.pageTextForExtraction.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Only consider lines that might contain credential patterns
      if (trimmed.length < 8 || trimmed.length > 200) continue;

      // Quick filter: must contain credential-related keywords
      if (!/username|user|login|email|password|pass|pwd|credential/i.test(trimmed)) continue;

      const extracted = extractFromText(trimmed);
      if (extracted.username || extracted.password) {
        // High weight for page text extraction (similar to pre/code elements)
        const weight = 5 + tagBoost('pre'); // Treat as high-signal source
        candidates.push({
          text: trimmed,
          source: 'global_text',
          tag: 'body',
          weight,
        });
      }
    }
  }

  // 2b) Placeholder candidates (safe input attributes)
  for (const { el, kind } of inputs) {
    if (el.placeholder && el.placeholder.trim().length >= 3) {
      const baseWeight = 2; // placeholder bonus (plan)
      const weight = baseWeight + tagBoost(el.tag) + contextPenalty(el.context);
      candidates.push({
        text: el.placeholder,
        source: 'placeholder',
        tag: el.tag,
        context: el.context,
        weight,
        proximity: { kind, tier: 'strong' }, // placeholder belongs to the field itself
      });
    }
  }

  // 2c) Text candidates from non-input elements
  const textElements = snapshot.elements.filter(el => el.visible && el.tag !== 'input' && el.tag !== 'textarea');

  for (const el of textElements) {
    const text = (el.name || '').trim();
    if (text.length < 3) continue;

    const baseWeight = 0;
    const weightBase = baseWeight + tagBoost(el.tag) + contextPenalty(el.context);

    // Proximity scoring if bounds are available
    let addedProximity = false;
    if (el.bounds) {
      for (const input of inputs) {
        if (!input.el.bounds) continue;
        const d = distanceBetween(el.bounds, input.el.bounds);

        let tier: ProximityTier | null = null;
        if (d <= STRONG_RADIUS_PX) tier = 'strong';
        else if (d <= MEDIUM_RADIUS_PX) tier = 'medium';

        if (!tier) continue;

        // Weight by field kind + tier
        const proxWeight =
          input.kind === 'password'
            ? (tier === 'strong' ? 3 : 2)
            : (tier === 'strong' ? 2 : 1);

        candidates.push({
          text,
          source: 'nearby_text',
          tag: el.tag,
          context: el.context,
          weight: weightBase + proxWeight,
          proximity: { kind: input.kind, tier },
        });
        addedProximity = true;
      }
    }

    // Always include as a global candidate (lower priority)
    // If it was already added as nearby candidate, global still helps as fallback but with lower weight.
    candidates.push({
      text,
      source: 'global_text',
      tag: el.tag,
      context: el.context,
      weight: addedProximity ? weightBase - 1 : weightBase,
    });
  }

  // 2d) Page title (very low priority)
  if (snapshot.title && snapshot.title.trim().length >= 3) {
    candidates.push({
      text: snapshot.title,
      source: 'title',
      tag: 'title',
      weight: -1,
    });
  }

  // 3) Run extraction over weighted candidates
  candidates.sort((a, b) => b.weight - a.weight);

  let bestUsername: { value: string; evidence: ExtractionEvidence; pattern?: string; weight: number } | null = null;
  let bestPassword: { value: string; evidence: ExtractionEvidence; pattern?: string; weight: number } | null = null;
  let foundBothInSameCandidate = false;

  for (const c of candidates) {
    const kindHint = c.proximity?.kind;
    const extracted = kindHint ? extractFromKnownField(c.text, kindHint) : extractFromText(c.text);

    const evidence: ExtractionEvidence = {
      source: c.source,
      tag: c.tag,
      context: c.context,
      proximity: c.proximity,
      usedPlaceholder: c.source === 'placeholder',
      usedPreCode: c.tag === 'pre' || c.tag === 'code',
      inLowSignalContext: isLowSignalContext(c.context),
    };

    if (extracted.username) {
      const usernameScore =
        c.weight +
        (c.proximity?.kind === 'username' ? 1 : 0) +
        (c.proximity?.kind === 'password' ? -1 : 0);

      if (!bestUsername || usernameScore > bestUsername.weight) {
        bestUsername = { value: extracted.username, evidence, pattern: extracted.pattern, weight: usernameScore };
      }
    }

    if (extracted.password) {
      const passwordScore =
        c.weight +
        (c.proximity?.kind === 'password' ? 1 : 0) +
        (c.proximity?.kind === 'username' ? -1 : 0);

      if (!bestPassword || passwordScore > bestPassword.weight) {
        bestPassword = { value: extracted.password, evidence, pattern: extracted.pattern, weight: passwordScore };
      }
    }

    if (extracted.username && extracted.password) {
      foundBothInSameCandidate = true;
    }
  }

  let foundUsername = bestUsername?.value;
  let foundPassword = bestPassword?.value;

  // 4) Stricter validation guards to prevent false positives
  // Only apply if we have at least one credential
  if (foundUsername || foundPassword) {
    // Guard: disallow credentials with internal spaces (likely not real credentials)
    if (foundUsername && /\s/.test(foundUsername)) {
      logger.debug('[PAGE_CREDS_EXTRACTOR] Rejected username with spaces', { testId });
      foundUsername = undefined;
      bestUsername = null;
    }
    if (foundPassword && /\s/.test(foundPassword)) {
      logger.debug('[PAGE_CREDS_EXTRACTOR] Rejected password with spaces', { testId });
      foundPassword = undefined;
      bestPassword = null;
    }

    // Guard: disallow obviously non-credential tokens (URLs, emails as username, etc.)
    if (foundUsername) {
      const looksInvalid =
        foundUsername.startsWith('http') ||
        foundUsername.startsWith('www.') ||
        foundUsername.length > 100 || // Too long
        foundUsername.length < 2; // Too short
      if (looksInvalid) {
        logger.debug('[PAGE_CREDS_EXTRACTOR] Rejected invalid username pattern', { testId, length: foundUsername.length });
        foundUsername = undefined;
        bestUsername = null;
      }
    }
    if (foundPassword) {
      const looksInvalid =
        foundPassword.startsWith('http') ||
        foundPassword.startsWith('www.') ||
        foundPassword.length > 100 || // Too long
        foundPassword.length < 2; // Too short
      if (looksInvalid) {
        logger.debug('[PAGE_CREDS_EXTRACTOR] Rejected invalid password pattern', { testId, length: foundPassword.length });
        foundPassword = undefined;
        bestPassword = null;
      }
    }
  }

  // 5) Multi-factor confidence scoring
  let score = 0;

  // Proximity factors
  if (bestPassword?.evidence.proximity?.kind === 'password') score += 3;
  if (bestUsername?.evidence.proximity?.kind === 'username') score += 2;

  // Structure factors
  if (bestUsername?.evidence.usedPreCode || bestPassword?.evidence.usedPreCode) score += 2;

  // Attribute factors
  if (bestUsername?.evidence.usedPlaceholder || bestPassword?.evidence.usedPlaceholder) score += 2;

  // Penalty for low-signal contexts
  if (bestUsername?.evidence.inLowSignalContext || bestPassword?.evidence.inLowSignalContext) score -= 2;

  // Full match bonus
  if (foundUsername && foundPassword) score += 2;
  if (foundBothInSameCandidate) score += 1; // slight bonus for cohesive source

  let confidence: PageCredentialsResult['confidence'];
  if (!foundUsername && !foundPassword) {
    confidence = 'none';
  } else if (score >= 6) {
    confidence = 'high';
  } else if (score >= 3) {
    confidence = 'medium';
  } else if (score >= 1) {
    confidence = 'low';
  } else {
    confidence = 'none';
  }

  const sourcePattern = foundUsername || foundPassword
    ? [
      foundBothInSameCandidate ? 'cohesive' : undefined,
      bestUsername ? `u:${bestUsername.evidence.source}` : undefined,
      bestPassword ? `p:${bestPassword.evidence.source}` : undefined,
      bestUsername?.pattern,
      bestPassword?.pattern,
    ].filter(Boolean).join(' | ')
    : undefined;

  // Log metadata only (never log actual values)
  if (testId) {
    logger.debug('[PAGE_CREDS_EXTRACTOR] Extraction complete', {
      testId,
      hasUsername: !!foundUsername,
      hasPassword: !!foundPassword,
      usernameLength: foundUsername?.length,
      passwordLength: foundPassword?.length,
      confidence,
      sourcePattern,
      candidatesScanned: candidates.length,
      score,
    });
  }

  return {
    username: foundUsername,
    password: foundPassword,
    confidence,
    sourcePattern,
  };
}

/**
 * Parse user-provided credentials from clarification response
 * Supports both full ("username: xxx, password: yyy") and partial ("admin") responses.
 *
 * @param response - User's response text
 * @param expectingField - Optional hint: 'username' or 'password' if we're expecting a single value
 * @returns Parsed credentials (partial or full) or null if parsing failed
 */
export function parseCredentialsFromResponse(
  response: string,
  expectingField?: 'username' | 'password' | 'both'
): { username?: string; password?: string } | null {
  if (!response || response.trim().length < 2) {
    return null;
  }

  const text = response.trim();

  // Try structured patterns first (full credentials)
  const extracted = extractFromText(text);
  if (extracted.username && extracted.password) {
    return { username: extracted.username, password: extracted.password };
  }

  // If we got partial extraction, return what we have
  if (extracted.username || extracted.password) {
    return {
      ...(extracted.username && { username: extracted.username }),
      ...(extracted.password && { password: extracted.password }),
    };
  }

  // Try simple split patterns: "user / pass" or "user, pass" or "user pass"
  const splitPatterns = [
    /^([^\s/,]+)\s*[/,]\s*([^\s/,]+)$/, // "user / pass" or "user, pass"
    /^(\S+)\s+(\S+)$/, // "user pass" (two words)
  ];

  for (const pattern of splitPatterns) {
    const match = text.match(pattern);
    if (match && match[1] && match[2]) {
      const username = cleanCredentialValue(match[1]);
      const password = cleanCredentialValue(match[2], true);
      if (username.length >= 2 && password.length >= 2) {
        return { username, password };
      }
    }
  }

  // Single value fallback: treat as expected field or guess based on content
  // Check heuristic BEFORE cleaning to preserve special chars for detection
  const looksLikePassword = /[!@#$%^&*()_+\-=[\]{}|;:,.<>?0-9]/.test(text) && text.length >= 4;

  // Determine if we should treat as password for cleaning
  const treatAsPassword = expectingField === 'password' || (expectingField !== 'username' && looksLikePassword);
  const singleValue = cleanCredentialValue(text, treatAsPassword);

  if (singleValue.length >= 2) {
    // If expecting specific field, use it
    if (expectingField === 'password') {
      return { password: singleValue };
    }
    if (expectingField === 'username') {
      return { username: singleValue };
    }

    // Heuristic: if looks like password, treat as password
    if (looksLikePassword) {
      return { password: singleValue };
    }

    // Default: treat single value as username (more common case when password extracted from page)
    return { username: singleValue };
  }

  return null;
}
