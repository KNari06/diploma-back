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
