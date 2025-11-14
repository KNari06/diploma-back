# 🔌 API Reference

Полная документация API для QAI Backend.

## 📋 Содержание

- [**Обзор API**](#обзор-api)
- [**Аутентификация**](./authentication.md)
- [**Примеры использования**](./examples.md)
- [**Endpoints**](#endpoints)
- [**Коды ошибок**](#коды-ошибок)
- [**API Fuzzing**](#api-fuzzing)

## 🔍 Обзор API

QAI Backend предоставляет RESTful API для управления автоматизированным тестированием веб-приложений.

### Базовый URL
```
https://api.qai.so/api/v1
```

### Формат ответов
Все ответы возвращаются в формате JSON:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## 🛠️ Endpoints

### Тесты

#### `POST /tests/run`
Запуск нового теста

**Параметры:**
```json
{
  "url": "https://example.com",
  "browsers": ["chrome", "firefox"],
  "projectId": "uuid",
  "options": {
    "mobile": false,
    "viewport": {
      "width": 1920,
      "height": 1080
    }
  }
}
```

**Ответ:**
```json
{
  "success": true,
  "data": {
    "id": "test-uuid",
    "url": "https://example.com",
    "status": "pending",
    "browsers": ["chrome", "firefox"],
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

#### `GET /tests/:id`
Получение информации о тесте

#### `GET /tests/:id/result`
Получение результатов теста

#### `POST /tests/result`
Отправка результатов теста (для агентов)

### Проекты

#### `GET /projects`
Список проектов пользователя

#### `POST /projects`
Создание нового проекта

### Пользователи

#### `GET /users/profile`
Профиль пользователя

#### `PUT /users/profile`
Обновление профиля

### Playwright

#### `POST /playwright/upload-trace`
Загрузка Playwright trace файла

#### `GET /playwright/trace/:filename`
Скачивание trace файла

#### `GET /playwright/traces/:testId`
Список всех trace для теста

[📖 Подробная документация Playwright API](./playwright.md)

## 🔒 API Fuzzing

### Intelligent API Fuzzing

QAI Backend автоматически выполняет security testing для API endpoints:

- [**Intelligent API Fuzzing Implementation**](./INTELLIGENT_API_FUZZING_IMPLEMENTATION.md) - Полная документация по реализации
- [**Enhanced Fuzzing Details**](./ENHANCED_FUZZING_DETAILS.md) - Детальная информация о failed tests

**Возможности:**
- Автоматическая генерация security test scenarios через GPT
- Параллельное выполнение negative tests (authentication, authorization, SQL injection, XSS, rate limiting)
- Comprehensive security reports с CWE references
- Полная детализация request/response для каждого failed test

## 📊 Коды ошибок

| Код | Описание |
|-----|----------|
| 400 | Неверный запрос |
| 401 | Не авторизован |
| 403 | Доступ запрещен |
| 404 | Не найдено |
| 429 | Превышен лимит запросов |
| 500 | Внутренняя ошибка сервера |

## 🔐 Аутентификация

API использует JWT токены для аутентификации. Подробнее в [документации по аутентификации](./authentication.md).

## 📝 Примеры

Практические примеры использования API смотрите в [примерах](./examples.md).

---

[← Назад к документации](../README.md) | [Примеры использования →](./examples.md)
