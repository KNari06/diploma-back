/**
 * Centralized AI Model Configuration
 *
 * All AI model selections should reference this config instead of hardcoding model strings.
 * Override via environment variables for different deployments.
 *
 * Architecture:
 * - "smart" models: expensive, high-quality (auditing, vision, complex reasoning)
 * - "fast" models: cheap, quick (classification, extraction, disambiguation)
 *
 * Usage:
 *   import { AI_MODELS } from '@/config/ai/ai-models.config';
 *   const result = await openai.chat({ model: AI_MODELS.fast, ... });
 */

import { env } from '@/config/environment/env';

// ═══════════════════════════════════════════════════════════════════════════
// CORE MODEL ALIASES (override via env vars)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Core model aliases — the two models used across the entire system.
 * Every AI call should use one of these instead of a hardcoded string.
 */
export const AI_MODELS = {
  /** High-quality model for complex reasoning, auditing, vision. Default: gpt-5.4-mini */
  smart: env.OPENAI_MODEL || 'gpt-5.4-mini',

  /** Fast/cheap model for classification, extraction, disambiguation. Default: gpt-5.4-mini */
  fast: env.OPENAI_MODEL_FAST || 'gpt-5.4-mini',

  /** Vision-capable model for screenshot analysis. Default: gpt-5.4-mini */
  vision: env.OPENAI_MODEL || 'gpt-5.4-mini',

  /**
   * Classification / extraction model for the Allure import pipeline (file
   * classification, KB preprocessing, step conversion, CSV/PDF parsing).
   *
   * Now gpt-5.4-mini, matching `smart`/`vision`: extraction tasks (step
   * conversion, PDF parsing) get noticeably better action-type inference, which
   * directly reduces degraded imports. Resolves via `OPENAI_MODEL` (NOT
   * `OPENAI_MODEL_FAST`, whose env default is still gpt-4.1-mini and would
   * silently pin this back to the old model).
   */
  classify: env.OPENAI_MODEL || 'gpt-5.4-mini',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TASK-SPECIFIC MODEL SELECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task-specific model map.
 * Services should import the task they need:
 *   import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
 *   model: AI_TASK_MODELS.disambiguation
 */
export const AI_TASK_MODELS = {
  // ── Editor Mode / Preview ──────────────────────────────────────────────
  /**
   * LLM disambiguation when multiple candidates match.
   * Gemini 2.5 Flash Lite: non-reasoning model → predictable ~300-800ms latency,
   * strong multilingual support (critical — intents come in RU/EN/KZ/CN/etc),
   * cheap ($0.10 input / $0.40 output per 1M). Picked over gpt-5.x because the
   * latter's hidden chain-of-thought made latency swing 1.5s..7s on identical
   * prompts, causing Find-by-description to time out on first click.
   */
  disambiguation: 'gemini-2.5-flash-lite' as const,
  /**
   * Intent step linting — clarification messages (NOT element selection).
   *
   * V23 (April 2026): switched from gpt-5.4-mini to gemini-2.5-flash-lite for
   * the same reason as `disambiguation`: gpt's hidden chain-of-thought made
   * lint latency unpredictable (1.5-14s observed in production logs on the
   * "Find using desc." button), causing the LLM circuit breaker to open and
   * masking real errors. gemini-flash-lite gives predictable 300-800ms,
   * native JSON mode, and equal-or-better multilingual handling for the
   * RU/KZ/EN clarification copy this prompt produces. Element SELECTION
   * (where reasoning matters) stays on the smarter model via the
   * disambiguation path; this slot is only ever asked to translate a
   * scenario classification into a localized one-sentence message.
   */
  intentLint: 'gemini-2.5-flash-lite' as const,
  /**
   * Stable-token extraction from UI labels for LocatorPlanBuilder.
   * Same reasoning as `disambiguation` / `intentLint`: predictable sub-second
   * latency + native JSON mode + multilingual (RU/KZ/EN/CN) matter more than
   * raw quality for this deterministic text-in/text-out preprocessing step.
   * temp=0 → same input must produce same tokens, otherwise compiled plans
   * drift between recordings of the same step.
   */
  stableTokens: 'gemini-2.5-flash-lite' as const,
  /**
   * Etap 1D.3 — Recorded element description.
   * Generates a short NL description of the clicked element ("the Save
   * button inside the user profile modal") at recording time. Fed to
   * the LLM resolver at replay as a 3rd channel alongside fingerprint
   * and snapshot. Same flash-lite tier as stableTokens — sub-second,
   * multilingual (RU/KZ/EN), cheap, and the task is short text-in/
   * text-out at temp=0.2 (slight creativity helps phrasing without
   * sacrificing determinism).
   */
  recordedDescription: 'gemini-2.5-flash-lite' as const,
  /**
   * Background editor Observer (observer.service.ts) — proactive hint
   * classifier (login_required / step_missing / blocked / wrong_page / none).
   * Same flash-lite tier as the other preview classifiers: it runs off the hot
   * path on every meaningful editor event, so predictable sub-second latency +
   * native JSON mode + multilingual matter more than raw quality. temp=0 for a
   * stable verdict given the same page+steps signature (drives the verdict cache).
   */
  observer: 'gemini-2.5-flash-lite' as const,
  /** AI check assertion evaluation */
  aiCheck: AI_MODELS.fast,
  /** AI check with screenshot (needs vision) */
  aiCheckVision: AI_MODELS.vision,
  /** Enter key detection after input */
  enterDetection: AI_MODELS.fast,

  // ── Self-Healing & Selectors ───────────────────────────────────────────
  /** Self-healing selector repair */
  selfHealing: AI_MODELS.fast,
  /** AI selector engine resolution */
  selectorResolution: AI_MODELS.fast,
  /** Intent parsing (NL → structured command) */
  intentParsing: AI_MODELS.fast,
  /**
   * Yes/no/other confirmation classification (e.g. "do you want to start
   * exploration?"). Gemini Flash for speed, native JSON, multilingual.
   */
  confirmationClassification: 'gemini-2.5-flash' as const,
  // ── API Flow Testing ───────────────────────────────────────────────
  /** API Flow Analyst — domain analysis from spec (needs large context for 1000+ endpoints) */
  apiFlowAnalyst: 'gemini-2.5-flash' as const,
  /** API Flow Architect — DAG building from analysis + endpoints */
  apiFlowArchitect: 'gemini-2.5-flash' as const,
  /** API Flow Enricher — realistic test data generation */
  apiFlowEnricher: 'gemini-2.5-flash' as const,

  /** Vision-based element resolution (Gemini multimodal, screenshot + DOM) */
  visionElementResolution: 'gemini-2.5-flash' as const,
  /** Post-healing visual verification (Gemini multimodal, confirm correct element) */
  healingVerification: 'gemini-2.5-flash' as const,

  // ── Lite Engine / Test Orchestration ───────────────────────────────────
  /** Core brain for Lite engine decision making */
  coreBrain: AI_MODELS.smart,
  /** Goal auditor (final validation) */
  goalAuditor: AI_MODELS.smart,
  /** Strategy generation */
  strategy: AI_MODELS.fast,
  /** Goal detection & expansion */
  goalDetection: AI_MODELS.fast,
  /** Target audit checks */
  targetAudit: AI_MODELS.fast,
  /** Task plan building */
  taskPlanning: AI_MODELS.fast,
  /** Pre-LLM snapshot pruner (fast context-aware element filter) */
  snapshotPruning: AI_MODELS.fast,

  // ── Analysis ───────────────────────────────────────────────────────────
  /** Page analysis with vision */
  pageAnalysisVision: AI_MODELS.vision,
  /** Fast element analysis */
  elementAnalysis: AI_MODELS.fast,
  /** Pre/post action analysis */
  actionAnalysis: AI_MODELS.fast,
  /** Form intelligence (type/dependency/error detection) */
  formIntelligence: AI_MODELS.fast,
  /** Contextual action generation */
  actionGeneration: AI_MODELS.smart,
  /** Cost-efficient action generation */
  actionGenerationFast: AI_MODELS.fast,

  // ── Chat & Agents ─────────────────────────────────────────────────────
  /** Chat message routing */
  chatRouter: AI_MODELS.fast,
  /** Tool orchestration planning */
  chatPlanner: AI_MODELS.smart,
  /** Tool execution */
  chatExecutor: AI_MODELS.smart,
  /** Response generation */
  chatResponder: AI_MODELS.fast,
  /** Pipeline reviewer (goal verification, double-blind) */
  chatReviewer: AI_MODELS.fast,
  /** Sub-executor (parallel step execution) */
  chatSubExecutor: AI_MODELS.fast,

  // ── Services ──────────────────────────────────────────────────────────
  /** Test failure analysis */
  failureAnalysis: AI_MODELS.fast,
  /**
   * Retry gate — classifies test failures as infra (retryable) vs product-bug /
   * test-issue (not retryable). Runs BEFORE a retry attempt to avoid wasted
   * reruns that hide real bugs. Must be fast; 3s hard timeout.
   * Uses Gemini 2.5 Flash for speed + native JSON mode.
   */
  retryClassification: 'gemini-2.5-flash' as const,
  /** Coverage analysis */
  coverageAnalysis: AI_MODELS.fast,
  /** Test recommendations */
  testRecommendation: AI_MODELS.fast,
  /** Dependency suggestion */
  dependencySuggestion: AI_MODELS.fast,
  /** Data extraction */
  dataExtraction: AI_MODELS.fast,
  /** Chat summarization */
  summarization: AI_MODELS.fast,
  /** Question generation */
  questionGeneration: AI_MODELS.fast,
  /** Knowledge base queries */
  knowledgeBase: AI_MODELS.fast,
  /** Skill suggestion */
  skillSuggestion: AI_MODELS.fast,
  /** Vision analysis */
  visionAnalysis: AI_MODELS.vision,
  /** URL analysis */
  urlAnalysis: AI_MODELS.fast,
  /** Scope strategy */
  scopeStrategy: AI_MODELS.fast,
  /** Navigation analysis */
  navigationAnalysis: AI_MODELS.fast,
  /** API agent planning */
  apiAgentPlanning: AI_MODELS.fast,
  /** API expectation generation */
  apiExpectation: AI_MODELS.fast,
  /** Test case resolution */
  testCaseResolution: AI_MODELS.fast,
  /** Test visualization */
  testVisualization: AI_MODELS.fast,
  /** AI helpers (generic) */
  helpers: AI_MODELS.fast,
  /** Credit calculations */
  creditDefault: AI_MODELS.fast,

  // ── Allure Import Pipeline ─────────────────────────────────────────────
  /**
   * Classifies ambiguous files inside an Allure ZIP.
   * Receives up to 2000 chars of file content and returns category + summary.
   */
  allureClassify: AI_MODELS.classify,
  /**
   * Preprocesses documentation before KB ingestion.
   * Strips HTML/noise, summarises logs, extracts useful content.
   */
  allurePreprocess: AI_MODELS.classify,
  /**
   * Converts Allure test steps into platform IntentSteps.
   * Understands UI action context, splits composite steps, filters non-UI steps.
   */
  allureStepConvert: AI_MODELS.classify,
  /**
   * Parses structured test case data from Allure TestOps CSV rows or PDF text.
   * Handles column mapping, scenario parsing, hierarchy resolution, step conversion.
   */
  allureCsvPdfParse: AI_MODELS.classify,
} as const;
