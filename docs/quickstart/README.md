# 🚀 QAI Backend - Quick Start Guide

## Prerequisites

- **Node.js 18+** - [Download](https://nodejs.org/)
- **Redis** - [Install Redis](https://redis.io/download)
- **Supabase Account** - [Sign up](https://supabase.com/)
- **OpenAI API Key** - [Get API key](https://platform.openai.com/)

## ⚡ 5-Minute Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment

```bash
# Copy environment template
cp env.example .env

# Edit with your credentials
nano .env
```

**Required Environment Variables:**
```env
# Supabase (Required)
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# OpenAI (Required)
OPENAI_API_KEY=your_openai_api_key

# Redis (Required)
REDIS_URL=redis://35.202.242.230:6379

# Security (Required)
JWT_SECRET=your_32_character_secret_key_here
API_KEY_SECRET=your_32_character_api_secret_here
```

### 3. Setup Database

1. **Create Supabase Project:**
   - Go to [supabase.com](https://supabase.com/)
   - Create new project
   - Note down your project URL and API keys

2. **Run Database Schema:**
   ```sql
   -- Copy and paste the contents of supabase-schema.sql
   -- into your Supabase SQL editor and run it
   ```

3. **Create Storage Bucket:**
   - Go to Storage in Supabase dashboard
   - Create bucket named `qai-screenshots`
   - Set to public if needed

### 4. Start Redis

```bash
# On macOS with Homebrew
brew install redis
brew services start redis

# On Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis

# On Windows
# Download and install Redis from official website
```

### 5. Run the Application

```bash
# Terminal 1: Start API server
npm run dev

# Terminal 2: Start worker
npm run worker
```

## 🧪 Test the API

### Health Check
```bash
curl http://localhost:3000/health
```

### Create a Test
```bash
curl -X POST http://localhost:3000/api/v1/tests/run \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "browsers": ["chrome", "firefox"],
    "projectId": "00000000-0000-0000-0000-000000000001"
  }'
```

### Check Test Status
```bash
curl http://localhost:3000/api/v1/tests/{test-id}
```

## 🐳 Docker Alternative

If you prefer Docker:

```bash
# Start with Docker Compose
docker-compose up --build

# This will start:
# - Redis
# - API server
# - Worker
# - Nginx (optional)
```

## 📊 Monitor the System

### API Health
- **Health Check**: http://localhost:3000/health
- **API Info**: http://localhost:3000/

### Queue Status
```bash
# Check queue stats (if implemented)
curl http://localhost:3000/api/v1/queue/stats
```

### Logs
```bash
# View API logs
npm run dev

# View worker logs
npm run worker

# Docker logs
docker-compose logs -f api
docker-compose logs -f worker
```

## 🔧 Common Issues

### Redis Connection Failed
```bash
# Check if Redis is running
redis-cli ping
# Should return: PONG

# If not running, start Redis
redis-server
```

### Supabase Connection Failed
- Verify your Supabase URL and keys
- Check if your project is active
- Ensure RLS policies are set up correctly

### OpenAI API Errors
- Verify your API key is valid
- Check if you have credits available
- Ensure the model is accessible

### Port Already in Use
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or change port in .env
PORT=3001
```

## 🚀 Next Steps

1. **Read the full documentation**: [DEVELOPMENT.md](./DEVELOPMENT.md)
2. **Set up monitoring**: Configure logging and metrics
3. **Deploy to production**: Use Railway, Render, or your preferred platform
4. **Add authentication**: Implement user management
5. **Scale the system**: Add more workers and optimize performance

## 📚 API Reference

### Test Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/tests/run` | Create and run test |
| GET | `/api/v1/tests/:id` | Get test details |
| GET | `/api/v1/tests/:id/result` | Get test results |
| POST | `/api/v1/tests/:id/cancel` | Cancel test |
| POST | `/api/v1/tests/:id/retry` | Retry test |

### Health Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | System health check |
| GET | `/` | API information |

## 🆘 Need Help?

- **Documentation**: Check [DEVELOPMENT.md](./DEVELOPMENT.md)
- **Issues**: Create an issue on GitHub
- **Discord**: Join our community (if available)
- **Email**: support@qai.so

---

**Happy Testing! 🎉**
