/**
 * Test plan types.
 *
 * All plan-generation functions (generateTestPlan, generateIntelligentTestPlan,
 * formatTestPlanForConfirmation, validateSelectorsInPlan) were removed — they
 * were part of the Pro mode approval flow. Tests now run immediately via Lite mode.
 *
 * Only the TestPlan interface and ExpectedOutcome type are retained — they're
 * imported by test-report-generator.service.ts (live).
 */

import { PlaywrightCommand } from '@/types';

/**
 * Expected outcome - supports both string (legacy) and structured format
 */
export type ExpectedOutcome =
  | string // Legacy format: simple string description
  | {
      type: 'url_change' | 'toast' | 'element_visible' | 'count_increase' | 'form_submitted' | 'other';
      selector?: string | null;
      expectedValue?: string | null;
      timeoutMs?: number;
    };

/**
 * Test plan structure used by report generator.
 */
export interface TestPlan {
  id: string;
  status: string;
  url: string;
  scope: string;
  summary: string;
  steps: Array<{
    id: string;
    description: string;
    action: string;
    selector?: string;
    value?: string;
    optional?: boolean;
    confidence?: number;
    expectedOutcome: ExpectedOutcome;
  }>;
  /** @deprecated Commands are now used as hints, not strict commands */
  commands: PlaywrightCommand[];
  estimatedDuration: string;
  whatWillBeTested: string[];
  whatWillNotBeTested: string[];
  risks: string[];
  notes?: string | null;
  createdAt: string;
  expiresAt: string;
  intelligentMode?: boolean;
  estimatedPages?: string;
  estimatedCost?: string;
  mode?: string;
}
