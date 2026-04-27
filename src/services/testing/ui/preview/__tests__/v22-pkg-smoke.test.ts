/**
 * V22 Pkg1-8 + label-elevation + Unicode normalize smoke tests.
 *
 * One concise sanity test per package — verifies the public API surface
 * still produces the expected fingerprint / hint shape so a regression
 * in any single layer (probe → buildBindingHints → buildRecordedFingerprint
 * → text-normalizer) trips a fast failure here, not later in production.
 *
 * NOT a behavioural / e2e suite — those live in __tests__/ alongside
 * each subsystem (hover-highlight.test.ts, preview-run.service.test.ts,
 * etc). This file is the "did we break the contract" early-warning net.
 */
import { RecordingCaptureService } from '../recording-capture.service';
import { normalizeText, escapeHasText, CELL_SEP } from '../text-normalizer.util';
import type { ProbedElement } from '../recording-capture.service';

// Build a minimal but valid ProbedElement. Tests override only the fields
// they care about, leaving the rest at neutral defaults.
function makeProbedElement(overrides: Partial<ProbedElement> = {}): ProbedElement {
  return {
    tag: 'button',
    role: 'button',
    text: 'Click me',
    ariaLabel: undefined,
    placeholder: undefined,
    name: undefined,
    title: undefined,
    alt: undefined,
    testId: undefined,
    elementId: undefined,
    cssClass: undefined,
    href: undefined,
    type: undefined,
    labelText: undefined,
    boundingBox: { x: 10, y: 20, width: 100, height: 30 },
    ...overrides,
  } as ProbedElement;
}

describe('V22 Pkg smoke — fingerprint + bindingHints contract', () => {
  // ─────────────────────────────────────────────────────────────────────
  // Pkg1: dataValue / childTestId / ariaCurrent / ariaValueNow
  // ─────────────────────────────────────────────────────────────────────
  describe('Pkg1 — semantic identifiers', () => {
    it('emits dataValue from <option value> equivalent', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ dataValue: 'today' } as any),
      );
      expect((fp as any).dataValue).toBe('today');
    });

    it('emits childTestId lifted from icon child', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ childTestId: 'VisibilityOffOutlinedIcon' } as any),
      );
      expect((fp as any).childTestId).toBe('VisibilityOffOutlinedIcon');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pkg2: Bootstrap / aria-haspopup / activedescendant / dataRowKey
  // ─────────────────────────────────────────────────────────────────────
  describe('Pkg2 — popup-trigger + row identity', () => {
    it('emits bsToggle/bsTarget pair', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({
          bsToggle: 'modal',
          bsTarget: '#editForm',
        } as any),
      );
      expect((fp as any).bsToggle).toBe('modal');
      expect((fp as any).bsTarget).toBe('#editForm');
    });

    it('emits dataRowKey', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ dataRowKey: 'user-123' } as any),
      );
      expect((fp as any).dataRowKey).toBe('user-123');
    });

    it('emits ariaHasPopup', () => {
      const hints = RecordingCaptureService.buildBindingHints(
        makeProbedElement({ ariaHasPopup: 'menu' } as any),
      );
      expect((hints as any).ariaHasPopup).toBe('menu');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pkg4: iconLabel
  // ─────────────────────────────────────────────────────────────────────
  describe('Pkg4 — iconLabel for bare icon buttons', () => {
    it('emits iconLabel from svg <title> extraction', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({
          tag: 'div',
          role: 'button',
          iconLabel: 'menu',
          text: undefined,
          ariaLabel: undefined,
        } as any),
      );
      expect((fp as any).iconLabel).toBe('menu');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Pkg5: nearestRowText / siblingIndex / disabled / arrowDir
  // ─────────────────────────────────────────────────────────────────────
  describe('Pkg5 — row text + sibling index + state', () => {
    it('emits nearestRowText concatenated with CELL_SEP', () => {
      const rowText = `АО ХАБАР${CELL_SEP}khabar${CELL_SEP}980640000529`;
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ nearestRowText: rowText } as any),
      );
      expect((fp as any).nearestRowText).toBe(rowText);
      // Caller can re-tokenize on CELL_SEP without ambiguity.
      const cells = rowText.split(CELL_SEP);
      expect(cells).toHaveLength(3);
      expect(cells[0]).toBe('АО ХАБАР');
    });

    it('emits siblingIndex (0-indexed)', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ siblingIndex: 1 } as any),
      );
      expect((fp as any).siblingIndex).toBe(1);
    });

    it('emits disabled boolean — distinguishes prev (true) from next (false)', () => {
      const prevFp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ disabled: true } as any),
      );
      const nextFp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ disabled: false } as any),
      );
      expect((prevFp as any).disabled).toBe(true);
      expect((nextFp as any).disabled).toBe(false);
    });

    it('emits arrowDir for svg-only pagination buttons', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({ arrowDir: 'left' } as any),
      );
      expect((fp as any).arrowDir).toBe('left');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Sparseness contract — empty inputs produce no noise fields
  // ─────────────────────────────────────────────────────────────────────
  describe('Sparseness — fingerprint stays minimal when fields absent', () => {
    it('does not emit Pkg5 fields when probe lacks them', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({}),
      );
      expect((fp as any).nearestRowText).toBeUndefined();
      expect((fp as any).siblingIndex).toBeUndefined();
      expect((fp as any).disabled).toBeUndefined();
      expect((fp as any).arrowDir).toBeUndefined();
    });

    it('does not emit Pkg2/Pkg4 fields when probe lacks them', () => {
      const fp = RecordingCaptureService.buildRecordedFingerprint(
        makeProbedElement({}),
      );
      expect((fp as any).bsToggle).toBeUndefined();
      expect((fp as any).bsTarget).toBeUndefined();
      expect((fp as any).dataRowKey).toBeUndefined();
      expect((fp as any).iconLabel).toBeUndefined();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// Unicode normalization — NFC + invisible-strip + whitespace collapse
// ───────────────────────────────────────────────────────────────────────
describe('text-normalizer — Unicode + control char stripping', () => {
  it('returns undefined for nullish input (sparse-friendly)', () => {
    expect(normalizeText(undefined)).toBeUndefined();
    expect(normalizeText(null)).toBeUndefined();
  });

  it('returns empty string for empty input (callers may treat "" as no-text)', () => {
    expect(normalizeText('')).toBe('');
  });

  it('canonicalizes NFC: decomposed collapses to precomposed', () => {
    // Use \u escapes for unambiguous codepoints — Latin A-acute canonical
    // pair per Unicode TR15: U+00C1 (precomposed) vs U+0041 + U+0301
    // (decomposed). Both render as Á; NFC must collapse the second to
    // the first. Latin chosen because TS-source-encoding round-trips can
    // silently re-compose Cyrillic decomposed sequences during file save.
    const precomposed = '\u00c1';
    const decomposed = '\u0041\u0301';
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeText(decomposed)).toBe(precomposed);
  });

  it('strips zero-width characters that visually equal but break ===', () => {
    const withZWSP = 'hello​world';
    const withZWNJ = 'hello‌world';
    const withBOM = 'hello﻿world';
    expect(normalizeText(withZWSP)).toBe('helloworld');
    expect(normalizeText(withZWNJ)).toBe('helloworld');
    expect(normalizeText(withBOM)).toBe('helloworld');
  });

  it('strips bidi format chars (LRM/RLM/PDF/etc) — common in copied text', () => {
    const withLRM = 'hello‎world';
    const withRLM = 'hello‏world';
    const withPDF = 'hello‬world';
    expect(normalizeText(withLRM)).toBe('helloworld');
    expect(normalizeText(withRLM)).toBe('helloworld');
    expect(normalizeText(withPDF)).toBe('helloworld');
  });

  it('collapses whitespace runs and trims edges', () => {
    expect(normalizeText('  hello   world  ')).toBe('hello world');
    expect(normalizeText('hello\t\tworld')).toBe('hello world');
    expect(normalizeText('hello\n\nworld')).toBe('hello world');
  });

  it('is idempotent: normalize(normalize(s)) === normalize(s)', () => {
    const messy = '  Hello​  World﻿\n';
    const once = normalizeText(messy);
    const twice = normalizeText(once);
    expect(twice).toBe(once);
  });

  it('preserves emoji and CJK — only invisible/format chars are stripped', () => {
    expect(normalizeText('Hello 🌍 世界')).toBe('Hello 🌍 世界');
    expect(normalizeText('Қазақша')).toBe('Қазақша');
    expect(normalizeText("O‘zbekcha")).toBe("O‘zbekcha");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Cell separator — collision-free with real DOM text
// ───────────────────────────────────────────────────────────────────────
describe('CELL_SEP — collision-free cell delimiter', () => {
  it('is U+241F (Information Separator One) — never appears in real DOM text', () => {
    expect(CELL_SEP).toBe('␟');
    expect(CELL_SEP.length).toBe(1);
  });

  it('survives a round-trip join/split with cells containing literal " | "', () => {
    const cells = ['Active | 5 items', 'plain text', 'pipe | inside'];
    const joined = cells.join(CELL_SEP);
    const split = joined.split(CELL_SEP);
    expect(split).toEqual(cells);
  });
});

// ───────────────────────────────────────────────────────────────────────
// has-text escaping — backslash + double-quote
// ───────────────────────────────────────────────────────────────────────
describe('escapeHasText — Playwright :has-text() escaping', () => {
  it('escapes backslashes', () => {
    expect(escapeHasText('C:\\Users\\file')).toBe('C:\\\\Users\\\\file');
  });

  it('escapes double-quotes', () => {
    expect(escapeHasText('Click "Save"')).toBe('Click \\"Save\\"');
  });

  it('passes Unicode through unmodified (Playwright accepts it)', () => {
    expect(escapeHasText('Қазақша')).toBe('Қазақша');
    expect(escapeHasText("O‘zbekcha")).toBe("O‘zbekcha");
  });

  it('escapes backslash BEFORE quote so backslash-then-quote round-trips', () => {
    // input: a\"b   →   stored: a\\\"b   →   parsed by Playwright: a\"b ✓
    expect(escapeHasText('a\\"b')).toBe('a\\\\\\"b');
  });
});
