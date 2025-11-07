# 🚀 Deployment Guide

Руководство по деплою QAI Backend на production сервер.

## 📡 Подключение к серверу

### SSH команда:

```bash
ssh -i /Users/yerassylospanov/Desktop/QAI-BackEnd/gcp root@35.238.212.84
```

**Детали подключения:**
- **SSH ключ**: `/Users/yerassylospanov/Desktop/QAI-BackEnd/gcp` (в корне проекта)
- **Пользователь**: `root`
- **IP адрес**: `35.238.212.84`

**Альтернативный вариант (из корня проекта):**
```bash
cd /Users/yerassylospanov/Desktop/QAI-BackEnd
ssh -i ./gcp root@35.238.212.84
```

## 🔍 Pre-Deployment Checklist

Перед каждым деплоем обязательно выполните:

1. ✅ Запуск тестов
2. ✅ Проверка типов TypeScript
3. ✅ Проверка линтера
4. ✅ Локальное тестирование

Подробнее см. [Deployment Rules](../../.cursor/rules/deployment-rules.mdc)

## 📦 Процесс деплоя

1. Подключитесь к серверу используя команду выше
2. Перейдите в директорию проекта
3. Выполните деплой согласно инструкциям в deployment-rules.mdc

## 🔐 Безопасность

- SSH ключ (`gcp`) находится в `.gitignore` и не должен попадать в репозиторий
- Используйте правильные права доступа для ключа: `chmod 600 gcp`
- Никогда не коммитьте секреты и ключи

## 📝 Дополнительная информация

Для детальных процедур деплоя см.:
- [Deployment Rules](../../.cursor/rules/deployment-rules.mdc) - полные правила и чеклисты
- [Server Configuration](./server-config.md) - конфигурация сервера (если файл существует)
