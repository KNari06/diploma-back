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
  // Cache types
  CacheKeyComponents,
  CachedSelectorResult,
  // Node types
  DOMNode,
  // Intent types
  ParsedIntent, SelectedNode,
  SelectorCandidate,
  // Request/Response types
  SelectorResolveRequest,
  SelectorResolveResponse,
  // Selector types
  SelectorType,
  // Self-healing types
  SelfHealingResult
} from './types';
