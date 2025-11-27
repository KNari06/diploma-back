/**
 * AI Selector Engine
 * Intent-based adaptive selector resolution
 *
 * Export all public APIs
 */

export { AISelectorEngine } from './ai-selector-engine.service';
export { DOMNodeExtractor } from './dom-node-extractor';
export { IntentParserService } from './intent-parser.service';
export { SelectorCacheService } from './selector-cache.service';

export type {
  // Request/Response types
  SelectorResolveRequest,
  SelectorResolveResponse,
  // Node types
  DOMNode,
  SelectedNode,
  SelectorCandidate,
  // Intent types
  ParsedIntent,
  // Selector types
  SelectorType,
  // Self-healing types
  SelfHealingResult,
  // Cache types
  CacheKeyComponents,
  CachedSelectorResult,
} from './types';
