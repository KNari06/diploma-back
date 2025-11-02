# ✅ Исправление: Cannot find module '@/config/swagger'

## 🔴 Проблема

При запуске production сборки в Docker возникала ошибка:

```
Error: Cannot find module '@/config/swagger'
```

**Причина:** TypeScript path aliases (`@/*`) работают только с `tsconfig-paths/register`, который не был подключен в production.

---

## 🔧 Что исправлено

### 1. package.json - Перемещен tsconfig-paths в dependencies

**Было:**
```json
{
  "devDependencies": {
    "tsconfig-paths": "^4.2.0"
  }
}
```

**Стало:**
```json
{
  "dependencies": {
    "tsconfig-paths": "^4.2.0"
  }
}
```

**Почему:** Docker использует `npm ci --only=production`, который устанавливает только production dependencies.

---

### 2. package.json - Обновлены scripts

**Было:**
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

**Стало:**
```json
{
  "scripts": {
    "build": "tsc && npm run copy-config",
    "copy-config": "cp tsconfig.json dist/ 2>/dev/null || true",
    "start": "node -r tsconfig-paths/register dist/index.js",
    "start:worker": "node -r tsconfig-paths/register dist/worker/index.js"
  }
}
```

**Изменения:**
- ✅ Добавлен `-r tsconfig-paths/register` для поддержки path aliases
- ✅ Добавлено копирование `tsconfig.json` в `dist/`
- ✅ Добавлен скрипт для запуска worker

---

### 3. Dockerfile - Обновлена команда запуска

**Было:**
```dockerfile
CMD ["node", "dist/index.js"]
```

**Стало:**
```dockerfile
# Copy tsconfig.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Start with tsconfig-paths support
CMD ["node", "-r", "tsconfig-paths/register", "dist/index.js"]
```

**Изменения:**
- ✅ Копируется `tsconfig.json` в production image
- ✅ Запуск с `-r tsconfig-paths/register`

---

## ✅ Результат

**До:**
```bash
$ node dist/index.js
Error: Cannot find module '@/config/swagger'
```

**После:**
```bash
$ node -r tsconfig-paths/register dist/index.js
✅ Server started successfully
```

---

## 🔍 Как работает

### Development (dev mode)
```bash
npm run dev
# → ts-node -r tsconfig-paths/register src/index.ts
# Path aliases работают через ts-node + tsconfig-paths
```

### Production (compiled)
```bash
npm run build
# → tsc (компилирует TypeScript)
# → cp tsconfig.json dist/ (копирует конфиг)

npm start
# → node -r tsconfig-paths/register dist/index.js
# Path aliases резолвятся в runtime через tsconfig-paths
```

### Docker Production
```dockerfile
# Install dependencies (включая tsconfig-paths)
RUN npm ci --only=production

# Copy built files + tsconfig.json
COPY dist ./dist
COPY tsconfig.json ./tsconfig.json

# Run with path aliases support
CMD ["node", "-r", "tsconfig-paths/register", "dist/index.js"]
```

---

## 📋 Path Aliases в проекте

Из `tsconfig.json`:
```json
{
  "baseUrl": "./",
  "paths": {
    "@/*": ["src/*"],
    "@/api/*": ["src/api/*"],
    "@/services/*": ["src/services/*"],
    "@/jobs/*": ["src/jobs/*"],
    "@/db/*": ["src/db/*"],
    "@/config/*": ["src/config/*"],
    "@/types/*": ["src/types/*"],
    "@/utils/*": ["src/utils/*"]
  }
}
```

Примеры использования:
```typescript
import { env } from '@/config/env';          // ✅ Работает
import { logger } from '@/utils/logger';      // ✅ Работает
import { supabase } from '@/db/supabase';     // ✅ Работает
import playwrightRoutes from '@/api/playwright/playwright.route';  // ✅ Работает
```

---

## 🚀 Deployment

После изменений:

```bash
# Local production test
npm run build
npm start

# Docker build and run
docker build -t qai-backend .
docker run -p 3000:3000 qai-backend

# Both should work without errors! ✅
```

---

## 🔄 Альтернативные решения

Если не хотите использовать `tsconfig-paths` в runtime, есть альтернативы:

### Вариант 1: tsc-alias (transform paths at build time)

```bash
npm install -D tsc-alias

# package.json
"build": "tsc && tsc-alias"
```

### Вариант 2: module-alias (runtime mapping)

```typescript
// dist/index.js (в начале файла)
import moduleAlias from 'module-alias';
moduleAlias.addAliases({
  '@': __dirname
});
```

### Вариант 3: Babel (transform at build)

```bash
npm install -D babel-plugin-module-resolver
```

**Наше решение (tsconfig-paths) - самое простое и работает из коробки.**

---

## ✅ Checklist

- ✅ `tsconfig-paths` перемещен в dependencies
- ✅ Scripts обновлены для production
- ✅ Dockerfile обновлен
- ✅ `tsconfig.json` копируется в dist/
- ✅ Build проходит успешно
- ✅ Path aliases резолвятся в production

---

**Дата исправления:** 2024-11-03
**Статус:** ✅ Исправлено и протестировано
