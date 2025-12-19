---
name: action-generation-prompt-selector-hardening
overview: Tighten buildActionGenerationPrompt selector rules to match actual Playwright/executor capabilities, add explicit empty selector guidance, and enforce light runtime validation (required fields + format check, no strict allowedSelectors).
todos:
  - id: prompt-selector-rules
    content: Update selector rules in `buildActionGenerationPrompt` to match runtime capabilities, add priority order (role/label/text preferred, CSS/XPath/>> also valid), and add explicit 'empty selector' guidance.
    status: completed
  - id: strict-selector-validation
    content: Enforce per-action required fields validation in `sanitizeActions()` - drop actions missing required fields (selector for click, value for fill, etc.). Validate selector format. Do NOT enforce strict allowedSelectors check.
    status: completed
  - id: action-list-alignment
    content: Align prompt's allowed actions list with `sanitizeActions` valid actions.
    status: completed
  - id: scenario-checks
    content: Run quick spot-checks (manual or minimal code-path tests) for the 3 key scenarios (empty selector, missing selector, selector not in context but valid format).
    status: completed
---

## Scope

Improve selector-related reliability in action generation by:

- Fixing misleading/incorrect selector rules in `buildActionGenerationPrompt` to match actual Playwright capabilities
- Ensuring the LLM is guided to choose only selectors we explicitly provide from context
- Adding explicit guidance for handling empty selectors
- Enforcing light runtime validation (required fields + format check, but allowing executor self-healing)

## Current call path (where it's used)

- Prompt builder: [`src/ai/prompts/intelligent-testing-prompts.ts`](src/ai/prompts/intelligent-testing-prompts.ts) `buildActionGenerationPrompt()`
- Called from: [`src/agent/contextual-action-generator.ts`](src/agent/contextual-action-generator.ts) in `generateActions()`
- Output `DynamicAction[]` is executed in: [`src/agent/intelligent-test-orchestrator.ts`](src/agent/intelligent-test-orchestrator.ts) via `convertActionToCommand()` → `CommandExecutor.executeCommand()`

## Problems to address (selector-related)

- Prompt contains rules that don't align with our runtime selector handling (e.g. claiming some formats are unsupported while the executor accepts CSS selectors).
- Prompt does not explicitly instruct what to do when a listed element has an empty selector.
- Runtime currently validates selector *format* (`validateSelectorFormat`) but does not validate required fields per action type.
- Runtime `sanitizeActions()` does not drop actions that are missing required fields for their action type (e.g. `click` without selector), which can lead to executor failures.

## Implementation plan

### 1) Update `buildActionGenerationPrompt` selector rules (prompt-only changes)

File: [`src/ai/prompts/intelligent-testing-prompts.ts`](src/ai/prompts/intelligent-testing-prompts.ts)

- Replace the "INVALID SELECTOR FORMATS" section to match `validateSelectorFormat()` in [`src/agent/utils/selector-utils.ts`](src/agent/utils/selector-utils.ts):
- Explicitly allow with priority order:
- **PREFERRED**: `role=...`, `label=...`, `text=...` (most stable, recommended by Playwright)
- **ALSO VALID**: pure CSS (`#id`, `.class`, `[data-testid="..."]`, `button[...]`), XPath (`//button `or `xpath=//button`), and `>>` for Shadow DOM (`selector1 >> selector2`)
- Keep the "no mixed CSS + role/text/label" rule, but frame it as "we only accept single-selector strings; no chained mix".
- Note: CSS/XPath/>> are supported but less stable than Playwright locators (role/label/text).
- Add an explicit rule for empty selectors:
- If "Available Elements" shows an element with empty selector (Selector: "") → check "DOM Summary" for that element's selector
- If "DOM Summary" also has empty selector → DO NOT generate action for that element (it cannot be found)
- If both are empty → skip that element and use another element from context
- ❌ NEVER output action with empty selector (unless action doesn't require selector, like "wait" or "reload")
- Tighten "STRICT FROM CONTEXT" language:
- "Selector must match EXACTLY one of the selector strings shown in 'Available Elements' or 'DOM Summary' sections."
- "❌ NEVER invent or modify selectors - use them EXACTLY as provided in context."

### 2) Add light runtime validation (drop invalid actions, no strict allowedSelectors check)

File: [`src/agent/contextual-action-generator.ts`](src/agent/contextual-action-generator.ts)

- Keep `sanitizeActions(actions: any[])` signature (no context parameter needed for light validation).
- For each returned action:
- Validate required fields per action type (strict):
- `click/fill/type/select/check/uncheck/hover/focus/blur/press/...` require a non-empty `selector`
- `goto` requires `url`
- `fill/type/select/press` require `value` where applicable
- `dragAndDrop` requires `selector` and `value` as target selector
- If `selector` exists, validate format:
- `validateSelectorFormat(selector).isValid === true` (already implemented)
- If invalid format: **drop the action** and log warning
- **DO NOT** enforce strict `allowedSelectors` check (let executor handle via self-healing if selector is valid format but not in context).
- If missing required fields or invalid format: **drop the action** and log a structured warning containing action type, selector, and reason.

### 3) Align prompt action list with what we accept

Files:

- [`src/ai/prompts/intelligent-testing-prompts.ts`](src/ai/prompts/intelligent-testing-prompts.ts)
- [`src/agent/contextual-action-generator.ts`](src/agent/contextual-action-generator.ts)
- Ensure the prompt's allowed action string list matches the `validActions` list used by `sanitizeActions()` (so the model doesn't frequently output actions we later drop).

### 4) Validate end-to-end behavior with a few targeted scenarios (no broad test suite)

- Scenario A: Vision element selector empty, DOM Summary has good selector → model must pick DOM selector, runtime must allow it.
- Scenario B: Model returns `click` without selector → runtime drops it, loop continues safely.
- Scenario C: Model returns a selector not present in context → runtime allows it if format is valid (executor will handle via self-healing if needed).

## Files expected to change

- [`src/ai/prompts/intelligent-testing-prompts.ts`](src/ai/prompts/intelligent-testing-prompts.ts)
- [`src/agent/contextual-action-generator.ts`](src/agent/contextual-action-generator.ts)
- (Optional if needed) [`src/agent/utils/selector-utils.ts`](src/agent/utils/selector-utils.ts) — only if we need additional selector-format checks.

## Implementation todos

- id: prompt-selector-rules
content: Update selector rules in `buildActionGenerationPrompt` to match runtime capabilities, add priority order (role/label/text preferred, CSS/XPath/>> also valid), and add explicit "empty selector" guidance.
- id: strict-selector-validation
content: Enforce per-action required fields validation in `sanitizeActions()` - drop actions missing required fields (selector for click, value for fill, etc.). Validate selector format. Do NOT enforce strict allowedSelectors check.
- id: action-list-alignment
content: Align prompt's allowed actions list with `sanitizeActions` valid actions.
- id: scenario-checks
content: Run quick spot-checks (manual or minimal code-path tests) for the 3 key scenarios (empty selector, missing selector, selector not in context but valid format).