// src/index.ts
import { bot } from "./bot.js";

// allowedUpdates — белый список типов апдейтов. message_reaction Telegram НЕ шлёт
// по умолчанию, поэтому его нужно указать явно; message и callback_query тоже
// перечисляем, иначе перестанут приходить команды/текст и нажатия кнопок.
bot.telegram.setMyCommands([
    { command: "start", description: "Назначить эту личку для подтверждений (ПМ)" },
    { command: "bind", description: "Привязать @username к сотруднику YouGile" },
    { command: "stats", description: "Статус системы" },
    { command: "help", description: "Как пользоваться ботом" },
]).catch(() => { /* не критично */ });

// Глобальный лог ошибок хендлеров — чтобы видеть, что падает на апдейтах.
bot.catch((err, ctx) => {
    console.error(`BOT ERROR on update [${ctx?.updateType}]:`, err);
});

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