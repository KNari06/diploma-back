# 🚀 Quick Start: Применение миграции

## Что исправлено

✅ **Проблема:** HNSW индекс поддерживает максимум 2000 dimensions
✅ **Решение:** Переключились на `text-embedding-3-small` (1536 dims)

## Применить миграцию

### Supabase Dashboard (рекомендуется)

1. Открой [Supabase Dashboard](https://supabase.com/dashboard)
2. Твой проект → **SQL Editor**
3. **New Query**
4. Скопируй **весь файл** `knowledge-base-safe.sql`
5. **Run** (F5)

### Или через psql

```bash
psql $DATABASE_URL -f supabase-migrations/knowledge-base-safe.sql
```

## Проверка

```sql
-- Проверь что таблицы созданы
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE '%kb_chunks%';
-- Должно вернуть: global_kb_chunks, project_kb_chunks

-- Проверь индексы
SELECT indexname FROM pg_indexes
WHERE tablename LIKE '%kb_chunks%';
-- Должно быть ~8-10 индексов

-- Тест vector
SELECT '[1,2,3]'::vector(3);
```

## Тестирование

```bash
# Запусти бэкенд
npm run dev

# Проверь KB stats
curl http://localhost:3000/api/v1/kb/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Почему text-embedding-3-small?

| Параметр | 3-small | 3-large |
|----------|---------|---------|
| Dimensions | 1536 | 3072 |
| HNSW Support | ✅ Да | ❌ Нет (>2000) |
| Скорость | Быстрее | Медленнее |
| Цена | Дешевле | Дороже |
| Качество | Отлично | Чуть лучше |

**Вывод:** text-embedding-3-small - оптимальный выбор для production 🎯
