# URL Normalization Fix

**Дата:** 2024-11-27
**Проблема:** `Invalid URL format: hrgpt.kz`
**Статус:** ✅ Исправлено

---

## 🐛 Проблема

Пользователь вводил URL без протокола (`hrgpt.kz`), что вызывало ошибку:

```
2025-11-27 10:31:30:3130 error: [PROJECT] Failed to find/create project
{
  "error": "Invalid URL format: hrgpt.kz",
  "workspaceId": "26f6283a-4ef6-4bed-a086-d53c7a2871be",
  "url": "hrgpt.kz"
}
```

### Причина
`ProjectContextService.isValidUrl()` использовал `new URL(url)`, который требует полный URL с протоколом.

---

## 🔧 Решение

### 1. Обновлен `ProjectContextService.isValidUrl()`

**До:**
```typescript
private static isValidUrl(url: string): boolean {
  try {
    new URL(url); // ❌ Требует протокол
    return true;
  } catch {
    return false;
  }
}
```

**После:**
```typescript
private static isValidUrl(url: string): boolean {
  const trimmedUrl = url.trim();

  try {
    // ✅ Если нет протокола, пробуем добавить https://
    if (!trimmedUrl.includes('://')) {
      new URL(`https://${trimmedUrl}`);
      return true;
    }

    // ✅ Если есть протокол, валидируем как есть
    new URL(trimmedUrl);
    return true;
  } catch {
    return false;
  }
}
```

### 2. Добавлена функция нормализации

```typescript
/**
 * Normalize URL by adding protocol if missing
 */
private static normalizeUrl(url: string): string {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return url;
  }

  const trimmedUrl = url.trim();

  // ✅ Если нет протокола, добавляем https://
  if (!trimmedUrl.includes('://')) {
    return `https://${trimmedUrl}`;
  }

  return trimmedUrl;
}
```

### 3. Обновлен `findOrCreateProject()`

```typescript
// ✅ Нормализуем URL перед использованием
const normalizedUrl = this.normalizeUrl(url);

logger.info('[PROJECT] Finding or creating project', {
  workspaceId,
  url: normalizedUrl.substring(0, 100),
  originalUrl: url.substring(0, 100), // ✅ Логируем оригинал
  userId,
});

// ✅ Используем нормализованный URL
const baseUrl = this.extractBaseUrl(normalizedUrl);
```

### 4. Обновлен Chat Controller

Добавлена нормализация URL в `handlePlatformTest()`:

```typescript
// ✅ Нормализуем URL перед передачей в ProjectContextService
const rawUrl = parsedAnswers?.url || parsedIntent?.page || sessionProject?.settings?.main_url || null;
const extractedUrl = rawUrl ? normalizeUrl(rawUrl) : null;
```

И в `executeUiTestFlow()`:

```typescript
// ✅ Нормализуем URL из плана тестирования
const projectResult = await ProjectContextService.findOrCreateProject(
  workspace_id,
  normalizeUrl(plan.url), // ✅ Нормализация
  userId
);
```

---

## 📊 Результат

### Поддерживаемые форматы URL:

| Ввод пользователя | Нормализованный URL | Статус |
|-------------------|---------------------|---------|
| `hrgpt.kz` | `https://hrgpt.kz` | ✅ |
| `example.com` | `https://example.com` | ✅ |
| `https://site.com` | `https://site.com` | ✅ |
| `http://localhost:3000` | `http://localhost:3000` | ✅ |
| `ftp://files.com` | `ftp://files.com` | ✅ |

### Логирование:

```json
{
  "url": "https://hrgpt.kz",
  "originalUrl": "hrgpt.kz",
  "workspaceId": "26f6283a-4ef6-4bed-a086-d53c7a2871be"
}
```

---

## 🧪 Тестирование

### Успешные случаи:
- ✅ `hrgpt.kz` → `https://hrgpt.kz`
- ✅ `google.com` → `https://google.com`
- ✅ `https://example.com` → `https://example.com`

### Обработка ошибок:
- ✅ Пустая строка → ошибка валидации
- ✅ Невалидный домен → ошибка валидации
- ✅ Graceful fallback при ошибках

---

## 📁 Измененные файлы

1. **`src/services/utils/project-context.service.ts`**
   - ✅ `isValidUrl()` - поддержка URL без протокола
   - ✅ `normalizeUrl()` - новая функция нормализации
   - ✅ `findOrCreateProject()` - использование нормализации

2. **`src/api/chat/chat.controller.ts`**
   - ✅ `normalizeUrl()` - helper функция
   - ✅ `handlePlatformTest()` - нормализация extracted URL
   - ✅ `executeUiTestFlow()` - нормализация plan URL

---

## 🎯 Преимущества

1. **UX улучшение**: Пользователи могут вводить URL без протокола
2. **Backwards compatibility**: Существующие URL с протоколом работают как раньше
3. **Безопасность**: По умолчанию используется HTTPS
4. **Логирование**: Видно и оригинальный, и нормализованный URL
5. **Консистентность**: Все места используют одну логику нормализации

---

## 🚀 Готово к production

- ✅ TypeScript компиляция проходит
- ✅ Backwards compatibility сохранена
- ✅ Логирование улучшено
- ✅ Обработка ошибок добавлена

**Ошибка `Invalid URL format: hrgpt.kz` больше не возникает!**
