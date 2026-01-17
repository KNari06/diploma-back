# 🚀 Future Enhancements & Ideas

## ✅ Completed

### Visual Anchors (Manus Style)
- **Status**: ✅ IMPLEMENTED (2026-01-16)
- **What**: Spatial-based element lookup for sites with dynamic IDs/classes
- **Files**: `visual-anchor-manager.ts`, `lite-types.ts`, `snapshot-collector.ts`, `action-executor.ts`, `lite-state.ts`
- **Impact**: Handles Facebook, Google Ads, and SPA frameworks with obfuscated selectors

### Z-Index Awareness
- **Status**: ✅ IMPLEMENTED (2026-01-16)
- **What**: Prioritize elements with higher z-index (overlays, modals)
- **Files**: `snapshot-collector.ts`, `hybrid-semantic-weight.ts`
- **Impact**: Better handling of complex UIs with modals and overlays

---

## 📍 Priority: High Impact / Low Effort

### Multi-Language Support (Manus Style)
- **Status**: Concept approved
- **What**: Implement `MultiLangProcessor` for 3-level localization strategy
- **Why**: Better support for non-EN/RU sites (DE, ES, CN)
- **Impact**: Handles 100+ languages efficiently without hardcoding
- **Effort**: ~30 minutes
- **Implementation**:
  - Auto-detect `<html lang>` from page
  - Universal Anchors (HTML semantics) as Level 1
  - Dynamic Dictionary (LLM pre-parsing) as Level 2
  - Language plugins (stemming) as Level 3

### Context Scoring (Element Depth)
- **Status**: Concept approved
- **What**: Boost modal/dialog elements, penalize footer elements
- **Why**: Buttons in modals are more important than footer links
- **Impact**: Fewer clicks on irrelevant elements
- **Effort**: ~15 minutes
- **Example**: Modal boost = weight * 1.5

## 📍 Priority: Medium Impact / Medium Effort

### Coordinate Action (L5) with Visual Re-sync
- **Status**: Future feature
- **What**: Implement coordinate-based clicking with visual patch/area validation before click
- **Why**: For cases where coordinate clicking is needed, we need to verify the visual area matches expected state
- **Impact**: Enables reliable coordinate actions with safety checks
- **Effort**: ~2-3 hours
- **Details**:
  - Visual Re-sync: Check patch/area before coordinate click
  - Level L5 "coordinate action" feature
  - Currently not implemented

### AI Goal Map (Pre-test Intelligence)
- **Status**: Concept approved
- **What**: Use small AI model at test start to generate goal-specific "importance map"
- **Why**: Better than static heuristics for complex goals
- **Impact**: Reduces AI calls during test execution
- **Effort**: ~1 hour
- **Trade-offs**: +500-1000ms latency, +1 AI call per test

### Stemming Cache Optimization
- **Status**: Concept approved
- **What**: Add `Map<string, string>` for memoization of stemmed words
- **Why**: Words like "login" get stemmed 50+ times per test
- **Impact**: 5-10% performance boost
- **Effort**: ~10 minutes

## 📍 Priority: Low Impact / High Effort

### External Stemmer Library
- **Status**: Research needed
- **What**: Replace custom stemming with proven algorithms (Porter for EN, Snowball for RU)
- **Why**: Better accuracy for edge cases
- **Impact**: Marginal improvement in matching
- **Effort**: ~2 hours
- **Trade-offs**: Additional dependency, bundle size increase

### Semantic Rules in JSON
- **Status**: Over-engineering (declined)
- **What**: Move keyword lists to `semantic-rules.json`
- **Why**: Update without rebuild
- **Impact**: None for current scale
- **Effort**: ~1 hour
- **Trade-offs**: Lose TypeScript type safety

### A/B Testing Framework for Heuristics
- **Status**: Nice-to-have
- **What**: Compare different heuristic rules in production
- **Why**: Data-driven optimization
- **Impact**: Continuous improvement
- **Effort**: ~4 hours

## 📍 Research & Experiments

### Network-Aware State Validation
- **Idea**: Use successful API calls as "progress indicators" even without visual changes
- **Current**: Basic implementation exists
- **Potential**: Smart filtering of analytics/blacklist domains

### UI Framework Detection
- **Idea**: Auto-detect React/Angular/Vue components and apply framework-specific rules
- **Potential**: Better element classification for complex SPAs

---

## 🔄 Status Legend
- **Concept approved**: Ready for implementation when time allows
- **Research needed**: Need to investigate feasibility first
- **Over-engineering**: Not worth effort at current scale
- **Nice-to-have**: Good idea but not urgent

## 📝 Last Updated: 2026-01-18
