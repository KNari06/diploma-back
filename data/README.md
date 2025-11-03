# Data Directory

Локальное хранилище для Global Knowledge Base.

## Structure

```
data/
└── global-kb/
    ├── sources/           - Markdown source files
    │   ├── qa-testing-basics.md
    │   ├── api-testing-guide.md
    │   └── playwright-testing.md
    └── embeddings.json    - Pre-computed embeddings (commit to Git)
```

## Usage

### 1. Add new knowledge

Создай markdown файл в `sources/`:
```bash
touch data/global-kb/sources/new-guide.md
```

### 2. Rebuild embeddings

```bash
npm run build-kb
```

### 3. Commit

```bash
git add data/global-kb/
git commit -m "docs: update global KB"
```

## Current KB Stats

- **Files:** 3
- **Chunks:** 80
- **Size:** 2.52 MB
- **Model:** text-embedding-3-small (1536 dimensions)

## Topics Covered

- QA Testing basics
- API testing (GET, POST, PUT, DELETE)
- Playwright automation
- UI testing best practices
- Error handling
- Performance testing
- Authentication testing

## Notes

- `embeddings.json` is committed to Git (pre-computed for fast startup)
- Changes to sources require running `npm run build-kb`
- KB loads into memory on server startup (fast search)
- No database queries needed for global KB (local file system)
