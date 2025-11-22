# --- Build stage ---
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
ENV HUSKY=0
RUN npm ci

# Copy source files (note: .env is excluded via .dockerignore)
# Environment variables should be passed via docker run -e or --env-file at runtime
COPY . .
RUN npx tsc -p tsconfig.build.json

# --- Runtime stage ---
FROM node:22-slim AS runner
WORKDIR /app

# Install system dependencies for Playwright browsers
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Install Playwright browsers (Chromium only for optimization)
RUN npx playwright install chromium --with-deps

# Кладём сборку
COPY --from=builder /app/dist ./dist

# 👇 КЛЮЧЕВОЕ: кладём и исходники, чтобы swagger-jsdoc мог сканировать src/**/*.ts
COPY --from=builder /app/src ./src

# Копируем данные (Global KB embeddings)
COPY --from=builder /app/data ./data

# tsconfig-paths для алиасов в рантайме ( @/* -> dist/* )
RUN printf '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["dist/*"] }\n  }\n}\n' > /app/tsconfig.json

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "-r", "tsconfig-paths/register", "dist/index.js"]
