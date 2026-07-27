import { looksLikeQaStatus, suggestQaStatuses } from '../qa-status-heuristic';

describe('looksLikeQaStatus', () => {
  it('matches common QA/testing-ready column names (en)', () => {
    for (const n of ['Ready to test', 'Ready for QA', 'To Test', 'In QA', 'QA', 'Testing', 'Awaiting QA']) {
      expect(looksLikeQaStatus(n)).toBe(true);
    }
  });

  it('matches ru + kk names', () => {
    expect(looksLikeQaStatus('Готово к тестированию')).toBe(true);
    expect(looksLikeQaStatus('На тестирование')).toBe(true);
    expect(looksLikeQaStatus('Тестке дайын')).toBe(true);
  });

  it('does NOT match non-QA workflow columns', () => {
    for (const n of ['To Do', 'In Progress', 'Backlog', 'Done', 'Closed', 'Готово', 'В работе']) {
      expect(looksLikeQaStatus(n)).toBe(false);
    }
  });

  it('is empty-safe', () => {
    expect(looksLikeQaStatus('')).toBe(false);
    expect(looksLikeQaStatus('   ')).toBe(false);
  });
});

describe('suggestQaStatuses', () => {
  it('pre-selects only the QA-like statuses from a real board list', () => {
    const statuses = [
      { id: '1', name: 'To Do' },
      { id: '2', name: 'In Progress' },
      { id: '3', name: 'Ready to test' },
      { id: '4', name: 'QA' },
      { id: '5', name: 'Done' },
    ];
    const ids = suggestQaStatuses(statuses).map((s) => s.id).sort();
    expect(ids).toEqual(['3', '4']);
  });
});
