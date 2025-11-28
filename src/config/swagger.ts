import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'QAIT Backend API',
      version: '1.0.0',
      description: 'Quality Assurance Intelligence Testing Backend API - автоматизированное тестирование веб-приложений с AI',
      contact: {
        name: 'QAIT Support',
        email: 'support@qai.so',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: `http://localhost:${env.PORT}`,
        description: 'Development server',
      },
      {
        url: 'http://34.172.156.158:3000',
        description: 'Cloud server (GCP)',
      },
      {
        url: process.env.API_BASE_URL || `http://localhost:${env.PORT}`,
        description: 'Production server',
      },
      {
        url: 'https://api.qai.so',
        description: 'Production server (HTTPS)',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT токен для аутентификации',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API ключ для аутентификации',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            error: {
              type: 'string',
              example: 'Error message',
            },
            code: {
              type: 'string',
              example: 'ERROR_CODE',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        ApiResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true,
            },
            data: {
              type: 'object',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        AuthUser: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              example: '00000000-0000-0000-0000-000000000002',
            },
            email: {
              type: 'string',
              format: 'email',
              example: 'user@example.com',
            },
            name: {
              type: 'string',
              example: 'John Doe',
            },
            role: {
              type: 'string',
              enum: ['admin', 'user', 'ai'],
              example: 'user',
            },
          },
        },
        AuthTokens: {
          type: 'object',
          properties: {
            access_token: {
              type: 'string',
              description: 'JWT access token',
              example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            },
            refresh_token: {
              type: 'string',
              description: 'Refresh token для обновления access token',
              example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            },
            expires_in: {
              type: 'integer',
              description: 'Время жизни access token в секундах',
              example: 3600,
            },
          },
        },
      },
    },
    tags: [
      {
        name: 'Auth',
        description: 'Аутентификация и управление пользователями (Email/Password, Magic Links, OAuth)',
      },
      {
        name: 'Health',
        description: 'Health check endpoints',
      },
      {
        name: 'Manual Tests',
        description: 'Ручное тестирование веб-приложений через Playwright (требует auth)',
      },
      {
        name: 'Chat',
        description: 'AI чат с поддержкой API-тестирования (требует auth)',
      },
      {
        name: 'API Test',
        description: 'Прямое тестирование API endpoints (требует auth)',
      },
      {
        name: 'Jira',
        description: 'Jira OAuth 2.0 интеграция (требует auth)',
      },
      {
        name: 'Test Visualization',
        description: 'Визуализация тестовых шагов как нейронная сеть (граф nodes + edges) (требует auth)',
      },
      {
        name: 'Intelligent Tests',
        description: 'AI-генерированные intelligent test сессии с детальной визуализацией (требует auth)',
      },
      {
        name: 'Knowledge Base',
        description: 'Управление базой знаний и RAG поиск (требует auth)',
      },
      {
        name: 'Playwright',
        description: 'Работа с Playwright trace файлами и видео (требует auth)',
      },
      {
        name: 'Workspaces',
        description: 'Управление рабочими пространствами и проектами',
      },
      {
        name: 'Reports',
        description: 'Генерация и получение отчетов о тестировании (требует auth)',
      },
      {
        name: 'Notifications',
        description: 'Управление уведомлениями пользователя (персональные, общие, системные) (требует auth)',
      },
      {
        name: 'User',
        description: 'Управление профилем пользователя, кредитами и планами (требует auth)',
      },
    ],
  },
  apis: [
    // Динамически определяем путь в зависимости от окружения
    process.env.NODE_ENV === 'production'
      ? ['./dist/api/**/*.js', './dist/index.js']
      : ['./src/api/**/*.route.ts', './src/api/**/*.routes.ts', './src/index.ts']
  ].flat(), // Путь к файлам с аннотациями
};

export const swaggerSpec = swaggerJsdoc(options);
