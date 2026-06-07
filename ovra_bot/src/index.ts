// src/index.ts
import { bot } from "./bot.js";

bot.launch().then(() => {
    console.log("Ovra PM-bot успешно запущен!");
}).catch((err: unknown) => {
    console.error("Ошибка запуска бота:", err);
});

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));