# 🔍 Проверки качества кода

Автоматические и ручные проверки качества кода в проекте QAI Backend.

## 📋 Содержание

- [**Автоматические проверки**](#автоматические-проверки)
- [**Ручные проверки**](#ручные-проверки)
- [**Перед коммитом**](#перед-коммитом)
- [**Перед деплоем**](#перед-деплоем)

## 🤖 Автоматические проверки

### TypeScript компиляция

```bash
# Проверка типов
npm run type-check

# Проверка конкретного файла
npx tsc --noEmit src/services/test.service.ts
```

### ESLint проверки

```bash
# Проверка линтера
npm run lint

# Автоисправление
npm run lint:fix
```

### Тесты

```bash
# Запуск всех тестов
npm test

# Тесты в watch режиме
npm run test:watch

# Покрытие кода
npm run test:coverage
```

## 🔍 Ручные проверки

### Проверка импортов при рефакторинге

```bash
# Найти все файлы которые импортируют модуль
grep -r "import.*from.*@/" src/
grep -r "require.*@/" src/

# Проверить каждый файл что импорт правильный
# Обновить импорты ВЕЗДЕ где нужно
```

### Проверка полей базы данных

```bash
# Найти использование неправильных полей
grep -r "\.test\.test_id" src/
grep -r "created_date" src/
grep -r "published_date" src/

# Проверить схему БД
grep -r "create table.*tests" supabase-schema.sql
```

### Проверка на дубликаты

```bash
# Проверить есть ли уже похожий файл
find src/ -name "*service*"
find src/ -name "*auth*"
find src/ -name "*test*"

# Поиск по содержимому
grep -r "function_you_want_to_add" src/
```

## ✅ Перед коммитом

### Обязательные проверки

```bash
# 1. TypeScript компиляция
npm run type-check

# 2. ESLint проверки
npm run lint

# 3. Тесты
npm test

# 4. Проверка измененных файлов
git diff --name-only | grep '\.ts$' | xargs -I {} npx tsc --noEmit {}
```

### Git hooks

Husky автоматически запускает проверки:

```bash
# pre-commit hook
npm run type-check
npm run lint
npm test

# commit-msg hook
# Проверка формата сообщения коммита
```

## 🚀 Перед деплоем

### Pre-deploy checklist

```bash
# 1. Синтаксис всех измененных файлов
git diff --name-only | grep '\.ts$' | xargs -I {} npx tsc --noEmit {}

# 2. Проверка типов
npm run type-check

# 3. Проверка линтера
npm run lint

# 4. Проверка импортов
grep -r "import.*@/" src/
grep -r "\.test\.test_id" src/
```

### Локальное тестирование

```bash
# Запуск сервера
npm run dev

# Тестирование API
curl http://localhost:3000/health
curl "http://localhost:3000/api/v1/tests" -X POST \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","browsers":["chrome"]}'
```

## 🐛 Исправление ошибок

### TypeScript ошибки

```typescript
// ❌ Плохо - неопределенный тип
const data: any = await getData();

// ✅ Хорошо - конкретный тип
const data: TestData = await getData();
```

### ESLint ошибки

```typescript
// ❌ Плохо - неиспользуемая переменная
const unused = 'value';

// ✅ Хорошо - используй переменную или удали
const used = 'value';
console.log(used);
```

### Логические ошибки

```typescript
// ❌ Плохо - не проверяешь данные
const testId = result.test.id; // может быть undefined!

// ✅ Хорошо - проверка перед использованием
if (!result || !result.test || !result.test.id) {
  logger.error("Test missing required field");
  return null;
}
const testId = result.test.id;
```

## 📊 Метрики качества

### Покрытие кода
- **Минимум**: 80%
- **Цель**: 90%+

### ESLint ошибки
- **Критические**: 0
- **Предупреждения**: минимум

### TypeScript ошибки
- **Строгий режим**: включен
- **Any типы**: минимум

## 🔧 Инструменты

### VS Code расширения
- TypeScript
- ESLint
- Prettier
- Jest

### Автоматизация
- Husky (Git hooks)
- GitHub Actions (CI/CD)
- Dependabot (обновления)

---

[← Назад к правилам](./README.md) | [Безопасность →](./security.md)
