/**
 * API Agent Policy
 * Level policies (LIGHT/MEDIUM/HARD) with budget defaults and safety gates
 */

import type {
  ApiAgentBudget,
  ApiAgentLevel,
  ApiAgentLevelPolicy,
  ApiAgentStepType,
  SafetyGateContext,
  SafetyGateResult,
  ExecutionProfile,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT BUDGETS PER LEVEL
// ═══════════════════════════════════════════════════════════════════════════

const LIGHT_BUDGET: ApiAgentBudget = {
  maxSteps: 8,
  maxSeconds: 60,
  maxAiTokens: 15000,
  maxEndpointsConsidered: 1,
  maxRequests: 20,
};

const MEDIUM_BUDGET: ApiAgentBudget = {
  maxSteps: 20,
  maxSeconds: 180,
  maxAiTokens: 35000,
  maxEndpointsConsidered: 5,
  maxRequests: 60,
};

const HARD_BUDGET: ApiAgentBudget = {
  maxSteps: 35,
  maxSeconds: 300,
  maxAiTokens: 50000,
  maxEndpointsConsidered: 5,
  maxRequests: 120,
};

/** Hard cap for prod_readonly to prevent request sprawl */
export const PROD_READONLY_MAX_REQUESTS = 30;

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
 * @param url - URL to analyze
 * @returns true if URL appears to be a production environment
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
 * Infer execution profile from URL if not explicitly provided.
 * Production-looking URLs get 'prod_readonly', others get 'nonprod'.
 * @param url - Target URL to analyze
 * @param explicitProfile - Optional explicit profile override
 * @returns The effective execution profile
 */
export function inferExecutionProfile(
  url: string,
  explicitProfile?: ExecutionProfile
): ExecutionProfile {
  if (explicitProfile) {
    return explicitProfile;
  }
  return looksLikeProduction(url) ? 'prod_readonly' : 'nonprod';
}

/**
 * Check safety gate for a planned step.
 * Enforces execution profile constraints (prod_readonly blocks all mutations).
 * Returns whether the step is allowed and why if not.
 * @param context - Safety gate context with URL, method, step type, policy, and profile
 * @returns SafetyGateResult indicating if action is allowed
 */
export function checkSafetyGate(context: SafetyGateContext): SafetyGateResult {
  const { url, method, stepType, policy, executionProfile } = context;

  // Determine effective profile (explicit or inferred)
  const profile = inferExecutionProfile(url, executionProfile);

  // Gate 0: SSRF protection (always enforced, inherited from executeApiTest)
  // This is handled at execution level, not here

  // ═══════════════════════════════════════════════════════════════════════════
  // PROD_READONLY STRICT GATES (override all other logic)
  // ═══════════════════════════════════════════════════════════════════════════
  if (profile === 'prod_readonly') {
    // Block ALL mutation methods in prod_readonly (except method_contract probing)
    if (MUTATION_METHODS.includes(method.toUpperCase())) {
      // method_contract is allowed because it expects 405/4xx (read-only intent)
      if (stepType !== 'method_contract') {
        return {
          allowed: false,
          reason: `Mutation method ${method} blocked in prod_readonly profile`,
          skippedAction: `${method} ${url} (prod_readonly)`,
        };
      }
    }

    // Block mutation step types entirely in prod_readonly
    if (MUTATION_STEP_TYPES.includes(stepType)) {
      return {
        allowed: false,
        reason: `Step type ${stepType} blocked in prod_readonly profile (requires mutations)`,
        skippedAction: stepType,
      };
    }

    // Block race_probe entirely in prod_readonly
    if (stepType === 'race_probe') {
      return {
        allowed: false,
        reason: 'Race probing blocked in prod_readonly profile',
        skippedAction: 'race_probe',
      };
    }

    // Fuzzing allowed in prod_readonly but with safe subset (enforced elsewhere via config)
    // We allow the step type, the executor will use prod_readonly limits
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STANDARD POLICY GATES (nonprod or fallback)
  // ═══════════════════════════════════════════════════════════════════════════

  // Gate 1: Mutation methods based on policy
  if (MUTATION_METHODS.includes(method.toUpperCase())) {
    // Method contract probing is allowed at all levels (it is designed to expect 405/4xx).
    if (stepType === 'method_contract') {
      return { allowed: true };
    }

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

  // Gate 2: Mutation step types
  if (MUTATION_STEP_TYPES.includes(stepType)) {
    if (!policy.allowMutations) {
      return {
        allowed: false,
        reason: `Step type ${stepType} requires mutation capability (not in ${policy.level})`,
        skippedAction: stepType,
      };
    }
  }

  // Gate 3: Fuzzing step types
  if (FUZZING_STEP_TYPES.includes(stepType)) {
    if (!policy.allowFuzzing) {
      return {
        allowed: false,
        reason: `Step type ${stepType} requires fuzzing capability (not in ${policy.level})`,
        skippedAction: stepType,
      };
    }
  }

  // Gate 4: Race probing
  if (stepType === 'race_probe') {
    if (!policy.allowRaceProbing) {
      return {
        allowed: false,
        reason: `Race probing not allowed in ${policy.level} level`,
        skippedAction: 'race_probe',
      };
    }

    // Even in HARD nonprod, skip race probing on production-looking hosts
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
 * Get list of step types allowed for a level.
 * HARD level includes expanded read-only security checks.
 * @param level - API agent level (light/medium/hard)
 * @returns Array of allowed step types for the level
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

  // HARD: includes all medium steps + security-focused read-only checks
  return [
    ...medium,
    'fuzzing',
    'auth_bypass',
    'race_probe',
    // New read-only HARD step types for deeper coverage
    'auth_matrix',           // Systematic auth header variations
    'idor_probe',            // Synthetic invalid IDs for IDOR detection
    'header_security_check', // Validate security headers
    'rate_limit_probe_safe', // Safe rate limit detection
    'error_leak_check',      // Detect error/debug info leaks
    'content_negotiation',   // Accept header variants
  ];
}

/**
 * Get baseline credits for a level
 */
export function getBaselineCredits(level: ApiAgentLevel): number {
  return LEVEL_POLICIES[level].baselineCredits;
}
