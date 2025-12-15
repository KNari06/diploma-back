---
name: Features Documentation Site
overview: Создание мини фронт-сайта документации в /docs/features с автоматическим обновлением диаграмм при изменении кода
todos:
  - id: setup-structure
    content: Создать структуру папок /docs/features с подпапками для каждой фичи
    status: completed
  - id: create-main-page
    content: Создать главную страницу index.html с навигацией и поиском
    status: completed
    dependencies:
      - setup-structure
  - id: create-feature-template
    content: Создать шаблон страницы фичи с секциями (overview, diagram, methods, changelog)
    status: completed
    dependencies:
      - setup-structure
  - id: migrate-intelligent-testing
    content: Перенести и адаптировать существующую HTML страницу intelligent-testing в новую структуру
    status: completed
    dependencies:
      - create-feature-template
  - id: create-ast-parser
    content: Создать AST парсер для TypeScript (scripts/generate-diagrams.js) для извлечения методов и связей
    status: completed
  - id: create-change-tracker
    content: Создать скрипт трекинга изменений (scripts/track-changes.js) с Git интеграцией
    status: completed
    dependencies:
      - create-ast-parser
  - id: create-diagram-generator
    content: Создать генератор Mermaid диаграмм из AST данных (scripts/update-docs.js)
    status: completed
    dependencies:
      - create-ast-parser
  - id: setup-git-hooks
    content: Настроить Git hooks для автоматического обновления документации при коммитах
    status: completed
    dependencies:
      - create-change-tracker
      - create-diagram-generator
  - id: create-cursor-rules
    content: Создать Cursor rules для автоматического обновления документации (.cursor/rules/features-docs.mdc)
    status: completed
  - id: document-authentication
    content: Создать документацию для Authentication flow с диаграммами
    status: completed
    dependencies:
      - create-feature-template
  - id: document-prompts
    content: Создать документацию для Prompts System с версионированием
    status: completed
    dependencies:
      - create-feature-template
  - id: document-other-features
    content: Создать документацию для остальных фич (packages, websocket, credits, api-routing)
    status: completed
    dependencies:
      - create-feature-template
---

