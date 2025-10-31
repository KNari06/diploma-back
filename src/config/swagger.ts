import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'QAI Backend API',
      version: '1.0.0',
      description: 'Quality Assurance Intelligence Backend API - автоматизированное тестирование веб-приложений с AI',
      contact: {
        name: 'QAI Support',
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
        url: 'https://api.qai.so',
        description: 'Production server',
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
      },
    },
    tags: [
      {
        name: 'Health',
        description: 'Health check endpoints',
      },
      {
        name: 'Tests',
        description: 'UI тестирование веб-приложений',
      },
      {
        name: 'Chat',
        description: 'AI чат с поддержкой API-тестирования',
      },
      {
        name: 'API Test',
        description: 'Прямое тестирование API endpoints',
      },
    ],
  },
  apis: [
    './src/api/**/*.route.ts',
    './src/api/**/*.routes.ts',
    './src/index.ts',
  ], // Путь к файлам с аннотациями
};

export const swaggerSpec = swaggerJsdoc(options);
