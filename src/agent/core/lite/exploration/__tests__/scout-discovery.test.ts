/**
 * Scout.toDiscovery — the record shape FlowRunner now pushes into
 * bb.discoveredBranches so the Strategist's re-evaluation can see Scout's
 * findings. (Audit finding #3 — previously toDiscovery was never called.)
 */

import { Scout } from '../agents/scout';
import type { ScoutOutput } from '../agents/agent-types';

describe('Scout.toDiscovery (finding #3 — Scout→Strategist channel)', () => {
  const output: ScoutOutput = {
    newEntryPoints: [
      {
        name: 'Edit Profile',
        goal: 'Open and edit the user profile',
        category: 'user_management',
        priority: 'high',
        requiresAuth: true,
        estimatedComplexity: 'medium',
        relatedElements: [],
      },
    ],
    newPages: ['https://ex.com/settings'],
    insight: 'After login the dashboard exposes profile + settings flows',
  };

  it('wraps a ScoutOutput into a ScoutDiscovery carrying source + payload', () => {
    const d = Scout.toDiscovery('ep-7', 'User Login', output);
    expect(d.sourceFlowId).toBe('ep-7');
    expect(d.sourceFlowName).toBe('User Login');
    expect(d.newEntryPoints).toHaveLength(1);
    expect(d.newPages).toEqual(['https://ex.com/settings']);
    expect(d.insight).toContain('dashboard');
    expect(typeof d.discoveredAt).toBe('number');
  });

  it('preserves an empty discovery (no entry points / pages)', () => {
    const d = Scout.toDiscovery('ep-1', 'Search', { newEntryPoints: [], newPages: [], insight: 'nothing new' });
    expect(d.newEntryPoints).toHaveLength(0);
    expect(d.newPages).toHaveLength(0);
    expect(d.insight).toBe('nothing new');
  });
});
