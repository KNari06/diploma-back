# QAI Backend Setup Instructions

## 1. Environment Configuration

Создайте файл `.env` в корне проекта, скопировав содержимое из `env.example`:

```bash
cp env.example .env
```

Затем отредактируйте `.env` файл и заполните реальными значениями:

### Обязательные переменные:

```env
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# OpenAI Configuration
OPENAI_API_KEY=sk-your_openai_api_key_here

# Security (сгенерируйте случайные строки)
JWT_SECRET=your_random_jwt_secret_minimum_32_characters
API_KEY_SECRET=your_random_api_key_secret_minimum_32_characters
```

### Опциональные переменные (можно оставить по умолчанию):

```env
# Server
NODE_ENV=development
PORT=3000
API_VERSION=v1

# Redis (если используете локальный Redis)
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379

# OpenAI
OPENAI_MODEL=gpt-4o
OPENAI_MAX_TOKENS=4000

# Queue
QUEUE_CONCURRENCY=5
QUEUE_RETRY_ATTEMPTS=3
QUEUE_RETRY_DELAY=5000

# Agent
AGENT_TIMEOUT=300000
AGENT_MAX_RETRIES=3
AGENT_BASE_URL=http://localhost:3001

# Logging
LOG_LEVEL=info
LOG_FORMAT=combined

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## 2. Установка зависимостей

```bash
npm install
```

## 3. Настройка базы данных

1. Создайте проект в Supabase
2. Выполните SQL скрипт из `supabase-schema.sql` в Supabase SQL Editor
3. Настройте RLS политики
4. Создайте bucket для скриншотов

## 4. Запуск приложения

### Development режим:
```bash
npm run dev
```

### Production режим:
```bash
npm run build
npm start
```

### Запуск воркера очередей:
```bash
npm run worker
```

## 5. Проверка работоспособности

После запуска проверьте:

1. **API доступен**: `http://localhost:3000/health`
2. **Документация**: `http://localhost:3000/api/v1/tests` (POST для создания теста)

## 6. Структура проекта

```
src/
├── api/           # API маршруты
├── config/        # Конфигурация
├── db/            # База данных
├── jobs/          # Обработчики очередей
├── services/      # Бизнес-логика
├── types/         # TypeScript типы
├── utils/         # Утилиты
└── worker/        # Воркер очередей
```

## 7. Основные команды

```bash
# Разработка
npm run dev          # Запуск с hot reload
npm run worker       # Запуск воркера очередей

# Сборка
npm run build        # Компиляция TypeScript
npm start           # Запуск production версии

# Тестирование
npm test            # Запуск тестов
npm run test:watch  # Тесты в watch режиме

# Линтинг
npm run lint        # Проверка кода
npm run lint:fix    # Автоисправление
npm run type-check  # Проверка типов
```

## 8. Переменные окружения

Все переменные описаны в `env.example`. Основные:

- **SUPABASE_*** - настройки Supabase
- **OPENAI_API_KEY** - ключ для OpenAI API
- **REDIS_*** - настройки Redis для очередей
- **JWT_SECRET** - секрет для JWT токенов
- **API_KEY_SECRET** - секрет для API ключей
