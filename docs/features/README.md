# Features Documentation Site

Интерактивный мини фронт-сайт для визуализации всех фич проекта с автоматическим обновлением диаграмм.

## Структура

```
docs/features/
├── index.html                    # Главная страница
├── assets/                       # Общие ресурсы
│   ├── styles.css               # Стили
│   ├── app.js                    # JavaScript логика
│   └── components.js             # Компоненты
├── features/                     # Документация фич
│   ├── intelligent-testing/     # Intelligent Testing Flow
│   ├── chat-flow/                # Chat Flow (POST /api/v1/chat)
│   ├── authentication/          # Authentication & Authorization
│   ├── prompts-system/           # Prompts System
│   ├── packages/                 # Packages System
│   ├── websocket/                # WebSocket Flow
│   ├── credits-system/           # Credits System
│   └── api-routing/              # API Routing
└── scripts/                      # Скрипты для автоматизации
    ├── generate-diagrams.js       # AST парсер
    ├── track-changes.js          # Трекинг изменений
    ├── update-docs.js            # Генератор диаграмм
    └── setup-git-hooks.sh        # Установка Git hooks
```

## Использование

### Обновление документации вручную

```bash
# Трекинг изменений
node docs/features/scripts/track-changes.js src/agent/intelligent-test-orchestrator.ts --feature=docs/features/features/intelligent-testing

# Генерация диаграмм
node docs/features/scripts/update-docs.js --feature=docs/features/features/intelligent-testing
```

### Установка Git hooks

```bash
./docs/features/scripts/setup-git-hooks.sh
```

## Автоматическое обновление

Система автоматически обновляет документацию через:
- Git hooks (pre-commit, post-commit)
- Cursor rules (`.cursor/rules/features-docs.mdc`)
- Скрипты трекинга изменений

## Открытие документации

Откройте `docs/features/index.html` в браузере для просмотра документации.
