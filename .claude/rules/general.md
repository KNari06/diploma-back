---
description: Core project rules — style, safety, communication
alwaysApply: true
---

# General Rules

- Answer concisely, 1-3 bullet points when possible.
- Save tokens: no filler, no extra examples, only what's needed.
- Naming/structure/types: strictly consistent.
- Comments and variables: English only.
- Answer in the language of the question.

## DO NOT without explicit permission

- **Documentation**: NEVER create `.md`/docs/reports without explicit permission. Ask first.
- **Deploy**: NEVER deploy without explicit permission. Run pre-deploy checks first.
- **Git**: NEVER commit without explicit request. NEVER force push to main/master. NEVER modify git config.

## Documentation (only after permission)

- Documentation goes in `/docs/` only.
- Index: `/docs/README.md` (update on additions).
- Folders: `/docs/api/`, `/docs/development/`, `/docs/architecture/`, `/docs/contributing/`, `/docs/rules/`.

## Security

- Never hardcode keys/tokens — use `process.env`.
- Never log sensitive data (debug level only).
- Validate input before API calls.

## Pre-deploy checks (when deploy is approved)

```bash
npm run type-check
npm run lint
```

## Production bug procedure

1. EXIT the server — never fix on prod directly.
2. Reproduce locally — `npm run dev` and test.
3. Fix and test — verify the fix works.
4. Deploy — only after local verification.
