# 🚀 Deployment Guide

Руководство по деплою QAI Backend на production сервер.

## 📡 Подключение к серверу

### SSH команда:

```bash
ssh -i ${DEPLOY_SSH_KEY_PATH} ${DEPLOY_SSH_USER}@${DEPLOY_SSH_HOST}
```

**Детали подключения:**

- ⚠️ **SECURITY**: SSH credentials хранятся в переменных окружения (`.env` файл, НЕ коммитится в репозиторий)
- Используй переменные: `DEPLOY_SSH_KEY_PATH`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_HOST`
- Эти переменные должны быть настроены локально в `.env` файле (см. `env.example`)

**Настройка переменных окружения:**

Добавь в свой локальный `.env` файл (не коммитится):
```bash
DEPLOY_SSH_HOST=your_production_server_ip
DEPLOY_SSH_USER=your_ssh_username
DEPLOY_SSH_KEY_PATH=/path/to/your/ssh/private/key
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

- ⚠️ **CRITICAL**: SSH credentials и production server details НЕ должны быть в репозитории
- SSH ключ должен быть в `.gitignore` и не должен попадать в репозиторий
- Используйте правильные права доступа для ключа: `chmod 600 <ssh-key-path>`
- Никогда не коммитьте:
  - `.env` файл с реальными credentials
  - SSH private keys
  - Production server IP addresses
  - Usernames и другие чувствительные данные
- Все production credentials должны храниться только в локальном `.env` файле или секретах CI/CD

## 📝 Дополнительная информация

Для детальных процедур деплоя см.:

- [Deployment Rules](../../.cursor/rules/deployment-rules.mdc) - полные правила и чеклисты
- [Server Configuration](./server-config.md) - конфигурация сервера (если файл существует)

## 📋 Deployment Checklists

- [**Pre-Deployment Check Summary**](./PRE_DEPLOYMENT_CHECK_SUMMARY.md) - Краткая сводка проверок перед деплоем
- [**Multi-Chat Deployment Checklist**](./DEPLOYMENT_CHECKLIST_MULTI_CHAT.md) - Чеклист для деплоя мультичата
