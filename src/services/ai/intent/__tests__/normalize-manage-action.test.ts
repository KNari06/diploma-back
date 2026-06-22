import { normalizeManageAction } from '../intent-parser.service';

describe('normalizeManageAction', () => {
  describe('manage_module', () => {
    it('keeps canonical create/update', () => {
      expect(normalizeManageAction('manage_module', 'create')).toBe('create');
      expect(normalizeManageAction('manage_module', 'update')).toBe('update');
    });

    it('maps rename/edit synonyms to update', () => {
      expect(normalizeManageAction('manage_module', 'rename')).toBe('update');
      expect(normalizeManageAction('manage_module', 'edit')).toBe('update');
    });

    it('recognizes unsupported move (incl. synonyms) for honest refusal', () => {
      expect(normalizeManageAction('manage_module', 'move')).toBe('move');
      expect(normalizeManageAction('manage_module', 'relocate')).toBe('move');
      expect(normalizeManageAction('manage_module', 'reassign')).toBe('move');
    });

    it('recognizes unsupported convert (incl. synonyms + separators)', () => {
      expect(normalizeManageAction('manage_module', 'convert')).toBe('convert');
      expect(normalizeManageAction('manage_module', 'change_platform')).toBe('convert');
      expect(normalizeManageAction('manage_module', 'change platform')).toBe('convert');
      expect(normalizeManageAction('manage_module', 'migrate')).toBe('convert');
    });

    it('is case- and separator-insensitive', () => {
      expect(normalizeManageAction('manage_module', 'Convert')).toBe('convert');
      expect(normalizeManageAction('manage_module', 'ADD-ITEM')).toBeNull(); // wrong intent vocab
    });

    // The exact failures the audit (HIGH-3) flagged: an unknown variant must
    // DROP (→ null) so the handler falls back to a clarification, NOT be
    // mislabeled as "update" or silently treated as a real rename.
    it('drops unknown variants instead of mislabeling them', () => {
      expect(normalizeManageAction('manage_module', 'convert_to_mobile')).toBeNull();
      expect(normalizeManageAction('manage_module', 'converts')).toBeNull();
      expect(normalizeManageAction('manage_module', 'foobar')).toBeNull();
    });
  });

  describe('manage_plan', () => {
    it('normalizes add_item/remove_item synonyms', () => {
      expect(normalizeManageAction('manage_plan', 'add_item')).toBe('add_item');
      expect(normalizeManageAction('manage_plan', 'addToPlan')).toBe('add_item');
      expect(normalizeManageAction('manage_plan', 'remove_item')).toBe('remove_item');
    });

    it('does not leak module-only actions into plan vocab', () => {
      expect(normalizeManageAction('manage_plan', 'move')).toBeNull();
      expect(normalizeManageAction('manage_plan', 'convert')).toBeNull();
    });
  });

  describe('manage_schedule', () => {
    it('maps enable/disable synonyms to activate/deactivate', () => {
      expect(normalizeManageAction('manage_schedule', 'enable')).toBe('activate');
      expect(normalizeManageAction('manage_schedule', 'disable')).toBe('deactivate');
      expect(normalizeManageAction('manage_schedule', 'pause')).toBe('deactivate');
    });
  });

  it('returns null for a non-management intent', () => {
    expect(normalizeManageAction('general_chat', 'create')).toBeNull();
    expect(normalizeManageAction('platform_test', 'move')).toBeNull();
  });
});
