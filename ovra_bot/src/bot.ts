// src/bot.ts
import { Telegraf, Markup, Context } from "telegraf";
import { isPotentialTask } from "./utils/heuristics.js";
import { parseMessageWithAI, type ParsedTask } from "./services/ai.js";
import {
    sendTaskToOvraBackend, resolveTenant, createWorkspace, getWorkspaceInfo,
    listYougileMembers, registerUser, scheduleCallInOvra,
    saveYougileCreds, listYougileProjects, setWorkspaceProject,
    listCalendarAccounts, addCalendarAccount, deleteCalendarAccount,
    type YougileMember, type YougileProject, type CalendarAccount
} from "./services/backend.js";
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
// Храним задачу вместе с воркспейсом и чатом-источником.
interface PendingTask { task: ParsedTask; tenantId: string; originChatId?: number; }
const pendingTasks = new Map<string, PendingTask>();

// Сессии онбординга (по user id):
const awaitingKey = new Map<number, string>();                              // юзер → tenant: ждём API-ключ от админа
const linkSessions = new Map<number, { tenant: string; members: YougileMember[] }>(); // юзер → выбор себя из YouGile
const projectSessions = new Map<number, { tenant: string; projects: YougileProject[] }>(); // юзер → выбор проекта

// Сессии добавления календарного аккаунта (по user id).
interface CalendarSession {
    tenant: string;
    provider: 'google' | 'yandex';
    step: 'json' | 'login' | 'password';
    login?: string;
}
const calendarSessions = new Map<number, CalendarSession>();

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
// (старый /bind-онбординг убран — теперь приветствие с deep-link ниже,
//  см. единый bot.on('my_chat_member') и подвязку через кнопки)

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
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Напишите мне в личные сообщения 🙏 (или нажмите «Открыть бота» в рабочей группе).');
    }
    const userId = ctx.from.id;
    activePmChatId = ctx.chat.id; // эта личка получает карточки на одобрение

    // Deep-link payload = tenant_id воркспейса (из кнопки «Открыть бота»).
    const payload = (ctx.message.text.split(' ').slice(1).join(' ') || '').trim();
    if (!payload) {
        return ctx.reply('Привет! 👋 Я Ovra.\nЧтобы подвязаться к доске — откройте меня кнопкой «Открыть бота» из вашей рабочей группы.');
    }

    const tenant = payload;
    try {
        const ws = await getWorkspaceInfo(tenant);

        // 1) Не подключён → онбординг админа: просим API-ключ.
        if (!ws.connected) {
            awaitingKey.set(userId, tenant);
            await ctx.reply(
                '🔌 Доска ещё не подключена к YouGile.\n\n' +
                'Если вы *администратор* — пришлите *API-ключ YouGile* одним сообщением ' +
                '(настройки YouGile → API-ключи).',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // 2) Подключён, но проект/колонки не выбраны → выбор проекта.
        if (!ws.board_resolved) {
            const projects = await listYougileProjects(tenant);
            if (projects.length === 0) {
                return ctx.reply('В YouGile нет проектов. Создайте проект и нажмите /start ещё раз.');
            }
            projectSessions.set(userId, { tenant, projects });
            const buttons = projects.map((p, i) => [Markup.button.callback(p.title || `Проект ${i + 1}`, `proj_${i}`)]);
            await ctx.reply('Выберите проект YouGile для этой группы:', Markup.inlineKeyboard(buttons));
            return;
        }

        // 3) Всё готово → выбор себя из сотрудников.
        const members = await listYougileMembers(tenant);
        if (members.length === 0) {
            return ctx.reply('В проекте YouGile пока нет сотрудников. Добавьте их и нажмите /start ещё раз.');
        }
        linkSessions.set(userId, { tenant, members });
        const buttons = members.map((m, i) =>
            [Markup.button.callback(m.name || m.email || `Сотрудник ${i + 1}`, `link_${i}`)]);
        await ctx.reply('Выберите себя из списка сотрудников YouGile:', Markup.inlineKeyboard(buttons));
    } catch (e) {
        console.error('start:', e);
        await ctx.reply('Не удалось получить данные доски. Попробуйте позже.');
    }
});

async function processTaskAndConfirm(ctx: Context, text: string) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // К какому воркспейсу привязан этот чат?
    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws) {
        if (ctx.chat?.type !== 'private')
            await ctx.reply('⚠️ Этот чат не привязан к доске. Администратор: добавьте меня и дайте права администратора.');
        return;
    }
    if (!ws.connected) {
        await ctx.reply('⚠️ Доска ещё не подключена. Администратор: откройте меня в личке (/start) и подключите YouGile.');
        return;
    }

    const parsed = await parseMessageWithAI(text);

    if (parsed && parsed.isTask) {
        const taskId = crypto.randomBytes(8).toString('hex');
        pendingTasks.set(taskId, { task: parsed, tenantId: ws.tenant_id, originChatId: chatId });
        cleanUpCache();

        const messageText = `🆕 *Новая задача на подтверждение*\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `📌 *${parsed.title || 'Без названия'}*\n\n` +
                            `👤 Исполнитель: ${parsed.assignee || '—'}\n` +
                            `⏳ Дедлайн: ${parsed.deadline || '—'}\n` +
                            `📝 ${parsed.description || 'без описания'}\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `_Создать карточку в YouGile?_`;

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

// ---- Управление календарями ----

function calendarMenuKeyboard(tenant: string) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📋 Список аккаунтов', `cal_list:${tenant}`)],
        [Markup.button.callback('➕ Добавить Google', `cal_add_g:${tenant}`)],
        [Markup.button.callback('➕ Добавить Яндекс', `cal_add_y:${tenant}`)],
    ]);
}

function formatAccountList(accounts: CalendarAccount[], tenant: string): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
    if (accounts.length === 0) {
        return {
            text: '📅 Подключённых календарей нет.',
            keyboard: Markup.inlineKeyboard([[Markup.button.callback('← Назад', `cal_menu:${tenant}`)]]),
        };
    }
    const lines = accounts.map((a, i) => {
        const name = a.label || (a.provider === 'google' ? 'Google Calendar' : 'Яндекс Календарь');
        return `${i + 1}. ${a.provider === 'google' ? '🔵' : '🟡'} *${name}*\n   ID: \`${a.id.slice(0, 8)}…\``;
    });
    const deleteButtons = accounts.map(a =>
        [Markup.button.callback(`🗑️ Удалить ${(a.label || a.id.slice(0, 8))}`, `cal_del:${a.id}:${tenant}`)]
    );
    return {
        text: `📅 *Подключённые календари:*\n\n${lines.join('\n\n')}`,
        keyboard: Markup.inlineKeyboard([
            ...deleteButtons,
            [Markup.button.callback('← Назад', `cal_menu:${tenant}`)],
        ]),
    };
}

async function processGoogleJson(ctx: Context, userId: number, sess: CalendarSession, jsonText: string) {
    let creds: Record<string, unknown>;
    try {
        creds = JSON.parse(jsonText);
    } catch {
        await ctx.reply('❌ Это не валидный JSON. Пришлите ещё раз.');
        return;
    }
    if (!creds.type || !creds.project_id) {
        await ctx.reply('❌ Не похоже на Google service account (нужны поля `type`, `project_id`). Попробуйте ещё раз.', { parse_mode: 'Markdown' });
        return;
    }
    calendarSessions.delete(userId);
    try {
        const account = await addCalendarAccount(sess.tenant, 'google', creds, 'Google Calendar');
        await ctx.reply(`✅ *Google Calendar подключён!*\nID: \`${account.id}\``, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('addCalendarAccount google:', e);
        await ctx.reply('❌ Не удалось подключить. Проверьте, что service account корректный.');
    }
}

bot.command('calendar', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Используйте эту команду в групповом чате.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) {
        return ctx.reply('⚠️ Этот чат не привязан к доске.');
    }
    await ctx.reply('⚙️ *Управление Calendar*', {
        parse_mode: 'Markdown',
        ...calendarMenuKeyboard(ws.tenant_id),
    });
});

// Показать меню (кнопка «Назад»).
bot.action(/^cal_menu:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('⚙️ *Управление Calendar*', {
        parse_mode: 'Markdown',
        ...calendarMenuKeyboard(ctx.match[1]!),
    });
});

// Список аккаунтов.
bot.action(/^cal_list:(.+)$/, async (ctx) => {
    const tenant = ctx.match[1]!;
    await ctx.answerCbQuery('Загружаю…');
    try {
        const accounts = await listCalendarAccounts(tenant);
        const { text, keyboard } = formatAccountList(accounts, tenant);
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        console.error('listCalendarAccounts:', e);
        await ctx.editMessageText('❌ Не удалось загрузить список. Проверьте логи.');
    }
});

// Старт добавления Google-аккаунта.
bot.action(/^cal_add_g:(.+)$/, async (ctx) => {
    const tenant = ctx.match[1]!;
    const userId = ctx.from!.id;
    calendarSessions.set(userId, { tenant, provider: 'google', step: 'json' });
    await ctx.answerCbQuery();
    const isPrivate = ctx.chat?.type === 'private';
    if (isPrivate) {
        await ctx.editMessageText(
            '🔵 *Подключение Google Calendar*\n\n' +
            'Пришлите JSON-файл *service account* (или вставьте содержимое текстом).\n\n' +
            '*Как получить:*\n' +
            '1. console.cloud.google.com → IAM → Сервисные аккаунты → Создать\n' +
            '2. Открыть аккаунт → Ключи → Добавить ключ → JSON\n' +
            '3. Поделиться календарём с email аккаунта (права «Просмотр»)',
            { parse_mode: 'Markdown' }
        );
    } else {
        const me = await ctx.telegram.getMe();
        await ctx.editMessageText(
            '🔵 *Подключение Google Calendar*\n\n' +
            'Пришлите JSON-файл *service account* (или вставьте содержимое текстом) ' +
            'в личные сообщения боту.\n\n' +
            '_Как получить: IAM → Service Accounts → Ключи → Добавить ключ → JSON._',
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.url('💬 Открыть личку', `https://t.me/${me.username}`)]]),
            }
        );
    }
});

// Старт добавления Яндекс-аккаунта.
bot.action(/^cal_add_y:(.+)$/, async (ctx) => {
    const tenant = ctx.match[1]!;
    const userId = ctx.from!.id;
    calendarSessions.set(userId, { tenant, provider: 'yandex', step: 'login' });
    await ctx.answerCbQuery();
    const isPrivate = ctx.chat?.type === 'private';
    if (isPrivate) {
        await ctx.editMessageText(
            '🟡 *Подключение Яндекс Календаря*\n\n' +
            'Введите *логин CalDAV* (обычно email @yandex.ru).\n\n' +
            '*Важно:* нужен пароль приложения, не обычный пароль от Яндекса.\n' +
            'Получить: passport.yandex.ru → Безопасность → Пароли приложений → Создать',
            { parse_mode: 'Markdown' }
        );
    } else {
        const me = await ctx.telegram.getMe();
        await ctx.editMessageText(
            '🟡 *Подключение Яндекс Календаря*\n\n' +
            'Откройте личку бота и введите *логин CalDAV* (обычно email @yandex.ru).',
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.url('💬 Открыть личку', `https://t.me/${me.username}`)]]),
            }
        );
    }
});

// Удаление аккаунта. Формат: cal_del:<accountId>:<tenant>
bot.action(/^cal_del:([^:]+):(.+)$/, async (ctx) => {
    const accountId = ctx.match[1]!;
    const tenant = ctx.match[2]!;
    await ctx.answerCbQuery('Удаляю…');
    try {
        await deleteCalendarAccount(tenant, accountId);
        const accounts = await listCalendarAccounts(tenant);
        const { text, keyboard } = formatAccountList(accounts, tenant);
        await ctx.editMessageText(`✅ Удалено.\n\n${text}`, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        console.error('deleteCalendarAccount:', e);
        await ctx.editMessageText('❌ Не удалось удалить. Проверьте логи.');
    }
});

// Получение JSON-файла (Google service account) в личке.
bot.on('document', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const userId = ctx.from.id;
    const sess = calendarSessions.get(userId);
    if (!sess || sess.provider !== 'google' || sess.step !== 'json') return;

    const doc = ctx.message.document;
    if (!doc.mime_type?.includes('json') && !doc.file_name?.endsWith('.json')) {
        await ctx.reply('❌ Пришлите .json файл (или вставьте содержимое текстом).');
        return;
    }
    try {
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(link.href);
        const content = await resp.text();
        await processGoogleJson(ctx, userId, sess, content);
    } catch (e) {
        console.error('calendar document:', e);
        await ctx.reply('❌ Не удалось обработать файл. Попробуйте ещё раз.');
    }
});

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

    // Личка: ждём ли мы API-ключ от админа (онбординг доски)?
    if (ctx.chat.type === 'private') {
        const tenant = awaitingKey.get(ctx.from.id);
        if (tenant) {
            awaitingKey.delete(ctx.from.id);
            try {
                await saveYougileCreds(tenant, message.text.trim());
                const projects = await listYougileProjects(tenant);
                if (projects.length === 0) {
                    await ctx.reply('🔑 Ключ принят, но в YouGile нет проектов. Создайте проект и нажмите /start ещё раз.');
                    return;
                }
                projectSessions.set(ctx.from.id, { tenant, projects });
                const buttons = projects.map((p, i) => [Markup.button.callback(p.title || `Проект ${i + 1}`, `proj_${i}`)]);
                await ctx.reply('🔑 Ключ принят! Выберите проект YouGile для этой группы:', Markup.inlineKeyboard(buttons));
            } catch (e) {
                console.error('connect yougile:', e);
                awaitingKey.set(ctx.from.id, tenant); // ждём ключ снова
                await ctx.reply('❌ YouGile отклонил ключ (неверный или нет доступа).\nПришлите корректный *API-ключ* ещё раз.', { parse_mode: 'Markdown' });
            }
        }
        // Ввод данных для подключения календаря.
        const calSess = calendarSessions.get(ctx.from.id);
        if (calSess) {
            if (calSess.provider === 'google' && calSess.step === 'json') {
                await processGoogleJson(ctx, ctx.from.id, calSess, message.text.trim());
            } else if (calSess.provider === 'yandex' && calSess.step === 'login') {
                calSess.login = message.text.trim();
                calSess.step = 'password';
                await ctx.reply('🟡 Теперь введите *пароль* (или пароль приложения для CalDAV):', { parse_mode: 'Markdown' });
            } else if (calSess.provider === 'yandex' && calSess.step === 'password') {
                const login = calSess.login!;
                const password = message.text.trim();
                calendarSessions.delete(ctx.from.id);
                try {
                    const account = await addCalendarAccount(calSess.tenant, 'yandex', { login, password }, 'Яндекс Календарь');
                    await ctx.reply(`✅ *Яндекс Календарь подключён!*\nID: \`${account.id}\``, { parse_mode: 'Markdown' });
                } catch (e) {
                    console.error('addCalendarAccount yandex:', e);
                    await ctx.reply('❌ Не удалось подключить. Проверьте логин и пароль.');
                }
            }
            return;
        }

        return; // прочие личные сообщения не разбираем как задачи
    }

    // Группа: кэшируем.
    recentMessages.set(message.message_id, message.text);

    // Telemost-ссылка в сообщении → планируем созвон без участия PM.
    const telemostUrl = message.text.match(/https?:\/\/telemost\.yandex\.ru\/j\/[^\s]+/)?.[0];
    if (telemostUrl) {
        const ws = await resolveTenant(ctx.chat.id).catch(() => null);
        if (ws) {
            try {
                const result = await scheduleCallInOvra(ws.tenant_id, telemostUrl);
                if (result.duplicate) {
                    await ctx.reply('📅 Эта встреча уже запланирована — бот придёт.');
                } else {
                    await ctx.reply('📅 Принял! Бот придёт на этот созвон и пришлёт саммари.');
                }
            } catch (e) {
                console.error('schedule call:', e);
                await ctx.reply('❌ Не удалось запланировать созвон. Проверьте логи.');
            }
        }
        return;
    }

    // Если похоже на задачу — разбираем (эвристика бережёт токены).
    if (isPotentialTask(message.text)) {
        await processTaskAndConfirm(ctx, message.text);
    }
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

// Создаёт задачу через бэкенд. force=false: при найденных дублях показывает
// подтверждение «всё равно добавить?». force=true: создаёт в обход дедупа.
async function submitTask(ctx: Context, taskId: string, pending: PendingTask, force: boolean) {
    const taskData = pending.task;

    // @username → имя из YouGile, если привязан через /bind.
    let assignee = taskData.assignee || "";
    if (assignee.startsWith('@')) {
        const mapped = userMapping[assignee.toLowerCase()];
        if (mapped) assignee = mapped;
    }

    const title = taskData.title || "Новая задача из Telegram";
    const description = taskData.description || "";
    const deadline = taskData.deadline || "";

    const result = await sendTaskToOvraBackend(pending.tenantId, title, assignee, description, deadline, force);

    // Найдены похожие задачи — спрашиваем хоста, добавлять ли всё равно.
    if (result.isDuplicate && !force) {
        const onBoard = (result.duplicates || []).map(d => `• ${d.title}`).join('\n') || '—';
        await ctx.editMessageText(
            `⚠️ *Похоже, такая задача уже есть*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🆕 Новая задача:\n*${title}*\n\n` +
            `📋 Уже на доске:\n${onBoard}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Вы желаете добавить?`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    Markup.button.callback('✅ Да, добавить', `force_${taskId}`),
                    Markup.button.callback('❌ Нет', `reject_${taskId}`)
                ])
            }
        );
        return; // pending НЕ удаляем — нужен для кнопки «Да, добавить»
    }

    // Успех.
    await ctx.editMessageText(
        `✅ *Задача создана в YouGile*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 *${title}*\n` +
        `👤 ${assignee || '—'}\n` +
        `🔗 ID: \`${result.yougile_task_id || 'неизвестно'}\``,
        { parse_mode: 'Markdown' }
    );

    // Уведомляем исходный чат (группу), что задача поставлена.
    if (pending.originChatId && pending.originChatId !== ctx.chat?.id) {
        try {
            await ctx.telegram.sendMessage(
                pending.originChatId,
                `✅ *Задача поставлена в YouGile*\n📌 ${title}` +
                (assignee ? `\n👤 ${assignee}` : ''),
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.error('Не удалось отправить уведомление в чат-источник:', e);
        }
    }

    pendingTasks.delete(taskId);
}

bot.action(/^approve_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingTasks.get(taskId);
    if (!pending) return ctx.answerCbQuery('Задача устарела или не найдена.');
    try {
        await ctx.answerCbQuery('Проверяю…');
        await submitTask(ctx, taskId, pending, false);
    } catch (error) {
        console.error(error);
        await ctx.editMessageText('❌ Не удалось создать задачу в YouGile. Подробности — в логах бэкенда.');
    }
});

// «Да, добавить» — создать несмотря на найденные дубли.
bot.action(/^force_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingTasks.get(taskId);
    if (!pending) return ctx.answerCbQuery('Задача устарела или не найдена.');
    try {
        await ctx.answerCbQuery('Добавляю…');
        await submitTask(ctx, taskId, pending, true);
    } catch (error) {
        console.error(error);
        await ctx.editMessageText('❌ Не удалось создать задачу в YouGile. Подробности — в логах бэкенда.');
    }
});

bot.action(/^reject_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    pendingTasks.delete(taskId);
    await ctx.editMessageText('🗑️ Задача отклонена.');
});

bot.command('help', async (ctx) => {
    await ctx.reply(
        `🤖 *Ovra PM-bot*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Я слежу за чатом и превращаю поручения в карточки YouGile.\n\n` +
        `*Как создать задачу:*\n` +
        `• просто напиши поручение в чат (напр. «нужно сделать отчёт к пятнице»)\n` +
        `• или поставь реакцию ✍️/🔥 на любое сообщение\n` +
        `→ я пришлю карточку на подтверждение, жми *✅ Одобрить*.\n\n` +
        `*Команды:*\n` +
        `/start — назначить эту личку для подтверждений (ПМ)\n` +
        `/bind Имя Фамилия — привязать твой @ к сотруднику YouGile\n` +
        `/stats — статус системы\n` +
        `/help — эта справка`,
        { parse_mode: 'Markdown' }
    );
});

// Бота добавили в группу / сделали админом → создаём воркспейс и зовём в личку.
bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    if (!upd || upd.chat.type === 'private') return;
    const status = upd.new_chat_member.status;
    if (status !== 'administrator' && status !== 'member') return;

    try {
        const chat: any = upd.chat;
        const ws = await createWorkspace(chat.id, chat.title || 'Группа', upd.from?.id || '');
        const me = await ctx.telegram.getMe();
        const link = `https://t.me/${me.username}?start=${ws.tenant_id}`;
        const adminNote = status === 'administrator' ? '' :
            '\n\n⚠️ Дайте мне права *администратора*, чтобы я видел сообщения и реакции.';
        await ctx.telegram.sendMessage(chat.id,
            `👋 Привет! Я *Ovra* — превращаю поручения из чата в задачи YouGile.\n` +
            `Нажмите кнопку ниже, чтобы подключить доску и подвязаться:` + adminNote,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.url('🔗 Открыть бота', link)]) }
        );
    } catch (e) {
        console.error('my_chat_member onboarding:', e);
    }
});

// Админ выбрал проект YouGile для группы.
bot.action(/^proj_(\d+)$/, async (ctx) => {
    const idx = parseInt(ctx.match[1]!, 10);
    const userId = ctx.from!.id;
    const sess = projectSessions.get(userId);
    if (!sess || !sess.projects[idx]) {
        return ctx.answerCbQuery('Сессия устарела — нажмите /start ещё раз.');
    }
    const proj = sess.projects[idx];
    try {
        await ctx.answerCbQuery('Подключаю…');
        await setWorkspaceProject(sess.tenant, proj.id);
        projectSessions.delete(userId);
        await ctx.editMessageText(
            `✅ Доска подключена: *${proj.title}*\n\n` +
            `Подключите календарь, чтобы бот автоматически присоединялся к Telemost-звонкам и присылал саммари встреч:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔵 Google Calendar', `cal_add_g:${sess.tenant}`)],
                    [Markup.button.callback('🟡 Яндекс Календарь', `cal_add_y:${sess.tenant}`)],
                    [Markup.button.callback('⏭️ Пропустить', `cal_skip:${sess.tenant}`)],
                ]),
            }
        );
    } catch (e) {
        console.error('set project:', e);
        await ctx.editMessageText('❌ Не удалось подключить доску. Попробуйте /start ещё раз.');
    }
});

// Пользователь выбрал себя из списка сотрудников YouGile.
bot.action(/^link_(\d+)$/, async (ctx) => {
    const idx = parseInt(ctx.match[1]!, 10);
    const userId = ctx.from!.id;
    const sess = linkSessions.get(userId);
    if (!sess || !sess.members[idx]) {
        return ctx.answerCbQuery('Сессия устарела — нажмите /start ещё раз.');
    }
    const m = sess.members[idx];
    try {
        await ctx.answerCbQuery('Сохраняю…');
        await registerUser(sess.tenant, {
            tg_id: String(userId),
            tg_username: ctx.from!.username ? `@${ctx.from!.username}` : '',
            full_name: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' ') || (ctx.from!.username || ''),
            yougile_user_id: m.id,
        });
        linkSessions.delete(userId);
        await ctx.editMessageText(`✅ Готово! Вы привязаны к *${m.name || m.email}*.\nТеперь задачи из чата смогут назначаться на вас.`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('link register:', e);
        await ctx.editMessageText('❌ Не удалось сохранить привязку. Попробуйте позже.');
    }
});

// Пропустить подключение календаря при онбординге.
bot.action(/^cal_skip:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '✅ Готово! Сотрудники могут нажать «Открыть бота» в группе и подвязаться к себе.\n\n' +
        '_Подключить календарь можно позже командой `/calendar` в групповом чате._',
        { parse_mode: 'Markdown' }
    );
});

export { bot };