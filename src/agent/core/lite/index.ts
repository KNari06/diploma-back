/**
 * Lite Engine Exports
 * Central export point for all Lite Engine components
 */

// Main engine
export { LiteEngine } from './lite-engine';
export { LiteState } from './lite-state';
export { ModeRouter } from './mode-router';
export type { TestMode } from './mode-router';

// Types
export type {
  LiteElement,
  LiteSnapshot,
  StateDiff,
  ActionOutcome,
  ExecutionResult,
  StuckCheck,
  AICommand,
  AIDecision,
  LiteTestResult,
  LiteEngineConfig,
  IterationRecord,
  ElementInfo,
  CollectedError,
  // NEW: Goal detection types
  GoalContext,
  GoalEval,
  GoalGuidance,
} from './lite-types';

// Collectors
export { SnapshotCollector } from './collectors/snapshot-collector';
export { NetworkTracker } from './collectors/network-tracker';
export type { NetworkError } from './collectors/network-tracker';
export { ConsoleCollector } from './collectors/console-collector';
export { ErrorCollector } from './collectors/error-collector';
export type { UIError } from './collectors/error-collector';
export { ScreenshotCollector } from './collectors/screenshot-collector';
export { VisualStability } from './collectors/visual-stability';

// Analysis
export { GoalDetector } from './analysis/goal-detector';
export type { GoalDetectionResult, GoalSignal } from './analysis/goal-detector';
export { AIGoalEvaluator, buildSnapshotSummary } from './analysis/ai-goal-evaluator';
export { StateDiffComputer } from './analysis/state-diff';
export { StateValidator } from './analysis/state-validator';

// Execution
export { ActionExecutor } from './execution/action-executor';
export { ShadowDOMHandler } from './execution/shadow-dom-handler';

// Prompt
export { LitePromptBuilder } from './prompt/lite-prompt-builder';
