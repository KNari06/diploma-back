# 📋 Rules Overview - QAI Backend

Этот файл содержит краткий обзор всех правил и файлов проекта.

## 📁 Структура правил

```
QAI - BackEnd/
├── .github/                    # GitHub конфигурация
│   ├── CONTRIBUTING.md         # Правила участия
│   ├── CODE_OF_CONDUCT.md      # Кодекс поведения
│   ├── SECURITY.md             # Политика безопасности
│   ├── PULL_REQUEST_TEMPLATE.md # Шаблон PR
│   ├── ISSUE_TEMPLATE/         # Шаблоны issues
│   │   ├── bug_report.md       # Шаблон бага
│   │   └── feature_request.md  # Шаблон функции
│   ├── workflows/              # GitHub Actions
│   │   ├── ci.yml              # CI/CD пайплайн
│   │   └── dependency-review.yml # Проверка зависимостей
│   └── dependabot.yml          # Автообновление зависимостей
├── .vscode/                    # VS Code конфигурация
│   ├── settings.json           # Настройки редактора
│   ├── extensions.json         # Рекомендуемые расширения
│   ├── launch.json             # Конфигурация отладки
│   └── tasks.json              # Задачи VS Code
├── .husky/                     # Git hooks
│   ├── pre-commit              # Проверки перед коммитом
│   └── commit-msg              # Валидация сообщений коммитов
├── .eslintrc.js                # ESLint конфигурация
├── .gitignore                  # Игнорируемые файлы
├── COMMIT_CONVENTIONS.md       # Правила коммитов
├── CODING_STANDARDS.md         # Стандарты кодирования
├── PROJECT_RULES.md            # Общие правила проекта
└── RULES_OVERVIEW.md           # Этот файл
```

## 🎯 Основные правила

### 1. **Качество кода**
- Строгая типизация TypeScript
- Следование принципам SOLID
- Покрытие тестами > 80%
- Документирование сложной логики

### 2. **Безопасность**
- Никогда не коммитьте секреты
- Валидация всех входных данных
- Регулярное обновление зависимостей
- Использование HTTPS

### 3. **Производительность**
- Оптимизация запросов к БД
- Использование кэширования
- Избегание блокирующих операций
- Мониторинг метрик

## 📝 Стандарты

### Именование
- **Файлы**: kebab-case (`user-service.ts`)
- **Классы**: PascalCase (`UserService`)
- **Функции**: camelCase (`getUserById`)
- **Константы**: UPPER_SNAKE_CASE (`API_BASE_URL`)

### Коммиты
```bash
feat(api): add user authentication endpoint
fix(auth): resolve JWT token validation
docs: update API documentation
refactor(service): simplify user creation logic
```

### Ветки
- `main` - продакшн
- `develop` - разработка
- `feature/name` - новые функции
- `fix/description` - исправления

## 🔧 Инструменты

### Обязательные
- **TypeScript** - типизация
- **ESLint** - линтинг
- **Jest** - тестирование
- **Husky** - Git hooks
- **Prettier** - форматирование

### VS Code
- Автоформатирование при сохранении
- Автоисправление ESLint
- Интеграция с TypeScript
- Готовые конфигурации отладки

## 🧪 Тестирование

### Команды
```bash
npm test              # Все тесты
npm run test:watch    # Watch режим
npm run test:coverage # Покрытие
```

### Требования
- Unit тесты для всех сервисов
- Integration тесты для API
- Покрытие кода > 80%
- Тесты должны быть быстрыми и надежными

## 🚀 CI/CD

### GitHub Actions
- **Test & Lint** - проверка кода
- **Build** - сборка проекта
- **Security** - аудит безопасности
- **Deploy** - деплой в продакшн

### Автоматизация
- Dependabot для обновления зависимостей
- Автоматические проверки PR
- Автоматический деплой при merge в main

## 🔒 Безопасность

### Секреты
- Используйте `.env` файлы
- Никогда не коммитьте API ключи
- Ротируйте секреты регулярно
- Разные секреты для разных окружений

### Валидация
- Zod для схем валидации
- Санитизация пользовательского ввода
- Ограничение размера запросов
- Rate limiting

## 📚 Документация

### Обязательная
- README.md - общее описание
- API_EXAMPLES.md - примеры API
- SETUP.md - инструкции настройки
- DEVELOPMENT.md - руководство разработчика

### Обновление
- При изменении API обновляйте документацию
- Документируйте новые environment переменные
- Добавляйте примеры использования

## 🚫 Запрещено

- ❌ Коммитить `.env` файлы
- ❌ Добавлять зависимости без обсуждения
- ❌ Изменять API без версионирования
- ❌ Игнорировать ошибки линтера
- ❌ Создавать большие PR (> 500 строк)
- ❌ Использовать `any` без крайней необходимости
- ❌ Оставлять `console.log` в продакшн коде

## ✅ Рекомендуется

- ✅ Регулярно обновлять зависимости
- ✅ Использовать `npm audit` для проверки уязвимостей
- ✅ Валидировать все входные данные
- ✅ Писать тесты для новой функциональности
- ✅ Документировать сложную логику
- ✅ Использовать TypeScript строго

## 📞 Поддержка

### Контакты
- **Telegram**: @qai_support
- **Email**: dev@qai.so
- **Issues**: GitHub Issues

### Время ответа
- **Критические ошибки**: 2 часа
- **Обычные вопросы**: 24 часа
- **Feature requests**: 1 неделя

## 🎯 Быстрый старт

1. **Клонируйте репозиторий**
2. **Настройте окружение**: `npm run setup`
3. **Установите зависимости**: `npm install`
4. **Запустите тесты**: `npm test`
5. **Запустите проект**: `npm run dev`

## 📖 Дополнительные ресурсы

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Express.js Security](https://expressjs.com/en/advanced/best-practice-security.html)
- [Jest Testing](https://jestjs.io/docs/getting-started)
- [Conventional Commits](https://www.conventionalcommits.org/)

---

**Помните: хороший код - это код, который легко читать, понимать и поддерживать!** 🚀
