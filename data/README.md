# Data Directory

Local storage for the Global Knowledge Base (KB v2).

## Structure

```
data/global-kb/
├── en/
│   ├── qait-platform/     - What QAIT is and what it does
│   ├── playwright-2026/   - Modern browser automation patterns
│   ├── recipes/           - Copy-pasteable working patterns
│   ├── antipatterns/      - "Do not do X because Y" cards
│   └── troubleshooting/   - Symptom → cause → fix
└── embeddings.json        - Pre-computed embeddings (commit to Git)
```

## Usage

### Add new knowledge

Create a markdown file in the appropriate folder:

```bash
touch data/global-kb/en/recipes/new-pattern.md
```

Keep each file focused on one topic. Shorter files produce better retrieval.

### Rebuild embeddings

```bash
npm run build-kb
```

This regenerates `embeddings.json` from every markdown file under `data/global-kb/en/`.

### Commit

```bash
git add data/global-kb/
git commit -m "docs: update global KB"
```

## Conventions

- **One topic per file** — small, focused files retrieve better than long ones
- **Header-based structure** — chunker splits on `##` so use clear headings
- **English only** — AI translates at runtime; translated source duplicates the index without quality lift
- **No intent classifier data** — those belong under `src/ai/training/`, not in KB
- **No generic "what is testing" content** — KB is for QAIT-specific and modern best-practice content

## Current KB scope

- QAIT platform capabilities, integrations, safety model
- Modern Playwright patterns (getByRole, web-first assertions, locator handler, test structure)
- Recipes: login storageState, wait for API, modal handling, file upload fallback, flaky diagnosis
- Antipatterns: avoid waitForTimeout, networkidle, raw CDP, silent WS returns
- Troubleshooting: click intercepted, element not found, timeout errors

## Notes

- `embeddings.json` is committed to Git (pre-computed for fast startup)
- Changes to source files require running `npm run build-kb`
- KB loads into memory on server startup; search is in-process (no DB hop for global KB)
- Project-specific KB (user-uploaded docs) lives in Supabase `project_kb_chunks` and is per-project
