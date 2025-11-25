# QAI Backend - Development Guide

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Redis
- Supabase account
- OpenAI API key

### Installation

```bash
# Clone repository
git clone <repository-url>
cd qai-backend

# Install dependencies
npm install

# Copy environment variables
cp env.example .env

# Edit .env with your configuration
nano .env
```

### Environment Setup

Create a `.env` file with the following variables:

```env
# Server Configuration
NODE_ENV=development
PORT=3000
API_VERSION=v1

# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_BUCKET_NAME=qai-assets

# Redis Configuration
REDIS_URL=redis://35.202.242.230:6379

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o
OPENAI_MAX_TOKENS=4000

# Security
JWT_SECRET=your_jwt_secret_32_chars_min
API_KEY_SECRET=your_api_key_secret_32_chars_min
```

### Database Setup

1. Create a new Supabase project
2. Run the SQL schema from `supabase-schema.sql`
3. Create a storage bucket named `qai-assets`
4. Set up RLS policies as defined in the schema

### Running the Application

```bash
# Development mode (API server)
npm run dev

# In another terminal (Worker)
npm run worker

# Build for production
npm run build

# Start production
npm start
```

## 🏗️ Architecture Overview

### Project Structure

```
src/
├── api/                 # API routes and controllers
│   └── test.routes.ts   # Test-related endpoints
├── services/            # Business logic services
│   ├── ai.service.ts    # AI/GPT integration
│   └── test.service.ts  # Test management logic
├── jobs/                # Queue job handlers
│   ├── test-run.job.ts  # Test execution jobs
│   └── ai-analysis.job.ts # AI analysis jobs
├── db/                  # Database layer
│   └── supabase.ts      # Supabase client and operations
├── config/              # Configuration files
│   ├── env.ts           # Environment variables
│   └── queues.ts        # BullMQ queue setup
├── utils/               # Utility functions
│   ├── logger.ts        # Logging configuration
│   ├── error-handler.ts # Error handling middleware
│   └── validation.ts    # Input validation schemas
├── types/               # TypeScript type definitions
│   └── index.ts         # Main type definitions
├── worker/              # Background worker
│   └── index.ts         # Worker entry point
└── index.ts             # Main API server
```

### Key Components

#### 1. API Layer (`/api`)

- RESTful endpoints for test management
- Request validation and response formatting
- Authentication and authorization (future)

#### 2. Services Layer (`/services`)

- **TestService**: Core test management logic
- **AIService**: GPT integration for analysis

#### 3. Queue System (`/jobs`, `/config/queues`)

- **BullMQ** for job processing
- **Redis** for queue storage
- Background workers for async processing

#### 4. Database Layer (`/db`)

- **Supabase** client configuration
- Type-safe database operations
- Row Level Security (RLS) policies

## 🔄 Workflow

### Test Execution Flow

1. **API Request** → `POST /tests/run`
2. **Validation** → Input validation and user checks
3. **Test Creation** → Database record creation
4. **Queue Jobs** → Test run jobs added to queue
5. **Worker Processing** → Jobs picked up by workers
6. **Agent Communication** → Test sent to Playwright agents
7. **Result Processing** → Results received and stored
8. **AI Analysis** → GPT analysis of results
9. **Notifications** → Alerts and webhooks sent

### Queue Architecture

```
test-run → test-result → ai-analysis → notification/webhook
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- test.service.test.ts
```

### Test Structure

- Unit tests for services and utilities
- Integration tests for API endpoints
- Mock external dependencies (Supabase, OpenAI, Redis)

## 🐳 Docker Development

```bash
# Build and run with Docker Compose
docker-compose up --build

# Run only specific services
docker-compose up redis api worker

# View logs
docker-compose logs -f api
docker-compose logs -f worker
```

## 📊 Monitoring

### Health Checks

- **API Health**: `GET /health`
- **Queue Health**: Included in API health check
- **Database Health**: Supabase connection test

### Logging

- **Winston** for structured logging
- **Morgan** for HTTP request logging
- **Log levels**: error, warn, info, http, debug

### Metrics

- Queue job counts and processing times
- API response times and error rates
- Database query performance

## 🔧 Development Tools

### Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Type checking
npm run type-check
```

### Database Management

```bash
# Connect to Supabase CLI
supabase login
supabase link --project-ref your-project-ref

# Run migrations
supabase db push

# Generate types
supabase gen types typescript --local > src/types/database.ts
```

## 🚀 Deployment

### Environment Variables

Ensure all required environment variables are set in production:

- Database credentials
- Redis connection string
- OpenAI API key
- Security secrets
- External service URLs

### Scaling Considerations

1. **Horizontal Scaling**: Multiple worker instances
2. **Queue Scaling**: Redis Cluster for high availability
3. **Database Scaling**: Supabase auto-scaling
4. **Load Balancing**: Nginx or cloud load balancer

### Production Checklist

- [ ] Environment variables configured
- [ ] Database schema deployed
- [ ] Redis cluster setup
- [ ] SSL certificates configured
- [ ] Monitoring and alerting setup
- [ ] Backup strategy implemented
- [ ] Security headers configured
- [ ] Rate limiting enabled

## 🔐 Security

### Authentication (Future)

- JWT-based authentication
- API key authentication
- OAuth integration

### Data Protection

- Input validation and sanitization
- SQL injection prevention (Supabase RLS)
- XSS protection
- CSRF protection

### Rate Limiting

- Per-user rate limits
- Per-endpoint rate limits
- Queue-based rate limiting

## 🐛 Troubleshooting

### Common Issues

1. **Redis Connection Failed**

   - Check Redis server status
   - Verify connection string
   - Check firewall settings

2. **Supabase Connection Failed**

   - Verify API keys
   - Check project status
   - Verify RLS policies

3. **OpenAI API Errors**

   - Check API key validity
   - Verify rate limits
   - Check model availability

4. **Queue Jobs Not Processing**
   - Check worker status
   - Verify Redis connection
   - Check job error logs

### Debug Mode

```bash
# Enable debug logging
LOG_LEVEL=debug npm run dev

# Enable verbose queue logging
DEBUG=bullmq:* npm run worker
```

## 📚 API Documentation

### Test Endpoints

- `POST /api/v1/tests/run` - Create and run test
- `GET /api/v1/tests/:id` - Get test details
- `GET /api/v1/tests/:id/result` - Get test results
- `POST /api/v1/tests/:id/cancel` - Cancel test
- `POST /api/v1/tests/:id/retry` - Retry test

### Health Endpoints

- `GET /health` - System health check
- `GET /` - API information

## 📖 Implementation Documentation

### Features & Fixes

- [**Chat Vector Context**](./chat-vector-context.md) - Векторный контекст для чата
- [**WebSocket Progress Implementation**](./websocket-progress-implementation-plan.md) - Реализация WebSocket прогресса
- [**AI Capabilities Fix**](./AI_CAPABILITIES_FIX.md) - Исправление "забывания" возможностей AI
- [**API Test WebSocket Fix**](./API_TEST_WEBSOCKET_FIX.md) - Исправление WebSocket для API тестов
- [**Multi-Chat Implementation**](./MULTI_CHAT_IMPLEMENTATION.md) - Реализация мультичата
- [**API Test Debug Guide**](./API_TEST_DEBUG_GUIDE.md) - Руководство по отладке API тестов
- [**Analytics Implementation**](./ANALYTICS_IMPLEMENTATION_COMPLETE.md) - Реализация аналитики
- [**Analytics Review**](./ANALYTICS_REVIEW.md) - Обзор аналитики
- [**Feedback Feature Summary**](./FEEDBACK_FEATURE_SUMMARY.md) - Сводка по фиче feedback

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details
