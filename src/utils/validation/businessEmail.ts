// Business-email validation for signup — backend authoritative copy.
//
// Mirrors the frontend logic in qai-frontend (apps/web/src/lib/businessEmail.js
// and apps/desktop/src/renderer/app/lib/businessEmail.ts). Both frontends
// and this file consume the same generated domain lists — regenerate via
// `node scripts/generate-email-blocklist.mjs` in the qai-frontend repo.

import {
  FREE_EMAIL_DOMAINS,
  DISPOSABLE_EMAIL_DOMAINS,
} from './businessEmail.data';

const getDomain = (email: string): string => {
  if (!email || typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) return '';
  return email.slice(at + 1).trim().toLowerCase();
};

export const isFreeEmailDomain = (email: string): boolean =>
  FREE_EMAIL_DOMAINS.has(getDomain(email));

export const isDisposableEmailDomain = (email: string): boolean =>
  DISPOSABLE_EMAIL_DOMAINS.has(getDomain(email));

export type BusinessEmailCheck =
  | { ok: true }
  | { ok: false; reason: 'free' | 'disposable' };

export const validateBusinessEmail = (email: string): BusinessEmailCheck => {
  if (isDisposableEmailDomain(email)) return { ok: false, reason: 'disposable' };
  if (isFreeEmailDomain(email)) return { ok: false, reason: 'free' };
  return { ok: true };
};

// Error codes returned to the client so the frontend can map them to
// localized strings (web has i18n; desktop currently hard-codes English).
export const BUSINESS_EMAIL_ERROR_CODES = {
  free: 'BUSINESS_EMAIL_REQUIRED',
  disposable: 'DISPOSABLE_EMAIL_NOT_ALLOWED',
} as const;
