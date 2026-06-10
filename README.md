# Ovra

Telegram-ассистент для управления задачами: ловит задачи из чата и со звонков,
подтверждает их и создаёт карточки в **YouGile**. Состоит из четырёх сервисов в
Docker Compose плюс Telegram **Mini App** для онбординга доски.

```
┌────────────┐    события/задачи     ┌──────────────┐   REST    ┌──────────┐
│  ovra_bot  │ ────────────────────▶ │  app (Go)    │ ────────▶ │ YouGile  │
│ (Telegram) │ ◀──────────────────── │  API-шлюз    │           └──────────┘
└────────────┘  дайджест/напоминания └──────┬───────┘
      ▲  web_app кнопка                      │ pgx
      │                                ┌──────▼───────┐
┌─────┴────────┐  саммари встреч       │  postgres    │
│ Mini App     │  POST /v1/meetings    │  (schema:    │
│ (miniapp.html│◀──────────────┐       │  public +    │
│  в app)      │               │       │  meeting)    │
└──────────────┘        ┌──────┴───────┴──────────────┐
   ▲ Cloudflare         │      meeting-worker (TS)     │
   │ tunnel             │  Telemost + SpeechKit + LLM  │
 Telegram               │  + календари Google/Yandex   │
                        └──────────────────────────────┘
```

| Сервис           | Стек                         | Назначение                                                                 |
|------------------|------------------------------|----------------------------------------------------------------------------|
| **app**          | Go 1.26                      | API-шлюз, очередь, воркер задач, интеграция YouGile, хостит Mini App        |
| **ovra_bot**     | Node + Telegraf (TS)         | Telegram-бот: парсинг задач, подтверждения, дайджесты, команды             |
| **meeting-worker** | Node + Prisma (TS)         | Подключается к звонкам (Telemost), транскрибирует (Yandex SpeechKit), делает саммари (LLM), читает календари |
| **postgres**     | postgres:16-alpine           | Общая БД: схема `public` (Go) + схема `meeting` (Prisma воркера)            |

---

## Требования

- **Docker** + **Docker Compose v2** (`docker compose`, не `docker-compose`).
- Токен Telegram-бота от [@BotFather](https://t.me/BotFather).
- Аккаунт **YouGile** (логин/пароль или API-ключ) — вводится через бота/Mini App.
- *(Опционально)* ключ **OpenRouter** — AI-парсинг задач, классификация колонок, саммари встреч.
- *(Опционально)* **Yandex SpeechKit** + **Google/Yandex Calendar** — для meeting-worker.
- *(Для прода)* публичный **HTTPS** для Mini App — например, через **Cloudflare Tunnel**.

---

## Конфигурация

Три файла окружения (каждый копируется из своего `.env.example`):

| Файл                    | Кем читается              | Ключевые переменные                                                        |
|-------------------------|---------------------------|---------------------------------------------------------------------------|
| `.env` (корень)         | `app`, общие              | `APP_SECRET`, `TELEGRAM_BOT_TOKEN`, `MINI_APP_URL`, `OPENROUTER_API_KEY`, `YOUGILE_API_TOKEN`, `DEADLINE_TZ` |
| `ovra_bot/.env`         | `bot`                     | `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `TENANT_ID`, `CONFIRM_TARGET`, `PROXY_URL`, `APP_SECRET` |
| `meeting-worker/.env`   | `meeting-worker`          | `OPENROUTER_*`, `YANDEX_API_KEY`/`YANDEX_FOLDER_ID`, `GOOGLE_SA_JSON`, `YANDEX_CALDAV_*`, `ORCH_*`, `WORKER_*` |

```bash
cp .env.example .env
cp ovra_bot/.env.example ovra_bot/.env
cp meeting-worker/.env.example meeting-worker/.env
# заполнить токены в каждом
```

> ⚠️ **`APP_SECRET` должен совпадать** в корневом `.env` и `ovra_bot/.env` — это
> ключ шифрования токенов YouGile (AES-256-GCM). В проде задайте сильное значение
> и не используйте `dev-only-change-me`. Без `APP_SECRET` хранение кредов отключается.

> ⚠️ **`TELEGRAM_BOT_TOKEN` нужен и боту, и app** — бот общается с Telegram, а app
> проверяет подпись `initData` Mini App тем же токеном.

Тенанты (воркспейсы) описываются в `workspace.yaml` и синхронизируются в таблицу
`workspaces` при старте app.

---

## Запуск

### Всё разом (Docker)

```bash
docker compose up -d --build
```

Поднимет postgres → app (применит миграции, засеет воркспейсы) → meeting-worker → bot.
Проверка живости:

```bash
curl http://localhost:8080/healthz
# {"status":"ok","workspaces":1}
```

Логи: `docker compose logs -f app` (или `bot` / `meeting-worker`).

### Только backend локально (без Docker)

Нужен Postgres — можно поднять только сервис БД из compose:

```bash
docker compose up -d postgres     # Postgres на хостовом порту 5433
go run ./cmd/server
```

> Хостовый порт Postgres — **5433** (чтобы не конфликтовать с локальным PostgreSQL).
> Внутри compose-сети сервисы ходят на `postgres:5432`.

### Бот / meeting-worker локально

```bash
cd ovra_bot && npm install && npm run dev
cd meeting-worker && npm install && npm run dev
```

---

## Деплой (продакшен)

1. **VPS** (Ubuntu) с Docker + Compose. Склонировать репозиторий, заполнить три `.env`.
2. **Mini App нужен публичный HTTPS.** app слушает `:8080` по HTTP — наружу его
   отдаёт **Cloudflare Tunnel** (`cloudflared`), который терминирует TLS:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   # или именованный туннель с конфигом, привязанным к домену
   ```
   Полученный `https://<домен>` пропишите в `MINI_APP_URL` (корневой `.env` **и**
   `ovra_bot/.env`) — на него ведут `web_app`-кнопки бота.
3. В **@BotFather** зарегистрируйте Mini App (Main App / direct link) на тот же URL;
   задайте `MINIAPP_SHORT_NAME`, если используете `startapp`-ссылки.
4. `docker compose up -d --build`.

> Cloudflare Tunnel **не кэширует** ответы (в отличие от проксируемого DNS с
> «оранжевым облаком») — purge кэша не нужен. app уже отдаёт Mini App с
> `Cache-Control: no-cache`.

---

## Как применять изменения

**Главное правило:** реальные сервисы крутятся в Docker, а Go-бэкенд встраивает
HTML/SQL в бинарь через `//go:embed`. Правка файла **не подхватится**, пока образ
не пересобран. Перезапуск контейнера без `--build` запускает **старый** образ.

| Что изменили                                  | Команда                                              | Почему                                                          |
|-----------------------------------------------|------------------------------------------------------|----------------------------------------------------------------|
| Go-код, `miniapp.html`, `migrations/*.sql`    | `docker compose up -d --build app`                   | `miniapp.html` и миграции вшиты через `//go:embed` → нужна пересборка |
| `ovra_bot/src/**`                             | `docker compose up -d --build bot`                   | TS компилируется внутри образа                                 |
| `meeting-worker/src/**`                       | `docker compose up -d --build meeting-worker`        | то же + Prisma client                                          |
| `workspace.yaml`                              | `docker compose restart app`                         | монтируется как volume (ro) → пересборка не нужна, только рестарт |
| Только переменные в `.env`                    | `docker compose up -d <service>`                     | Compose пересоздаст контейнер с новым окружением               |

Проверить, что новый код реально отдаётся:

```bash
curl -s http://localhost:8080/healthz
# для Mini App — что новый HTML внутри образа:
curl -s http://localhost:8080/miniapp/ | grep -c "<нужная строка>"
```

> 🔸 **Кэш Telegram WebView.** После деплоя Mini App Telegram держит старую версию
> на устройстве. Полностью закройте окно мини-аппа (свайп вниз) и переоткройте;
> при необходимости — Telegram → Settings → Data and Storage → Clear Cache.
> Для быстрой проверки откройте `https://<домен>/miniapp/` в обычном браузере.

### Миграции БД

SQL-файлы в `migrations/` вшиты в бинарь и применяются **автоматически на старте
app** (идемпотентный раннер, версии в `schema_migrations`). Чтобы добавить
миграцию: положите новый `NNNN_name.sql` → `docker compose up -d --build app`.

Миграции **meeting-worker** живут отдельно (Prisma, схема `meeting`), применяются
при старте воркера — не конфликтуют с таблицами Go в схеме `public`.

---

## Список фич

### Telegram-бот (`ovra_bot`)

- **Парсинг задач из чата** — текст в группе разбирается (эвристики + AI через
  OpenRouter) в задачу: заголовок, исполнитель, дедлайн.
- **Подтверждение задач** — задача создаётся только после аппрува (кнопки
  ✅/✏️/❌ или реакция на сообщение). Режим `/confirm_mode`: только админ / любой участник.
- **Голосовые → задачи** — голосовое сообщение транскрибируется (Yandex SpeechKit) и парсится.
- **Документы** — загруженный файл прикладывается к задаче.
- **Дайджест** — `/digest` показывает задачи; `/digest_time` задаёт время ежедневной авто-рассылки.
- **Напоминания о дедлайнах** — личный пинг исполнителю за ~24 ч до срока и при просрочке.
- **Доска** — `/board` показывает состояние колонок YouGile; `/sync` подтягивает изменения с доски.
- **Корзина** — `/trash` показывает удалённые задачи; авто-очистка через 24 ч.
- **Статистика** — `/stats`.
- **Календарь** — `/calendar`: подключение Google (service account) / Yandex (CalDAV) для авто-захода воркера на встречи.
- **Команды**: `/start`, `/setup`, `/bind`, `/board`, `/digest`, `/digest_time`,
  `/trash`, `/sync`, `/stats`, `/calendar`, `/confirm`, `/confirm_mode`, `/help`.

### Backend (`app`, Go)

- **API-шлюз** для бота и воркера; задачи → карточки YouGile (`col_todo`), движение
  по статусам (`todo/in_progress/review/done`) двигает карточку.
- **Per-workspace креды YouGile** — шифрование AES-256-GCM, пароль не персистится.
- **Очередь событий** (in-memory, каналы) + воркер с роутингом по `type`.
- **AI-классификация колонок** и **дедупликация задач** (pg_trgm + LLM-судья) — при наличии `OPENROUTER_API_KEY`.
- **Авто-синк YouGile → Ovra** каждые 5 мин (удаление на доске → soft-delete в Ovra).
- **Планировщики**: дайджест (тик 1 мин), напоминания (5 мин), очистка корзины (1 ч).
- **Mini App** — встроенная HTML-страница онбординга доски (см. ниже).
- **Наблюдаемость**: структурный JSON-лог на каждый запрос, recovery-middleware, graceful shutdown.

### Mini App (`internal/transport/http/miniapp.html`)

- Онбординг доски YouGile из Telegram: ввод API-ключа **или** логин/пароль (с выбором компании).
- Список «Мои доски», профиль с **аватаркой из Telegram** и ролью (host/member).
- Безопасность: каждый запрос несёт Telegram `initData`; app **повторно
  проверяет HMAC-SHA256** токеном бота. `tenant_id` приходит в подписанном `start_param`.
- Брендинг: фирменный цвет `#3450CD`, логотип Ovra в шапке.

### Meeting-worker (`meeting-worker`)

- **Оркестратор** опрашивает БД и поднимает звонки к началу встречи (Telemost).
- **Захват аудио** (ffmpeg/WebRTC) → **транскрипция** Yandex SpeechKit (gRPC, ru-RU).
- **Саммари встречи** через LLM → `POST /v1/meetings/summary` в backend → задачи в боте.
- **Календари**: Google (service account) и Yandex (CalDAV) — авто-обнаружение встреч.

---

## API (backend)

| Метод/путь                                         | Назначение                                  |
|----------------------------------------------------|---------------------------------------------|
| `GET /healthz`                                     | живость + число тенантов                    |
| `POST /v1/workspaces` · `GET /v1/workspaces/{t}`   | создать / получить воркспейс                |
| `POST /v1/workspaces/{t}/credentials`              | сохранить креды YouGile (ключ или логин/пароль) |
| `POST /v1/workspaces/{t}/board/resolve`            | сопоставить доску и колонки                 |
| `POST /v1/workspaces/{t}/sync`                     | синхронизация с YouGile                     |
| `POST /v1/tasks` · `PATCH /v1/tasks/{id}` · `DELETE /v1/tasks/{id}` | создать / сменить статус / удалить задачу |
| `GET /v1/workspaces/{t}/tasks` · `/trash` · `/digest` | списки задач / корзины / дайджеста        |
| `PATCH /v1/workspaces/{t}/digest` · `/confirm-mode` | настройки дайджеста и режима подтверждения |
| `POST /v1/events`                                  | приём событий в очередь (async, `202`)      |
| `POST /v1/meetings/summary`                        | приём саммари встречи от воркера            |
| `*/calendar/accounts`                              | управление календарными аккаунтами          |
| `GET /metrics`                                     | метрики                                      |
| `GET /` · `GET /miniapp/` · `POST /miniapp/{verify,connect,workspaces,companies}` | Mini App |

Тело — JSON; ошибки — конверт `{"error":"..."}`. Сбой YouGile после записи в БД
отдаётся `502` вместе с сохранённой задачей (публикацию можно повторить).

---

## Тесты

```bash
go test ./...          # backend
```

- `internal/secret` — юнит-тесты шифрования (без БД).
- `internal/storage` — интеграционные, **требуют Postgres** (DSN из `OVRA_TEST_DSN`,
  по умолчанию `localhost:5433`); при недоступной БД — skipped.

---

## Troubleshooting

| Симптом                                            | Причина / решение                                                        |
|----------------------------------------------------|--------------------------------------------------------------------------|
| Правка Mini App/Go не видна                        | Образ не пересобран → `docker compose up -d --build app`. Затем сбросить кэш Telegram. |
| `bind: address already in use :8080`               | Уже запущен контейнер `app` (или локальный `go run`). Это нормально — не поднимайте второй экземпляр на том же порту. |
| `APP_SECRET not set` в логах                       | Не задан `APP_SECRET` → хранение кредов YouGile отключено. Задайте в `.env`. |
| Mini App не открывается / `initData` invalid       | `TELEGRAM_BOT_TOKEN` в `.env` app не совпадает с ботом, либо `MINI_APP_URL` не HTTPS. |
| Бот не отвечает                                    | Проверьте `PROXY_URL` (из контейнера — через `host.docker.internal`, не `127.0.0.1`). |
| Prisma `P3005` у meeting-worker                    | Воркер обязан использовать `?schema=meeting` в `DATABASE_URL` (задано в compose). |

---

## Структура репозитория

```
cmd/server/main.go              — точка входа backend: конфиг → БД → миграции → HTTP
internal/config                 — env + workspace.yaml → Config
internal/transport/http         — API-шлюз, хендлеры, Mini App (miniapp.html, miniapp.go)
internal/storage                — Repository + Postgres (pgx) + раннер миграций
internal/secret                 — AES-256-GCM шифрование токенов YouGile
internal/queue · internal/worker — очередь событий + консьюмер с роутингом по type
internal/service                — задачи, авто-синк, дайджест, напоминания
internal/integrations/yougile   — REST-клиент YouGile
internal/integrations/llm       — клиент OpenRouter (классификатор колонок, дедуп)
migrations/                     — SQL-миграции (embed, авто-применение)
ovra_bot/                       — Telegram-бот (Telegraf, TS)
meeting-worker/                 — воркер встреч (Telemost + SpeechKit + LLM + календари)
workspace.yaml                  — каталог тенантов (монтируется в app)
docker-compose.yml              — postgres + app + bot + meeting-worker
```
