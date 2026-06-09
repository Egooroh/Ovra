// src/bot.ts
import { Telegraf, Markup, Context } from "telegraf";
import { isPotentialTask } from "./utils/heuristics.js";
import { parseMessageWithAI, type ParsedTask } from "./services/ai.js";
import {
    sendTaskToOvraBackend, resolveTenant, createWorkspace, getWorkspaceInfo,
    listYougileMembers, registerUser, scheduleCallInOvra,
    saveYougileCreds, listYougileProjects, setWorkspaceProject,
    listCalendarAccounts, addCalendarAccount, deleteCalendarAccount,
    deleteTask, getDigest, getTrash, clearTrash, syncWorkspace, listTasks,
    setConfirmMode, updateDigestSettings,
    type YougileMember, type YougileProject, type CalendarAccount, type DigestData
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

// Куда слать подтверждения задач: 'pm' (личка ПМа) или 'group' (группа-источник).
const confirmDefault: 'pm' | 'group' =
    (process.env.CONFIRM_TARGET === 'pm' ? 'pm' : 'group');
const confirmTarget = new Map<string, 'pm' | 'group'>(); // tenant_id → override

// Сессии онбординга (по user id):
const awaitingKey = new Map<number, string>();                              // юзер → tenant: ждём API-ключ от админа
const linkSessions = new Map<number, { tenant: string; members: YougileMember[] }>(); // юзер → выбор себя из YouGile
const projectSessions = new Map<number, { tenant: string; projects: YougileProject[] }>(); // юзер → выбор проекта

// taskIdByMessage хранит backend task_id для кнопки «Удалить» после одобрения.
// ключ — messageId сообщения «Задача создана», значение — task id из бэкенда.
const taskIdByMessage = new Map<number, string>();

// Задачи из созвона, ожидающие подтверждения в групповом чате.
interface PendingMeetingTask {
    title: string;
    assignee: string;
    deadline: string;
    tenantId: string;
    groupChatId: number;
}
const pendingMeetingTasks = new Map<string, PendingMeetingTask>();

// Проверка, является ли пользователь администратором (или создателем) группы.
// Используется для гейтинга подтверждения задач из созвона: только админ,
// которому в Telegram-группе выданы права, может одобрять/отклонять задачи.
// Возвращает true, если пользователь может подтверждать задачи.
// mode='everyone' — разрешено всем; mode='admin_only' — только администраторам группы.
async function canConfirmTasks(chatId: number | string, userId: number, mode: string): Promise<boolean> {
    if (mode === 'everyone') return true;
    try {
        const member = await bot.telegram.getChatMember(chatId, userId);
        const ok = member.status === 'creator' || member.status === 'administrator';
        console.log(`[canConfirm] chat=${chatId} user=${userId} status=${member.status} mode=${mode} → ${ok}`);
        return ok;
    } catch (e) {
        console.error(`[canConfirm] chat=${chatId} user=${userId} error:`, e);
        return false;
    }
}

// Payload, который бэкенд шлёт боту после завершения созвона.
export interface MeetingDonePayload {
    chat_id: string;
    tenant_id: string;
    title: string;
    summary: string;
    tasks: Array<{ title: string; assignee: string; deadline: string }>;
}

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
        try {
            const ws = await resolveTenant(ctx.chat.id);
            if (ws) {
                const me = await ctx.telegram.getMe();
                const link = `https://t.me/${me.username}?start=${ws.tenant_id}`;
                return ctx.reply(
                    'Нажмите кнопку ниже, чтобы привязать свой YouGile-аккаунт:',
                    Markup.inlineKeyboard([[Markup.button.url('🔗 Открыть бота', link)]])
                );
            }
        } catch {}
        return ctx.reply('Напишите мне в личные сообщения 🙏');
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

async function processTaskAndConfirm(ctx: Context, text: string, force = false) {
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

    // force=true (постановка через реакцию ✍️/🔥) — пользователь явным жестом
    // пометил сообщение как задачу, поэтому создаём её даже если ИИ счёл, что
    // это не задача. Извлечённые ИИ поля используем, если они есть.
    let task = parsed;
    if (force && (!parsed || !parsed.isTask)) {
        task = {
            isTask: true,
            title: parsed?.title || text.trim().slice(0, 100),
            assignee: parsed?.assignee || '',
            deadline: parsed?.deadline || '',
            description: parsed?.description || '',
        };
    }

    if (task && task.isTask) {
        const taskId = crypto.randomBytes(8).toString('hex');
        pendingTasks.set(taskId, { task, tenantId: ws.tenant_id, originChatId: chatId });
        cleanUpCache();

        const messageText = `🆕 *Новая задача на подтверждение*\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `📌 *${task.title || 'Без названия'}*\n\n` +
                            `👤 Исполнитель: ${task.assignee || '—'}\n` +
                            `⏳ Дедлайн: ${task.deadline || '—'}\n` +
                            `📝 ${task.description || 'без описания'}\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `_Создать карточку в YouGile?_`;

        const target = confirmTarget.get(ws.tenant_id) ?? confirmDefault;
        const targetChatId = target === 'group' ? chatId : activePmChatId;

        if (!targetChatId) {
            console.error("❌ ID ПМа не установлен! Некуда отправлять задачу.");
            if (ctx.chat && ctx.chat.type !== 'private') {
                await ctx.reply("❌ Задача найдена, но я не знаю, кому её отправить на подтверждение. Кто-нибудь, напишите мне /start в личные сообщения, или используйте /confirm group.");
            }
            return;
        }

        try {
            await ctx.telegram.sendMessage(targetChatId, messageText, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    Markup.button.callback('✅ Одобрить', `approve_${taskId}`),
                    Markup.button.callback('❌ Отклонить', `reject_${taskId}`)
                ])
            });
        } catch (error) {
            console.error("❌ Ошибка отправки подтверждения.", error);
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

    let confirmStatus = '—';
    if (ctx.chat.type !== 'private') {
        const ws = await resolveTenant(ctx.chat.id).catch(() => null);
        if (ws) {
            const t = confirmTarget.get(ws.tenant_id) ?? confirmDefault;
            confirmStatus = t === 'group' ? '👥 В группу' : '👤 В личку ПМа';
        }
    }

    const statsText = `📊 **Статус системы Ovra PM-Bot**\n\n` +
                      `🌐 **Прокси:** ${proxyStatus}\n` +
                      `⚙️ **Go-Бэкенд:** ${backendStatus}\n` +
                      `🧠 **AI (OpenRouter):** ${aiStatus}\n` +
                      `👤 **Личка ПМа:** ${pmStatus}\n` +
                      `📬 **Подтверждения:** ${confirmStatus}\n\n` +
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

bot.on("text", async (ctx, next) => {
    const message = ctx.message;

    // Личка: ждём ли мы API-ключ от админа (онбординг доски)?
    if (ctx.chat.type === 'private') {
        const tenant = awaitingKey.get(ctx.from.id);
        if (tenant) {
            awaitingKey.delete(ctx.from.id);
            try {
                await saveYougileCreds(tenant, { api_key: message.text.trim() });
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

    // Команды в группе обрабатываются отдельными bot.command() хендлерами.
    if (message.text.startsWith('/')) return next();

    // Группа: кэшируем.
    recentMessages.set(message.message_id, message.text);

    // Telemost-ссылка в сообщении → планируем созвон без участия PM.
    const telemostUrl = message.text.match(/https?:\/\/telemost\.yandex\.ru\/j\/[^\s]+/)?.[0];
    if (telemostUrl) {
        const ws = await resolveTenant(ctx.chat.id).catch(() => null);
        if (ws) {
            try {
                const startsAt = parseCallTime(message.text);
                const result = await scheduleCallInOvra(ws.tenant_id, telemostUrl, undefined, startsAt);
                if (result.duplicate) {
                    await ctx.reply('📅 Эта встреча уже запланирована — бот придёт.');
                } else if (startsAt) {
                    const localTime = formatLocalTime(startsAt);
                    await ctx.reply(`📅 Принял! Бот придёт на созвон в ${localTime} и пришлёт саммари.`);
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

    const emojis = (reactionInfo.new_reaction || [])
        .filter((r: any) => r.type === 'emoji')
        .map((r: any) => r.emoji as string);
    console.log(`[reaction] msg=${messageId} chat=${(reactionInfo as any).chat?.id} emojis=${JSON.stringify(emojis)} cached=${recentMessages.has(messageId)}`);

    // Сравнение без variation selector (✍️ может прийти как ✍ без ️).
    const hasPinReaction = emojis.some((e) => {
        const base = e.replace(/️/g, '');
        return base === '✍' || base === '🔥';
    });

    if (!hasPinReaction) return;

    const text = recentMessages.get(messageId);
    if (!text) {
        console.log(`[reaction] msg=${messageId} нет в кэше — сообщение отправлено до рестарта бота или не текстовое`);
        return;
    }
    // Реакция = явное намерение создать задачу, поэтому force=true.
    await processTaskAndConfirm(ctx, text, true);
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

    // Успех — показываем кнопку «Удалить» если знаем backend task id.
    const successText =
        `✅ *Задача создана в YouGile*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 *${title}*\n` +
        `👤 ${assignee || '—'}\n` +
        `🔗 ID: \`${result.yougile_task_id || 'неизвестно'}\``;

    const backendId: string | undefined = (result as any).id;
    if (backendId) {
        const sent = await ctx.editMessageText(successText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('🗑️ Удалить', `del_task_${backendId}`)
            ])
        });
        if (typeof sent === 'object' && sent && 'message_id' in sent) {
            taskIdByMessage.set(sent.message_id, backendId);
        }
    } else {
        await ctx.editMessageText(successText, { parse_mode: 'Markdown' });
    }

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
    if (pending.originChatId) {
        const ws = await resolveTenant(pending.originChatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        if (!(await canConfirmTasks(pending.originChatId, ctx.from!.id, mode))) {
            return ctx.answerCbQuery('Только администратор может подтверждать задачи.', { show_alert: true });
        }
    }
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
    if (pending.originChatId) {
        const ws = await resolveTenant(pending.originChatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        if (!(await canConfirmTasks(pending.originChatId, ctx.from!.id, mode))) {
            return ctx.answerCbQuery('Только администратор может подтверждать задачи.', { show_alert: true });
        }
    }
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
    const pending = pendingTasks.get(taskId);
    if (!pending) return ctx.answerCbQuery('Задача устарела или не найдена.');
    if (pending.originChatId) {
        const ws = await resolveTenant(pending.originChatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        if (!(await canConfirmTasks(pending.originChatId, ctx.from!.id, mode))) {
            return ctx.answerCbQuery('Только администратор может отклонять задачи.', { show_alert: true });
        }
    }
    pendingTasks.delete(taskId);
    await ctx.editMessageText('🗑️ Задача отклонена.');
});

bot.command('confirm', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();

    if (ctx.chat.type !== 'private') {
        const ws = await resolveTenant(ctx.chat.id).catch(() => null);
        if (!ws) return ctx.reply('❌ Чат не привязан к доске.');

        if (arg === 'group') {
            confirmTarget.set(ws.tenant_id, 'group');
            return ctx.reply('✅ Задачи на подтверждение будут приходить *в эту группу*.', { parse_mode: 'Markdown' });
        } else if (arg === 'pm') {
            confirmTarget.set(ws.tenant_id, 'pm');
            return ctx.reply('✅ Задачи на подтверждение будут приходить *в личку ПМа*.', { parse_mode: 'Markdown' });
        } else {
            const current = confirmTarget.get(ws.tenant_id) ?? confirmDefault;
            return ctx.reply(
                `📬 Куда приходят подтверждения: *${current === 'group' ? 'в эту группу' : 'в личку ПМа'}*\n\n` +
                `Изменить:\n` +
                `/confirm group — приходить сюда в группу\n` +
                `/confirm pm — приходить в личку ПМа`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    return ctx.reply('Используй эту команду в группе: /confirm group или /confirm pm');
});

// Настройка режима подтверждения задач: только админы или все участники.
bot.command('confirm_mode', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Эта команда работает только в группе.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('❌ Чат не привязан к доске.');

    const isAdmin = await canConfirmTasks(ctx.chat.id, ctx.from!.id, 'admin_only');
    if (!isAdmin) {
        return ctx.reply('⛔ Изменять режим может только администратор группы.');
    }

    const current = ws.confirm_mode ?? 'admin_only';
    const label = current === 'everyone' ? '👥 Все участники' : '🔒 Только администраторы';
    await ctx.reply(
        `⚙️ *Режим подтверждения задач*\n\nСейчас: *${label}*\n\nКто может подтверждать и отклонять задачи?`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback(
                    current === 'admin_only' ? '✅ Только администраторы' : 'Только администраторы',
                    'cm_admin_only'
                ),
                Markup.button.callback(
                    current === 'everyone' ? '✅ Все участники' : 'Все участники',
                    'cm_everyone'
                ),
            ]),
        }
    );
});

bot.action('cm_admin_only', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return ctx.answerCbQuery();
    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws) return ctx.answerCbQuery('Воркспейс не найден.', { show_alert: true });
    const isAdmin = await canConfirmTasks(chatId, ctx.from!.id, 'admin_only');
    if (!isAdmin) return ctx.answerCbQuery('Только администратор может менять настройки.', { show_alert: true });

    await setConfirmMode(ws.tenant_id, 'admin_only');
    await ctx.editMessageText(
        '⚙️ *Режим подтверждения задач*\n\nСейчас: *🔒 Только администраторы*',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('✅ Только администраторы', 'cm_admin_only'),
                Markup.button.callback('Все участники', 'cm_everyone'),
            ]),
        }
    );
    await ctx.answerCbQuery('Режим обновлён: только администраторы.');
});

bot.action('cm_everyone', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return ctx.answerCbQuery();
    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws) return ctx.answerCbQuery('Воркспейс не найден.', { show_alert: true });
    const isAdmin = await canConfirmTasks(chatId, ctx.from!.id, 'admin_only');
    if (!isAdmin) return ctx.answerCbQuery('Только администратор может менять настройки.', { show_alert: true });

    await setConfirmMode(ws.tenant_id, 'everyone');
    await ctx.editMessageText(
        '⚙️ *Режим подтверждения задач*\n\nСейчас: *👥 Все участники*',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('Только администраторы', 'cm_admin_only'),
                Markup.button.callback('✅ Все участники', 'cm_everyone'),
            ]),
        }
    );
    await ctx.answerCbQuery('Режим обновлён: все участники.');
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
        `/confirm group — подтверждения в группу\n` +
        `/confirm pm — подтверждения в личку ПМа\n` +
        `/confirm\\_mode — кто может подтверждать задачи (только в группе)\n` +
        `/bind Имя Фамилия — привязать твой @ к сотруднику YouGile\n` +
        `/digest — дайджест открытых задач по исполнителям\n` +
        `/digest\\_time — настроить время ежедневного дайджеста\n` +
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
        // Получаем воркспейс чтобы проверить, является ли регистрирующийся хостом.
        let role = 'member';
        try {
            const wsInfo = await getWorkspaceInfo(sess.tenant);
            if (wsInfo.host_tg_id && wsInfo.host_tg_id === String(userId)) {
                role = 'admin';
            }
        } catch { /* нет данных о роли — ставим member */ }

        await registerUser(sess.tenant, {
            tg_id: String(userId),
            tg_username: ctx.from!.username ? `@${ctx.from!.username}` : '',
            full_name: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' ') || (ctx.from!.username || ''),
            yougile_user_id: m.id,
            role,
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

// ---- Парсинг времени созвона из сообщения ----

// Timezone for call scheduling — must match DEADLINE_TZ on the backend.
const CALL_TZ = process.env.DEADLINE_TZ ?? 'Europe/Moscow';

// Parses a time mention like "в 17:00", "в 17.00", "в 17 часов", "в 5pm"
// from a message and returns an ISO-8601 string in the configured timezone.
// Returns undefined if no time found.
function parseCallTime(text: string): string | undefined {
    // Match "в 17:00", "в 17.00", "в 17-00", "в 17 00", "в 17 часов/час"
    const m = text.match(/\bв\s+(\d{1,2})(?:[:\.\-](\d{2}))?(?:\s*часов?|ч\.?)?\b/i);
    if (!m) return undefined;

    const hours = parseInt(m[1]!, 10);
    const minutes = parseInt(m[2] ?? '0', 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;

    // Build a date in the target timezone for today.
    const now = new Date();
    // Format today's date parts in the target TZ.
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: CALL_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);

    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';
    let year = parseInt(get('year'), 10);
    let month = parseInt(get('month'), 10);
    let day = parseInt(get('day'), 10);
    const currentHour = parseInt(get('hour'), 10);

    // If the requested time has already passed today, schedule for tomorrow.
    if (hours < currentHour || (hours === currentHour && minutes <= parseInt(get('minute'), 10))) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tp = new Intl.DateTimeFormat('en-CA', {
            timeZone: CALL_TZ,
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(tomorrow);
        year = parseInt(tp.find(p => p.type === 'year')?.value ?? '0', 10);
        month = parseInt(tp.find(p => p.type === 'month')?.value ?? '0', 10);
        day = parseInt(tp.find(p => p.type === 'day')?.value ?? '0', 10);
    }

    // Convert local time in CALL_TZ to UTC ISO string.
    // We do this by formatting a UTC date that matches the local time.
    const localStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00`;
    // Find the UTC offset at that moment in the target timezone.
    const probe = new Date(`${localStr}Z`);
    const offsetMin = (probe.getTime() - new Date(new Intl.DateTimeFormat('en-CA', {
        timeZone: CALL_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(probe) + 'Z').getTime()) / 60000;

    const utc = new Date(probe.getTime() - offsetMin * 60000);
    return utc.toISOString();
}

function formatLocalTime(iso: string): string {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: CALL_TZ,
        hour: '2-digit', minute: '2-digit',
        timeZoneName: 'short',
    }).format(new Date(iso));
}

// ---- Саммари созвона и подтверждение задач из встречи ----

// Вызывается из HTTP-сервера в index.ts когда бэкенд пушит результат созвона.
export async function handleMeetingDone(payload: MeetingDonePayload): Promise<void> {
    const chatId = Number(payload.chat_id);
    if (!chatId) throw new Error(`invalid chat_id: ${payload.chat_id}`);

    const meetingTitle = payload.title || 'Созвон';

    const summaryText =
        `📋 *Саммари встречи: ${meetingTitle}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${payload.summary || '_Саммари недоступно_'}\n` +
        `━━━━━━━━━━━━━━━━━━`;

    await bot.telegram.sendMessage(chatId, summaryText, { parse_mode: 'Markdown' });

    if (!payload.tasks || payload.tasks.length === 0) {
        await bot.telegram.sendMessage(chatId, '✅ Задач из созвона не найдено.');
        return;
    }

    await bot.telegram.sendMessage(
        chatId,
        `📌 Найдено задач: *${payload.tasks.length}*. Подтвердите каждую:`,
        { parse_mode: 'Markdown' }
    );

    for (const task of payload.tasks) {
        const taskId = crypto.randomBytes(8).toString('hex');
        pendingMeetingTasks.set(taskId, {
            title: task.title,
            assignee: task.assignee || '',
            deadline: task.deadline || '',
            tenantId: payload.tenant_id,
            groupChatId: chatId,
        });

        const taskText =
            `🆕 *Задача из созвона*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📌 *${task.title}*\n` +
            `👤 Исполнитель: ${task.assignee || '—'}\n` +
            `⏳ Дедлайн: ${task.deadline || '—'}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `_Создать карточку в YouGile?_`;

        await bot.telegram.sendMessage(chatId, taskText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('✅ Добавить', `mtask_ok_${taskId}`),
                Markup.button.callback('❌ Пропустить', `mtask_no_${taskId}`),
            ]),
        });
    }
}

bot.action(/^mtask_ok_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingMeetingTasks.get(taskId);
    if (!pending) return ctx.answerCbQuery('Задача устарела или не найдена.');

    const ws = await resolveTenant(pending.groupChatId).catch(() => null);
    const mode = ws?.confirm_mode ?? 'admin_only';
    if (!(await canConfirmTasks(pending.groupChatId, ctx.from!.id, mode))) {
        return ctx.answerCbQuery('Только администратор может подтверждать задачи.', { show_alert: true });
    }

    try {
        await ctx.answerCbQuery('Создаю…');

        let assignee = pending.assignee;
        if (assignee.startsWith('@')) {
            const mapped = userMapping[assignee.toLowerCase()];
            if (mapped) assignee = mapped;
        }

        const result = await sendTaskToOvraBackend(
            pending.tenantId, pending.title, assignee, '', pending.deadline, true
        );

        pendingMeetingTasks.delete(taskId);
        await ctx.editMessageText(
            `✅ *Задача создана в YouGile*\n` +
            `📌 *${pending.title}*\n` +
            `👤 ${assignee || '—'}\n` +
            `🔗 ID: \`${result.yougile_task_id || 'неизвестно'}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('mtask_ok error:', error);
        await ctx.editMessageText('❌ Не удалось создать задачу в YouGile. Подробности — в логах.');
    }
});

bot.action(/^mtask_no_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingMeetingTasks.get(taskId);
    if (!pending) return ctx.answerCbQuery('Задача устарела или не найдена.');

    const ws2 = await resolveTenant(pending.groupChatId).catch(() => null);
    const mode2 = ws2?.confirm_mode ?? 'admin_only';
    if (!(await canConfirmTasks(pending.groupChatId, ctx.from!.id, mode2))) {
        return ctx.answerCbQuery('Только администратор может отклонять задачи.', { show_alert: true });
    }

    pendingMeetingTasks.delete(taskId);
    await ctx.answerCbQuery();
    await ctx.editMessageText('🗑️ Задача из созвона пропущена.');
});

// Удаление задачи через кнопку после одобрения (мягкое удаление, 24 ч корзина).
bot.action(/^del_task_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    try {
        await ctx.answerCbQuery('Удаляю…');
        await deleteTask(taskId);
        await ctx.editMessageText('🗑️ Задача перемещена в корзину (удалится через 24 ч).');
    } catch (e) {
        console.error('del_task:', e);
        await ctx.answerCbQuery('❌ Не удалось удалить.');
    }
});

// /board — показать все задачи сгруппированные по статусу (канбан-доска).
bot.command('board', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Используйте команду в групповом чате.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('⚠️ Этот чат не привязан к доске.');

    const loading = await ctx.reply('⏳ Загружаю доску…');
    try {
        const tasks = await listTasks(ws.tenant_id);
        const approved = tasks.filter(t => t.approval_status === 'approved');

        type TaskArr = typeof approved;
        const groups: Record<string, TaskArr> = {
            todo: [], in_progress: [], review: [], done: [],
        };
        for (const t of approved) {
            const bucket = groups[t.status];
            if (bucket) bucket.push(t);
        }

        const labels: Record<string, string> = {
            todo: '🔵 В очереди',
            in_progress: '🟡 В работе',
            review: '🟣 На ревью',
            done: '✅ Готово',
        };

        const lines = ['📋 *Доска задач*', '━━━━━━━━━━━━━━━━━━'];
        let total = 0;
        for (const status of ['todo', 'in_progress', 'review', 'done'] as const) {
            const items: TaskArr = groups[status] ?? [];
            lines.push(`\n${labels[status]} *(${items.length})*`);
            for (const t of items) {
                const dl = t.deadline
                    ? ` · ${new Date(t.deadline) < new Date() ? '🔴' : '📅'} ${new Date(t.deadline).toLocaleDateString('ru-RU')}`
                    : '';
                lines.push(`  • ${t.title}${dl}`);
            }
            total += items.length;
        }
        lines.push(`\n━━━━━━━━━━━━━━━━━━`);
        lines.push(`Всего задач: ${total}`);

        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('board:', e);
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            '❌ Не удалось загрузить доску.');
    }
});

// Форматирует данные дайджеста в текст (Markdown). Возвращает null, если задач нет.
function formatDigest(data: DigestData): string | null {
    const total = data.assignees.reduce((s, a) => s + a.tasks.length, 0)
        + (data.unassigned?.length ?? 0);
    if (total === 0) return null;

    const lines: string[] = [`📋 *Дайджест задач*\n━━━━━━━━━━━━━━━━━━`];

    for (const assignee of data.assignees) {
        const who = assignee.tg_username
            ? `*${assignee.full_name}* (${assignee.tg_username})`
            : `*${assignee.full_name}*`;
        lines.push(`\n👤 ${who}`);
        for (const t of assignee.tasks) {
            const dl = t.deadline
                ? ` · ${t.overdue ? '🔴' : '📅'} ${new Date(t.deadline).toLocaleDateString('ru-RU')}`
                : '';
            lines.push(`  ${statusEmoji(t.status)} ${t.title}${dl}`);
        }
    }

    if (data.unassigned?.length) {
        lines.push(`\n❓ *Без исполнителя*`);
        for (const t of data.unassigned) {
            const dl = t.deadline
                ? ` · ${t.overdue ? '🔴' : '📅'} ${new Date(t.deadline).toLocaleDateString('ru-RU')}`
                : '';
            lines.push(`  ${statusEmoji(t.status)} ${t.title}${dl}`);
        }
    }

    lines.push(`\n━━━━━━━━━━━━━━━━━━\n_Всего открытых: ${total}_`);
    return lines.join('\n');
}

// Шлёт напоминание о задаче в личку исполнителю — планировщик (POST /internal/reminder).
export async function handleReminderDue(
    payload: { tg_id: string; title: string; deadline: string; overdue: boolean }
): Promise<void> {
    const userId = Number(payload.tg_id);
    if (!userId) throw new Error(`invalid tg_id: ${payload.tg_id}`);

    const when = payload.deadline
        ? new Date(payload.deadline).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })
        : '—';

    const text = payload.overdue
        ? `🔴 *Просрочена задача*\n━━━━━━━━━━━━━━━━━━\n📌 ${payload.title}\n⏳ Дедлайн был: ${when}`
        : `⏰ *Напоминание о задаче*\n━━━━━━━━━━━━━━━━━━\n📌 ${payload.title}\n📅 Дедлайн: ${when}`;

    // Может упасть с 403 (бот заблокирован) / 400 (чат не найден), если юзер не
    // запускал бота в личке — это перманентно, эндпоинт обработает отдельно.
    await bot.telegram.sendMessage(userId, text, { parse_mode: 'Markdown' });
}

// Собирает и шлёт дайджест в чат — используется планировщиком (POST /internal/digest).
export async function handleDigestDue(payload: { chat_id: string; tenant_id: string }): Promise<void> {
    const chatId = Number(payload.chat_id);
    if (!chatId) throw new Error(`invalid chat_id: ${payload.chat_id}`);

    const data = await getDigest(payload.tenant_id);
    const text = formatDigest(data);
    if (!text) return; // нет открытых задач — не спамим пустым дайджестом

    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// /digest — прислать дайджест открытых задач по исполнителям.
bot.command('digest', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Используйте команду в групповом чате.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) {
        return ctx.reply('⚠️ Этот чат не привязан к доске.');
    }

    const loading = await ctx.reply('⏳ Собираю дайджест…');

    try {
        const data = await getDigest(ws.tenant_id);
        const text = formatDigest(data);

        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            text ?? '✅ Открытых задач нет — всё чисто!', { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('digest:', e);
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            '❌ Не удалось получить дайджест. Проверьте логи.');
    }
});

// --- Настройка расписания дайджеста ---

// Пресеты времени для кнопок (часовой пояс воркспейса, по умолчанию МСК).
const DIGEST_PRESETS = ['08:00', '09:00', '10:00', '12:00', '18:00', '19:00'];

// Проверка формата HH:MM с валидными часами/минутами.
function isValidHHMM(t: string): boolean {
    const m = /^(\d{2}):(\d{2})$/.exec(t);
    if (!m) return false;
    const h = +m[1]!, min = +m[2]!;
    return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function digestSettingsText(enabled: boolean, time: string): string {
    const state = enabled ? `включён, ежедневно в *${time}* (МСК)` : '🔕 выключен';
    return `🕘 *Ежедневный дайджест*\n\nСейчас: ${state}\n\n` +
        `Выбери время кнопкой ниже или пришли своё:\n` +
        '`/digest_time 14:30` — задать время\n' +
        '`/digest_time off` — выключить';
}

function digestSettingsKeyboard(current: string, enabled: boolean) {
    const timeButtons = DIGEST_PRESETS.map((t) =>
        Markup.button.callback(enabled && t === current ? `✅ ${t}` : t, `dt_set_${t}`)
    );
    return Markup.inlineKeyboard([
        timeButtons.slice(0, 3),
        timeButtons.slice(3),
        [Markup.button.callback(enabled ? '🔕 Выключить' : '✅ Выключен', 'dt_off')],
    ]);
}

// /digest_time — настроить время ежедневного дайджеста (только админ).
bot.command('digest_time', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Используйте команду в групповом чате.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('⚠️ Этот чат не привязан к доске.');

    const isAdmin = await canConfirmTasks(ctx.chat.id, ctx.from!.id, 'admin_only');
    if (!isAdmin) return ctx.reply('⛔ Менять расписание дайджеста может только администратор группы.');

    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();

    if (arg === 'off') {
        await updateDigestSettings(ws.tenant_id, false, ws.digest_time || '09:00');
        return ctx.reply('🔕 Ежедневный дайджест выключен.');
    }
    if (arg) {
        if (!isValidHHMM(arg)) {
            return ctx.reply('⚠️ Неверный формат времени. Пример: `/digest_time 09:30`', { parse_mode: 'Markdown' });
        }
        await updateDigestSettings(ws.tenant_id, true, arg);
        return ctx.reply(`✅ Дайджест будет приходить ежедневно в *${arg}* (МСК).`, { parse_mode: 'Markdown' });
    }

    // Без аргумента — показать текущее состояние с кнопками.
    const time = ws.digest_time || '09:00';
    await ctx.reply(digestSettingsText(ws.digest_enabled, time), {
        parse_mode: 'Markdown',
        ...digestSettingsKeyboard(time, ws.digest_enabled),
    });
});

bot.action(/^dt_set_(\d{2}:\d{2})$/, async (ctx) => {
    const time = ctx.match[1]!;
    const chatId = ctx.chat?.id;
    if (!chatId) return ctx.answerCbQuery();
    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws) return ctx.answerCbQuery('Воркспейс не найден.', { show_alert: true });
    const isAdmin = await canConfirmTasks(chatId, ctx.from!.id, 'admin_only');
    if (!isAdmin) return ctx.answerCbQuery('Только администратор может менять настройки.', { show_alert: true });

    await updateDigestSettings(ws.tenant_id, true, time);
    await ctx.editMessageText(digestSettingsText(true, time), {
        parse_mode: 'Markdown',
        ...digestSettingsKeyboard(time, true),
    }).catch(() => { /* message not modified — игнорируем */ });
    await ctx.answerCbQuery(`Дайджест в ${time}`);
});

bot.action('dt_off', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return ctx.answerCbQuery();
    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws) return ctx.answerCbQuery('Воркспейс не найден.', { show_alert: true });
    const isAdmin = await canConfirmTasks(chatId, ctx.from!.id, 'admin_only');
    if (!isAdmin) return ctx.answerCbQuery('Только администратор может менять настройки.', { show_alert: true });

    const time = ws.digest_time || '09:00';
    await updateDigestSettings(ws.tenant_id, false, time);
    await ctx.editMessageText(digestSettingsText(false, time), {
        parse_mode: 'Markdown',
        ...digestSettingsKeyboard(time, false),
    }).catch(() => { /* message not modified — игнорируем */ });
    await ctx.answerCbQuery('Дайджест выключен');
});

// Формирует текст и кнопки для сообщения корзины.
function buildTrashMessage(tasks: any[], tenantId: string): { text: string; keyboard: any } {
    const lines: string[] = [
        `🗑 *Корзина* — ${tasks.length} ${pluralTasks(tasks.length)}`,
        `_Задачи автоматически удалятся через 24 ч после попадания в корзину_`,
        `━━━━━━━━━━━━━━━━━━`,
    ];
    for (const t of tasks) {
        const when = t.deleted_at
            ? new Date(t.deleted_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '?';
        lines.push(`  • ${t.title}\n    _удалено ${when}_`);
    }
    const keyboard = Markup.inlineKeyboard([
        Markup.button.callback(`🗑 Очистить корзину (${tasks.length})`, `trash_clear_${tenantId}`)
    ]);
    return { text: lines.join('\n'), keyboard };
}

function pluralTasks(n: number): string {
    if (n % 10 === 1 && n % 100 !== 11) return 'задача';
    if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'задачи';
    return 'задач';
}

// /trash — показать задачи в корзине.
bot.command('trash', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Используйте команду в групповом чате.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('⚠️ Этот чат не привязан к доске.');

    const loading = await ctx.reply('⏳ Загружаю корзину…');
    try {
        const tasks = await getTrash(ws.tenant_id);
        if (tasks.length === 0) {
            await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
                '🗑 Корзина пуста — удалять нечего.');
            return;
        }
        const { text, keyboard } = buildTrashMessage(tasks, ws.tenant_id);
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        console.error('trash:', e);
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            '❌ Не удалось загрузить корзину.');
    }
});

// Нажатие «Очистить корзину» → показываем подтверждение.
bot.action(/^trash_clear_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const tenantId = ctx.match[1]!;
    const tasks = await getTrash(tenantId).catch(() => [] as any[]);
    if (tasks.length === 0) {
        await ctx.editMessageText('🗑 Корзина уже пуста.');
        return;
    }
    await ctx.editMessageText(
        `⚠️ *Подтвердите очистку*\n\nБудет удалено *${tasks.length} ${pluralTasks(tasks.length)}* без возможности восстановления:\n\n` +
        tasks.map((t: any) => `  • ${t.title}`).join('\n'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Да, удалить всё', `trash_confirm_${tenantId}`)],
                [Markup.button.callback('❌ Отмена', `trash_cancel_${tenantId}`)],
            ])
        }
    );
});

// Подтверждение очистки.
bot.action(/^trash_confirm_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Очищаю…');
    const tenantId = ctx.match[1]!;
    try {
        const deleted = await clearTrash(tenantId);
        await ctx.editMessageText(
            `✅ *Корзина очищена*\n\nУдалено задач: *${deleted}*`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        console.error('trash_confirm:', e);
        await ctx.editMessageText('❌ Не удалось очистить корзину. Попробуйте ещё раз.');
    }
});

// Отмена очистки → возвращаем список.
bot.action(/^trash_cancel_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Отменено');
    const tenantId = ctx.match[1]!;
    try {
        const tasks = await getTrash(tenantId);
        if (tasks.length === 0) {
            await ctx.editMessageText('🗑 Корзина пуста.');
            return;
        }
        const { text, keyboard } = buildTrashMessage(tasks, tenantId);
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        await ctx.editMessageText('🗑 Корзина.');
    }
});

// /sync — синхронизировать задачи Ovra с YouGile (пересоздать удалённые карточки).
bot.command('sync', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('Используйте команду в групповом чате.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('⚠️ Этот чат не привязан к доске.');

    const loading = await ctx.reply('🔄 Синхронизирую с YouGile…');
    try {
        const r = await syncWorkspace(ws.tenant_id);
        const lines = [
            `🔄 *Синхронизация завершена*`,
            `━━━━━━━━━━━━━━━━━━`,
            `🔍 Проверено задач: *${r.checked}*`,
            `🗑 Удалено из Ovra (нет в YouGile): *${r.deleted}*`,
            `📊 Обновлён статус из YouGile: *${r.status_updated}*`,
            `👤 Обновлён исполнитель из YouGile: *${r.assignee_updated}*`,
            `⏭ Уже синхронизированы: *${r.already_synced}*`,
        ];
        if (r.unarchived > 0) lines.push(`📂 Разархивировано в YouGile: *${r.unarchived}*`);
        if (r.errors.length > 0) {
            lines.push(`\n❌ *Ошибки (${r.errors.length}):*`);
            r.errors.slice(0, 5).forEach(e => lines.push(`  • ${e}`));
            if (r.errors.length > 5) lines.push(`  _…и ещё ${r.errors.length - 5}_`);
        }
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('sync:', e);
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined,
            '❌ Ошибка синхронизации. Проверьте что YouGile подключён (/stats).');
    }
});

function statusEmoji(status: string): string {
    switch (status) {
        case 'todo':        return '🔵';
        case 'in_progress': return '🟡';
        case 'review':      return '🟣';
        case 'done':        return '✅';
        default:            return '•';
    }
}

// Человекочитаемое русское название статуса.
function statusLabel(status: string): string {
    switch (status) {
        case 'todo':        return 'К выполнению';
        case 'in_progress': return 'В работе';
        case 'review':      return 'На ревью';
        case 'done':        return 'Готово';
        default:            return status;
    }
}

// Уведомление о смене статусов задач в группе — планировщик autosync (POST /internal/status-change).
export async function handleStatusChange(
    payload: { chat_id: string; changes: Array<{ title: string; old_status: string; new_status: string }> }
): Promise<void> {
    const chatId = Number(payload.chat_id);
    if (!chatId) throw new Error(`invalid chat_id: ${payload.chat_id}`);
    if (!payload.changes || payload.changes.length === 0) return;

    const lines: string[] = [`🔄 *Обновление статусов задач*\n━━━━━━━━━━━━━━━━━━`];
    for (const c of payload.changes) {
        lines.push(
            `${statusEmoji(c.new_status)} *${c.title}*\n` +
            `   ${statusLabel(c.old_status)} → *${statusLabel(c.new_status)}*`
        );
    }

    await bot.telegram.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

export { bot };