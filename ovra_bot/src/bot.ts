// src/bot.ts
import { Telegraf, Markup, Context } from "telegraf";
import { isPotentialTask } from "./utils/heuristics.js";
import { parseMessageWithAI, type ParsedTask } from "./services/ai.js";
import { sendTaskToOvraBackend } from "./services/backend.js";
import crypto from "crypto";
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent as SocksProxyAgent } from 'https-proxy-agent';

dotenv.config();

const proxyUrl = process.env.PROXY_URL;
const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
    telegram: {
        ...(agent ? { agent: agent } : {})
    }
});

let activePmChatId: string | number | undefined = process.env.PM_CHAT_ID || undefined;

const recentMessages = new Map<number, string>();
const pendingTasks = new Map<string, ParsedTask>();

// --- СИСТЕМА ПРИВЯЗКИ ПОЛЬЗОВАТЕЛЕЙ (Маппинг) ---
const MAPPING_FILE = path.resolve(process.cwd(), 'users.json');
let userMapping: Record<string, string> = {};

// Загружаем сохраненные теги при запуске
if (fs.existsSync(MAPPING_FILE)) {
    userMapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
}

function saveMapping() {
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(userMapping, null, 2));
}
// ------------------------------------------------

function cleanUpCache() {
    if (recentMessages.size > 1000) recentMessages.clear();
    if (pendingTasks.size > 500) pendingTasks.clear();
}

// Приветственное сообщение при добавлении бота в новую группу
bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    // Если бота только что добавили в группу или сделали админом
    if (status === 'member' || status === 'administrator') {
        await ctx.reply(
            `👋 Всем привет! Я Ovra PM-Bot.\n\n` +
            `Чтобы я мог корректно назначать на вас задачи, мне нужно связать ваши Telegram-теги с аккаунтами YouGile.\n\n` +
            `Пожалуйста, каждый напишите прямо в этот чат команду:\n` +
            `\`/bind Ваше Имя В YouGile\`\n\n` +
            `Пример: \`/bind Иван Иванов\``, 
            { parse_mode: 'Markdown' }
        );
    }
});

// Команда для привязки тега к имени YouGile
bot.command('bind', async (ctx) => {
    const username = ctx.from.username;
    if (!username) {
        return ctx.reply('❌ У вас не установлен @username в Telegram. Установите его в настройках профиля.');
    }

    const yougileName = ctx.message.text.replace('/bind', '').trim();
    if (!yougileName) {
        return ctx.reply('❌ Напишите ваше имя из YouGile после команды. Пример: `/bind Иван Иванов`', { parse_mode: 'Markdown' });
    }

    const tag = `@${username.toLowerCase()}`;
    userMapping[tag] = yougileName;
    saveMapping();

    await ctx.reply(`✅ Отлично! Теперь ваш тег ${tag} привязан к сотруднику "${yougileName}" в YouGile.`);
});

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        activePmChatId = ctx.chat.id;
        
        try {
            const envPath = path.resolve(process.cwd(), '.env');
            let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
            
            if (envContent.includes('PM_CHAT_ID=')) {
                envContent = envContent.replace(/PM_CHAT_ID=.*/, `PM_CHAT_ID="${activePmChatId}"`);
            } else {
                envContent += `\nPM_CHAT_ID="${activePmChatId}"\n`;
            }
            
            fs.writeFileSync(envPath, envContent);
            await ctx.reply(`✅ Вы успешно назначены PM-ом (ID: ${activePmChatId})!\n\nЯ запомнил этот чат и записал его в конфиг. Теперь все карточки на одобрение будут приходить сюда.`);
        } catch (err) {
            console.error("Ошибка записи в .env:", err);
            await ctx.reply(`✅ Вы назначены PM-ом на время текущей сессии (ID: ${activePmChatId}), но я не смог записать это в .env файл.`);
        }
    } else {
        await ctx.reply('Привет! Я PM-бот. Напиши мне команду /start в личные сообщения, чтобы я начал присылать тебе задачи на подтверждение.');
    }
});

async function processTaskAndConfirm(ctx: Context, text: string) {
    const parsed = await parseMessageWithAI(text);
    
    if (parsed && parsed.isTask) {
        const taskId = crypto.randomBytes(8).toString('hex');
        pendingTasks.set(taskId, parsed);
        cleanUpCache();

        const messageText = `🤖 **Найдена задача из чата**\n\n` +
                            `📌 Название: ${parsed.title || 'Без названия'}\n` +
                            `👤 Исполнитель: ${parsed.assignee || 'Не указан'}\n` +
                            `⏳ Дедлайн: ${parsed.deadline || 'Не указан'}\n` +
                            `📝 Описание: ${parsed.description || 'Нет'}`;

        if (!activePmChatId) {
            console.error("❌ ID ПМа не установлен! Некуда отправлять задачу.");
            if (ctx.chat && ctx.chat.type !== 'private') {
                await ctx.reply("❌ Задача найдена, но я не знаю, кому её отправить на подтверждение. Кто-нибудь, напишите мне /start в личные сообщения!");
            }
            return;
        }

        try {
            await ctx.telegram.sendMessage(activePmChatId, messageText, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    Markup.button.callback('✅ Одобрить', `approve_${taskId}`),
                    Markup.button.callback('❌ Отклонить', `reject_${taskId}`)
                ])
            });
        } catch (error) {
            console.error("❌ Ошибка отправки в личку.", error);
        }
    }
}

bot.command('stats', async (ctx) => {
    const loadingMessage = await ctx.reply('⏳ Собираю статистику...');

    const proxyStatus = process.env.PROXY_URL ? `✅ Включен (${process.env.PROXY_URL})` : `❌ Выключен`;
    const aiStatus = process.env.OPENROUTER_API_KEY ? `✅ Подключен (${process.env.AI_MODEL || 'по умолчанию'})` : `❌ Нет ключа`;
    const pmStatus = activePmChatId ? `✅ Установлен (${activePmChatId})` : `❌ Не установлен (напиши /start в личку)`;

    let backendStatus = '❌ Недоступен / Выключен';
    try {
        const backendUrl = process.env.BACKEND_URL || 'http://localhost:8080';
        const res = await fetch(`${backendUrl}/healthz`);
        if (res.ok) {
            backendStatus = `✅ Работает`;
        }
    } catch (error) {
        backendStatus = `❌ Ошибка подключения`;
    }

    const statsText = `📊 **Статус системы Ovra PM-Bot**\n\n` +
                      `🌐 **Прокси:** ${proxyStatus}\n` +
                      `⚙️ **Go-Бэкенд:** ${backendStatus}\n` +
                      `🧠 **AI (OpenRouter):** ${aiStatus}\n` +
                      `👤 **Личка ПМа:** ${pmStatus}\n\n` +
                      `👥 **Привязано юзеров:** ${Object.keys(userMapping).length}\n` +
                      `📦 **Сообщений в кэше:** ${recentMessages.size}\n` +
                      `⏳ **Задач в ожидании:** ${pendingTasks.size}`;

    await ctx.telegram.editMessageText(
        ctx.chat.id, 
        loadingMessage.message_id, 
        undefined, 
        statsText, 
        { parse_mode: 'Markdown' }
    );
});

bot.on("text", async (ctx) => {
    const message = ctx.message;
    recentMessages.set(message.message_id, message.text);
    // ИИ отключен для обычных сообщений в целях экономии токенов
});

bot.on("message_reaction", async (ctx) => {
    const reactionInfo = ctx.messageReaction;
    const messageId = reactionInfo.message_id;
    
    const hasPinReaction = reactionInfo.new_reaction.some((r: any) => 
        r.type === 'emoji' && (r.emoji === '✍️' || r.emoji === '🔥')
    );

    if (hasPinReaction) {
        const text = recentMessages.get(messageId);
        if (text) {
            await processTaskAndConfirm(ctx, text);
        }
    }
});

bot.action(/^approve_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!; 
    const taskData = pendingTasks.get(taskId);

    if (!taskData) {
        return ctx.answerCbQuery('Задача устарела или не найдена.');
    }

    try {
        await ctx.answerCbQuery('Отправляю в Ovra Backend...');

        // Ищем тег в нашей базе. Если находим — подменяем на Имя из YouGile.
        let assignee = taskData.assignee || "";
        if (assignee.startsWith('@')) {
            const mappedName = userMapping[assignee.toLowerCase()];
            if (mappedName) {
                assignee = mappedName;
            }
        }

        const title = taskData.title || "Новая задача из Telegram";
        const description = taskData.description || "";

        const result = await sendTaskToOvraBackend(title, assignee, description);
        
        await ctx.editMessageText(
            `✅ **Задача создана!**\n` +
            `Название: ${title}\n` +
            `Исполнитель: ${assignee || 'Не указан'}\n` +
            `ID в YouGile: \`${result.yougile_task_id || 'Неизвестно'}\``, 
            { parse_mode: 'Markdown' }
        );
        
        pendingTasks.delete(taskId);
    } catch (error) {
        console.error(error);
        await ctx.editMessageText('❌ Ошибка при передаче задачи в Ovra Backend. Проверь логи.');
    }
});

bot.action(/^reject_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    pendingTasks.delete(taskId);
    await ctx.editMessageText('❌ Задача отменена.');
});

export { bot };