/**
 * API Agent Policy
 * Level policies (LIGHT/MEDIUM/HARD) with budget defaults and safety gates
 */

import type {
  ApiAgentLevel,
  ApiAgentLevelPolicy,
  ApiAgentBudget,
  SafetyGateContext,
  SafetyGateResult,
  ApiAgentStepType,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT BUDGETS PER LEVEL
// ═══════════════════════════════════════════════════════════════════════════

const LIGHT_BUDGET: ApiAgentBudget = {
  maxSteps: 8,
  maxSeconds: 60,
  maxAiTokens: 5000,
  maxEndpointsConsidered: 1,
};

const MEDIUM_BUDGET: ApiAgentBudget = {
  maxSteps: 20,
  maxSeconds: 180,
  maxAiTokens: 15000,
  maxEndpointsConsidered: 5,
};

const HARD_BUDGET: ApiAgentBudget = {
  maxSteps: 35,
  maxSeconds: 300,
  maxAiTokens: 30000,
  maxEndpointsConsidered: 5,
};

// ═══════════════════════════════════════════════════════════════════════════
// LEVEL POLICIES
// ═══════════════════════════════════════════════════════════════════════════

const LEVEL_POLICIES: Record<ApiAgentLevel, ApiAgentLevelPolicy> = {
  light: {
    level: 'light',
    budget: LIGHT_BUDGET,
    baselineCredits: 2,
    noveltyStopThreshold: 0.5, // Higher threshold = stops sooner
    allowMutations: false,
    allowFuzzing: false,
    allowRaceProbing: false,
    maxRetryOnHighRisk: 0,
  },
  medium: {
    level: 'medium',
    budget: MEDIUM_BUDGET,
    baselineCredits: 6,
    noveltyStopThreshold: 0.3,
    allowMutations: true, // With safety gates
    allowFuzzing: false,
    allowRaceProbing: false,
    maxRetryOnHighRisk: 0,
  },
  hard: {
    level: 'hard',
    budget: HARD_BUDGET,
    baselineCredits: 12,
    noveltyStopThreshold: 0.1, // Very low = explores more
    allowMutations: true,
    allowFuzzing: true,
    allowRaceProbing: true, // With safety gates
    // Requirement: re-attack 3–5 times total → use up to 4 retries + 1 initial = 5 attempts
    maxRetryOnHighRisk: 4,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// POLICY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get policy for a level
 */
export function getPolicy(level: ApiAgentLevel): ApiAgentLevelPolicy {
  return LEVEL_POLICIES[level];
}

/**
 * Get policy with optional budget overrides
 */
export function getPolicyWithOverrides(
  level: ApiAgentLevel,
  budgetOverrides?: Partial<ApiAgentBudget>
): ApiAgentLevelPolicy {
  const basePolicy = LEVEL_POLICIES[level];

  if (!budgetOverrides) {
    return basePolicy;
  }

  return {
    ...basePolicy,
    budget: {
      ...basePolicy.budget,
      ...budgetOverrides,
    },
  };
}

/**
 * Validate that a level is valid
 */
export function isValidLevel(level: string): level is ApiAgentLevel {
  return level === 'light' || level === 'medium' || level === 'hard';
}

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY GATES
// ═══════════════════════════════════════════════════════════════════════════

/** Patterns that suggest production environment */
const PRODUCTION_PATTERNS = [
  /^(www\.)?[a-z0-9-]+\.(com|org|net|io|co)$/i, // Simple TLD without subdomain prefixes
  /prod/i,
  /production/i,
  /live/i,
  /api\.[a-z0-9-]+\.(com|org|net|io|co)$/i, // api.example.com
];

/** Patterns that suggest safe/test environment */
const SAFE_ENVIRONMENT_PATTERNS = [
  /localhost/i,
  /127\.0\.0\.1/,
  /staging/i,
  /sandbox/i,
  /test/i,
  /dev/i,
  /preview/i,
  /demo/i,
  /mock/i,
  /fake/i,
];

/** Mutation methods */
const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Step types that require mutation capability */
const MUTATION_STEP_TYPES: ApiAgentStepType[] = [
  'crud_chain',
  'race_probe',
];

/** Step types that require fuzzing capability */
const FUZZING_STEP_TYPES: ApiAgentStepType[] = [
  'fuzzing',
  'auth_bypass',
];

/**
 * Check if URL looks like production
 */
function looksLikeProduction(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    // Check safe patterns first
    for (const pattern of SAFE_ENVIRONMENT_PATTERNS) {
      if (pattern.test(hostname)) {
        return false; // Safe environment
      }
    }

    // Check production patterns
    for (const pattern of PRODUCTION_PATTERNS) {
      if (pattern.test(hostname)) {
        return true; // Looks like production
      }
    }

    return false; // Default: not production
  } catch {
    return true; // If URL parsing fails, be conservative
  }
}

/**
 * Check safety gate for a planned step
 * Returns whether the step is allowed and why if not
 */
export function checkSafetyGate(context: SafetyGateContext): SafetyGateResult {
  const { url, method, stepType, policy } = context;

  // Gate 1: SSRF protection (always enforced, inherited from executeApiTest)
  // This is handled at execution level, not here

  // Gate 2: Mutation methods on production-looking hosts
  if (MUTATION_METHODS.includes(method.toUpperCase())) {
    if (!policy.allowMutations) {
      return {
        allowed: false,
        reason: `Mutation methods (${method}) not allowed in ${policy.level} level`,
        skippedAction: `${method} ${url}`,
      };
    }

    // Extra caution: skip mutations on production-looking hosts in MEDIUM
    if (policy.level === 'medium' && looksLikeProduction(url)) {
      return {
        allowed: false,
        reason: `Mutation methods skipped on production-looking host in MEDIUM level`,
        skippedAction: `${method} ${url} (host looks like production)`,
      };
    }
  }

  // Gate 3: Mutation step types
  if (MUTATION_STEP_TYPES.includes(stepType)) {
    if (!policy.allowMutations) {
      return {
        allowed: false,
        reason: `Step type ${stepType} requires mutation capability (not in ${policy.level})`,
        skippedAction: stepType,
      };
    }
  }

  // Gate 4: Fuzzing step types
  if (FUZZING_STEP_TYPES.includes(stepType)) {
    if (!policy.allowFuzzing) {
      return {
        allowed: false,
        reason: `Step type ${stepType} requires fuzzing capability (not in ${policy.level})`,
        skippedAction: stepType,
      };
    }
  }

  // Gate 5: Race probing
  if (stepType === 'race_probe') {
    if (!policy.allowRaceProbing) {
      return {
        allowed: false,
        reason: `Race probing not allowed in ${policy.level} level`,
        skippedAction: 'race_probe',
      };
    }

    // Even in HARD, skip race probing on production
    if (looksLikeProduction(url)) {
      return {
        allowed: false,
        reason: 'Race probing skipped on production-looking host',
        skippedAction: `race_probe on ${url}`,
      };
    }
  }

  // All gates passed
  return { allowed: true };
}

/**
 * Get list of step types allowed for a level
 */
export function getAllowedStepTypes(level: ApiAgentLevel): ApiAgentStepType[] {
  const base: ApiAgentStepType[] = [
    'happy_path',
    'method_contract',
    'schema_validation',
  ];

  if (level === 'light') {
    return base;
  }

  const medium: ApiAgentStepType[] = [
    ...base,
    'negative_case',
    'crud_chain',
    'consistency_check',
    'retry_on_error',
  ];

  if (level === 'medium') {
    return medium;
  }

  // HARD
  return [
    ...medium,
    'fuzzing',
    'auth_bypass',
    'race_probe',
  ];
}

/**
 * Get baseline credits for a level
 */
export function getBaselineCredits(level: ApiAgentLevel): number {
  return LEVEL_POLICIES[level].baselineCredits;
}
