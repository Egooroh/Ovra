// src/index.ts
import http from 'http';
import { bot, handleMeetingDone, type MeetingDonePayload } from "./bot.js";

// allowedUpdates — белый список типов апдейтов. message_reaction Telegram НЕ шлёт
// по умолчанию, поэтому его нужно указать явно; message и callback_query тоже
// перечисляем, иначе перестанут приходить команды/текст и нажатия кнопок.
bot.telegram.setMyCommands([
    { command: "start", description: "Назначить эту личку для подтверждений (ПМ)" },
    { command: "bind", description: "Привязать @username к сотруднику YouGile" },
    { command: "stats", description: "Статус системы" },
    { command: "help", description: "Как пользоваться ботом" },
]).catch(() => { /* не критично */ });

bot.launch({
    allowedUpdates: ["message", "callback_query", "message_reaction", "my_chat_member"],
}).then(() => {
    console.log("Ovra PM-bot успешно запущен!");
}).catch((err: unknown) => {
    console.error("Ошибка запуска бота:", err);
});

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ---- Внутренний HTTP-сервер для приёма вебхуков от бэкенда ----

const BOT_INTERNAL_PORT = parseInt(process.env.BOT_INTERNAL_PORT || '3000', 10);
const WORKER_SECRET = process.env.WORKER_SECRET || '';

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/internal/meeting-done') {
        const auth = (req.headers['authorization'] || '').replace('Bearer ', '');
        if (WORKER_SECRET && auth !== WORKER_SECRET) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        let body = '';
        for await (const chunk of req) body += chunk;

        try {
            const payload = JSON.parse(body) as MeetingDonePayload;
            await handleMeetingDone(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('meeting-done handler error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(BOT_INTERNAL_PORT, () => {
    console.log(`Bot internal HTTP server listening on port ${BOT_INTERNAL_PORT}`);
});
