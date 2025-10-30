# 📝 Commit Message Conventions

Мы используем [Conventional Commits](https://www.conventionalcommits.org/) для единообразных и понятных сообщений коммитов.

## 🎯 Формат

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## 🔧 Типы (Types)

| Тип | Описание | Пример |
|-----|----------|--------|
| `feat` | Новая функция | `feat(api): add user authentication` |
| `fix` | Исправление ошибки | `fix(auth): resolve token expiration` |
| `docs` | Изменения в документации | `docs: update API examples` |
| `style` | Форматирование, отсутствие изменений в логике | `style: fix code formatting` |
| `refactor` | Рефакторинг кода | `refactor(service): simplify user logic` |
| `test` | Добавление или исправление тестов | `test(api): add user endpoint tests` |
| `chore` | Изменения в процессе сборки или вспомогательных инструментах | `chore: update dependencies` |
| `ci` | Изменения в CI/CD | `ci: add GitHub Actions workflow` |
| `perf` | Улучшение производительности | `perf(db): optimize user queries` |
| `build` | Изменения в системе сборки | `build: update webpack config` |
| `revert` | Откат предыдущего коммита | `revert: feat(api): add user auth` |

## 📍 Области (Scopes)

| Область | Описание |
|---------|----------|
| `api` | API endpoints и маршруты |
| `auth` | Аутентификация и авторизация |
| `db` | База данных и модели |
| `queue` | Очереди и воркеры |
| `ai` | AI сервисы и анализ |
| `config` | Конфигурация |
| `utils` | Утилиты и хелперы |
| `types` | TypeScript типы |
| `test` | Тесты |
| `docs` | Документация |
| `ci` | CI/CD |
| `deps` | Зависимости |

## 📝 Описание (Description)

- Используйте повелительное наклонение: "add" вместо "added" или "adds"
- Не ставьте точку в конце
- Ограничьте длину до 50 символов
- Начинайте с маленькой буквы

## 📄 Тело (Body)

- Объясните **что** и **почему**, а не **как**
- Ограничьте длину строк до 72 символов
- Используйте пустую строку между заголовком и телом

## 🔗 Подвал (Footer)

- Ссылки на issues: `Closes #123`
- Breaking changes: `BREAKING CHANGE: description`

## ✅ Примеры

### ✨ Хорошие примеры

```bash
feat(api): add user registration endpoint
fix(auth): resolve JWT token validation
docs: update installation guide
refactor(service): simplify user creation logic
test(api): add authentication tests
chore(deps): update express to v4.18.2
```

### ❌ Плохие примеры

```bash
# Слишком общее
fix: bug fix

# Неправильный формат
Added user endpoint

# Слишком длинное описание
feat(api): add user registration endpoint with email validation and password hashing

# Неправильный тип
update: user service
```

## 🚀 Примеры с телом

```bash
feat(api): add user authentication

Implement JWT-based authentication with refresh tokens.
Add middleware for protected routes.
Update user model with password hashing.

Closes #123
```

```bash
fix(db): resolve connection timeout

Increase connection pool size from 10 to 20.
Add retry logic for failed connections.
Update connection timeout to 30 seconds.

Fixes #456
```

## 🔄 Breaking Changes

```bash
feat(api): redesign user endpoints

BREAKING CHANGE: User endpoints now require API version header.
Old endpoints are deprecated and will be removed in v2.0.

Migration guide: https://docs.qai.so/migration/v1-to-v2
```

## 🎯 Советы

1. **Будьте конкретными** - опишите точно, что изменилось
2. **Используйте эмодзи** (опционально) для лучшей читаемости
3. **Группируйте изменения** - один коммит = одна логическая единица
4. **Проверяйте перед коммитом** - используйте `git status` и `git diff`

## 🔧 Автоматизация

Мы используем Husky для автоматической проверки формата коммитов:

```bash
# Установка husky
npm install

# Хуки будут установлены автоматически
```

## 📚 Дополнительные ресурсы

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Angular Commit Guidelines](https://github.com/angular/angular/blob/main/CONTRIBUTING.md#commit)
- [Semantic Versioning](https://semver.org/)

---

**Помните: хорошие коммиты делают историю проекта читаемой и понятной!** 📖
