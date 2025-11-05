# --- Build stage ---
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
ENV HUSKY=0
RUN npm ci

# Копируем исходники и билдим
COPY . .
RUN npx tsc -p tsconfig.build.json

# --- Runtime stage ---
FROM node:22-slim AS runner
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Кладём сборку
COPY --from=builder /app/dist ./dist

# 👇 КЛЮЧЕВОЕ: кладём и исходники, чтобы swagger-jsdoc мог сканировать src/**/*.ts
COPY --from=builder /app/src ./src

# tsconfig-paths для алиасов в рантайме ( @/* -> dist/* )
RUN printf '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["dist/*"] }\n  }\n}\n' > /app/tsconfig.json

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "-r", "tsconfig-paths/register", "dist/index.js"]
