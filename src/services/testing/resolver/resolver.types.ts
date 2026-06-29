import { AICommand } from '@/agent/core/lite/lite-types';

export type MatchType = 'exact' | 'partial' | 'none';

export interface ResolvedTestCase {
  id: string;
  name: string;
  description?: string;
  url?: string;
  commands: any[];
  stepsJson: any[];
  projectId: string;
  flowId?: string;
  tags?: string[];
  /** Execution platform — drives web vs mobile dispatch on run. */
  platform?: string;
  score: number;
  matchType: MatchType;
  matchReason: string;
}

export interface ResolverResult {
  matchType: MatchType;
  bestMatch?: ResolvedTestCase;
  relatedCases?: ResolvedTestCase[];
  prefilledSteps?: PrefilledStep[];
  resolverMeta: {
    candidatesScanned: number;
    totalTimeMs: number;
    strategy: 'embedding' | 'hybrid' | 'name_only';
  };
}

export interface PrefilledStep {
  command: AICommand;
  sourceTestCaseId: string;
  sourceTestCaseName: string;
  stepIndex: number;
  softReplay: boolean;
}

export interface ResolverConfig {
  exactMatchThreshold: number;
  partialMatchThreshold: number;
  maxCandidates: number;
  maxPrefilledSources: number;
  timeoutMs: number;
}

// ============================================================================
// TestQueryResolver — descriptor → candidate IDs
// ============================================================================

/**
 * The kind of entity a natural-language descriptor refers to. Derived from the
 * ANALYZE prompt's `targetSelector.type` (minus 'url'/'element', which are not
 * test-collection selectors).
 */
export type QuerySelectorType = 'test_case' | 'module' | 'plan' | 'flow' | 'tag' | 'keyword';

export interface QueryCandidate {
  id: string;
  name: string;
  url?: string;
  tags?: string[];
  score: number;
}

/**
 * resolution:
 *  - 'unique'    → exactly one clear winner (`topId` set); safe to auto-use.
 *  - 'ambiguous' → several plausible candidates; caller should disambiguate
 *                  (via session context or a single ENRICH clarification).
 *  - 'none'      → nothing matched the descriptor.
 */
export interface TestQueryResult {
  candidates: QueryCandidate[];
  resolution: 'unique' | 'ambiguous' | 'none';
  topId?: string;
}
