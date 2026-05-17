---
description: Code quality checks — imports, duplicates, pre-commit
alwaysApply: true
---

# Code Quality Checks

## Import verification on refactoring

When changing exports, ALWAYS check all imports:

```bash
rg "import.*from.*changed-module" src/
```

Update imports EVERYWHERE they're used.

## No duplicates

Before creating a new file:
- Search for existing similar functionality
- Two files with similar names = likely duplicate
- Files marked "improved", "v2", "new" = delete the old one

## Pre-commit checks

```bash
npm run type-check
npm run lint
```
