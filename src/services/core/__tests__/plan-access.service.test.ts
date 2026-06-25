import { isPaidUser } from '../plan-access.service';
import { getUserPlanSlug, userHasPaidWorkspace } from '../db/plan-access.db';

// Mock only the DB reads; keep the pure `isFreeSlug` helper real (it's domain
// logic, not a DB boundary — auto-mocking it would make every slug non-free).
jest.mock('../db/plan-access.db', () => {
  const actual = jest.requireActual('../db/plan-access.db');
  return {
    ...actual,
    getUserPlanSlug: jest.fn(),
    userHasPaidWorkspace: jest.fn(),
  };
});

const mockGetUserPlanSlug = getUserPlanSlug as jest.MockedFunction<typeof getUserPlanSlug>;
const mockUserHasPaidWorkspace = userHasPaidWorkspace as jest.MockedFunction<typeof userHasPaidWorkspace>;

describe('isPaidUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no paid workspace, so personal plan decides.
    mockUserHasPaidWorkspace.mockResolvedValue(false);
  });

  it('is paid when the personal plan slug is non-free', async () => {
    mockGetUserPlanSlug.mockResolvedValue('pro');
    expect(await isPaidUser('u1')).toBe(true);
    // Personal plan already decided — workspace check must be skipped.
    expect(mockUserHasPaidWorkspace).not.toHaveBeenCalled();
  });

  it('is free when personal plan is free and no paid workspace', async () => {
    mockGetUserPlanSlug.mockResolvedValue('free');
    mockUserHasPaidWorkspace.mockResolvedValue(false);
    expect(await isPaidUser('u1')).toBe(false);
  });

  it('is free when no plan slug and no paid workspace', async () => {
    mockGetUserPlanSlug.mockResolvedValue(null);
    mockUserHasPaidWorkspace.mockResolvedValue(false);
    expect(await isPaidUser('u1')).toBe(false);
  });

  it('is paid via a paid B2B workspace even when personal plan is free', async () => {
    mockGetUserPlanSlug.mockResolvedValue('free');
    mockUserHasPaidWorkspace.mockResolvedValue(true);
    expect(await isPaidUser('u1')).toBe(true);
  });

  it('is paid via a paid B2B workspace even when personal plan_id is null', async () => {
    mockGetUserPlanSlug.mockResolvedValue(null);
    mockUserHasPaidWorkspace.mockResolvedValue(true);
    expect(await isPaidUser('u1')).toBe(true);
  });
});
