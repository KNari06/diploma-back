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
  /** High-quality model for complex reasoning, auditing, vision. Default: gpt-4o */
  smart: env.OPENAI_MODEL || 'gpt-4o',

  /** Fast/cheap model for classification, extraction, disambiguation. Default: gpt-4o-mini */
  fast: env.OPENAI_MODEL_FAST || 'gpt-4o-mini',

  /** Vision-capable model for screenshot analysis. Default: gpt-4o */
  vision: env.OPENAI_MODEL || 'gpt-4o',
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
  /** LLM disambiguation when multiple candidates match */
  disambiguation: AI_MODELS.fast,
  /** Intent step linting (element resolution) */
  intentLint: AI_MODELS.fast,
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
  /** Vision-based element resolution (Gemini multimodal, screenshot + DOM) */
  visionElementResolution: 'gemini-2.0-flash-exp' as const,
  /** Post-healing visual verification (Gemini multimodal, confirm correct element) */
  healingVerification: 'gemini-2.0-flash-exp' as const,

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
  /** Semantic weight classification */
  semanticWeight: AI_MODELS.fast,
  /** AI helpers (generic) */
  helpers: AI_MODELS.fast,
  /** Credit calculations */
  creditDefault: AI_MODELS.fast,
} as const;
