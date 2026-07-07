import { isPaidUser } from '../plan-access.service';
import { getUserPlanSlug, userHasPaidBusinessPlan } from '../db/plan-access.db';

// Mock only the DB reads; keep the pure `isFreeSlug` helper real (it's domain
// logic, not a DB boundary — auto-mocking it would make every slug non-free).
jest.mock('../db/plan-access.db', () => {
  const actual = jest.requireActual('../db/plan-access.db');
  return {
    ...actual,
    getUserPlanSlug: jest.fn(),
    userHasPaidBusinessPlan: jest.fn(),
  };
});

const mockGetUserPlanSlug = getUserPlanSlug as jest.MockedFunction<typeof getUserPlanSlug>;
const mockUserHasPaidBusinessPlan = userHasPaidBusinessPlan as jest.MockedFunction<
  typeof userHasPaidBusinessPlan
>;

describe('isPaidUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no paid B2B plan, so personal plan decides.
    mockUserHasPaidBusinessPlan.mockResolvedValue(false);
  });

  it('is paid when the personal plan slug is non-free', async () => {
    mockGetUserPlanSlug.mockResolvedValue('pro');
    expect(await isPaidUser('u1')).toBe(true);
    // Personal plan already decided — B2B check must be skipped.
    expect(mockUserHasPaidBusinessPlan).not.toHaveBeenCalled();
  });

  it('is free when personal plan is free and no paid B2B plan', async () => {
    mockGetUserPlanSlug.mockResolvedValue('free');
    mockUserHasPaidBusinessPlan.mockResolvedValue(false);
    expect(await isPaidUser('u1')).toBe(false);
  });

  it('is free when no plan slug and no paid B2B plan', async () => {
    mockGetUserPlanSlug.mockResolvedValue(null);
    mockUserHasPaidBusinessPlan.mockResolvedValue(false);
    expect(await isPaidUser('u1')).toBe(false);
  });

  it('is paid via a paid B2B plan on user_credits even when personal plan is free', async () => {
    mockGetUserPlanSlug.mockResolvedValue('free');
    mockUserHasPaidBusinessPlan.mockResolvedValue(true);
    expect(await isPaidUser('u1')).toBe(true);
  });

  it('is paid via a paid B2B plan on user_credits even when personal plan_id is null', async () => {
    mockGetUserPlanSlug.mockResolvedValue(null);
    mockUserHasPaidBusinessPlan.mockResolvedValue(true);
    expect(await isPaidUser('u1')).toBe(true);
  });
});
