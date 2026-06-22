import {
  scoreCloseAffordance,
  isConfidentCloseAffordance,
  CLOSE_CONFIDENT_THRESHOLD,
  type CloseCandidate,
} from '../close-affordance.util';

const overlay = { left: 200, top: 100, width: 600, height: 400 };

describe('scoreCloseAffordance — structural, language-agnostic', () => {
  it('finds a close button via data-dismiss (any language, no text)', () => {
    expect(isConfidentCloseAffordance({ hasDismissData: true })).toBe(true);
  });

  it('finds a × glyph close button regardless of language', () => {
    expect(isConfidentCloseAffordance({ text: '×', isIconOnly: true })).toBe(true);
    expect(isConfidentCloseAffordance({ ariaLabel: '✕' })).toBe(true);
  });

  it('finds a top-corner small icon-only button by GEOMETRY alone (no text)', () => {
    const c: CloseCandidate = {
      isIconOnly: true,
      rect: { left: 760, top: 108, width: 24, height: 24 }, // hugs overlay top-right
      overlayRect: overlay,
    };
    expect(scoreCloseAffordance(c).signals).toContain('top-corner-icon');
    expect(isConfidentCloseAffordance(c)).toBe(true); // geometry is enough now
  });

  it('finds a Russian "Закрыть" close button by CLASS (no word list)', () => {
    // The Russian aria-label is NOT consulted — the framework class wins.
    const c: CloseCandidate = { ariaLabel: 'Закрыть', className: 'modal__close' };
    expect(isConfidentCloseAffordance(c)).toBe(true);
    expect(scoreCloseAffordance(c).signals).toContain('class-close');
  });

  it('finds a Kazakh-labelled close button by × glyph (no word list)', () => {
    // aria-label "Жабу" (Kazakh "close") is never read — the × glyph decides.
    expect(isConfidentCloseAffordance({ ariaLabel: 'Жабу', text: '×', isIconOnly: true })).toBe(true);
  });

  it('does NOT treat a destructive "Удалить" button as close (the data-loss guard)', () => {
    const c: CloseCandidate = { text: 'Удалить', ariaLabel: 'Удалить' };
    expect(isConfidentCloseAffordance(c)).toBe(false); // no structural close signal
  });

  it('does NOT treat "Delete account" as close', () => {
    expect(isConfidentCloseAffordance({ text: 'Delete account' })).toBe(false);
  });

  it('does NOT treat a normal "Save" / in-flow button as close', () => {
    expect(isConfidentCloseAffordance({ text: 'Save', className: 'btn-primary' })).toBe(false);
  });

  it('does NOT treat a centered large button as a top-right close icon', () => {
    const c: CloseCandidate = {
      isIconOnly: true,
      rect: { left: 460, top: 380, width: 120, height: 40 }, // center-ish, large
      overlayRect: overlay,
    };
    expect(scoreCloseAffordance(c).signals).not.toContain('top-corner-icon');
  });

  it('threshold is the documented constant', () => {
    expect(CLOSE_CONFIDENT_THRESHOLD).toBe(0.6);
  });
});
