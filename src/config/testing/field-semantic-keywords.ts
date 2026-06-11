/**
 * Field-semantic keyword lists for the DEGRADED (rule-based, LLM-down) element
 * resolution path only. Maps a user-intent fragment in any product language to
 * an HTML `autocomplete` / input `type` token so the rule scorer can infer
 * "this describes the email field" without an LLM call.
 *
 * Scope / why it lives here, not in intent-keywords.ts
 * ────────────────────────────────────────────────────
 * `intent-keywords.ts` is the CHAT control-word registry (yes/no/cancel) — a
 * different domain. Per CLAUDE.md Hard invariant #17, DOM/element-semantic
 * keyword lists are kept local to their consumer by design. This file is that
 * local registry; it deliberately reuses ONLY the `MultiLangList` TYPE so the
 * {en,ru,kk} language contract (build fails if a language is dropped — the bug
 * that kept losing Kazakh) is enforced identically, without coupling the two
 * domains.
 *
 * This is an OPTIMIZATION + FALLBACK, never the source of truth. The live path
 * is the LLM resolver, which is language-agnostic. These lists only help the
 * rule-based scorer when the LLM is unavailable (circuit breaker / timeout).
 * Keep buckets to high-frequency anchor stems per language; the LLM covers the
 * long tail. Matched with substring `includes()` against a lowercased intent,
 * so stems ("почт", "пароль") match their inflections.
 */

import type { MultiLangList } from './intent-keywords';

/**
 * Intent stems per `autocomplete`/`type` value. The KEY is the canonical HTML
 * token the scorer compares against `node.autocomplete` / `node.type`; the
 * VALUE lists language stems whose presence in the intent implies that field.
 *
 * Kazakh is REQUIRED (MultiLangList) — добавляя новую запись, заполни все три
 * языка или build упадёт.
 */
export const FIELD_SEMANTIC_KEYWORDS: Record<string, MultiLangList> = {
  email: {
    en: ['email', 'e-mail', 'mail'],
    ru: ['почт', 'емейл', 'мейл', 'электронн'],
    kk: ['пошта', 'электронды', 'имейл'],
  },
  username: {
    en: ['username', 'login', 'user name', 'account'],
    ru: ['логин', 'пользовател', 'имя пользовател', 'учётн', 'учетн'],
    kk: ['логин', 'пайдаланушы', 'қолданушы', 'тіркелгі'],
  },
  password: {
    en: ['password', 'passcode', 'current-password', 'new-password'],
    ru: ['пароль', 'парол'],
    kk: ['құпиясөз', 'құпия сөз', 'пароль'],
  },
  tel: {
    en: ['phone', 'telephone', 'mobile', 'cell'],
    ru: ['телефон', 'мобильн', 'номер телефон', 'сотов'],
    kk: ['телефон', 'ұялы', 'нөмір', 'байланыс нөмір'],
  },
};

/**
 * Flatten one field's MultiLangList into a single lowercase stem array.
 * Mirrors `flattenLangs` in intent-keywords but kept local to avoid importing
 * the chat-domain helper into the element-resolution domain.
 */
export function fieldSemanticStems(list: MultiLangList): string[] {
  return [...list.en, ...list.ru, ...list.kk].map((w) => w.toLowerCase());
}

/**
 * Stop-word stems for the synchronous degraded keyword extractor. The async
 * AI extractor is language-agnostic; this list only feeds `extractKeywordsSync`
 * (regex fallback when AI keyword extraction can't run). English was the only
 * language covered, so a Russian/Kazakh intent kept its verbs ("нажми",
 * "кнопку") as "keywords", diluting the real target token. These are the
 * highest-frequency action verbs + generic UI nouns per language — NOT
 * exhaustive (the AI path handles the long tail).
 */
export const KEYWORD_STOP_WORDS: MultiLangList = {
  en: [
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or',
    'enter', 'fill', 'type', 'click', 'press', 'select', 'input', 'field',
    'button', 'link', 'into', 'please', 'should', 'want', 'need', 'put',
    'this', 'value', 'box', 'form', 'element', 'of', 'is', 'are', 'from',
  ],
  ru: [
    'нажми', 'нажать', 'нажмите', 'кликни', 'кликнуть', 'введи', 'ввести',
    'введите', 'заполни', 'заполнить', 'выбери', 'выбрать', 'нажав',
    'кнопку', 'кнопка', 'поле', 'ссылку', 'ссылка', 'элемент', 'значение',
    'этот', 'эту', 'это', 'для', 'или', 'и', 'на', 'в', 'с', 'по',
  ],
  kk: [
    'бас', 'басу', 'басыңыз', 'таңда', 'таңдау', 'таңдаңыз', 'енгіз',
    'енгізу', 'енгізіңіз', 'толтыр', 'толтыру', 'батырма', 'батырманы',
    'түйме', 'өріс', 'сілтеме', 'элемент', 'мән', 'осы', 'үшін', 'және',
    'немесе', 'мына',
  ],
};

/** Flatten the stop-word list into a lowercase Set for O(1) membership. */
export function buildStopWordSet(): Set<string> {
  return new Set(
    [...KEYWORD_STOP_WORDS.en, ...KEYWORD_STOP_WORDS.ru, ...KEYWORD_STOP_WORDS.kk]
      .map((w) => w.toLowerCase()),
  );
}
