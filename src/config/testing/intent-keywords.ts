/**
 * Centralized natural-language keyword lists for CHAT INTENT control words —
 * affirmative / cancel / rejection / pure-chitchat / confirmation-markers.
 *
 * Why this file exists
 * ────────────────────
 * These word families were previously duplicated across FOUR independent
 * call sites (intent-fast-path, confirmation-classifier, compound-queue,
 * manage-tool.helper). A word added in one place silently drifted from the
 * others — and Kazakh kept getting forgotten. This is the single source of
 * truth; every consumer imports from here.
 *
 * Scope: these lists are an OPTIMIZATION + FALLBACK, NOT the source of truth
 * ─────────────────────────────────────────────────────────────────────────
 * The authoritative classifier is the LLM (`parseUserIntent` GPT pass, and the
 * Gemini→OpenAI chain in `confirmation-classifier`), which is language-agnostic
 * and already understands kk/ru/en plus synonyms and phrasing variants.
 *
 * These keyword lists only:
 *   • let the fast-path skip the LLM for the MOST COMMON trivial replies
 *     ("yes", "да", "иә", "привет") — pure latency/token saving; a miss just
 *     falls through to the LLM, never a wrong answer; and
 *   • give `confirmation-classifier` a deterministic regex fallback for the
 *     rare case BOTH LLM calls fail.
 *
 * => Do NOT chase completeness here. Keep each bucket to high-frequency ANCHOR
 *    forms per language. Coverage of long-tail synonyms / morphology is the
 *    LLM's job, not this file's. Adding obscure variants just grows a list
 *    that drifts; it buys nothing the LLM doesn't already handle.
 *
 * Language contract
 * ─────────────────
 * Each list is a `MultiLangList` — `en`, `ru` AND `kk` are REQUIRED keys, so
 * TypeScript fails the build if a new family forgets a language (the bug that
 * scattered these lists). A regression test (`intent-keywords.contract.test.ts`)
 * asserts no bucket is empty and that the canonical ANCHOR words are present —
 * it intentionally checks anchors, not exhaustiveness.
 *
 * Matching note: these are LOWERCASE surface forms matched against a
 * normalized user message (exact-set membership for short replies, or
 * `(?![\p{L}\p{N}])` unicode-boundary regex — NEVER ASCII `\b`, which misses
 * all Cyrillic). Build regexes with the `iu` flags via `toBoundaryRegex`.
 */

/**
 * A keyword list that MUST cover the three product languages. Adding a fourth
 * language later is additive (make the new key optional in a follow-up); the
 * three core keys stay required so none is ever dropped by accident.
 */
export interface MultiLangList {
  en: readonly string[];
  ru: readonly string[];
  kk: readonly string[];
}

/** Flatten a MultiLangList into a single lowercase array (all languages). */
export function flattenLangs(list: MultiLangList): string[] {
  return [...list.en, ...list.ru, ...list.kk].map((w) => w.toLowerCase());
}

/** Flatten into a Set for O(1) exact-match membership tests. */
export function toLangSet(list: MultiLangList): Set<string> {
  return new Set(flattenLangs(list));
}

/**
 * Build an anchored, unicode-boundary alternation regex from a MultiLangList.
 * `^(word1|word2|…)(?![\p{L}\p{N}])` with `iu`. The unicode lookahead is
 * mandatory — JS `\b` is ASCII-only and never matches Cyrillic/Kazakh.
 * Multi-word phrases are escaped for regex safety.
 */
export function toBoundaryRegex(list: MultiLangList): RegExp {
  const escaped = flattenLangs(list).map((w) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return new RegExp(`^(${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

// ════════════════════════════════════════════════════════════════════════════
// CONTROL-WORD FAMILIES
// ════════════════════════════════════════════════════════════════════════════

/** Affirmative / approval ("yes, go ahead"). */
export const AFFIRMATIVE: MultiLangList = {
  en: ['yes', 'yeah', 'yep', 'y', 'ok', 'okay', 'sure', 'go', 'go ahead', 'do it', 'proceed', 'start', 'confirm', 'confirmed'],
  ru: ['да', 'ага', 'давай', 'хорошо', 'конечно', 'ок', 'окей', 'поехали', 'запускай', 'подтверждаю', 'подтвердить', 'выполняй'],
  kk: ['иә', 'ия', 'жарайды', 'болады', 'келісемін', 'жақсы', 'мақұл', 'растаймын'],
};

/** Cancel / abort / stop ("forget it", "stop"). */
export const CANCEL: MultiLangList = {
  en: ['cancel', 'stop', 'abort', 'nevermind', 'never mind', 'forget it'],
  ru: ['отмена', 'отмени', 'отменить', 'стоп', 'хватит', 'забудь', 'забей', 'не надо'],
  kk: ['тоқта', 'тоқтат', 'тоқтату', 'бас тарт', 'болды', 'жетеді', 'қажет емес'],
};

/** Rejection / negation ("no"). */
export const REJECTION: MultiLangList = {
  en: ['no', 'nope', 'nah'],
  ru: ['нет', 'неа', 'не'],
  kk: ['жоқ', 'болмайды', 'керек емес'],
};

/** Pure conversational openers/closers — greetings, thanks, farewells. */
export const CHITCHAT: MultiLangList = {
  en: ['hi', 'hello', 'hey', 'yo', 'sup', 'thanks', 'thank you', 'thx', 'ty', 'bye', 'goodbye', 'see you', 'cya'],
  ru: ['привет', 'здравствуй', 'здравствуйте', 'хай', 'спасибо', 'спс', 'благодарю', 'пока', 'до свидания', 'увидимся'],
  kk: ['сәлем', 'сәлеметсіз бе', 'сәлеметсіз', 'сәлеметсің бе', 'рахмет', 'рақмет', 'көп рахмет', 'сау бол', 'сау болыңыз', 'кездескенше'],
};

/**
 * Substrings that mark an assistant message as a pending yes/no question
 * ("shall I run this?"). Matched with `includes()` against the last AI message,
 * so these are phrase fragments, not whole-word tokens.
 */
export const CONFIRMATION_MARKERS: MultiLangList = {
  en: ['shall i', 'should i', 'do you want me', 'ready to run', 'run it?'],
  ru: ['запустить', 'выполнить', 'подтверди', 'продолжить', 'начать'],
  kk: ['орындайын ба', 'іске қосайын ба', 'жүргізейін ба', 'бастайын ба', 'дайын ба'],
};
