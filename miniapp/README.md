# Ovra Mini App

Telegram Mini App для онбординга, дайджеста задач и настроек воркспейса.
React + Vite + TypeScript, кастомный liquid-glass дизайн в брендовом `#3450CD`.

## Архитектура и безопасность

- Каждый запрос к API несёт подписанный Telegram `initData` в заголовке
  `Authorization: tma <initData>`. Go-бэкенд **переподписывает его HMAC-SHA256**
  ключом `TELEGRAM_BOT_TOKEN` ([miniapp_auth.go](../internal/transport/http/miniapp_auth.go)),
  поэтому `tg_id` нельзя подделать с клиента.
- `tenant_id` приходит из `start_param` **внутри подписанного** initData — он
  попадает туда только при запуске через `t.me/<bot>/<app>?startapp=<tenant>`.
- Роли: `host` (админ воркспейса) — подключение YouGile, выбор проекта, календарь;
  `member` — просмотр; join-флоу доступен любому, кто открыл подписанную ссылку.
- Секреты (API-ключ YouGile, креды календаря) уходят прямо на бэкенд по HTTPS,
  шифруются `APP_SECRET` и **никогда не хранятся в браузере**.

## Локальная разработка (на ПК)

Telegram требует HTTPS, поэтому Mini App нельзя открыть с `http://localhost`.
Нужен туннель.

1. **Backend** (из корня репозитория): задайте `TELEGRAM_BOT_TOKEN` и `APP_SECRET`
   в `.env`, поднимите Postgres и запустите `go run ./cmd/server`.

2. **Frontend dev-сервер**:
   ```bash
   cd miniapp
   npm install
   npm run dev          # http://localhost:5173, /app/api проксируется на :8080
   ```

3. **HTTPS-туннель** на dev-сервер (один из):
   ```bash
   cloudflared tunnel --url http://localhost:5173
   # или: ngrok http 5173
   ```
   Получите URL вида `https://<random>.trycloudflare.com`.

4. **@BotFather** → ваш бот → *Bot Settings* → *Configure Mini App* →
   *Enable* и укажите URL туннеля + `app` (короткое имя). Затем в `ovra_bot/.env`:
   ```
   MINIAPP_SHORT_NAME=app
   ```
   Перезапустите бота. Кнопка «🚀 Открыть приложение» в группе и команда `/app`
   откроют Mini App с привязкой к доске этой группы.

## Прод (Ubuntu VPS, позже)

Собранный бандл отдаёт сам Go-бэкенд под `/app/` — отдельный хостинг не нужен:

```bash
cd miniapp && npm ci && npm run build      # → miniapp/dist
# Backend читает MINIAPP_DIR (по умолчанию miniapp/dist) и раздаёт /app/
```

В @BotFather укажите URL вида `https://<ваш-домен>/app/`. Поставьте перед
бэкендом reverse-proxy с TLS (Caddy/Nginx) — и тот же домен обслуживает и API,
и статику (никакого CORS).

## Структура

```
src/
  theme.css            дизайн-система: glass-токены, аврора-фон, компоненты
  telegram.ts          обёртка над window.Telegram.WebApp (initData, haptics)
  api.ts               защищённый fetch-клиент (шлёт initData)
  components/ui.tsx     Glass, Button, Field, StepDots, Avatar, …
  screens/
    Onboarding.tsx     визард: подключить YouGile → выбрать проект → выбрать себя
    Digest.tsx         задачи по исполнителям
    Settings.tsx       дайджест, календари, роль
  App.tsx              bootstrap (/me), роутинг по роли/состоянию, таб-бар
```
