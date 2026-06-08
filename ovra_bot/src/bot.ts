// src/bot.ts
import { Telegraf, Markup, Context } from "telegraf";
import { isPotentialTask } from "./utils/heuristics.js";
import { parseMessageWithAI, type ParsedTask } from "./services/ai.js";
import {
    sendTaskToOvraBackend, resolveTenant, createWorkspace, getWorkspaceInfo,
    listYougileMembers, registerUser,
    saveYougileCreds, listYougileProjects, setWorkspaceProject,
    type YougileMember, type YougileProject
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
        return; // прочие личные сообщения не разбираем как задачи
    }

    // Группа: кэшируем + если похоже на задачу — разбираем (эвристика бережёт токены).
    recentMessages.set(message.message_id, message.text);
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
            `✅ Доска подключена: *${proj.title}*\nКолонки распознаны.\n\nТеперь сотрудники могут нажать «Открыть бота» в группе и подвязаться к себе.`,
            { parse_mode: 'Markdown' }
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

export { bot };