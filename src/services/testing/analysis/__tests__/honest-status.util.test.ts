import {
  deriveHonestStatusFromReadiness,
  deriveHonestStatusFromRun,
} from '../honest-status.util';
import type { TaskReadinessAssessment } from '@/types/testing.types';

const ready: TaskReadinessAssessment = {
  readinessScore: 85, readyToTest: true, blockingQuestions: [], coverageGaps: [], summary: 'ok',
};
const notReady: TaskReadinessAssessment = {
  readinessScore: 30, readyToTest: false, blockingQuestions: ['which URL?'], coverageGaps: [], summary: 'thin',
};

describe('deriveHonestStatusFromReadiness', () => {
  it('ready when readyToTest and outcome is not rework', () => {
    expect(deriveHonestStatusFromReadiness(ready, 'CAN_RUN_AUTO').status).toBe('ready');
  });

  it('blocked when readiness says not ready', () => {
    expect(deriveHonestStatusFromReadiness(notReady, 'CAN_RUN_AUTO').status).toBe('blocked');
  });

  it('blocked when outcome is NEEDS_REWORK even if readiness looks ready', () => {
    expect(deriveHonestStatusFromReadiness(ready, 'NEEDS_REWORK').status).toBe('blocked');
  });

  it('defaults to ready when readiness is undefined and not rework', () => {
    expect(deriveHonestStatusFromReadiness(undefined, 'PREPARE_MANUAL').status).toBe('ready');
  });
});

describe('deriveHonestStatusFromRun', () => {
  it('empty when there are no executions', () => {
    expect(deriveHonestStatusFromRun({ totalExecutions: 0, passed: 0, failed: 0, skipped: 0 }).status).toBe('empty');
  });

  it('empty when the test set is explicitly empty', () => {
    expect(deriveHonestStatusFromRun({ totalExecutions: 3, passed: 0, failed: 0, skipped: 0, emptyTestSet: true }).status).toBe('empty');
  });

  it('blocked on a setup failure', () => {
    expect(deriveHonestStatusFromRun({ totalExecutions: 2, passed: 0, failed: 0, skipped: 0, setupFailure: true }).status).toBe('blocked');
  });

  it('skipped when every execution was skipped', () => {
    expect(deriveHonestStatusFromRun({ totalExecutions: 3, passed: 0, failed: 0, skipped: 3 }).status).toBe('skipped');
  });

  it('blocked when any execution failed', () => {
    expect(deriveHonestStatusFromRun({ totalExecutions: 4, passed: 3, failed: 1, skipped: 0 }).status).toBe('blocked');
  });

  it('ready when everything passed', () => {
    expect(deriveHonestStatusFromRun({ totalExecutions: 4, passed: 4, failed: 0, skipped: 0 }).status).toBe('ready');
  });

  it('carries a human reason string on every branch', () => {
    const r = deriveHonestStatusFromRun({ totalExecutions: 0, passed: 0, failed: 0, skipped: 0 });
    expect(r.reason.length).toBeGreaterThan(0);
    expect(r.reasonCode).toBe('EMPTY_TEST_SET');
  });
});
