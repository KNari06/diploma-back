import { TrackerRegistry } from '../tracker-registry';
import type { TaskTrackerProvider } from '../tracker-provider.interface';

function fakeProvider(id: string): TaskTrackerProvider {
  return {
    provider: id as TaskTrackerProvider['provider'],
    capabilities: { hasBoards: true, hasComments: true, hasStatusWrite: true, hasWebhook: true },
    buildAuthUrl: () => '',
    exchangeCode: async () => [],
    listBoards: async () => [],
    listColumns: async () => [],
    listTasks: async () => ({ tasks: [], columns: [], total: 0 }),
    getTask: async () => ({} as never),
    getRelatedContext: async () => ({ related: [], comments: [] }),
    listStatuses: async () => [],
    addComment: async () => {},
    setStatus: async () => {},
    verifyWebhook: () => true,
    parseWebhook: () => null,
  };
}

describe('TrackerRegistry', () => {
  it('registers a provider and resolves it by id', () => {
    TrackerRegistry.register(fakeProvider('linear'));
    expect(TrackerRegistry.isSupported('linear')).toBe(true);
    expect(TrackerRegistry.get('linear').provider).toBe('linear');
  });

  it('throws a clear error for an unsupported tracker', () => {
    expect(() => TrackerRegistry.get('does-not-exist' as never)).toThrow(/Unsupported task tracker/);
  });

  it('tryGet returns null instead of throwing for an unknown tracker', () => {
    expect(TrackerRegistry.tryGet('nope' as never)).toBeNull();
  });

  it('has jira registered via the bootstrap barrel', async () => {
    await import('../index');
    expect(TrackerRegistry.isSupported('jira')).toBe(true);
    expect(TrackerRegistry.list()).toContain('jira');
  });
});
