# Ovra

**Ovra** — система автоматизации задач для команд в Telegram. Обнаруживает задачи в переписке и на встречах, парсит их с помощью AI, собирает согласование от PM и публикует карточки в YouGile.

## Содержание

- [Обзор](#обзор)
- [Архитектура](#архитектура)
- [Быстрый старт](#быстрый-старт)
- [Конфигурация](#конфигурация)
- [Рабочий процесс](#рабочий-процесс)
- [API](#api)
- [Разработка](#разработка)
- [Деплой](#деплой)

---

## Обзор

### Что делает Ovra

1. **Ловит задачи** из Telegram-чата — по ключевым словам, эмодзи-реакциям (✍️ 🔥) или вручную
2. **Парсит задачу** через AI (OpenRouter): заголовок, описание, исполнитель, дедлайн
3. **Проверяет дубликаты** — 4-слойная система (нормализация → `pg_trgm` → LLM-судья)
4. **Отправляет на согласование** PM в личку или в группу
5. **Публикует карточку** в YouGile и синхронизирует статусы
6. **Суммирует встречи** — бот заходит в Telemost, пишет транскрипт через Яндекс SpeechKit и извлекает задачи
7. **Напоминает и дайджестирует** — уведомления перед дедлайном и ежедневная сводка по исполнителям

### Стек

| Слой | Технологии |
|------|-----------|
| Бэкенд | Go 1.25, `net/http`, PostgreSQL 16 (pgx) |
| Telegram-бот | Node.js 20, TypeScript, Telegraf |
| Встречи | Node.js 20, TypeScript, Playwright, PulseAudio, FFmpeg, Prisma |
| AI | OpenRouter (совместимый с OpenAI API) |
| Речь → текст | Яндекс SpeechKit (gRPC) |
| Туннель | Cloudflare Tunnel |
| Контейнеры | Docker Compose |

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                        Telegram                              │
│          чат команды          ·         личка PM             │
└───────────────┬───────────────────────────┬─────────────────┘
                │ сообщения / реакции        │ согласование
                ▼                           ▼
        ┌──────────────┐          ┌──────────────────┐
        │  ovra_bot    │◄────────►│   Go backend     │
        │  (Node.js)   │  HTTP    │   (cmd/server)   │
        └──────────────┘          └────────┬─────────┘
                                           │
               ┌───────────────────────────┼──────────────────┐
               │                           │                  │
               ▼                           ▼                  ▼
        ┌────────────┐           ┌──────────────┐    ┌──────────────┐
        │  YouGile   │           │  PostgreSQL  │    │ meeting-     │
        │  REST API  │           │  (pgx + pgm) │    │ worker       │
        └────────────┘           └──────────────┘    │ (Playwright) │
                                                      └──────────────┘
                                                             │
                                                      Яндекс SpeechKit
                                                      OpenRouter AI
```

### Сервисы Docker Compose

| Сервис | Порт | Назначение |
|--------|------|-----------|
| `postgres` | 5433 (хост) | PostgreSQL 16 |
| `app` | 8080 | Go API-сервер |
| `bot` | — (внутр. 3000) | Telegram-бот (polling) |
| `meeting-worker` | — (внутр. 3001) | Оркестратор встреч |
| `cloudflared` | — | Обратный туннель |

### Структура проекта

```
Ovra/
├── cmd/
│   ├── server/         # точка входа Go-бэкенда
│   └── ygsetup/        # утилита первоначальной настройки YouGile
├── internal/
│   ├── config/         # разбор .env и workspace.yaml
│   ├── domain/         # сущности: Workspace, User, Task, Meeting
│   ├── storage/        # PostgreSQL-репозиторий
│   ├── secret/         # шифрование AES-256-GCM
│   ├── integrations/
│   │   ├── yougile/    # YouGile REST-клиент
│   │   └── llm/        # OpenRouter: парсинг, дедуп, классификация колонок
│   ├── service/        # бизнес-логика (задачи, синк, дайджест, напоминания)
│   ├── queue/          # in-memory очередь событий
│   ├── worker/         # роутер событий
│   └── transport/http/ # REST-хендлеры
├── migrations/         # SQL-миграции (встроены, применяются при старте)
├── ovra_bot/           # Telegram-бот (TypeScript)
├── meeting-worker/     # оркестратор встреч (TypeScript)
├── workspace.yaml      # реестр тенантов
├── docker-compose.yml
└── .env.example
```

---

## Быстрый старт

### Требования

- Docker и Docker Compose
- Telegram Bot Token ([получить у @BotFather](https://t.me/BotFather))
- Аккаунт YouGile с API-токеном
- OpenRouter API Key (для AI-парсинга)

### 1. Клонировать репозиторий и настроить окружение

```bash
git clone <repo-url> ovra
cd ovra
cp .env.example .env
```

### 2. Заполнить `.env`

Обязательные переменные:

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_token_here

# AI (OpenRouter)
OPENROUTER_API_KEY=your_openrouter_key

# Безопасность (сгенерировать: openssl rand -hex 32)
APP_SECRET=change-me-to-strong-secret
BOT_SECRET=change-me-too
WORKER_SECRET=change-me-three
```

> **YouGile-токен** не нужен в `.env` — бот запросит его у администратора команды при первой настройке и сохранит зашифрованно в БД (AES-256-GCM) отдельно для каждого тенанта.

### 3. Создать первый тенант в `workspace.yaml`

```yaml
workspaces:
  - id: "ws-myteam"
    chat_id: "-1001234567890"      # ID вашего Telegram-чата (отрицательное)
    name: "Моя команда"
    yougile_project_id: "uuid"     # ID проекта в YouGile
    columns:
      todo: "col-uuid"
      in_progress: "col-uuid"
      review: "col-uuid"
      done: "col-uuid"
    host_tg_id: "123456789"        # Telegram ID PM
    timezone: "Europe/Moscow"
    digest_enabled: true
    digest_time: "09:00"
    confirm_mode: "admin_only"     # или "everyone"
    task_detection: "heuristic"    # или "ai"
```

> Не знаете ID колонок? Запустите `go run ./cmd/ygsetup` — он выведет все нужные UUID.

### 4. Запустить

```bash
docker-compose up -d
```

Бэкенд автоматически применит миграции и загрузит тенанты из `workspace.yaml`.

### 5. Проверить

```bash
curl http://localhost:8080/healthz
# {"status":"ok","workspaces":1}

docker-compose logs -f
```

### 6. Добавить бота в Telegram-группу

Добавьте бота в ваш чат и дайте ему права администратора (чтение сообщений).

---

## Конфигурация

### Переменные окружения — бэкенд (`app`)

| Переменная | По умолчанию | Описание |
|-----------|-------------|---------|
| `HTTP_ADDR` | `:8080` | Адрес HTTP-сервера |
| `DATABASE_URL` | `postgres://ovra:ovra@postgres:5432/ovra` | Строка подключения |
| `WORKSPACE_CONFIG` | `workspace.yaml` | Путь к реестру тенантов |
| `APP_SECRET` | — | Passphrase для AES-256-GCM (обязательно) |
| `YOUGILE_API_TOKEN` | — | Глобальный fallback-токен YouGile |
| `YOUGILE_HTTP_TIMEOUT` | `30s` | Таймаут запросов к YouGile |
| `OPENROUTER_API_KEY` | — | Включает AI-классификатор |
| `OPENROUTER_MODEL` | `openai/gpt-4o-mini` | Модель для AI-классификации |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-совместимый API |
| `DEDUP_SIMILARITY` | `0.4` | Порог pg_trgm (0..1) |
| `DEADLINE_TZ` | `Europe/Moscow` | Часовой пояс по умолчанию |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `BOT_SECRET` | — | Bearer-токен для запросов бота |
| `WORKER_SECRET` | — | Bearer-токен для meeting-worker |
| `MINI_APP_URL` | — | HTTPS-URL Telegram Mini App |
| `HTTPS_PROXY` | — | Корпоративный прокси |

### Переменные окружения — бот (`ovra_bot`)

| Переменная | Описание |
|-----------|---------|
| `TELEGRAM_BOT_TOKEN` | Токен бота |
| `OPENROUTER_API_KEY` | Ключ для AI-парсинга задач |
| `AI_MODEL` | Модель (по умолч. `qwen/qwen3.7-plus`) |
| `YANDEX_API_KEY` | Ключ Яндекс SpeechKit (голос → текст) |
| `YANDEX_FOLDER_ID` | Folder ID в Яндекс Облаке |
| `BACKEND_URL` | URL Go-бэкенда |
| `TENANT_ID` | ID тенанта по умолчанию |
| `CONFIRM_TARGET` | `group` или `pm` (куда слать согласование) |
| `APP_SECRET` | Тот же, что у бэкенда |
| `BOT_SECRET` | Bearer-токен |

### workspace.yaml — поля тенанта

| Поле | Тип | Описание |
|------|-----|---------|
| `id` | string | Уникальный идентификатор тенанта |
| `chat_id` | string | ID Telegram-группы (отрицательное) |
| `name` | string | Отображаемое имя |
| `yougile_project_id` | UUID | ID проекта YouGile |
| `columns.todo` | UUID | Колонка «К выполнению» |
| `columns.in_progress` | UUID | Колонка «В работе» |
| `columns.review` | UUID | Колонка «Проверка» |
| `columns.done` | UUID | Колонка «Готово» |
| `host_tg_id` | string | Telegram ID PM |
| `timezone` | IANA | Часовой пояс (напр. `Europe/Moscow`) |
| `digest_enabled` | bool | Включить ежедневный дайджест |
| `digest_time` | `HH:MM` | Время дайджеста в TZ тенанта |
| `confirm_mode` | string | `admin_only` или `everyone` |
| `task_detection` | string | `heuristic` или `ai` |

---

## Рабочий процесс

### Создание задачи из чата

```
Участник пишет "нужно исправить баг в авторизации"
        │
        ▼
Бот обнаруживает задачу (heuristic / ai)
        │
        ▼
OpenRouter парсит: {title, assignee, deadline}
        │
        ├─── Дубликат? → возвращает 409 + кандидаты
        │
        ▼
Карточка согласования → PM (личка или группа)
        │
      [✅ Одобрить]  [❌ Отклонить]
        │
        ▼
Задача → PostgreSQL → YouGile-карточка в колонке «Сделать»
```

### Эмодзи-реакции

| Реакция | Действие |
|---------|---------|
| ✍️ | Создать задачу из сообщения |
| 🔥 | Создать срочную задачу |

### Синхронизация статусов

Ovra следит за перемещением карточек в YouGile и обновляет статус задачи каждые 5 минут:

```
todo → in_progress → review → done (закрывает карточку)
```

### Встречи

1. Бот подключается к звонку в Telemost (автоматически по календарю)
2. Записывает аудио через PulseAudio + FFmpeg
3. Транскрибирует через Яндекс SpeechKit (gRPC)
4. OpenRouter извлекает задачи из транскрипта
5. Задачи проходят стандартный флоу согласования

---

## API

Базовый URL: `http://localhost:8080`

### Здоровье

```
GET /healthz
```

### Тенанты

```
POST   /v1/workspaces                              # создать тенант
GET    /v1/workspaces/{tenant}                     # получить конфиг
GET    /v1/chats/{chat_id}/workspace               # найти по chat_id
POST   /v1/workspaces/{tenant}/credentials         # сохранить YouGile-токен
PATCH  /v1/workspaces/{tenant}/pm-chat             # установить чат PM
POST   /v1/workspaces/{tenant}/board/resolve       # автоматически найти колонки
```

### Задачи

```
POST   /v1/tasks                                   # создать задачу
GET    /v1/tasks/{id}                              # получить задачу
PATCH  /v1/tasks/{id}                              # обновить статус
DELETE /v1/tasks/{id}                              # мягкое удаление
POST   /v1/tasks/{id}/move-column                 # переместить в колонку
GET    /v1/workspaces/{tenant}/tasks               # список активных задач
GET    /v1/workspaces/{tenant}/trash               # корзина
DELETE /v1/workspaces/{tenant}/trash               # очистить корзину
```

**Создание задачи — тело запроса:**

```json
{
  "tenant_id": "ws-myteam",
  "title": "Исправить баг в авторизации",
  "description": "При входе через Google возникает 500",
  "assignee_tg_id": "123456789",
  "deadline": "2026-06-20T18:00:00Z",
  "force": false
}
```

Если обнаружен дубликат — возвращает `409 Conflict` со списком похожих задач. Передайте `"force": true` для принудительного создания.

### Пользователи

```
POST   /v1/workspaces/{tenant}/users               # зарегистрировать участника
GET    /v1/workspaces/{tenant}/users               # список участников
GET    /v1/workspaces/{tenant}/users/by-tg/{tg_id} # найти по Telegram ID
PATCH  /v1/workspaces/{tenant}/users/{tg_id}/role       # admin / member
PATCH  /v1/workspaces/{tenant}/users/{tg_id}/timezone   # часовой пояс
```

### События (асинхронные)

```
POST /v1/events
```

```json
{
  "type": "task_create",
  "payload": { ... }
}
```

Возвращает `202 Accepted` немедленно. Обрабатывается воркером в фоне.

### YouGile

```
GET  /v1/workspaces/{tenant}/yougile-users         # участники проекта
GET  /v1/workspaces/{tenant}/yougile-projects      # доступные проекты
POST /v1/workspaces/{tenant}/project               # задать активный проект
POST /v1/workspaces/{tenant}/sync                  # принудительная синхронизация
```

### Встречи и календари

```
POST   /v1/meetings/summary                                  # загрузить транскрипт
POST   /v1/workspaces/{tenant}/calls                         # запланировать звонок
GET    /v1/workspaces/{tenant}/calendar/accounts             # список календарей
POST   /v1/workspaces/{tenant}/calendar/accounts             # добавить Google/Яндекс
DELETE /v1/workspaces/{tenant}/calendar/accounts/{id}        # удалить
```

### Настройки

```
GET   /v1/workspaces/{tenant}/digest               # конфиг дайджеста
PATCH /v1/workspaces/{tenant}/digest               # обновить время/статус
PATCH /v1/workspaces/{tenant}/confirm-mode         # admin_only / everyone
PATCH /v1/workspaces/{tenant}/task-detection       # heuristic / ai
```

---

## Разработка

### Локальный запуск без Docker

```bash
# 1. База данных
docker-compose up -d postgres

# 2. Первоначальная настройка YouGile (единоразово)
YOUGILE_LOGIN=you@example.com YOUGILE_PASSWORD=secret go run ./cmd/ygsetup

# 3. Бэкенд
APP_SECRET=dev-secret go run ./cmd/server

# 4. Бот (в отдельном терминале)
cd ovra_bot
npm install
npm start

# 5. Meeting-worker (в отдельном терминале)
cd meeting-worker
npm install
npm run prisma:migrate
npm run dev:orchestrator
```

### Тесты

```bash
# Юнит-тесты
go test ./...

# Интеграционные (требуют Postgres на localhost:5433)
OVRA_TEST_DSN="postgres://ovra:ovra@localhost:5433/ovra?sslmode=disable" \
  go test ./internal/storage -v
```

### Управление сервисами

```bash
# Пересобрать после изменений
docker-compose build app bot
docker-compose up -d app bot

# Логи в реальном времени
docker-compose logs app -f
docker-compose logs bot -f
docker-compose logs meeting-worker -f

# Перезапустить отдельный сервис
docker-compose restart bot
```

> **Важно:** не запускайте бота одновременно в Docker и локально. Telegram вернёт `409 Conflict` — работает только одно polling-соединение.

### База данных

```bash
# Подключиться
psql -h localhost -p 5433 -U ovra -d ovra

# Полезные запросы
SELECT id, name, chat_id FROM workspaces;
SELECT * FROM tasks WHERE tenant_id = 'ws-myteam' AND deleted_at IS NULL;
SELECT * FROM users WHERE tenant_id = 'ws-myteam';
```

Миграции применяются автоматически при старте бэкенда (файлы встроены в бинарник).

---

## Деплой

### Продакшн-чеклист

- [ ] Сгенерировать стойкие секреты: `openssl rand -hex 32`
- [ ] Задать `APP_SECRET`, `BOT_SECRET`, `WORKER_SECRET`
- [ ] Настроить `MINI_APP_URL` (HTTPS обязателен для Telegram Mini App)
- [ ] Настроить Cloudflare Tunnel (`cloudflared tunnel login`)
- [ ] Подключить Яндекс SpeechKit (для транскрипции встреч)
- [ ] Подключить Google Calendar или Яндекс CalDAV (для встреч)
- [ ] Настроить резервное копирование PostgreSQL
- [ ] Настроить корпоративный прокси (`HTTPS_PROXY`) при необходимости

### Остановка и удаление данных

```bash
# Остановить (данные сохраняются)
docker-compose down

# Остановить и удалить всё включая БД ⚠️
docker-compose down -v
```

### Масштабирование

Архитектура спроектирована с учётом роста:

| Компонент | Путь миграции |
|-----------|-------------|
| Очередь событий | In-memory → NATS JetStream (замена `internal/queue`) |
| Хранилище | PostgreSQL → любая БД (интерфейс `storage.Repository`) |
| AI | OpenRouter → любой OpenAI-совместимый API (смена `OPENROUTER_BASE_URL`) |
| Воркеры | Один горутин → пул воркеров (`internal/worker`) |

---

## Лицензия

Proprietary. Все права защищены.
