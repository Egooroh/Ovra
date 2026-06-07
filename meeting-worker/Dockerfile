FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS build
WORKDIR /app
# Prisma engine needs libssl (OpenSSL 3.x) on Alpine/musl.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build
RUN npx prisma generate

FROM node:20-alpine
WORKDIR /app
# Runtime also runs `prisma migrate deploy`, which needs libssl.
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json ./
COPY prisma ./prisma

# Применяем Prisma-миграции (таблицы Call/Transcript), затем запускаем оркестратор
ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy && node dist/orchestrator/index.js"]
