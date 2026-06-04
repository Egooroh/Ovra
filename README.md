# Ovra — backend (У1)

Модульный монолит на Go: API-шлюз → очередь → воркер → хранилище → интеграция с YouGile.
Сейчас реализована **Фаза 0 (каркас)**: layout, конфиг-загрузчик, `GET /healthz`, docker-compose с Postgres.

## Структура

```
cmd/server/main.go              — точка входа, сборка зависимостей
internal/config                 — env + workspace.yaml → Config
internal/domain                 — сущности (пока Workspace)
internal/transport/http         — API-шлюз, хендлеры
internal/queue                  — интерфейс Queue + inmemory (Фаза 3)
internal/worker                 — потребитель очереди (Фаза 3)
internal/storage                — Repository + Postgres (Фаза 1)
internal/integrations/yougile   — REST-клиент YouGile (Фаза 2)
migrations/                     — SQL-миграции (Фаза 1)
```

## Запуск

### Через Docker (одной командой)

```bash
docker compose up --build
```

Поднимет Postgres + app. Проверка:

```bash
curl http://localhost:8080/healthz
# {"status":"ok","workspaces":1}
```

### Локально (без Docker)

```bash
go run ./cmd/server
curl http://localhost:8080/healthz
```

## Конфигурация

Переменные окружения (см. `.env.example`):

| Переменная          | По умолчанию                                                  | Назначение                  |
|---------------------|--------------------------------------------------------------|-----------------------------|
| `HTTP_ADDR`         | `:8080`                                                       | адрес API-шлюза             |
| `DATABASE_URL`      | `postgres://ovra:ovra@localhost:5432/ovra?sslmode=disable`    | DSN Postgres (с Фазы 1)     |
| `WORKSPACE_CONFIG`  | `workspace.yaml`                                              | путь к каталогу тенантов    |
| `YOUGILE_API_TOKEN` | —                                                            | токен YouGile (с Фазы 2)    |
| `LOG_LEVEL`         | `info`                                                        | debug/info/warn/error       |

Тенанты описываются в `workspace.yaml` (см. пример в репозитории).

## Статус по тикетам

- [x] **B-01** — репо, Go-модуль, layout, docker-compose (app + Postgres), `GET /healthz`
- [x] **B-02** — конфиг-загрузчик (env + workspace.yaml), структура `Workspace`
- [ ] B-03…B-10 — следующие фазы
