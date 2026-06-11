# Telegram-бот (У3): отдельный Node-сервис, общается с Go-бэкендом по HTTP.
FROM node:20-alpine
WORKDIR /app

# Сначала зависимости — кэшируется отдельно от исходников.
COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/data

# Бот работает на long-polling Telegram — входящий порт не нужен.
CMD ["npm", "start"]
