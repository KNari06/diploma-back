# 📚 QAIT Backend Documentation

Добро пожаловать в документацию QAIT Backend! Здесь собрана вся информация о проекте, его архитектуре, API и процессах разработки.

## 🗂️ Структура документации

### 🚀 Быстрый старт

- [**Установка и настройка**](./setup/README.md) - как запустить проект локально
- [**Первые шаги**](./quickstart/README.md) - быстрый старт для разработчиков
- [**Auth Quick Start**](./quickstart/auth-quick-start.md) - аутентификация за 7 шагов

### 🏗️ Архитектура

- [**Обзор системы**](./architecture/README.md) - общая архитектура проекта
- [**Схема базы данных**](./architecture/database.md) - структура БД и связи
- [**Статус проекта**](./architecture/project-status.md) - текущий прогресс и roadmap
- [**OAuth Flow**](./architecture/oauth-flow.md) - детальное объяснение OAuth процесса
- [**Chat Processing Flow**](./architecture/chat-flow.md) - как обрабатываются пользовательские запросы

### 🔌 API

- [**API Reference**](./api/README.md) - полная документация API
- [**Примеры использования**](./api/examples.md) - практические примеры
- [**Аутентификация**](./api/authentication.md) - работа с токенами и ключами
- [**Multi-Chat Sessions**](./api/multi-chat-sessions.md) - ✨ NEW! Мультичат как в ChatGPT
- [**Playwright API**](./api/playwright.md) - загрузка trace файлов
- [**Feedback API**](./api/feedback-api-examples.md) - система like/dislike для улучшения AI
- [**Feedback Analytics**](./api/feedback-analytics-guide.md) - аналитика и insights для мониторинга качества AI
- [**Intelligent API Fuzzing**](./api/INTELLIGENT_API_FUZZING_IMPLEMENTATION.md) - автоматическое security testing API
- [**Enhanced Fuzzing Details**](./api/ENHANCED_FUZZING_DETAILS.md) - детальная информация о failed tests

### 💻 Разработка

- [**Руководство разработчика**](./development/README.md) - как разрабатывать
- [**Стандарты кодирования**](./development/coding-standards.md) - правила написания кода
- [**🤖 Intent Parsing Guide**](./development/INTENT_PARSING_GUIDE.md) - ✨ Context-First AI подход и трекинг изменений
- [**🔍 Playwright Logging Improvements**](./development/PLAYWRIGHT_LOGGING_IMPROVEMENTS.md) - Детальное логирование всего testing flow
- [**Auth Implementation**](./development/auth-implementation.md) - технические детали аутентификации
- [**Auth Validation**](./development/auth-validation.md) - отчет проверки auth файлов
- [**Anonymous User Migration**](./development/anonymous-user-migration.md) - миграция анонимных пользователей

## ⚙️ Setup & Configuration

- [**Setup Instructions**](./setup/README.md) - базовая установка проекта
- [**Auth Setup**](./setup/auth-setup.md) - полная настройка аутентификации
- [**Supabase Setup**](./setup/supabase-setup.md) - миграции и конфигурация БД

### 🚀 Деплой

- [**Процедуры деплоя**](./deployment/README.md) - как деплоить проект и подключение к серверу
- [**Pre-Deployment Check Summary**](./deployment/PRE_DEPLOYMENT_CHECK_SUMMARY.md) - краткая сводка проверок перед деплоем
- [**Multi-Chat Deployment Checklist**](./deployment/DEPLOYMENT_CHECKLIST_MULTI_CHAT.md) - чеклист для деплоя мультичата
- [**Конфигурация сервера**](./deployment/server-config.md) - настройка окружения (если файл существует)
- [**Мониторинг**](./deployment/monitoring.md) - отслеживание состояния (если файл существует)

## 🤝 Участие в проекте

- [**Руководство контрибьютора**](./contributing/README.md) - как участвовать в разработке
- [**Правила коммитов**](./contributing/commit-conventions.md) - стандарты коммитов

## 📋 Правила и стандарты

- [**Обзор правил**](./rules/README.md) - все правила проекта
- [**Проверки качества**](./rules/code-quality.md) - автоматические проверки
- [**Overview**](./rules/overview.md) - общий обзор

## 🔍 Быстрый поиск

### Для новых разработчиков

1. Начните с [Установки](./setup/README.md)
2. Изучите [Архитектуру](./architecture/README.md)
3. Прочитайте [Руководство разработчика](./development/README.md)

### Для DevOps

1. [Процедуры деплоя](./deployment/README.md)
2. [Конфигурация сервера](./deployment/server-config.md)
3. [Мониторинг](./deployment/monitoring.md)

### Для API пользователей

1. [API Reference](./api/README.md)
2. [Примеры использования](./api/examples.md)
3. [Аутентификация](./api/authentication.md)

## 📝 Обновление документации

При внесении изменений в проект:

1. **Обновите соответствующие разделы** документации
2. **Проверьте ссылки** - они должны работать
3. **Добавьте примеры** для новых функций
4. **Обновите этот индекс** если добавили новые разделы

## 🆘 Получение помощи

- **Issues**: [GitHub Issues](https://github.com/your-username/qait-backend/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-username/qait-backend/discussions)
- **Email**: dev@qai.so
- **Telegram**: @qait_support

---

**Последнее обновление**: $(date +'%Y-%m-%d')
