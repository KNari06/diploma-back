/**
 * Credential Field Patterns Configuration
 * Fallback dictionary for field classification (Level 3)
 * Used when semantic attributes (Level 1) and accessibility hints (Level 2) are not present
 *
 * NOTE: This is the LAST resort - prefer type/autocomplete/inputmode attributes (Level 1)
 */

export type CredentialKind = 'password' | 'email' | 'phone' | 'username';

/**
 * Fallback keyword patterns for each credential type
 * Keys are lowercase, matching is case-insensitive
 * Includes English and Russian patterns for i18n support
 */
export const CREDENTIAL_FALLBACK_PATTERNS: Record<CredentialKind, string[]> = {
  password: [
    'password', 'passwd', 'pass', 'pwd', 'secret',
    'пароль', 'парол',
  ],
  email: [
    'email', 'e-mail', 'mail',
    'почта', 'емейл', 'эмейл',
  ],
  phone: [
    'phone', 'tel', 'mobile', 'cell', 'sms',
    'телефон', 'номер', 'мобильный',
  ],
  username: [
    'username', 'user', 'login', 'account', 'userid',
    'логин', 'пользователь', 'аккаунт', 'учетная',
  ],
};

/**
 * Level 1: Technical semantic signals (highest confidence)
 * Maps attribute values to credential kinds
 */
export const LEVEL1_TYPE_MAP: Record<string, CredentialKind> = {
  password: 'password',
  email: 'email',
  tel: 'phone',
};

export const LEVEL1_AUTOCOMPLETE_MAP: Record<string, CredentialKind> = {
  'current-password': 'password',
  'new-password': 'password',
  password: 'password',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  username: 'username',
};

export const LEVEL1_INPUTMODE_MAP: Record<string, CredentialKind> = {
  tel: 'phone',
  email: 'email',
};
