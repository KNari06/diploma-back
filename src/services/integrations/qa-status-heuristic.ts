/**
 * Heuristic: does a Jira status NAME look like a "ready for QA / testing" column?
 *
 * Used ONLY to PRE-SELECT likely trigger statuses in the settings picker — the
 * human always confirms/overrides, so a false positive here is harmless (it's a
 * suggestion, never an auto-trigger). Multilingual (en/ru/kk) since teams name
 * columns in their own language.
 *
 * Deliberately conservative: matches clear "ready to test / QA / testing"
 * phrasings, not vague ones like "In Progress" or "Done".
 */

// Substrings that strongly signal a QA/testing-ready column (lowercased).
const QA_PATTERNS: string[] = [
  // English
  'ready to test', 'ready for test', 'ready for qa', 'ready for testing',
  'to test', 'to qa', 'in qa', 'qa ready', 'qa', 'testing', 'test ready',
  'awaiting test', 'awaiting qa',
  // Russian
  'готово к тест', 'готов к тест', 'на тест', 'тестирование', 'к тестированию',
  'на проверк', 'готово к проверке',
  // Kazakh
  'тестке дайын', 'тестілеу', 'тексеруге',
];

// Words that DISQUALIFY even if a QA pattern loosely matches (avoid "Done testing", etc.).
const NEGATIVE_PATTERNS: string[] = ['done', 'closed', 'готово', 'закрыт', 'аяқталды', 'жабық'];

/**
 * True if the status name looks like a QA/testing-ready column.
 * Bare "qa"/"test" tokens match only as whole words to avoid false hits like
 * "Quality Assessment" phrases; longer phrases match as substrings.
 */
export function looksLikeQaStatus(name: string): boolean {
  const n = (name || '').trim().toLowerCase();
  if (!n) return false;

  // Disqualify terminal/done-like columns outright.
  if (NEGATIVE_PATTERNS.some((neg) => n === neg || n.includes(neg))) {
    // "ready to test" wouldn't hit these; "Done" / "Готово" would.
    // Still allow if it ALSO clearly says test/qa AND isn't just "done".
    const clearlyTest = n.includes('test') || n.includes('qa') || n.includes('тест') || n.includes('тексер');
    if (!clearlyTest) return false;
  }

  return QA_PATTERNS.some((p) => {
    // Short tokens ("qa", "to qa") — require word-ish boundary to reduce noise.
    if (p.length <= 3) {
      const re = new RegExp(`(^|[^\\p{L}])${p}([^\\p{L}]|$)`, 'u');
      return re.test(n);
    }
    return n.includes(p);
  });
}

/** Pre-select the QA-like statuses from a project's status list (for the picker). */
export function suggestQaStatuses(
  statuses: Array<{ id: string; name: string }>,
): Array<{ id: string; name: string }> {
  return statuses.filter((s) => looksLikeQaStatus(s.name));
}
