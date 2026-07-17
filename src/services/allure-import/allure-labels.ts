/**
 * Multilingual structural-label recognition for Allure text exports.
 *
 * The ZIP path (raw `*-result.json` / generated `data/test-cases/*.json`) uses
 * ENGLISH JSON field names regardless of the report's UI language — so it needs
 * none of this. But the CSV `scenario` column and the PDF text export carry the
 * report's LOCALIZED section labels ("Expected result", "Ожидаемый результат",
 * "Erwartetes Ergebnis", …). The old code hardcoded EN/RU/KZ only, so any other
 * language silently mis-parsed expected-results as steps.
 *
 * This module centralises the recognisable forms for the handful of structural
 * labels we key off, across the languages QAIT users actually ship in plus the
 * common European/CIS/Asian set. It is a best-effort ANCHOR list, not a
 * classifier: the LLM step-converter is the language-agnostic backstop for the
 * long tail (mirrors the chat control-word approach in
 * `config/testing/intent-keywords.ts`). Add a language by extending the arrays —
 * no call-site changes needed.
 */

/**
 * Localised forms of "Expected result" (the step-verification delimiter).
 * Lowercased; matched case-insensitively with optional trailing ":" and
 * optional surrounding punctuation. Keep to high-frequency anchor forms.
 */
const EXPECTED_RESULT_FORMS: readonly string[] = [
  // English — NOTE: the bare word "expected" is intentionally NOT here. As a
  // standalone delimiter it swallows real content lines ("Expected number of
  // rows is 50" → mis-read as an assertion). Require the "result" qualifier.
  'expected result', 'expected results',
  // Russian
  'ожидаемый результат', 'ожидаемые результаты', 'ожидаемый рез-т',
  // Kazakh
  'күтілетін нәтиже', 'күтiлетiн нәтиже',
  // Ukrainian
  'очікуваний результат',
  // German
  'erwartetes ergebnis',
  // French
  'résultat attendu', 'resultat attendu',
  // Spanish
  'resultado esperado',
  // Portuguese
  'resultado esperado',
  // Italian
  'risultato atteso',
  // Turkish
  'beklenen sonuç', 'beklenen sonuc',
  // Polish
  'oczekiwany wynik',
  // Chinese (simplified/traditional)
  '预期结果', '預期結果',
  // Japanese
  '期待される結果', '期待結果',
  // Korean
  '예상 결과', '기대 결과',
];

/**
 * Localised forms of the "Precondition" label.
 */
const PRECONDITION_FORMS: readonly string[] = [
  'precondition', 'preconditions', 'pre-condition', 'pre condition',
  'предусловие', 'предусловия', 'предварительные условия',
  'алдын ала шарт', 'алғышарт',
  'передумова', 'передумови',
  'vorbedingung', 'voraussetzung',
  'condition préalable', 'préconditions', 'préalable',
  'precondición', 'condiciones previas', 'requisitos previos',
  'pré-condição', 'pré-requisitos',
  'precondizione',
  'ön koşul', 'onkosul',
  'warunek wstępny',
  '前提条件', '前置条件',
  '事前条件',
  '전제 조건', '사전 조건',
];

/**
 * Localised forms of the "Steps" section label.
 */
const STEPS_FORMS: readonly string[] = [
  'steps', 'test steps', 'scenario', 'scenario steps',
  'шаги', 'шаги теста', 'сценарий',
  'қадамдар', 'қадам',
  'кроки',
  'schritte', 'testschritte',
  'étapes', 'etapes',
  'pasos',
  'passos',
  'passi',
  'adımlar', 'adimlar',
  'kroki',
  '步骤', '测试步骤',
  'ステップ', '手順',
  '단계',
];

/**
 * Build a case-insensitive matcher for a set of localised label forms. The
 * returned regex captures any trailing text after the label + optional ":".
 * Anchored at line start (after optional leading list markers / numbering).
 *
 * Longer forms are tried first so "expected results" isn't shadowed by
 * "expected".
 */
function buildLabelRegex(forms: readonly string[]): RegExp {
  const escaped = [...forms]
    .sort((a, b) => b.length - a.length)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Optional leading "- "/"* "/"• "/"N. "/"N) " markers, then the label,
  // optional ":" / whitespace, then a capture of the rest of the line.
  return new RegExp(
    `^\\s*(?:[-*•]\\s*|\\d+[.)]\\s*)?(?:${escaped.join('|')})\\s*:?\\s*(.*)$`,
    'i',
  );
}

/**
 * Localised forms of the "attachment" marker word (used inside `[attachment N]`
 * sub-item markers in the CSV scenario field). Kept separate so a bracketed
 * marker whose word is one of these is treated as an attachment, not a step.
 */
const ATTACHMENT_FORMS: readonly string[] = [
  'attachment', 'attachments',
  'вложение', 'вложения', 'приложение',
  'тіркеме', 'қосымша',
  'вкладення',
  'anhang', 'anlage',
  'pièce jointe', 'piece jointe',
  'adjunto', 'anexo',
  'allegato',
  'ek', 'eklenti',
  'załącznik',
  '附件', '添付', '첨부',
];

/** Set of lowercased attachment marker words for fast membership checks. */
const ATTACHMENT_WORDS = new Set(ATTACHMENT_FORMS.map((w) => w.toLowerCase()));

/**
 * True when a bracketed marker word (the `word` in `[word 1.1]`) denotes an
 * attachment rather than a step. Used by the CSV scenario parser so an
 * `[attachment 1.1]` marker isn't mistaken for a step in any language.
 */
export function isAttachmentMarkerWord(word: string): boolean {
  return ATTACHMENT_WORDS.has(word.trim().toLowerCase());
}

/** Matches an "Expected result[:]" line. Group 1 = trailing text (may be ""). */
export const EXPECTED_RESULT_LABEL = buildLabelRegex(EXPECTED_RESULT_FORMS);

/** Matches a "Precondition[:]" line. Group 1 = trailing text. */
export const PRECONDITION_LABEL = buildLabelRegex(PRECONDITION_FORMS);

/** Matches a "Steps[:]" section header line. Group 1 = trailing text. */
export const STEPS_LABEL = buildLabelRegex(STEPS_FORMS);

/**
 * All localised "Steps" / "Expected result" / "Precondition" / "Attachments"
 * forms flattened — handed to the PDF LLM prompt so it recognises section
 * delimiters in ANY of these languages (rather than only English literals).
 */
export function allSectionLabelForms(): {
  steps: readonly string[];
  expected: readonly string[];
  precondition: readonly string[];
} {
  return {
    steps: STEPS_FORMS,
    expected: EXPECTED_RESULT_FORMS,
    precondition: PRECONDITION_FORMS,
  };
}
