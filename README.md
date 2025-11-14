# 📘 QAIT — Quality Assurance Intelligence Testing

QAIT — это AI‑поддерживаемая SaaS‑платформа для автоматизированного тестирования веб‑приложений. Она сочетает в себе Playwright‑агентов для исполнения тестов и GPT‑модели (GPT‑4o / GPT‑5) для анализа DOM, логов и UI, чтобы генерировать баг‑репорты, объяснения и улучшать качество релизов без участия QA‑инженера.

## 🎯 Цель проекта

Упростить и ускорить QA‑тестирование в frontend‑и backend‑продуктах, заменив ручную проверку — умным, гибким и легко масштабируемым решением с AI-поддержкой.

## 🧱 Архитектура

| Компонент   | Технология                     | Назначение                           |
| ----------- | ------------------------------ | ------------------------------------ |
| Backend API | Node.js + TypeScript + Express | Управление тестами, маршруты, логика |
| Очередь     | BullMQ + Redis                 | Асинхронная обработка заданий        |
| База данных | Supabase (Postgres)            | Тесты, результаты, проекты           |
| Хранилище   | Supabase Storage               | Скриншоты и артефакты                |
| Тест-агенты | Playwright (в Docker)          | Запуск в Chrome, Firefox, Mobile     |
| AI-анализ   | GPT‑4o / GPT‑5                 | Понимание багов, генерация отчётов   |
| CI/CD       | Railway / Render / ps.kz       | Деплой и инфраструктура              |

## 📦 Основной функционал (MVP)

- **POST /api/v1/tests** — запуск теста по URL (и браузерам)
- **POST /api/v1/tests/result** — приём результата от Playwright-агента
- **GET /api/v1/tests/:id/result** — AI-анализ + история результата
- **Очереди**: масштабируемая обработка через BullMQ
- **AI**: GPT-4o генерирует баг-репорт и объяснение
- **Хранение артефактов** (скриншотов, логов)

### 🧠 AI Prompt (пример)
```
Ты QA-инженер. Вот DOM, скриншот и console.log.
Объясни, что пошло не так, почему и как это исправить.
```

## 💡 Особенности

- 🧠 **Анализ DOM, console.log, network logs, визуальных багов**
- 🪛 **Self-healing**: идея на будущее — фикс предложений и рекомендаций
- 📊 **Поддержка CI/CD пайплайнов**
- 🔌 **Интеграции с Jira, Slack, Trello**
- 💰 **Billing**: модель кредитов (1 тест = X кредитов)

## 💰 Тарифы (пример)

| Тип                 | Кредиты | Пример                       |
| ------------------- | ------- | ---------------------------- |
| Desktop браузер     | 1       | Chrome, Firefox              |
| Мобильный эмулятор  | 2       | iPhone, Android              |
| Реальное устройство | 3       | BrowserStack и др. (будущее) |

**Starter Plan**: $149/мес = 200 кредитов

## 📈 Roadmap

| Месяц   | Цель                                      |
| ------- | ----------------------------------------- |
| Октябрь | MVP: API, очередь, агент, AI-анализ       |
| Ноябрь  | CI/CD интеграции, Slack, Supabase Storage |
| Декабрь | Публичный запуск + billing + retry UI     |

## 🚀 Быстрый старт

### 📦 Установка (локально)

```bash
# Клонирование репозитория
git clone https://github.com/your-username/qait-backend.git
cd qait-backend

# Настройка окружения
cp .env.example .env

# Установка зависимостей
npm install

# ⚠️ ВАЖНО: Установка Playwright браузеров (ОДИН РАЗ)
npx playwright install chromium --with-deps

# Запуск в режиме разработки
npm run dev
```

### Предварительные требования

- Node.js 18+
- Docker
- Redis
- Supabase аккаунт

### Переменные окружения

```env
# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Redis
REDIS_URL=redis://35.202.242.230:6379

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Server
PORT=3000
NODE_ENV=development
```

## 📚 API Документация

### Запуск теста

```http
POST /tests/run
Content-Type: application/json

{
  "url": "https://example.com",
  "browsers": ["chrome", "firefox","safari"],
  "mobile": false
}
```

### Получение результата

```http
GET /tests/:id/result
```

### Отправка результата от агента

```http
POST /tests/result
Content-Type: application/json

{
  "testId": "uuid",
  "browser": "chrome",
  "screenshot": "base64_image",
  "dom": "<html>...</html>",
  "logs": ["console.log messages"],
  "networkLogs": ["network requests"]
}
```

## 🐳 Docker

```bash
# Сборка образа
docker build -t qait-backend .

# Запуск контейнера
docker run -p 3000:3000 --env-file .env qait-backend
```

## 🧪 Тестирование

```bash
# Запуск тестов
npm test

# Запуск тестов с покрытием
npm run test:coverage

# Запуск E2E тестов
npm run test:e2e
```

## 📊 Мониторинг

- **Health Check**: `GET /health`
- **Metrics**: `GET /metrics`
- **Queue Status**: `GET /queue/status`

## 🤝 Вклад в проект

1. Форкните репозиторий
2. Создайте ветку для новой функции (`git checkout -b feature/amazing-feature`)
3. Зафиксируйте изменения (`git commit -m 'Add some amazing feature'`)
4. Отправьте в ветку (`git push origin feature/amazing-feature`)
5. Откройте Pull Request

## 📄 Лицензия

Этот проект лицензирован под MIT License - см. файл [LICENSE](LICENSE) для деталей.

## 🚀 Быстрый старт

1. **Клонируйте репозиторий**
   ```bash
   git clone <repository-url>
   cd qait-backend
   ```

2. **Настройте переменные окружения**
   ```bash
   npm run setup
   # Это создаст .env файл из env.example
   ```

3. **Установите зависимости**
   ```bash
   npm install
   ```

4. **Настройте окружение**
   Отредактируйте `.env` файл и добавьте ваши данные:
   - Supabase URL и ключи
   - OpenAI API ключ
   - Другие необходимые переменные

5. **Настройте базу данных**
   - Создайте проект в Supabase
   - Выполните SQL схему из `supabase-schema.sql`
   - Обновите `.env` с вашими Supabase данными

6. **Запустите сервер разработки**
   ```bash
   npm run dev
   ```

7. **Запустите воркер очередей** (в другом терминале)
   ```bash
   npm run worker
   ```

## 📚 Документация

Полная документация находится в папке [`docs/`](./docs/):

- **🚀 Быстрый старт**: [docs/quickstart/](./docs/quickstart/) - быстрое начало работы
- **⚙️ Установка**: [docs/setup/](./docs/setup/) - настройка проекта, auth, Supabase
- **🏗️ Архитектура**: [docs/architecture/](./docs/architecture/) - дизайн системы, статус проекта
- **🔌 API**: [docs/api/](./docs/api/) - документация API и примеры
- **💻 Разработка**: [docs/development/](./docs/development/) - руководство разработчика, auth детали
- **🤝 Участие**: [docs/contributing/](./docs/contributing/) - как участвовать в проекте

**Swagger UI:** `http://localhost:3000/api/docs` - интерактивная документация API

## 👨‍💻 Автор проекта

**Ospanov Yerassyl**
AI/Flutter/Backend Developer

- **Проект**: [QAIT — https://qai.so](https://qai.so)
- **Поддержка**: Telegram, GPT-4o, Supabase, Docker

## 📞 Поддержка

Если у вас есть вопросы или предложения, пожалуйста:

- Создайте [Issue](https://github.com/your-username/qait-backend/issues)
- Свяжитесь через Telegram
- Напишите на email: support@qai.so

---

⭐ Если проект был полезен, поставьте звезду!
