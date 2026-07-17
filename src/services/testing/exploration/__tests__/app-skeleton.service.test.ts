/**
 * App-skeleton service — merge + read + summarise.
 * Mocks the db/ sublayer (per the mock-boundary rule) and asserts the pure
 * merge behaviour: union by fingerprint, scenario stickiness, version-guard
 * rebuild, best-effort non-throwing, and the NL brief.
 */
import { jest } from '@jest/globals';

const fetchAppSkeleton = jest.fn() as jest.Mock<any>;
const upsertAppSkeleton = jest.fn() as jest.Mock<any>;
const fetchProjectAccessRow = jest.fn() as jest.Mock<any>;

jest.mock('../db/app-skeleton.db', () => ({
  fetchAppSkeleton: (...a: unknown[]) => (fetchAppSkeleton as (...x: unknown[]) => unknown)(...a),
  upsertAppSkeleton: (...a: unknown[]) => (upsertAppSkeleton as (...x: unknown[]) => unknown)(...a),
  fetchProjectAccessRow: (...a: unknown[]) => (fetchProjectAccessRow as (...x: unknown[]) => unknown)(...a),
}));

const getRole = jest.fn() as jest.Mock<any>;
jest.mock('@/services/core/workspace-access.service', () => ({
  WorkspaceAccessService: { getRole: (...a: unknown[]) => (getRole as (...x: unknown[]) => unknown)(...a) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppSkeletonService } = require('../app-skeleton.service');

const KEY = { projectId: 'p1', platform: 'mobile_android' as const, packageName: 'com.app' };

function wireNode(fp: string, title: string, scenarios: Array<{ name: string; kind: string; status: string }> = [], extra: Record<string, unknown> = {}) {
  return { title, pageType: 'screen', mobile: { fingerprint: fp, visitCount: 1, scenarios, ...extra } };
}

beforeEach(() => {
  fetchAppSkeleton.mockReset();
  upsertAppSkeleton.mockReset();
  fetchProjectAccessRow.mockReset();
  getRole.mockReset();
  upsertAppSkeleton.mockResolvedValue(undefined);
});

describe('mergeRunIntoSkeleton', () => {
  it('inserts a fresh skeleton when none exists', async () => {
    fetchAppSkeleton.mockResolvedValue(null);
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: {
        nodes: [wireNode('fp1', 'Login', [{ name: 'Log in', kind: 'auth', status: 'covered' }])],
        edges: [{ fromFingerprint: 'fp1', toFingerprint: 'fp2', action: 'tap', description: 'go' }],
      },
      rootFingerprint: 'fp1', domainGuess: 'banking', coverageScore: 40, runId: 'r1',
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.screens).toHaveLength(1);
    expect(row.screens[0].scenarios[0]).toEqual({ name: 'Log in', kind: 'auth', status: 'covered' });
    expect(row.transitions).toHaveLength(1);
    expect(row.runCount).toBe(1);
    expect(row.domainGuess).toBe('banking');
  });

  it('unions screens across runs and makes covered sticky over pending', async () => {
    fetchAppSkeleton.mockResolvedValue({
      fingerprintVersion: 1, runCount: 1, bestCoverageScore: 30,
      screens: [{ fingerprint: 'fp1', name: 'Login', visitCount: 1, scenarios: [{ name: 'Log in', kind: 'auth', status: 'covered' }] }],
      transitions: [], rootFingerprint: 'fp1', domainGuess: 'banking',
    });
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: {
        // Re-see fp1 (Log in now only pending — must stay covered), add fp2.
        nodes: [
          wireNode('fp1', 'Login', [{ name: 'Log in', kind: 'auth', status: 'pending' }]),
          wireNode('fp2', 'Dashboard'),
        ],
        edges: [],
      },
      coverageScore: 55,
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.screens.map((s: any) => s.fingerprint).sort()).toEqual(['fp1', 'fp2']);
    const login = row.screens.find((s: any) => s.fingerprint === 'fp1');
    expect(login.scenarios[0].status).toBe('covered'); // sticky
    expect(login.visitCount).toBe(2); // merged
    expect(row.runCount).toBe(2);
    expect(row.bestCoverageScore).toBe(55); // max(30,55)
  });

  it('collapses duplicate transitions by (from,to,action)', async () => {
    fetchAppSkeleton.mockResolvedValue({
      fingerprintVersion: 1, runCount: 1, bestCoverageScore: 0,
      screens: [], transitions: [{ from: 'a', to: 'b', action: 'tap', description: 'x' }], rootFingerprint: null, domainGuess: null,
    });
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: { nodes: [], edges: [{ fromFingerprint: 'a', toFingerprint: 'b', action: 'tap', description: 'x again' }] },
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.transitions).toHaveLength(1); // same key collapses
  });

  it('rebuilds from scratch when fingerprint_version differs (version guard)', async () => {
    fetchAppSkeleton.mockResolvedValue({
      fingerprintVersion: 1, runCount: 5, bestCoverageScore: 90,
      screens: [{ fingerprint: 'old', name: 'Stale', visitCount: 9, scenarios: [] }],
      transitions: [{ from: 'old', to: 'x', action: 'tap', description: '' }], rootFingerprint: 'old', domainGuess: 'x',
    });
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 2, // bumped
      graph: { nodes: [wireNode('new', 'Fresh')], edges: [] },
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.screens.map((s: any) => s.fingerprint)).toEqual(['new']); // old discarded
    expect(row.runCount).toBe(1); // reset, not 6
    expect(row.fingerprintVersion).toBe(2);
  });

  it('MERGES (does not rebuild) when the incoming fingerprintVersion is undefined', async () => {
    // An older runner omits fingerprintVersion. Treating undefined as a version
    // change would wipe the stored graph every run and never accumulate.
    fetchAppSkeleton.mockResolvedValue({
      fingerprintVersion: 1, runCount: 4, bestCoverageScore: 70,
      screens: [{ fingerprint: 'fp1', name: 'Login', visitCount: 3, scenarios: [] }],
      transitions: [], rootFingerprint: 'fp1', domainGuess: 'banking',
    });
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, // no fingerprintVersion
      graph: { nodes: [wireNode('fp2', 'Dashboard')], edges: [] },
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    // Stored screen kept AND the new one unioned in → merge, not rebuild.
    expect(row.screens.map((s: any) => s.fingerprint).sort()).toEqual(['fp1', 'fp2']);
    expect(row.runCount).toBe(5); // incremented from stored 4
    // Column is NOT NULL → the stored version is preserved on the write.
    expect(row.fingerprintVersion).toBe(1);
  });

  it('defaults fingerprintVersion to 1 on a fresh row when the runner omits it', async () => {
    fetchAppSkeleton.mockResolvedValue(null);
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, // no fingerprintVersion, no prior row
      graph: { nodes: [wireNode('fp1', 'Home')], edges: [] },
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.fingerprintVersion).toBe(1); // non-null fallback for the NOT NULL column
  });

  it('carries coverageScore from the mobile header into bestCoverageScore', async () => {
    // Regression: coverageScore lives on the mobile header (no top-level summary);
    // the merge must honour it so bestCoverageScore is not stuck at 0.
    fetchAppSkeleton.mockResolvedValue(null);
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: { nodes: [wireNode('fp1', 'Home')], edges: [] },
      coverageScore: 42,
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.bestCoverageScore).toBe(42);
  });

  it('is best-effort: a db error is swallowed, never thrown', async () => {
    fetchAppSkeleton.mockRejectedValue(new Error('db down'));
    await expect(
      AppSkeletonService.mergeRunIntoSkeleton({ ...KEY, fingerprintVersion: 1, graph: { nodes: [], edges: [] } }),
    ).resolves.toBeUndefined();
    expect(upsertAppSkeleton).not.toHaveBeenCalled();
  });

  it('no-ops without projectId or packageName', async () => {
    await AppSkeletonService.mergeRunIntoSkeleton({ ...KEY, packageName: '', fingerprintVersion: 1, graph: { nodes: [], edges: [] } });
    expect(fetchAppSkeleton).not.toHaveBeenCalled();
  });

  it('redacts PII out of screen names / scenario names / transition descriptions before persist', async () => {
    // Device UI text can carry a logged-in user's email/phone in a header;
    // this sink persists AND re-prompts, so it must redact (invariant #10).
    fetchAppSkeleton.mockResolvedValue(null);
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: {
        nodes: [wireNode('fp1', 'Welcome jane.doe@acme.com', [
          { name: 'Call +1 415 555 0100', kind: 'contact', status: 'pending' },
        ])],
        edges: [{ fromFingerprint: 'fp1', toFingerprint: 'fp2', action: 'tap', description: 'email user@x.io' }],
      },
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.screens[0].name).toBe('Welcome <redacted:email>');
    expect(row.screens[0].scenarios[0].name).toContain('<redacted:phone>');
    expect(row.transitions[0].description).toBe('email <redacted:email>');
    // No raw PII anywhere in the persisted blob.
    const blob = JSON.stringify(row);
    expect(blob).not.toContain('jane.doe@acme.com');
    expect(blob).not.toContain('user@x.io');
  });

  it('persists + scrubs a control scenario’s checks, and preserves them across a re-merge', async () => {
    // First run: a slider scenario arrives with checks that embed the label.
    fetchAppSkeleton.mockResolvedValueOnce(null);
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: {
        nodes: [wireNode('fp1', 'Filters', [
          { name: 'Adjust price', kind: 'slider', status: 'pending' },
        ], {})],
        edges: [],
      },
    });
    // Inject checks onto the wire scenario (wireNode helper doesn't take them).
    const firstCallGraph = {
      nodes: [{
        title: 'Filters', pageType: 'screen',
        mobile: { fingerprint: 'fp1', visitCount: 1, scenarios: [
          { name: 'Adjust price', kind: 'slider', status: 'pending', checks: ['set to min for user@x.io', 'set to max'] },
        ] },
      }],
      edges: [],
    };
    upsertAppSkeleton.mockClear();
    fetchAppSkeleton.mockResolvedValueOnce(null);
    await AppSkeletonService.mergeRunIntoSkeleton({ ...KEY, fingerprintVersion: 1, graph: firstCallGraph });
    const row1: any = upsertAppSkeleton.mock.calls[0][0];
    const sc1 = row1.screens[0].scenarios[0];
    expect(sc1.checks).toBeDefined();
    expect(sc1.checks.join(' ')).not.toContain('user@x.io'); // scrubbed
    expect(sc1.checks.join(' ')).toContain('<redacted:email>');

    // Second run re-sees the scenario as covered but WITHOUT checks → must keep them.
    fetchAppSkeleton.mockResolvedValueOnce({
      fingerprintVersion: 1, runCount: 1, bestCoverageScore: 0,
      screens: [{ fingerprint: 'fp1', name: 'Filters', visitCount: 1, scenarios: [
        { name: 'Adjust price', kind: 'slider', status: 'pending', checks: ['set to min', 'set to max'] },
      ] }],
      transitions: [], rootFingerprint: null, domainGuess: null,
    });
    upsertAppSkeleton.mockClear();
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: { nodes: [wireNode('fp1', 'Filters', [{ name: 'Adjust price', kind: 'slider', status: 'covered' }])], edges: [] },
    });
    const row2: any = upsertAppSkeleton.mock.calls[0][0];
    const sc2 = row2.screens[0].scenarios[0];
    expect(sc2.status).toBe('covered');       // status advanced
    expect(sc2.checks).toEqual(['set to min', 'set to max']); // checks preserved
  });

  it('keeps the root screen when the merged set exceeds MAX_SCREENS', async () => {
    // 205 fresh screens with the root LAST in insertion order — a naive
    // slice(0,200) would drop it and orphan rootFingerprint.
    fetchAppSkeleton.mockResolvedValue(null);
    const nodes = [];
    for (let i = 0; i < 204; i++) nodes.push(wireNode(`n${i}`, `Screen ${i}`));
    nodes.push(wireNode('ROOT', 'Home')); // last
    await AppSkeletonService.mergeRunIntoSkeleton({
      ...KEY, fingerprintVersion: 1,
      graph: { nodes, edges: [] },
      rootFingerprint: 'ROOT',
    });
    const row: any = upsertAppSkeleton.mock.calls[0][0];
    expect(row.screens).toHaveLength(200);
    expect(row.screens.some((s: any) => s.fingerprint === 'ROOT')).toBe(true);
  });
});

describe('summariseForPrompt', () => {
  it('returns empty string for a missing/empty model', () => {
    expect(AppSkeletonService.summariseForPrompt(null)).toBe('');
    expect(AppSkeletonService.summariseForPrompt({ screens: [], transitions: [], rootFingerprint: null, domainGuess: null, screenCount: 0, runCount: 0, bestCoverageScore: 0, updatedAt: '' })).toBe('');
  });

  it('briefs domain, screen count, covered/pending flows, and root reachability', async () => {
    const model = {
      screens: [
        { fingerprint: 'fp1', name: 'Login', visitCount: 2, scenarios: [{ name: 'Log in', kind: 'auth', status: 'covered' }, { name: 'Reset password', kind: 'auth', status: 'pending' }] },
        { fingerprint: 'fp2', name: 'Dashboard', visitCount: 1, scenarios: [] },
      ],
      transitions: [{ from: 'fp1', to: 'fp2', action: 'tap', description: 'login' }],
      rootFingerprint: 'fp1', domainGuess: 'banking', screenCount: 2, runCount: 3, bestCoverageScore: 60, updatedAt: '',
    };
    const brief = AppSkeletonService.summariseForPrompt(model);
    expect(brief).toContain('banking app');
    expect(brief).toContain('2 screen');
    expect(brief).toContain('Log in (covered)');
    expect(brief).toContain('Reset password (pending)');
    expect(brief).toContain('From "Login" you can reach: Dashboard');
  });

  it('skips a nameless scenario from a legacy row instead of rendering "undefined"', () => {
    const model = {
      screens: [
        { fingerprint: 'fp1', name: 'Login', visitCount: 1, scenarios: [
          { kind: 'auth', status: 'covered' } as any, // no name (legacy/hand-edited)
          { name: 'Log in', kind: 'auth', status: 'covered' },
        ] },
      ],
      transitions: [], rootFingerprint: null, domainGuess: 'banking', screenCount: 1, runCount: 1, bestCoverageScore: 0, updatedAt: '',
    };
    const brief = AppSkeletonService.summariseForPrompt(model);
    expect(brief).toContain('Log in (covered)');
    expect(brief).not.toContain('undefined');
  });
});

describe('getAppModel access gate', () => {
  const modelRow = {
    fingerprintVersion: 1, screens: [{ fingerprint: 'fp1', name: 'Home', visitCount: 1, scenarios: [] }],
    transitions: [], rootFingerprint: 'fp1', domainGuess: 'x', screenCount: 1, runCount: 1, bestCoverageScore: 0, updatedAt: 'now',
  };

  it('returns the model for the project owner', async () => {
    fetchProjectAccessRow.mockResolvedValue({ userId: 'u1', workspaceId: 'w1' });
    fetchAppSkeleton.mockResolvedValue(modelRow);
    const out = await AppSkeletonService.getAppModel(KEY, 'u1');
    expect(out?.screenCount).toBe(1);
    expect(getRole).not.toHaveBeenCalled(); // owner short-circuits
  });

  it('returns the model for a workspace member (non-owner)', async () => {
    fetchProjectAccessRow.mockResolvedValue({ userId: 'owner', workspaceId: 'w1' });
    getRole.mockResolvedValue('member');
    fetchAppSkeleton.mockResolvedValue(modelRow);
    const out = await AppSkeletonService.getAppModel(KEY, 'stranger-in-workspace');
    expect(out?.screenCount).toBe(1);
    expect(getRole).toHaveBeenCalledWith('stranger-in-workspace', 'w1');
  });

  it('returns null (denies) for a non-owner, non-member — never reads the skeleton', async () => {
    fetchProjectAccessRow.mockResolvedValue({ userId: 'owner', workspaceId: 'w1' });
    getRole.mockResolvedValue(null); // not a member
    const out = await AppSkeletonService.getAppModel(KEY, 'attacker');
    expect(out).toBeNull();
    expect(fetchAppSkeleton).not.toHaveBeenCalled(); // fail-closed before the read
  });

  it('denies when the project does not exist', async () => {
    fetchProjectAccessRow.mockResolvedValue(null);
    const out = await AppSkeletonService.getAppModel(KEY, 'u1');
    expect(out).toBeNull();
    expect(fetchAppSkeleton).not.toHaveBeenCalled();
  });

  it('skips the access gate entirely when no userId is passed (trusted server caller)', async () => {
    fetchAppSkeleton.mockResolvedValue(modelRow);
    const out = await AppSkeletonService.getAppModel(KEY);
    expect(out?.screenCount).toBe(1);
    expect(fetchProjectAccessRow).not.toHaveBeenCalled();
  });
});
