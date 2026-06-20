import { computeImplicitRole } from '../implicit-role.util';

describe('computeImplicitRole', () => {
  it('returns the explicit role when present, trimmed', () => {
    expect(computeImplicitRole({ tag: 'div', explicitRole: 'tab' })).toBe('tab');
    expect(computeImplicitRole({ tag: 'div', explicitRole: '  menuitem  ' })).toBe('menuitem');
  });

  it('returns undefined for an unknown tag or no tag', () => {
    expect(computeImplicitRole({ tag: 'div' })).toBeUndefined();
    expect(computeImplicitRole({ tag: 'span' })).toBeUndefined();
    expect(computeImplicitRole({})).toBeUndefined();
  });

  it('maps button and summary to button', () => {
    expect(computeImplicitRole({ tag: 'button' })).toBe('button');
    expect(computeImplicitRole({ tag: 'summary' })).toBe('button');
  });

  it('maps <a> to link only when it has href', () => {
    expect(computeImplicitRole({ tag: 'a', hasHref: true })).toBe('link');
    expect(computeImplicitRole({ tag: 'a', hasHref: false })).toBeUndefined();
    expect(computeImplicitRole({ tag: 'area' })).toBe('link');
  });

  it('maps input types to their roles', () => {
    for (const t of ['button', 'submit', 'reset', 'image']) {
      expect(computeImplicitRole({ tag: 'input', inputType: t })).toBe('button');
    }
    expect(computeImplicitRole({ tag: 'input', inputType: 'checkbox' })).toBe('checkbox');
    expect(computeImplicitRole({ tag: 'input', inputType: 'radio' })).toBe('radio');
    expect(computeImplicitRole({ tag: 'input', inputType: 'range' })).toBe('slider');
    for (const t of ['text', 'email', 'password', 'number', 'date']) {
      expect(computeImplicitRole({ tag: 'input', inputType: t })).toBe('textbox');
    }
  });

  it('defaults a typeless input to textbox and an unknown input type to undefined', () => {
    expect(computeImplicitRole({ tag: 'input' })).toBe('textbox');
    expect(computeImplicitRole({ tag: 'input', inputType: 'hidden' })).toBeUndefined();
  });

  it('maps textarea and select variants', () => {
    expect(computeImplicitRole({ tag: 'textarea' })).toBe('textbox');
    expect(computeImplicitRole({ tag: 'select' })).toBe('combobox');
    expect(computeImplicitRole({ tag: 'select', hasMultiple: true })).toBe('listbox');
  });

  it('maps <img> to img only when it has alt', () => {
    expect(computeImplicitRole({ tag: 'img', hasAlt: true })).toBe('img');
    expect(computeImplicitRole({ tag: 'img', hasAlt: false })).toBeUndefined();
  });

  it('maps landmark elements', () => {
    expect(computeImplicitRole({ tag: 'nav' })).toBe('navigation');
    expect(computeImplicitRole({ tag: 'main' })).toBe('main');
    expect(computeImplicitRole({ tag: 'header' })).toBe('banner');
    expect(computeImplicitRole({ tag: 'footer' })).toBe('contentinfo');
    expect(computeImplicitRole({ tag: 'aside' })).toBe('complementary');
    expect(computeImplicitRole({ tag: 'form' })).toBe('form');
    expect(computeImplicitRole({ tag: 'search' })).toBe('search');
  });

  it('maps headings, lists, and table parts', () => {
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(computeImplicitRole({ tag: h })).toBe('heading');
    }
    expect(computeImplicitRole({ tag: 'ul' })).toBe('list');
    expect(computeImplicitRole({ tag: 'li' })).toBe('listitem');
    expect(computeImplicitRole({ tag: 'table' })).toBe('table');
    expect(computeImplicitRole({ tag: 'tr' })).toBe('row');
    expect(computeImplicitRole({ tag: 'td' })).toBe('cell');
    expect(computeImplicitRole({ tag: 'th' })).toBe('columnheader');
  });

  it('uppercases tag input is normalised', () => {
    expect(computeImplicitRole({ tag: 'BUTTON' })).toBe('button');
  });
});
