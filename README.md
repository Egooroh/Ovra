# Ovra — backend (У1)

Модульный монолит на Go: **API-шлюз → очередь → воркер → хранилище → интеграция с YouGile**.
Слои разделены интерфейсами (`Queue`, `Repository`), чтобы in-memory очередь и Postgres
можно было заменить на NATS/пул воркеров без переписывания бизнес-логики.

**Готово:** каркас (Фаза 0), хранилище и миграции (Фаза 1), фундамент per-workspace
кредов YouGile (шифрование + хранение). **В работе:** REST-клиент YouGile и онбординг (Фаза 2–3).

## Структура

```
cmd/server/main.go              — точка входа: конфиг → БД → миграции → сидинг → HTTP
internal/config                 — env + workspace.yaml → Config
internal/domain                 — сущности: Workspace, User, Task, Meeting
internal/transport/http         — API-шлюз, хендлеры, /healthz
internal/storage                — интерфейс Repository + Postgres (pgx) + раннер миграций
internal/secret                 — AES-256-GCM шифрование секретов (токены YouGile)
internal/queue                  — интерфейс Queue + inmemory          (Фаза 3)
internal/worker                 — потребитель очереди, роутинг по типу (Фаза 3)
internal/integrations/yougile   — REST-клиент YouGile                 (Фаза 2)
migrations/                     — SQL-миграции (вшиты в бинарь через embed)
docker-compose.yml              — app + postgres
```

## Запуск

### Через Docker (одной командой)

```bash
docker compose up --build
```

Поднимет Postgres + app, применит миграции и засеет воркспейсы из `workspace.yaml`. Проверка:

```bash
curl http://localhost:8080/healthz
# {"status":"ok","workspaces":1}
```

### Локально (без Docker)

Нужен запущенный Postgres (например, только сервис БД из compose):

```bash
docker compose up -d postgres          # Postgres на хостовом порту 5433
go run ./cmd/server
curl http://localhost:8080/healthz
```

> Хостовый порт Postgres — **5433** (а не 5432), чтобы не конфликтовать с локально
> установленным PostgreSQL. Внутри compose-сети приложение ходит на `postgres:5432`.

## Конфигурация

Переменные окружения (см. `.env.example`):

| Переменная          | По умолчанию                                                  | Назначение                                                   |
|---------------------|--------------------------------------------------------------|--------------------------------------------------------------|
| `HTTP_ADDR`         | `:8080`                                                       | адрес API-шлюза                                              |
| `DATABASE_URL`      | `postgres://ovra:ovra@localhost:5433/ovra?sslmode=disable`    | DSN Postgres                                                 |
| `WORKSPACE_CONFIG`  | `workspace.yaml`                                              | путь к каталогу тенантов                                     |
| `YOUGILE_API_TOKEN` | —                                                            | глобальный фолбэк-токен YouGile (опц.)                       |
| `APP_SECRET`        | —                                                            | парольная фраза для шифрования токенов; без неё хранение кредов отключено |
| `LOG_LEVEL`         | `info`                                                        | `debug`/`info`/`warn`/`error`                                |

Тенанты описываются в `workspace.yaml` (см. пример в репозитории) и при старте
синхронизируются в таблицу `workspaces`.

## Модель данных

- **`workspaces`** — тенант: один Telegram-чат ↔ один проект YouGile. `id` — текстовый
  ключ (совпадает с id из `workspace.yaml`), колонки доски (`col_todo`/`col_in_progress`/
  `col_review`/`col_done`), per-workspace креды YouGile.
- **`users`** — участники воркспейса, маппинг на аккаунт YouGile.
- **`tasks`** — ядро: кандидат/одобренная задача (`approval_status`: pending/approved/rejected,
  `status`: todo/in_progress/review/done, `source`: chat/meeting), `yougile_task_id` после
  создания карточки.
- **`meetings`** — источник задач из встреч (transcript/summary), заполняется позже.

Миграции применяются автоматически на старте (идемпотентный раннер, версии в
`schema_migrations`).

## Креды YouGile (онбординг через бота)

Токен YouGile хранится **на каждый воркспейс**, а не глобально: бот собирает креды у
хоста при онбординге и передаёт их бэку. Два пути:

- хост присылает **готовый API-ключ**, либо
- хост даёт **логин/пароль** — бэк сам получает `companyId` и генерирует ключ.

В БД (`workspaces.yougile_api_token_enc`) лежит только API-ключ, зашифрованный
**AES-256-GCM** ключом из `APP_SECRET`. **Пароль не персистится никогда.**

> Для прода: задайте сильный `APP_SECRET` и не переиспользуйте dev-значение.

## Тесты

```bash
go test ./...
```

- `internal/secret` — юнит-тесты шифрования (без БД).
- `internal/storage` — интеграционные тесты CRUD и кредов; **требуют запущенного
  Postgres** (DSN из `OVRA_TEST_DSN`, по умолчанию `localhost:5433`). Если БД недоступна —
  тесты помечаются как skipped.

## Статус по тикетам

- [x] **B-01** — репо, Go-модуль, layout, docker-compose (app + Postgres), `GET /healthz`
- [x] **B-02** — конфиг-загрузчик (env + workspace.yaml), структура `Workspace`
- [x] **B-03** — SQL-миграции: `workspaces`, `users`, `tasks`, `meetings`
- [x] **B-04** — интерфейс `Repository` + Postgres-реализация (CRUD tasks, чтение workspaces/users)
- [~] **B-05** — креды YouGile: хранение per-workspace (AES-GCM) ✅; REST-клиент/авторизация — в работе
- [ ] **B-06** — маппинг `assignee` → `yougile_user_id`, движение карточек по колонкам
- [ ] **B-07** — HTTP-хендлеры `/v1/events`, `/v1/tasks`, `PATCH /v1/tasks/{id}`, `GET .../tasks`
- [ ] **B-08** — интерфейс `Queue` + in-memory + цикл воркера
- [ ] **B-09** — E2E: `POST /v1/tasks` → БД → карточка в YouGile
- [ ] **B-10** — логирование, обработка ошибок внешних API, финальный README
