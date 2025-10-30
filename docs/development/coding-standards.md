# 📋 Coding Standards

Этот документ описывает стандарты кодирования для проекта QAI Backend.

## 🎯 Общие принципы

### 1. **Читаемость превыше всего**
- Код должен быть понятен без комментариев
- Используйте осмысленные имена переменных и функций
- Избегайте магических чисел и строк

### 2. **Принцип DRY (Don't Repeat Yourself)**
- Не дублируйте код
- Выносите общую логику в утилиты
- Используйте переиспользуемые компоненты

### 3. **Принцип SOLID**
- **S** - Single Responsibility Principle
- **O** - Open/Closed Principle
- **L** - Liskov Substitution Principle
- **I** - Interface Segregation Principle
- **D** - Dependency Inversion Principle

## 📝 TypeScript

### Именование

```typescript
// ✅ Хорошо
interface UserData {
  id: string;
  email: string;
  createdAt: Date;
}

class UserService {
  async getUserById(id: string): Promise<UserData> {
    // implementation
  }
}

const API_BASE_URL = 'https://api.qai.so';

// ❌ Плохо
interface userdata {
  ID: string;
  Email: string;
  created_at: Date;
}

class userservice {
  async getuserbyid(id: string) {
    // implementation
  }
}

const api_base_url = 'https://api.qai.so';
```

### Типизация

```typescript
// ✅ Строгая типизация
interface CreateUserRequest {
  email: string;
  password: string;
  name?: string;
}

async function createUser(data: CreateUserRequest): Promise<UserData> {
  // implementation
}

// ❌ Избегайте any
async function createUser(data: any): Promise<any> {
  // implementation
}
```

### Обработка ошибок

```typescript
// ✅ Хорошо
try {
  const user = await userService.getUserById(id);
  return { success: true, data: user };
} catch (error) {
  logger.error('Failed to get user:', error);
  throw new NotFoundError('User not found');
}

// ❌ Плохо
try {
  const user = await userService.getUserById(id);
  return user;
} catch (error) {
  console.log(error);
  return null;
}
```

## 🏗️ Архитектура

### Структура файлов

```
src/
├── api/              # API слой
│   ├── routes/       # Маршруты
│   ├── middleware/   # Middleware
│   └── validators/   # Валидаторы
├── services/         # Бизнес-логика
├── repositories/     # Доступ к данным
├── models/           # Модели данных
├── types/            # TypeScript типы
├── utils/            # Утилиты
└── config/           # Конфигурация
```

### Слои приложения

```typescript
// API Layer
export class UserController {
  constructor(private userService: UserService) {}

  async createUser(req: Request, res: Response) {
    const userData = req.body;
    const user = await this.userService.createUser(userData);
    res.json({ success: true, data: user });
  }
}

// Service Layer
export class UserService {
  constructor(private userRepository: UserRepository) {}

  async createUser(data: CreateUserRequest): Promise<UserData> {
    // Бизнес-логика
    const hashedPassword = await this.hashPassword(data.password);
    return this.userRepository.create({ ...data, password: hashedPassword });
  }
}

// Repository Layer
export class UserRepository {
  async create(data: CreateUserData): Promise<UserData> {
    // Доступ к данным
    return this.db.users.create(data);
  }
}
```

## 🧪 Тестирование

### Unit тесты

```typescript
// ✅ Хорошо
describe('UserService', () => {
  let userService: UserService;
  let mockUserRepository: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockUserRepository = {
      create: jest.fn(),
      findById: jest.fn(),
    } as any;

    userService = new UserService(mockUserRepository);
  });

  it('should create user with hashed password', async () => {
    const userData = { email: 'test@example.com', password: 'password123' };
    const expectedUser = { id: '1', email: 'test@example.com' };

    mockUserRepository.create.mockResolvedValue(expectedUser);

    const result = await userService.createUser(userData);

    expect(mockUserRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
        password: expect.not.stringMatching('password123')
      })
    );
    expect(result).toEqual(expectedUser);
  });
});
```

### Integration тесты

```typescript
// ✅ Хорошо
describe('POST /api/users', () => {
  it('should create user successfully', async () => {
    const userData = {
      email: 'test@example.com',
      password: 'password123',
      name: 'Test User'
    };

    const response = await request(app)
      .post('/api/users')
      .send(userData)
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        email: 'test@example.com',
        name: 'Test User'
      }
    });
  });
});
```

## 🔒 Безопасность

### Валидация входных данных

```typescript
// ✅ Хорошо
const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

export const createUserValidator = (req: Request, res: Response, next: NextFunction) => {
  try {
    req.body = createUserSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({ error: 'Invalid input data' });
  }
};
```

### Обработка секретов

```typescript
// ✅ Хорошо
const config = {
  jwtSecret: process.env.JWT_SECRET!,
  dbUrl: process.env.DATABASE_URL!,
};

// ❌ Плохо
const jwtSecret = 'my-secret-key';
const dbUrl = 'postgresql://user:password@localhost:5432/db';
```

## 📊 Производительность

### Асинхронность

```typescript
// ✅ Хорошо - параллельное выполнение
const [users, posts, comments] = await Promise.all([
  userService.getUsers(),
  postService.getPosts(),
  commentService.getComments(),
]);

// ❌ Плохо - последовательное выполнение
const users = await userService.getUsers();
const posts = await postService.getPosts();
const comments = await commentService.getComments();
```

### Кэширование

```typescript
// ✅ Хорошо
class UserService {
  private cache = new Map<string, UserData>();

  async getUserById(id: string): Promise<UserData> {
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }

    const user = await this.userRepository.findById(id);
    this.cache.set(id, user);
    return user;
  }
}
```

## 📝 Документация

### JSDoc комментарии

```typescript
/**
 * Создает нового пользователя в системе
 * @param userData - Данные пользователя для создания
 * @param userData.email - Email пользователя (обязательно)
 * @param userData.password - Пароль пользователя (обязательно)
 * @param userData.name - Имя пользователя (опционально)
 * @returns Promise с данными созданного пользователя
 * @throws {ValidationError} Если данные невалидны
 * @throws {ConflictError} Если пользователь уже существует
 * @example
 * ```typescript
 * const user = await userService.createUser({
 *   email: 'user@example.com',
 *   password: 'password123',
 *   name: 'John Doe'
 * });
 * ```
 */
async createUser(userData: CreateUserRequest): Promise<UserData> {
  // implementation
}
```

## 🧹 Линтинг и форматирование

### ESLint правила

```typescript
// ✅ Хорошо
const userService = new UserService();
const users = await userService.getUsers();

// ❌ Плохо (неиспользуемая переменная)
const userService = new UserService();
const users = await userService.getUsers();
const unusedVariable = 'not used';
```

### Prettier настройки

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 80,
  "tabWidth": 2
}
```

## 🔄 Git workflow

### Ветки

- `main` - продакшн код
- `develop` - разработка
- `feature/feature-name` - новые функции
- `fix/bug-description` - исправления
- `hotfix/urgent-fix` - критические исправления

### Коммиты

```bash
# ✅ Хорошо
feat(api): add user authentication endpoint
fix(auth): resolve JWT token validation
docs: update API documentation
refactor(service): simplify user creation logic

# ❌ Плохо
fix bug
update code
changes
```

## 📚 Дополнительные ресурсы

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Express.js Security](https://expressjs.com/en/advanced/best-practice-security.html)
- [Jest Testing](https://jestjs.io/docs/getting-started)

---

**Помните: хороший код - это код, который легко читать, понимать и поддерживать!** 🚀
