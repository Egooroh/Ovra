# Ovra

## Запуск и остановка

```bash
# Запустить всё (бэкенд + бот + база)
docker-compose up -d

# Остановить всё (данные сохраняются)
docker-compose down

# Перезапустить после изменений в коде
docker-compose build app bot && docker-compose up -d app bot
```

## Отдельные сервисы

```bash
docker-compose up -d bot       # запустить бота
docker-compose stop bot        # остановить бота
docker-compose restart bot     # перезапустить бота
```

## Логи

```bash
docker-compose logs bot -f     # логи бота в реальном времени
docker-compose logs app -f     # логи бэкенда
docker-compose logs -f         # все сервисы
```

## Важно

- Бот должен работать **только в Docker** — не запускай `npm start` из папки `ovra_bot` напрямую.
  Если запустить оба, Telegram будет отбивать лишний с ошибкой 409 Conflict.
- `docker-compose down` не удаляет данные. `docker-compose down -v` — удаляет всё включая базу.
