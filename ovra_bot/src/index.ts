// src/index.ts
import http from 'http';
import { bot, handleMeetingDone, handleDigestDue, handleReminderDue, handleStatusChange, type MeetingDonePayload } from "./bot.js";

// allowedUpdates — белый список типов апдейтов. message_reaction Telegram НЕ шлёт
// по умолчанию, поэтому его нужно указать явно; message и callback_query тоже
// перечисляем, иначе перестанут приходить команды/текст и нажатия кнопок.
bot.telegram.setMyCommands([
    { command: "start", description: "Назначить эту личку для подтверждений (ПМ)" },
    { command: "setup", description: "Открыть панель настройки доски (Мини-апп)" },
    { command: "confirm", description: "Куда слать подтверждения: group или pm" },
    { command: "confirm_mode", description: "Кто может подтверждать задачи: админы или все" },
    { command: "bind", description: "Привязать @username к сотруднику YouGile" },
    { command: "digest", description: "Дайджест открытых задач по исполнителям" },
    { command: "digest_time", description: "Настроить время ежедневного дайджеста" },
    { command: "board", description: "Все задачи по статусам (канбан-доска)" },
    { command: "trash", description: "Задачи в корзине (удалятся через 24 ч)" },
    { command: "sync", description: "Синхронизировать задачи с YouGile" },
    { command: "stats", description: "Статус системы" },
    { command: "help", description: "Как пользоваться ботом" },
]).catch(() => { /* не критично */ });

// Menu button (left of the input field): open the Mini App directly when an
// HTTPS URL is configured; otherwise fall back to the default commands menu.
const MINI_APP_URL = process.env.MINI_APP_URL || '';
bot.telegram.setChatMenuButton(
    MINI_APP_URL.startsWith('https://')
        ? { menuButton: { type: 'web_app', text: 'Ovra', web_app: { url: MINI_APP_URL } } }
        : { menuButton: { type: 'commands' } }
).catch((e) => console.error('setChatMenuButton:', e));

// Глобальный лог ошибок хендлеров — чтобы видеть, что падает на апдейтах.
bot.catch((err, ctx) => {
    console.error(`BOT ERROR on update [${ctx?.updateType}]:`, err);
});

// Поллинг с автоперезапуском. В Telegraf фатальная ошибка поллинга (например,
// 409 Conflict — гонка со старым процессом, который ещё держит getUpdates до
// 50 с после рестарта контейнера) реджектит промис launch() и НАВСЕГДА
// останавливает приём апдейтов, при этом процесс жив (HTTP-сервер держит event
// loop) — бот выглядит здоровым, но глухой. Поэтому ретраим с нарастающей паузой.
async function launchBot(attempt = 1): Promise<void> {
    try {
        await bot.launch(
            { allowedUpdates: ["message", "callback_query", "message_reaction", "my_chat_member"] },
            () => console.log("Ovra PM-bot успешно запущен, поллинг активен."),
        );
    } catch (err: any) {
        const desc = err?.response?.description || err?.message || String(err);
        const delay = Math.min(60_000, 5_000 * attempt);
        console.error(`Поллинг упал (попытка ${attempt}): ${desc} — перезапуск через ${delay / 1000} с`);
        await new Promise((r) => setTimeout(r, delay));
        return launchBot(attempt + 1);
    }
}
launchBot();

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
            console.log(`[meeting-done] chat_id=${payload.chat_id} tenant=${payload.tenant_id} tasks=${payload.tasks?.length ?? 0}`);
            await handleMeetingDone(payload);
            console.log(`[meeting-done] ok`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('meeting-done handler error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/internal/status-change') {
        const auth = (req.headers['authorization'] || '').replace('Bearer ', '');
        if (WORKER_SECRET && auth !== WORKER_SECRET) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        let body = '';
        for await (const chunk of req) body += chunk;

        try {
            const payload = JSON.parse(body) as { chat_id: string; changes: Array<{ title: string; old_status: string; new_status: string }> };
            console.log(`[status-change] chat_id=${payload.chat_id} changes=${payload.changes?.length ?? 0}`);
            await handleStatusChange(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('status-change handler error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/internal/reminder') {
        const auth = (req.headers['authorization'] || '').replace('Bearer ', '');
        if (WORKER_SECRET && auth !== WORKER_SECRET) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        let body = '';
        for await (const chunk of req) body += chunk;

        try {
            const payload = JSON.parse(body) as { tg_id: string; title: string; deadline: string; overdue: boolean };
            await handleReminderDue(payload);
            console.log(`[reminder] sent to tg_id=${payload.tg_id} overdue=${payload.overdue}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
            // 403 (бот заблокирован) / 400 (чат не найден) — перманентно: отдаём 200,
            // чтобы бэкенд пометил задачу как «напомнено» и не зацикливал повтор.
            const code = e?.response?.error_code ?? e?.code;
            if (code === 403 || code === 400) {
                console.warn(`[reminder] permanent failure (${code}) — giving up:`, e?.message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, skipped: true }));
            } else {
                console.error('reminder handler error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal error' }));
            }
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/internal/digest') {
        const auth = (req.headers['authorization'] || '').replace('Bearer ', '');
        if (WORKER_SECRET && auth !== WORKER_SECRET) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        let body = '';
        for await (const chunk of req) body += chunk;

        try {
            const payload = JSON.parse(body) as { chat_id: string; tenant_id: string };
            console.log(`[digest] chat_id=${payload.chat_id} tenant=${payload.tenant_id}`);
            await handleDigestDue(payload);
            console.log(`[digest] ok`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('digest handler error:', e);
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
