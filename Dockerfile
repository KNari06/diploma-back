# --- Используем официальный образ с Playwright ---
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS base

WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем все зависимости без Husky
ENV HUSKY=0
RUN npm install --ignore-scripts

# Копируем весь проект
COPY . .

# Собираем TypeScript → dist/
RUN npm run build

# Переключаемся в production режим
ENV NODE_ENV=production

EXPOSE 3000

# Запускаем backend
CMD ["node", "-r", "module-alias/register", "dist/index.js"]

