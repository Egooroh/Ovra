// src/bot.ts — Ovra Telegram-бот (мультитенантный).
// Поток: добавили в группу → создаём воркспейс + кнопка «Открыть бота» →
// админ присылает API-ключ и выбирает проект → сотрудники выбирают себя →
// поручение в чате (текст/реакция) → карточка с кнопками прямо в группе →
// [Одобрить] → задача в нужной доске YouGile.
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
import dotenv from "dotenv";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

const proxyUrl = process.env.PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
    telegram: agent ? { agent } : {},
});

// --- состояние в памяти ---
const recentMessages = new Map<number, string>();                  // message_id → текст (для реакций)
interface Pending { task: ParsedTask; tenantId: string; }
const pendingTasks = new Map<string, Pending>();                   // taskId → задача на одобрении
const awaitingKey = new Map<number, string>();                    // userId → tenant: ждём API-ключ
const projectSessions = new Map<number, { tenant: string; projects: YougileProject[] }>();
const linkSessions = new Map<number, { tenant: string; members: YougileMember[] }>();

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

// ============ ОНБОРДИНГ: бота добавили / сделали админом ============
bot.on("my_chat_member", async (ctx) => {
    const upd = ctx.myChatMember;
    if (!upd || upd.chat.type === "private") return;
    const status = upd.new_chat_member.status;
    if (status !== "member" && status !== "administrator") return;

    try {
        const chat: any = upd.chat;
        const ws = await createWorkspace(chat.id, chat.title || "Группа", upd.from?.id || "");
        const me = await ctx.telegram.getMe();
        const link = `https://t.me/${me.username}?start=${ws.tenant_id}`;
        const note = status === "administrator" ? "" :
            "\n\n⚠️ Дайте мне права администратора, чтобы я видел сообщения и реакции.";
        await ctx.telegram.sendMessage(chat.id,
            "👋 Привет! Я Ovra — превращаю поручения из чата в задачи YouGile.\n" +
            "Нажмите кнопку, чтобы подключить доску и подвязаться к себе:" + note,
            Markup.inlineKeyboard([Markup.button.url("🔗 Открыть бота", link)]));
    } catch (e) {
        console.error("my_chat_member:", e);
    }
});

// ============ /start (в т.ч. deep-link с tenant_id) ============
bot.start(async (ctx) => {
    const tenant = (ctx.message.text.split(" ").slice(1).join(" ") || "").trim();
    const userId = ctx.from.id;

    if (!tenant) {
        await ctx.reply(
            "Привет! 👋 Я Ovra.\nОткройте меня кнопкой «🔗 Открыть бота» из вашей рабочей группы — " +
            "так я пойму, к какой доске вас подвязать.");
        return;
    }

    try {
        const ws = await getWorkspaceInfo(tenant);

        if (!ws.connected) {                       // шаг 1 — админ присылает ключ
            awaitingKey.set(userId, tenant);
            await ctx.reply(
                "🔌 Доска ещё не подключена к YouGile.\n\n" +
                "Если вы *администратор*, пришлите одним сообщением одно из:\n" +
                "• *email и пароль* от YouGile через пробел — напр. `me@mail.ru МойПароль` (проще)\n" +
                "• или готовый *API-ключ*\n\n" +
                "_Совет: после подключения удалите сообщение с паролем из этого чата._",
                { parse_mode: "Markdown" });
            return;
        }
        if (!ws.board_resolved) {                  // шаг 2 — выбор проекта
            const projects = await listYougileProjects(tenant);
            if (!projects.length) { await ctx.reply("В YouGile нет проектов. Создайте проект и нажмите /start ещё раз."); return; }
            projectSessions.set(userId, { tenant, projects });
            await ctx.reply("Выберите проект YouGile для этой группы:", projectKeyboard(projects));
            return;
        }
        // шаг 3 — сотрудник выбирает себя
        const members = await listYougileMembers(tenant);
        if (!members.length) { await ctx.reply("В проекте нет сотрудников. Добавьте их в YouGile и нажмите /start ещё раз."); return; }
        linkSessions.set(userId, { tenant, members });
        await ctx.reply("Выберите себя из списка сотрудников YouGile:", memberKeyboard(members));
    } catch (e) {
        console.error("start:", e);
        await ctx.reply("Не удалось получить данные доски. Попробуйте позже.");
    }
});

bot.help(async (ctx) => {
    await ctx.reply(
        "🤖 *Ovra*\n━━━━━━━━━━━━━━━━━━\n" +
        "Я превращаю поручения из чата в карточки YouGile.\n\n" +
        "*Как пользоваться:*\n" +
        "1. Админ добавляет меня в группу и даёт права администратора.\n" +
        "2. Жмёт «Открыть бота» → присылает API-ключ → выбирает проект.\n" +
        "3. Каждый жмёт «Открыть бота» → выбирает себя.\n" +
        "4. Пишете поручение в чат (или ставите реакцию ✍️/🔥) → я предложу карточку → *Одобрить*.\n\n" +
        "Команды: /start, /help, /stats", { parse_mode: "Markdown" });
});

bot.command("stats", async (ctx) => {
    const backend = process.env.BACKEND_URL || "http://localhost:8080";
    let beStatus = "❌ недоступен";
    try { if ((await fetch(`${backend}/healthz`)).ok) beStatus = "✅ работает"; } catch { /* */ }
    await ctx.reply(
        "📊 *Ovra — статус*\n━━━━━━━━━━━━━━━━━━\n" +
        `🌐 Прокси: ${process.env.PROXY_URL ? "✅" : "❌"}\n` +
        `⚙️ Бэкенд: ${beStatus}\n` +
        `🧠 AI: ${process.env.OPENROUTER_API_KEY ? "✅" : "❌"}\n` +
        `📦 Кэш сообщений: ${recentMessages.size}\n` +
        `⏳ Задач на одобрении: ${pendingTasks.size}`, { parse_mode: "Markdown" });
});

// ============ Текст: приём ключа (личка) / триггер задач (группа) ============
bot.on("text", async (ctx) => {
    // Личка: ждём ли API-ключ от админа?
    if (ctx.chat.type === "private") {
        const tenant = awaitingKey.get(ctx.from.id);
        if (!tenant) return;
        awaitingKey.delete(ctx.from.id);

        // email+пароль (через пробел) или готовый API-ключ.
        const raw = ctx.message.text.trim();
        const parts = raw.split(/\s+/);
        const creds = (parts.length >= 2 && parts[0].includes("@"))
            ? { login: parts[0], password: parts.slice(1).join(" ") }
            : { api_key: raw };

        try {
            await saveYougileCreds(tenant, creds);
            const projects = await listYougileProjects(tenant);
            if (!projects.length) { await ctx.reply("🔑 Ключ принят, но в YouGile нет проектов. Создайте проект и /start ещё раз."); return; }
            projectSessions.set(ctx.from.id, { tenant, projects });
            await ctx.reply("🔑 Ключ принят! Выберите проект YouGile для этой группы:", projectKeyboard(projects));
        } catch (e) {
            console.error("connect:", e);
            awaitingKey.set(ctx.from.id, tenant);
            await ctx.reply("❌ YouGile не принял данные (неверный ключ или email/пароль).\nПришлите ещё раз: *email пароль* или *API-ключ*.", { parse_mode: "Markdown" });
        }
        return;
    }

    // Группа: кэшируем + если похоже на задачу — разбираем.
    recentMessages.set(ctx.message.message_id, ctx.message.text);
    if (isPotentialTask(ctx.message.text)) await processTask(ctx, ctx.message.text);
});

// ============ Реакция ✍️/🔥 на сообщение → разобрать как задачу ============
bot.on("message_reaction", async (ctx) => {
    const r: any = ctx.messageReaction;
    const hit = (r.new_reaction || []).some((x: any) => x.type === "emoji" && (x.emoji === "✍️" || x.emoji === "🔥"));
    if (!hit) return;
    const text = recentMessages.get(r.message_id);
    if (text) await processTask(ctx, text);
});

// ============ Разбор задачи → карточка с кнопками В ГРУППУ ============
async function processTask(ctx: Context, text: string) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws) {
        if (ctx.chat?.type !== "private")
            await ctx.reply("⚠️ Чат не привязан к доске. Админ: дайте мне права администратора (я пришлю кнопку подключения).");
        return;
    }
    if (!ws.connected || !ws.board_resolved) {
        await ctx.reply("⚠️ Доска ещё не подключена. Админ: откройте меня в личке и подключите YouGile.");
        return;
    }

    const parsed = await parseMessageWithAI(text);
    if (!parsed || !parsed.isTask) return;

    const taskId = crypto.randomBytes(6).toString("hex");
    pendingTasks.set(taskId, { task: parsed, tenantId: ws.tenant_id });
    cleanup();

    await ctx.reply(taskCard(parsed), {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[
            Markup.button.callback("✅ Одобрить", `approve_${taskId}`),
            Markup.button.callback("❌ Отклонить", `reject_${taskId}`),
        ]]),
    });
}

function taskCard(p: ParsedTask): string {
    return `🆕 *Новая задача*\n━━━━━━━━━━━━━━━━━━\n` +
        `📌 *${p.title || "Без названия"}*\n` +
        `👤 ${p.assignee || "—"}\n` +
        `⏳ ${p.deadline || "—"}\n` +
        `📝 ${p.description || "—"}\n` +
        `━━━━━━━━━━━━━━━━━━\nСоздать карточку в YouGile?`;
}

// ============ Создание задачи (Одобрить / Да-всё-равно) ============
async function submit(ctx: Context, taskId: string, force: boolean) {
    const p = pendingTasks.get(taskId);
    if (!p) { await ctx.editMessageText("Задача устарела."); return; }

    const t = p.task;
    const title = t.title || "Задача из Telegram";
    const assignee = t.assignee || "";
    try {
        const res = await sendTaskToOvraBackend(p.tenantId, title, assignee, t.description || "", t.deadline || "", force);

        if (res.isDuplicate && !force) {
            const list = (res.duplicates || []).map(d => `• ${d.title}`).join("\n") || "—";
            await ctx.editMessageText(
                `⚠️ *Похоже, такая задача уже есть*\n━━━━━━━━━━━━━━━━━━\n🆕 ${title}\n\n📋 На доске:\n${list}\n━━━━━━━━━━━━━━━━━━\nВсё равно добавить?`,
                { parse_mode: "Markdown", ...Markup.inlineKeyboard([[
                    Markup.button.callback("✅ Да, добавить", `force_${taskId}`),
                    Markup.button.callback("❌ Нет", `reject_${taskId}`),
                ]]) });
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
});

// Старт добавления Яндекс-аккаунта.
bot.action(/^cal_add_y:(.+)$/, async (ctx) => {
    const tenant = ctx.match[1]!;
    const userId = ctx.from!.id;
    calendarSessions.set(userId, { tenant, provider: 'yandex', step: 'login' });
    await ctx.answerCbQuery();
    const me = await ctx.telegram.getMe();
    await ctx.editMessageText(
        '🟡 *Подключение Яндекс Календаря*\n\n' +
        'Откройте личку бота и введите *логин CalDAV* (обычно email @yandex.ru).',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.url('💬 Открыть личку', `https://t.me/${me.username}`)]]),
        }
    );
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
            `✅ *Задача создана в YouGile*\n━━━━━━━━━━━━━━━━━━\n📌 *${title}*\n👤 ${assignee || "—"}\n🔗 \`${res.yougile_task_id || "—"}\``,
            { parse_mode: "Markdown" });
    } catch (e) {
        console.error("submit:", e);
        await ctx.editMessageText("❌ Не удалось создать задачу в YouGile. Подробности — в логах бэкенда.");
    }
}

bot.action(/^approve_(.+)$/, async (ctx) => { await ctx.answerCbQuery("Создаю…"); await submit(ctx, ctx.match[1]!, false); });
bot.action(/^force_(.+)$/, async (ctx) => { await ctx.answerCbQuery("Добавляю…"); await submit(ctx, ctx.match[1]!, true); });
bot.action(/^reject_(.+)$/, async (ctx) => { pendingTasks.delete(ctx.match[1]!); await ctx.editMessageText("🗑️ Задача отклонена."); });

// ============ Выбор проекта (админ) ============
bot.action(/^proj_(\d+)$/, async (ctx) => {
    const idx = parseInt(ctx.match[1]!, 10);
    const sess = projectSessions.get(ctx.from!.id);
    if (!sess || !sess.projects[idx]) { await ctx.answerCbQuery("Сессия устарела — /start ещё раз."); return; }
    const proj = sess.projects[idx];
    try {
        await ctx.answerCbQuery("Подключаю…");
        await setWorkspaceProject(sess.tenant, proj.id);
        projectSessions.delete(ctx.from!.id);
        await ctx.editMessageText(
            `✅ Доска подключена: *${proj.title}*\nКолонки распознаны.\n\nТеперь сотрудники могут нажать «Открыть бота» и выбрать себя.`,
            { parse_mode: "Markdown" });
    } catch (e) {
        console.error("proj:", e);
        await ctx.editMessageText("❌ Не удалось подключить доску. Попробуйте /start ещё раз.");
    }
});

// ============ Выбор себя (сотрудник) ============
bot.action(/^link_(\d+)$/, async (ctx) => {
    const idx = parseInt(ctx.match[1]!, 10);
    const sess = linkSessions.get(ctx.from!.id);
    if (!sess || !sess.members[idx]) { await ctx.answerCbQuery("Сессия устарела — /start ещё раз."); return; }
    const m = sess.members[idx];
    try {
        await ctx.answerCbQuery("Сохраняю…");
        await registerUser(sess.tenant, {
            tg_id: String(ctx.from!.id),
            tg_username: ctx.from!.username ? `@${ctx.from!.username}` : "",
            full_name: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(" ") || (ctx.from!.username || ""),
            yougile_user_id: m.id,
        });
        linkSessions.delete(ctx.from!.id);
        await ctx.editMessageText(`✅ Готово! Вы привязаны к *${m.name || m.email}*.`, { parse_mode: "Markdown" });
    } catch (e) {
        console.error("link:", e);
        await ctx.editMessageText("❌ Не удалось сохранить привязку. Попробуйте позже.");
    }
});

// --- клавиатуры ---
function projectKeyboard(projects: YougileProject[]) {
    return Markup.inlineKeyboard(projects.map((p, i) => [Markup.button.callback(p.title || `Проект ${i + 1}`, `proj_${i}`)]));
}
function memberKeyboard(members: YougileMember[]) {
    return Markup.inlineKeyboard(members.map((m, i) => [Markup.button.callback(m.name || m.email || `Сотрудник ${i + 1}`, `link_${i}`)]));
}

export { bot };
