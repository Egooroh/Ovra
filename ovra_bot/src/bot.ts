// src/bot.ts
import { Telegraf, Markup, Context } from "telegraf";
import { isPotentialTask, looksLikeStatusOrMove } from "./utils/heuristics.js";
import { parseMessageWithAI, parseTaskEdit, pickTaskAndColumn, type ParsedTask } from "./services/ai.js";
import {
    sendTaskToOvraBackend, resolveTenant, createWorkspace, getWorkspaceInfo,
    listYougileMembers, registerUser, scheduleCallInOvra,
    saveYougileCreds, listYougileProjects, setWorkspaceProject, listYougileCompanies,
    listCalendarAccounts, addCalendarAccount, deleteCalendarAccount,
    deleteTask, getTask, updateTask, getDigest, getTrash, clearTrash, syncWorkspace, listTasks,
    listBoardColumns, moveTaskToColumn,
    setPmChatId, setUserRole, listWorkspaceUsers, getUserByTgId,
    setConfirmMode, updateDigestSettings, setUserTimezone,
    type YougileMember, type YougileProject, type CalendarAccount, type YougileCompany, type DigestData, type BoardTask, type BoardColumn
} from "./services/backend.js";
import crypto from "crypto";
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent as SocksProxyAgent } from 'https-proxy-agent';
import { transcribeOgg } from "./services/speechkit.js";

dotenv.config();

const proxyUrl = process.env.PROXY_URL;
const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

// Public HTTPS URL of the Telegram Mini App (served by the Go backend).
// Must be set in .env for the web_app button to work.
// Example: MINI_APP_URL=https://your-domain.com/miniapp/
const MINI_APP_URL = process.env.MINI_APP_URL || '';

// Reply-keyboard buttons (private chat). Labels must match the bot.hears() below.
// Only commands that make sense in a private chat are exposed here.
// Group commands (/board, /digest, /sync, /trash) are available as slash-commands
// in group chats; they are NOT shown in the private keyboard to avoid confusion.
// The Mini App (profile + boards) is accessed via the left menu button (Ovra),
// NOT via a keyboard webApp button — KeyboardButton.web_app runs in "data input"
// mode and does not provide full Telegram.WebApp.initData.
const BTN_STATUS = '📊 Статус';
const BTN_HELP   = '❓ Помощь';

// mainReplyKeyboard — two quick-action buttons shown in the private chat.
function mainReplyKeyboard() {
    return Markup.keyboard([[BTN_STATUS, BTN_HELP]]).resize();
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
    telegram: {
        ...(agent ? { agent: agent } : {})
    }
});

bot.use((ctx, next) => {
    console.log(`[update] type=${ctx.updateType}`);
    return next();
});

let activePmChatId: string | number | undefined = process.env.PM_CHAT_ID || undefined;

const recentMessages = new Map<number, string>();

// Последние 10 сообщений на чат — для контекста при разборе задачи.
const chatHistory = new Map<number, string[]>();

// Последняя подтверждённая задача по чату — чтобы AI не дублировал её как новую.
const lastConfirmedTask = new Map<number, { title: string; ts: number }>();

// Кэшируем текст/подпись КАЖДОГО группового сообщения до остальных обработчиков —
// ранний return в каком-нибудь хендлере не должен оставлять кэш пустым,
// иначе реакция на такое сообщение не найдёт текст.
bot.use((ctx, next) => {
    const msg: any = ctx.message;
    if (msg && (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup')) {
        const text: string | undefined = msg.text ?? msg.caption;
        if (text) {
            recentMessages.set(msg.message_id, text);
            const chatId = ctx.chat!.id;
            const hist = chatHistory.get(chatId) ?? [];
            hist.push(text);
            if (hist.length > 10) hist.shift();
            chatHistory.set(chatId, hist);
            // Подрезаем старые записи (Map хранит порядок вставки), а не чистим
            // кэш целиком — свежие сообщения должны переживать переполнение.
            if (recentMessages.size > 2000) {
                for (const key of recentMessages.keys()) {
                    if (recentMessages.size <= 1000) break;
                    recentMessages.delete(key);
                }
            }
        }
    }
    return next();
});

// Храним задачу вместе с воркспейсом и чатом-источником.
interface PendingTask { task: ParsedTask; tenantId: string; originChatId?: number; }
const pendingTasks = new Map<string, PendingTask>();

// Карта "${chatId}:${messageId}" → taskId для перехвата ответов-правок на карточки.
// Персистируется в файл чтобы пережить рестарт бота.
const CARD_MESSAGES_FILE = path.join(process.cwd(), 'data', 'card_messages.json');
const cardMessages = new Map<string, string>((() => {
    try {
        const raw = fs.readFileSync(CARD_MESSAGES_FILE, 'utf8');
        return Object.entries(JSON.parse(raw)) as [string, string][];
    } catch { return []; }
})());

function saveCardMessages() {
    try {
        fs.mkdirSync(path.dirname(CARD_MESSAGES_FILE), { recursive: true });
        fs.writeFileSync(CARD_MESSAGES_FILE, JSON.stringify(Object.fromEntries(cardMessages)));
    } catch (e) { console.error('saveCardMessages:', e); }
}

function clearCardEntry(taskId: string) {
    for (const [key, tid] of cardMessages) {
        if (tid === taskId) cardMessages.delete(key);
    }
    saveCardMessages();
}

// После одобрения задачи обновляем ключ с локального hex-id на backend UUID,
// чтобы ответ на одобренную карточку мог найти задачу в БД.
function promoteCardEntry(localId: string, backendId: string) {
    for (const [key, tid] of cardMessages) {
        if (tid === localId) cardMessages.set(key, backendId);
    }
    saveCardMessages();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Маркеры ПРАВКИ полей задачи в ответе на карточку — если они есть, ответ
// трактуем как редактирование (parseTaskEdit), а не как смену статуса.
const EDIT_INSTRUCTION_RE = /переименуй|назови|название|заголовок|исполнител|assignee|дедлайн|deadline|срок|описани|добав/i;

// Восстанавливает PendingTask из БД, если он был потерян при рестарте бота.
// Возвращает null, если задача не найдена или уже не в статусе pending.
async function recoverPendingTask(taskId: string): Promise<PendingTask | null> {
    try {
        const dbTask = await getTask(taskId);
        if (!dbTask || dbTask.approval_status !== 'pending') return null;
        const ws = await getWorkspaceInfo(dbTask.tenant_id);
        if (!ws) return null;
        const recovered: PendingTask = {
            task: {
                title: dbTask.title,
                description: dbTask.description || undefined,
                assignee: undefined,
                deadline: dbTask.deadline ? dbTask.deadline.substring(0, 10) : undefined,
            },
            tenantId: dbTask.tenant_id,
            originChatId: ws.chat_id ? Number(ws.chat_id) : undefined,
        };
        pendingTasks.set(taskId, recovered);
        return recovered;
    } catch {
        return null;
    }
}

// Куда слать подтверждения задач: 'pm' (личка ПМа) или 'group' (группа-источник).
const confirmDefault: 'pm' | 'group' =
    (process.env.CONFIRM_TARGET === 'pm' ? 'pm' : 'group');
const confirmTarget = new Map<string, 'pm' | 'group'>(); // tenant_id → override

// Сессии онбординга (по user id):
const awaitingKey = new Map<number, string>();                              // юзер → tenant: ждём API-ключ от админа
const linkSessions = new Map<number, { tenant: string; members: YougileMember[] }>(); // юзер → выбор себя из YouGile
const projectSessions = new Map<number, { tenant: string; projects: YougileProject[] }>(); // юзер → выбор проекта
// Сессия входа по логину/паролю: шаги login → password → company (выбор из списка или ID).
interface LoginSession { tenant: string; step: 'login' | 'password' | 'company'; login?: string; password?: string; companies?: YougileCompany[]; }
const loginSessions = new Map<number, LoginSession>();

// taskIdByMessage хранит backend task_id для кнопки «Удалить» после одобрения.
// ключ — messageId сообщения «Задача создана», значение — task id из бэкенда.
const taskIdByMessage = new Map<number, string>();

// submitting — taskId, по которым прямо сейчас идёт создание задачи в бэкенде.
// Защита от двойного клика: быстрый double-tap по «Одобрить»/«Да, добавить»
// иначе запустит два параллельных запроса, и дедуп каждого пройдёт раньше,
// чем сохранится первый, — на доске появятся две карточки.
const submitting = new Set<string>();

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
// Проверить, является ли пользователь TG-администратором чата.
async function isTgAdmin(chatId: number | string, userId: number): Promise<boolean> {
    try {
        const m = await bot.telegram.getChatMember(chatId, userId);
        return m.status === 'creator' || m.status === 'administrator';
    } catch {
        return false;
    }
}

// canManageTasks — управление задачами (одобрить/отклонить/редактировать).
// Разрешено: TG-admin, workspace admin, workspace moderator.
// При mode='everyone' разрешено всем участникам группы.
async function canManageTasks(
    chatId: number | string,
    userId: number,
    tenantId: string,
    mode: string,
): Promise<boolean> {
    if (mode === 'everyone') return true;
    if (await isTgAdmin(chatId, userId)) return true;
    try {
        const u = await getUserByTgId(tenantId, userId);
        return u?.role === 'admin' || u?.role === 'moderator';
    } catch {
        return false;
    }
}

// canManageSettings — изменение настроек воркспейса (дайджест, confirm_mode и т.д.).
// Разрешено только TG-admin и workspace admin.
async function canManageSettings(
    chatId: number | string,
    userId: number,
    tenantId: string,
): Promise<boolean> {
    if (await isTgAdmin(chatId, userId)) return true;
    try {
        const u = await getUserByTgId(tenantId, userId);
        return u?.role === 'admin';
    } catch {
        return false;
    }
}

// Оставляем алиас для обратной совместимости внутри файла.
const canConfirmTasks = canManageTasks;

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
const MAPPING_FILE = path.resolve(process.cwd(), 'data', 'users.json');
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
    // recentMessages подрезается в middleware кэширования (см. выше).
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

    // Deep-link payload = tenant_id воркспейса (из кнопки «Открыть бота»).
    const payload = (ctx.message.text.split(' ').slice(1).join(' ') || '').trim();
    if (!payload) {
        return ctx.reply(
            'Привет! 👋 Я *Ovra*.\n\n' +
            '👉 Кнопка *меню* (слева от поля ввода) открывает твой профиль и доски.\n' +
            'Чтобы подключить новую доску — добавь меня в рабочую группу.',
            { parse_mode: 'Markdown', ...mainReplyKeyboard() }
        );
    }

    const tenant = payload;
    try {
        const ws = await getWorkspaceInfo(tenant);

        // If this user is the group host or a Telegram admin in the group, persist
        // this private chat as the PM destination for task confirmation cards.
        const isHost = String(userId) === ws.host_tg_id;
        let isTgAdmin = false;
        try {
            const member = await ctx.telegram.getChatMember(parseInt(ws.chat_id), userId);
            isTgAdmin = member.status === 'administrator' || member.status === 'creator';
        } catch {}
        if (isHost || isTgAdmin) {
            await setPmChatId(tenant, ctx.chat.id, userId).catch(() => {});
        }

        // 1) Не подключён → онбординг админа: выбор способа подключения.
        if (!ws.connected) {
            await ctx.reply(
                '🔌 Доска ещё не подключена к YouGile.\n\n' +
                'Если вы *администратор* — выберите способ подключения:',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔑 У меня есть API-ключ', `conn_key:${tenant}`)],
                        [Markup.button.callback('👤 Войти по логину и паролю', `conn_login:${tenant}`)],
                    ]),
                }
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

// continueToProjects — общий переход к выбору проекта после подключения доски.
async function continueToProjects(ctx: Context, tenant: string) {
    const userId = ctx.from!.id;
    const projects = await listYougileProjects(tenant);
    if (projects.length === 0) {
        await ctx.reply('✅ Доска подключена, но в YouGile нет проектов. Создайте проект и нажмите /start ещё раз.');
        return;
    }
    projectSessions.set(userId, { tenant, projects });
    const buttons = projects.map((p, i) => [Markup.button.callback(p.title || `Проект ${i + 1}`, `proj_${i}`)]);
    await ctx.reply('✅ Доска подключена! Выберите проект YouGile для этой группы:', Markup.inlineKeyboard(buttons));
}

// finishLogin — сохраняет креды по логину/паролю (+companyId) и ведёт к выбору проекта.
async function finishLogin(ctx: Context, tenant: string, login: string, password: string, companyId: string) {
    try {
        await saveYougileCreds(tenant, { login, password, company_id: companyId });
        await continueToProjects(ctx, tenant);
    } catch (e) {
        console.error('connect via login:', e);
        await ctx.reply('❌ Не удалось получить ключ YouGile (проверьте логин/пароль/компанию). Нажмите /start, чтобы попробовать снова.');
    }
}

// Онбординг: «У меня есть API-ключ» → ждём ключ сообщением.
bot.action(/^conn_key:(.+)$/, async (ctx) => {
    const tenant = ctx.match[1]!;
    const userId = ctx.from!.id;
    loginSessions.delete(userId);
    awaitingKey.set(userId, tenant);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '🔑 Пришлите *API-ключ YouGile* одним сообщением (настройки YouGile → API-ключи).',
        { parse_mode: 'Markdown' }
    );
});

// Онбординг: «Войти по логину и паролю» → пошаговый вход.
bot.action(/^conn_login:(.+)$/, async (ctx) => {
    const tenant = ctx.match[1]!;
    const userId = ctx.from!.id;
    awaitingKey.delete(userId);
    loginSessions.set(userId, { tenant, step: 'login' });
    await ctx.answerCbQuery();
    await ctx.editMessageText('👤 Пришлите *логин* (email) от YouGile:', { parse_mode: 'Markdown' });
});

// Онбординг: выбор компании из списка (когда у аккаунта их несколько).
bot.action(/^comp_(\d+)$/, async (ctx) => {
    const idx = parseInt(ctx.match[1]!, 10);
    const userId = ctx.from!.id;
    const sess = loginSessions.get(userId);
    if (!sess || sess.step !== 'company' || !sess.companies || !sess.companies[idx]) {
        return ctx.answerCbQuery('Сессия устарела — нажмите /start ещё раз.');
    }
    const company = sess.companies[idx];
    loginSessions.delete(userId);
    await ctx.answerCbQuery('Подключаю…');
    await ctx.editMessageText(`🏢 Компания: *${company.name}*`, { parse_mode: 'Markdown' });
    await finishLogin(ctx, sess.tenant, sess.login!, sess.password!, company.id);
});

// /setup — opens the Mini App panel for board admin registration.
// Works both in private chats and group chats.
// In a group chat it resolves the workspace and sends the Web App button.
// In a private chat (without context) it asks the admin to use it in the group.
bot.command('setup', async (ctx) => {
    const isMiniAppAvailable = !!MINI_APP_URL;

    if (ctx.chat.type === 'private') {
        if (!isMiniAppAvailable) {
            // Fall back to text instructions when MINI_APP_URL is not configured.
            return ctx.reply(
                '⚙️ Используйте команду /setup в рабочей группе, чтобы подключить доску YouGile.'
            );
        }
        // If this is a deep-link start (/setup <tenant_id>) handle it directly.
        const payload = (ctx.message.text.split(' ').slice(1).join(' ') || '').trim();
        if (payload) {
            const miniAppUrl = `${MINI_APP_URL}?tenant=${encodeURIComponent(payload)}`;
            return ctx.reply(
                '⚙️ *Настройка доски YouGile*\n\nНажмите кнопку ниже, чтобы открыть панель подключения:',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('🔧 Открыть панель настройки', miniAppUrl)],
                    ]),
                }
            );
        }
        return ctx.reply('Используйте /setup в групповом чате, чтобы настроить подключённую доску.');
    }

    // Group chat: resolve workspace.
    try {
        const ws = await resolveTenant(ctx.chat.id);
        if (!ws) {
            return ctx.reply('⚠️ Этот чат ещё не привязан к доске. Добавьте меня и дайте права администратора.');
        }

        if (isMiniAppAvailable) {
            const miniAppUrl = `${MINI_APP_URL}?tenant=${encodeURIComponent(ws.tenant_id)}`;
            return ctx.reply(
                '⚙️ *Настройка доски YouGile*\n\nАдминистратор: нажмите кнопку ниже, чтобы подключить или изменить YouGile-доску через мини-апп:',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('🔧 Открыть панель настройки', miniAppUrl)],
                    ]),
                }
            );
        }

        // Fallback (no MINI_APP_URL): send the classic deep-link.
        const me = await ctx.telegram.getMe();
        const link = `https://t.me/${me.username}?start=${ws.tenant_id}`;
        return ctx.reply(
            '⚙️ *Настройка доски YouGile*\n\nАдминистратор: откройте бота в личке и пройдите онбординг:',
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([Markup.button.url('🔗 Открыть бота', link)]),
            }
        );
    } catch (e) {
        console.error('setup:', e);
        return ctx.reply('Не удалось получить данные доски. Попробуйте позже.');
    }
});

// --- Карточки задач ---

function buildCardText(task: ParsedTask): string {
    return `🆕 *Новая задача на подтверждение*\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `📌 *${task.title || 'Без названия'}*\n\n` +
           `👤 Исполнитель: ${task.assignee || '—'}\n` +
           `⏳ Дедлайн: ${task.deadline || '—'}\n` +
           `📝 ${task.description || 'без описания'}\n` +
           `━━━━━━━━━━━━━━━━━━\n` +
           `_Создать карточку в YouGile? Ответьте на сообщение, чтобы отредактировать._`;
}

function buildCardKeyboard(taskId: string) {
    return Markup.inlineKeyboard([
        Markup.button.callback('✅', `approve_${taskId}`),
        Markup.button.callback('✏️', `edit_hint_${taskId}`),
        Markup.button.callback('❌', `reject_${taskId}`),
    ]);
}

// Резолвит «я» в имя отправителя: сначала ищет /bind-привязку, потом берёт имя из Telegram.
function resolveSelfAssignee(sender: { first_name: string; last_name?: string; username?: string }): string {
    const tag = sender.username ? `@${sender.username.toLowerCase()}` : null;
    if (tag && userMapping[tag]) return userMapping[tag];
    return [sender.first_name, sender.last_name].filter(Boolean).join(' ');
}

async function processTaskAndConfirm(ctx: Context, text: string, force = false, context: string[] = []) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

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

    // Если недавно (< 10 мин) в этом чате уже создали задачу, сообщаем об этом AI —
    // чтобы он не интерпретировал уточнения как создание новой задачи.
    const recent = lastConfirmedTask.get(chatId);
    const aiContext = [...context];
    if (recent && Date.now() - recent.ts < 10 * 60 * 1000) {
        aiContext.unshift(`[ЗАДАЧА УЖЕ СОЗДАНА: "${recent.title}"]`);
    }

    const tasks = await parseMessageWithAI(text, aiContext);

    // force=true (реакция ✍️/🔥) — создаём задачу даже если ИИ ничего не нашёл.
    if (force && tasks.length === 0) {
        tasks.push({
            isTask: true,
            title: text.trim().slice(0, 100),
            assignee: '',
            deadline: '',
            description: '',
        });
    }

    if (tasks.length === 0) return;

    const target = confirmTarget.get(ws.tenant_id) ?? confirmDefault;
    // Per-workspace pm_chat_id takes priority; fall back to env-configured default.
    const pmChatId = ws.pm_chat_id || activePmChatId;
    const targetChatId = target === 'group' ? chatId : pmChatId;

    if (!targetChatId) {
        console.error("❌ PM-чат не установлен для воркспейса", ws.tenant_id);
        if (ctx.chat && ctx.chat.type !== 'private') {
            await ctx.reply("❌ Задача найдена, но PM-чат не настроен. Администратор: откройте бота в личке (/start) чтобы стать получателем задач.");
        }
        return;
    }

    for (const task of tasks) {
        // «я» → имя отправителя
        const assigneeRaw = (task.assignee || '').trim();
        if (/^я(\s|$)/i.test(assigneeRaw) && ctx.from) {
            task.assignee = resolveSelfAssignee(ctx.from);
        }

        const taskId = crypto.randomBytes(8).toString('hex');
        pendingTasks.set(taskId, { task, tenantId: ws.tenant_id, originChatId: chatId });

        const messageText = buildCardText(task);

        try {
            const sent = await ctx.telegram.sendMessage(targetChatId, messageText, {
                parse_mode: 'Markdown',
                ...buildCardKeyboard(taskId),
            });
            cardMessages.set(`${targetChatId}:${sent.message_id}`, taskId);
            saveCardMessages();
        } catch (error) {
            console.error("❌ Ошибка отправки подтверждения.", error);
        }
    }

    cleanUpCache();
}

// performColumnMove — проверяет права и двигает карточку в РЕАЛЬНУЮ колонку
// доски YouGile (включая кастомную), с ответом пользователю. permChatId — чат
// для проверки прав (всегда группа воркспейса, не личка).
async function performColumnMove(
    ctx: Context,
    permChatId: number | string,
    tenantId: string,
    confirmMode: string,
    task: { id: string; title: string },
    columnId: string,
    columns: BoardColumn[],
): Promise<void> {
    const userId = ctx.from?.id;
    if (userId && !(await canManageTasks(permChatId, userId, tenantId, confirmMode))) {
        await ctx.reply('⛔ Менять статус задач могут администраторы и модераторы (или включите /confirm_mode everyone).');
        return;
    }
    try {
        const res = await moveTaskToColumn(task.id, columnId);
        const colTitle = res.column_title || columns.find(c => c.id === columnId)?.title || 'колонку';
        const emoji = res.status ? statusEmoji(res.status) : '🔀';
        await ctx.reply(`${emoji} «${task.title}» → *${colTitle}*`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('[move] moveTaskToColumn:', e);
        await ctx.reply('❌ Не удалось переместить задачу. Проверьте, что доска подключена к YouGile.');
    }
}

// tryHandleTaskMove — распознаёт в свободном тексте/голосовом сообщение о
// перемещении СУЩЕСТВУЮЩЕЙ задачи («лендинг готов», «отчёт в тестирование»),
// находит задачу и РЕАЛЬНУЮ колонку доски (любую, не только 4 стоковых статуса)
// и двигает карточку. Возвращает true, если обработано (тогда разбор «как новой
// задачи» не нужен). Дешёвый эвристический фильтр впереди — чтобы не дёргать AI
// на каждом сообщении.
async function tryHandleTaskMove(ctx: Context, text: string): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (!chatId) return false;
    if (!looksLikeStatusOrMove(text)) return false; // не похоже на смену статуса

    const ws = await resolveTenant(chatId).catch(() => null);
    if (!ws || !ws.connected) return false;

    let tasks: BoardTask[];
    let columns: BoardColumn[];
    try {
        [tasks, columns] = await Promise.all([listTasks(ws.tenant_id), listBoardColumns(ws.tenant_id)]);
    } catch (e) {
        console.error('[move] fetch tasks/columns:', e);
        return false;
    }
    const open = tasks.filter(t => t.approval_status === 'approved');
    if (open.length === 0 || columns.length === 0) return false;

    const pick = await pickTaskAndColumn(
        text,
        open.map(t => ({ title: t.title, status: t.status })),
        columns.map(c => ({ id: c.id, title: c.title })),
    );
    if (!pick) return false;

    const task = open[pick.taskIndex];
    if (!task) return false;

    await performColumnMove(ctx, ws.chat_id || chatId, ws.tenant_id, ws.confirm_mode ?? 'admin_only', task, pick.columnId, columns);
    return true;
}

// handleReplyMove — перемещение задачи ОТВЕТОМ на её карточку. Задача уже
// известна (taskId), AI выбирает только целевую колонку из реальных колонок доски.
async function handleReplyMove(ctx: Context, replyText: string, chatId: number, taskId: string): Promise<void> {
    const dbTask = await getTask(taskId).catch(() => null);
    if (!dbTask) {
        await ctx.telegram.sendMessage(chatId, '⚠️ Задача не найдена.');
        return;
    }
    let columns: BoardColumn[];
    try {
        columns = await listBoardColumns(dbTask.tenant_id);
    } catch (e) {
        console.error('[move] reply listBoardColumns:', e);
        await ctx.telegram.sendMessage(chatId, '❌ Не удалось получить колонки доски YouGile.');
        return;
    }
    if (columns.length === 0) {
        await ctx.telegram.sendMessage(chatId, '❌ На доске не найдено колонок.');
        return;
    }
    const pick = await pickTaskAndColumn(
        replyText,
        [{ title: dbTask.title, status: dbTask.status }],
        columns.map(c => ({ id: c.id, title: c.title })),
    );
    if (!pick) {
        await ctx.telegram.sendMessage(chatId, 'ℹ️ Не понял, в какую колонку переместить. Назовите статус или колонку точнее.');
        return;
    }
    const ws = await getWorkspaceInfo(dbTask.tenant_id).catch(() => null);
    await performColumnMove(
        ctx,
        ws?.chat_id || chatId,
        dbTask.tenant_id,
        ws?.confirm_mode ?? 'admin_only',
        { id: taskId, title: dbTask.title },
        pick.columnId,
        columns,
    );
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

// ---- Голосовые сообщения → транскрипция SpeechKit → задача ----
// Telegram шлёт голосовые в формате OGG/Opus 48kHz — именно то, что ожидает
// синхронный REST API SpeechKit (ограничение: ≤ 60 сек на один запрос).
bot.on('voice', async (ctx) => {
    if (ctx.chat.type === 'private') return;

    const voice = ctx.message.voice;
    if (voice.duration > 29) {
        console.log(`[voice] msg_id=${ctx.message.message_id} duration=${voice.duration}s > 29 — too long for SpeechKit sync API`);
        await ctx.reply('⚠️ Голосовое слишком длинное (максимум 30 сек). Запишите покороче.', {
            reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true }
        });
        return;
    }

    try {
        const link = await ctx.telegram.getFileLink(voice.file_id);
        const resp = await fetch(link.href, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) {
            console.error(`[voice] download failed: ${resp.status}`);
            await ctx.reply('⚠️ Не смог скачать голосовое из Telegram. Попробуйте ещё раз.', {
                reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
            });
            return;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        const text = await transcribeOgg(buffer);
        // Раньше пустой результат глушился молча — со стороны выглядело как «бот
        // не реагирует на голосовые». Теперь явно сообщаем о неудаче распознавания.
        if (!text) {
            console.warn(`[voice] msg_id=${ctx.message.message_id} transcription empty/failed`);
            await ctx.reply('⚠️ Не смог распознать голосовое. Скажите чуть чётче (и до 30 сек).', {
                reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
            });
            return;
        }

        console.log(`[voice] msg_id=${ctx.message.message_id} text="${text}"`);
        // Сначала пробуем как смену статуса существующей задачи («лендинг готов»),
        // и только потом — как новую задачу.
        if (await tryHandleTaskMove(ctx, text)) return;
        await processTaskAndConfirm(ctx, text);
    } catch (e) {
        console.error('[voice] handler error:', e);
    }
});

async function sendStats(ctx: Context) {
    const loadingMessage = await ctx.reply('⏳ Собираю статистику...');

    const proxyStatus = process.env.PROXY_URL ? `✅ Включен (${process.env.PROXY_URL})` : `❌ Выключен`;
    const aiStatus = process.env.OPENROUTER_API_KEY ? `✅ Подключен (${process.env.AI_MODEL || 'по умолчанию'})` : `❌ Нет ключа`;
    const pmStatus = activePmChatId ? `✅ Fallback (${activePmChatId})` : `➖ Используется pm_chat_id из БД`;

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
}
bot.command('stats', sendStats);
// Reply-keyboard shortcuts — registered before bot.on('text') so they are not
// swallowed by the generic text handler.
bot.hears(BTN_STATUS, sendStats);
bot.hears(BTN_HELP,   sendHelp);

// Кнопка «Редактировать» на карточке — показываем подсказку как редактировать.
bot.action(/^edit_hint_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery(
        'Ответьте на это сообщение (кнопка «Ответить»), написав что изменить.\n' +
        'Например: «исполнитель Иван», «дедлайн 20 июня», «переименуй в "Отчёт Q2"»',
        { show_alert: true }
    );
});

// Reply-перехват: если пользователь ответил на карточку задачи — редактируем её.
bot.use(async (ctx, next) => {
    const msg = ctx.message as any;
    if (!msg?.text || !msg.reply_to_message) return next();

    const chatId = msg.chat.id;
    const replyMsgId: number = msg.reply_to_message.message_id;
    const cardKey = `${chatId}:${replyMsgId}`;
    const taskId = cardMessages.get(cardKey);
    if (!taskId) return next();

    // Ответ-перемещение карточки («смени на в работе», «готово», «в тестирование»).
    // Гасим, если в тексте есть явный маркер ПРАВКИ полей (переименуй/дедлайн/…),
    // чтобы «переименуй в "X готово"» не трактовалось как смена статуса.
    if (looksLikeStatusOrMove(msg.text) && !EDIT_INSTRUCTION_RE.test(msg.text)) {
        if (UUID_RE.test(taskId)) {
            await handleReplyMove(ctx, msg.text, chatId, taskId);
        } else {
            // Задача ещё не одобрена (нет карточки в YouGile) — статус менять рано.
            await ctx.telegram.sendMessage(chatId, 'ℹ️ Задача ещё не создана — сначала нажмите ✅, потом можно менять статус.', { reply_parameters: { message_id: msg.message_id } });
        }
        return;
    }

    // UUID в cardMessages → задача уже одобрена, редактируем через API напрямую.
    if (UUID_RE.test(taskId)) {
        const dbTask = await getTask(taskId).catch(() => null);
        if (!dbTask) {
            await ctx.telegram.sendMessage(chatId, '⚠️ Задача не найдена.', {
                reply_parameters: { message_id: msg.message_id },
            });
            return;
        }
        const currentTask: ParsedTask = { isTask: true, title: dbTask.title, description: dbTask.description };
        let patch: Awaited<ReturnType<typeof parseTaskEdit>>;
        try { patch = await parseTaskEdit(currentTask, msg.text); }
        catch {
            await ctx.telegram.sendMessage(chatId, '❌ Не удалось распознать правку.', { reply_parameters: { message_id: msg.message_id } });
            return;
        }
        if (Object.keys(patch).length === 0) {
            await ctx.telegram.sendMessage(chatId, '🤔 Не понял, что изменить. Опишите точнее.', { reply_parameters: { message_id: msg.message_id } });
            return;
        }
        await updateTask(taskId, patch).catch(() => null);
        const changed = Object.keys(patch).map(k => ({ title: 'название', description: 'описание', deadline: 'дедлайн' } as Record<string, string>)[k]).filter(Boolean).join(', ');
        await ctx.telegram.sendMessage(chatId, `✏️ Обновлено: ${changed}.`, { reply_parameters: { message_id: replyMsgId } });
        return;
    }

    const pending = pendingTasks.get(taskId);
    if (!pending) {
        await ctx.telegram.sendMessage(chatId, '⚠️ Задача уже обработана или устарела.', {
            reply_parameters: { message_id: msg.message_id },
        });
        return;
    }

    // Проверяем права: редактировать может только admin / moderator / TG-admin.
    const userId: number = msg.from?.id;
    if (userId) {
        const ws = await resolveTenant(pending.originChatId ?? chatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        const allowed = await canManageTasks(pending.originChatId ?? chatId, userId, pending.tenantId, mode);
        if (!allowed) {
            await ctx.telegram.sendMessage(chatId, '⛔ Редактировать задачи могут только администраторы и модераторы.', {
                reply_parameters: { message_id: msg.message_id },
            });
            return;
        }
    }

    // Парсим правку через AI.
    let patch: Awaited<ReturnType<typeof parseTaskEdit>>;
    try {
        patch = await parseTaskEdit(pending.task, msg.text);
    } catch {
        await ctx.telegram.sendMessage(chatId, '❌ Не удалось распознать правку. Попробуйте ещё раз.', {
            reply_parameters: { message_id: msg.message_id },
        });
        return;
    }

    if (Object.keys(patch).length === 0) {
        await ctx.telegram.sendMessage(chatId, '🤔 Не понял, что именно изменить. Попробуйте описать точнее.', {
            reply_parameters: { message_id: msg.message_id },
        });
        return;
    }

    // Применяем патч к задаче.
    Object.assign(pending.task, patch);

    // Редактируем карточку на месте.
    try {
        await ctx.telegram.editMessageText(
            chatId,
            replyMsgId,
            undefined,
            buildCardText(pending.task),
            { parse_mode: 'Markdown', ...buildCardKeyboard(taskId) }
        );
    } catch (e) {
        console.error('edit card message:', e);
    }

    // Подтверждаем правку коротким сообщением.
    const changed = Object.keys(patch).map(k => ({
        title: 'название', assignee: 'исполнитель', deadline: 'дедлайн', description: 'описание'
    } as Record<string, string>)[k]).filter(Boolean).join(', ');
    await ctx.telegram.sendMessage(chatId, `✏️ Обновлено: ${changed}.`, {
        reply_parameters: { message_id: replyMsgId },
    });
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
                await continueToProjects(ctx, tenant);
            } catch (e) {
                console.error('connect yougile:', e);
                awaitingKey.set(ctx.from.id, tenant); // ждём ключ снова
                await ctx.reply('❌ YouGile отклонил ключ (неверный или нет доступа).\nПришлите корректный *API-ключ* ещё раз.', { parse_mode: 'Markdown' });
            }
            return;
        }

        // Личка: пошаговый вход по логину/паролю (онбординг доски по паролю).
        const loginSess = loginSessions.get(ctx.from.id);
        if (loginSess) {
            const text = message.text.trim();
            if (loginSess.step === 'login') {
                loginSess.login = text;
                loginSess.step = 'password';
                await ctx.reply('🔒 Теперь пришлите *пароль* от YouGile одним сообщением:', { parse_mode: 'Markdown' });
            } else if (loginSess.step === 'password') {
                loginSess.password = text;
                try {
                    const companies = await listYougileCompanies(loginSess.tenant, loginSess.login!, loginSess.password!);
                    if (companies.length === 0) {
                        loginSessions.delete(ctx.from.id);
                        await ctx.reply('❌ У этого аккаунта нет компаний в YouGile.');
                    } else if (companies.length === 1) {
                        loginSessions.delete(ctx.from.id);
                        await finishLogin(ctx, loginSess.tenant, loginSess.login!, loginSess.password!, companies[0].id);
                    } else {
                        loginSess.companies = companies;
                        loginSess.step = 'company';
                        const buttons = companies.map((c, i) => [Markup.button.callback(c.name || `Компания ${i + 1}`, `comp_${i}`)]);
                        await ctx.reply('🏢 Выберите компанию (или пришлите её *ID* сообщением):', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
                    }
                } catch (e) {
                    console.error('list companies:', e);
                    loginSess.step = 'login';
                    await ctx.reply('❌ YouGile отклонил логин или пароль. Пришлите *логин* (email) ещё раз:', { parse_mode: 'Markdown' });
                }
            } else if (loginSess.step === 'company') {
                loginSessions.delete(ctx.from.id);
                await finishLogin(ctx, loginSess.tenant, loginSess.login!, loginSess.password!, text);
            }
            return;
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

        // Команды (/help, /stats и т.д.) пробрасываем дальше по цепочке.
        if (message.text?.startsWith('/')) return next();
        return; // прочие личные сообщения не разбираем как задачи
    }

    // Команды в группе обрабатываются отдельными bot.command() хендлерами.
    if (message.text.startsWith('/')) return next();

    // Кэширование группового текста — в middleware выше (до всех обработчиков).

    // Telemost-ссылка в сообщении → планируем созвон без участия PM.
    const telemostUrl = message.text.match(/https?:\/\/telemost(?:\.\d+)?\.yandex\.ru\/j\/[^\s]+/)?.[0];
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

    // Смена статуса существующей задачи («лендинг готов», «беру X в работу»).
    // Проверяем ДО эвристического фильтра задач — фразы статуса его не проходят.
    if (await tryHandleTaskMove(ctx, message.text)) return;

    // Режим детекции: 'ai' — каждое сообщение в AI, 'heuristic' — сначала фильтр.
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    const detectionMode = ws?.task_detection ?? 'heuristic';
    if (detectionMode === 'heuristic' && !isPotentialTask(message.text)) return;
    const hist = chatHistory.get(ctx.chat.id) ?? [];
    const context = hist.slice(0, -1); // все кроме текущего
    await processTaskAndConfirm(ctx, message.text, false, context);
});

// ---- Реакции ✍️/🔥 → задача из сообщения ----
// ВАЖНО: Telegram присылает message_reaction ТОЛЬКО если бот — администратор
// группы (любых прав достаточно) и message_reaction указан в allowedUpdates
// (см. index.ts). Без админки апдейты о реакциях не приходят вовсе: в логах
// не будет даже строки [update] type=message_reaction.
const REACTION_TRIGGERS = new Set([
    '✍',    // ✍ writing hand — Telegram шлёт без variation selector
    '\u{1F525}', // 🔥 fire
]);

bot.on('message_reaction', async (ctx) => {
    try {
        const mr = ctx.messageReaction;
        const chatId = mr.chat.id;
        const messageId = mr.message_id;

        // Эмодзи реакций без variation selector (✍️ → ✍).
        const emojisOf = (arr: any[] | undefined) =>
            (arr ?? [])
                .filter((r: any) => r.type === 'emoji')
                .map((r: any) => String(r.emoji).replace(/️/g, ''));

        // Триггерим только на ДОБАВЛЕННЫЕ эмодзи (new минус old) —
        // снятие или замена чужой реакции задачу не создаёт.
        const before = new Set(emojisOf((mr as any).old_reaction));
        const added = emojisOf((mr as any).new_reaction).filter((e) => !before.has(e));

        console.log(`[reaction] chat=${chatId} msg=${messageId} added=${JSON.stringify(added)} cached=${recentMessages.has(messageId)}`);

        if (!added.some((e) => REACTION_TRIGGERS.has(e))) return;

        const text = recentMessages.get(messageId);
        if (!text) {
            // Кэш в памяти — после рестарта бота тексты старых сообщений недоступны
            // (message_reaction не содержит текст, а Bot API не умеет читать сообщения задним числом).
            await ctx.telegram.sendMessage(
                chatId,
                '⚠️ Не нашёл текст этого сообщения — бот перезапускался. Отправь сообщение заново и поставь реакцию на новое.',
                { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } },
            );
            return;
        }

        // Реакция — явное намерение пользователя: force=true создаёт задачу,
        // даже если ИИ не классифицировал текст как задачу.
        await processTaskAndConfirm(ctx, text, true);
    } catch (e) {
        console.error('[reaction] handler error:', e);
    }
});

// Создаёт задачу через бэкенд. force=false: при найденных дублях показывает
// подтверждение «всё равно добавить?». force=true: создаёт в обход дедупа.
// Ответ на callback-кнопку — косметический («Проверяю…»). Telegram протухает
// callback_query за ~15с, поэтому при медленном бэкенде answerCbQuery может
// бросить «query is too old». Эта ошибка НЕ должна ронять создание задачи —
// глотаем её здесь.
async function ack(ctx: Context, text?: string, alert = false): Promise<void> {
    try {
        await ctx.answerCbQuery(text, alert ? { show_alert: true } : undefined);
    } catch {
        /* подтверждение нажатия не критично */
    }
}

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

    // Частичный сбой: задача сохранена, но YouGile долго отвечал — карточка МОГЛА
    // создаться. Раньше это показывалось как «❌ не удалось создать», и человек
    // отправлял повторно → дубль. Теперь честно предупреждаем и просим не дублировать.
    if (result.partial) {
        pendingTasks.delete(taskId);
        clearCardEntry(taskId);
        if (pending.originChatId) {
            lastConfirmedTask.set(pending.originChatId, { title, ts: Date.now() });
        }
        await ctx.editMessageText(
            `⚠️ *YouGile долго ответил*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📌 *${title}*\n\n` +
            `Задача сохранена, карточка, скорее всего, уже создана — проверьте доску.\n` +
            `❗️ Не отправляйте повторно, чтобы не задвоить (при необходимости синхронизируйте: /sync).`,
            { parse_mode: 'Markdown' },
        );
        return;
    }

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
                    Markup.button.callback('✅', `force_${taskId}`),
                    Markup.button.callback('❌', `reject_${taskId}`)
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
                Markup.button.callback('🗑️', `del_task_${backendId}`)
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
    if (backendId) promoteCardEntry(taskId, backendId); else clearCardEntry(taskId);

    // Запоминаем задачу для исходного чата — AI не будет создавать её повторно.
    if (pending.originChatId) {
        lastConfirmedTask.set(pending.originChatId, { title, ts: Date.now() });
    }
}

// guardedSubmit запускает submitTask с защитой от двойного клика и уносит
// тяжёлый запрос в фон (не блокируя поллинг). Захват taskId синхронный — между
// has() и add() нет await, поэтому из двух параллельных кликов проходит один.
// finally снимает замок и для успеха, и для ветки «найдены дубли» (там submitTask
// возвращается, оставляя pending) — чтобы последующий клик «Да, добавить» прошёл.
function guardedSubmit(ctx: Context, taskId: string, pending: PendingTask, force: boolean): void {
    if (submitting.has(taskId)) {
        void ack(ctx, 'Уже обрабатываю эту задачу…');
        return;
    }
    submitting.add(taskId);
    submitTask(ctx, taskId, pending, force)
        .catch(async (error) => {
            console.error('submitTask error:', error);
            await ctx.editMessageText('❌ Не удалось создать задачу в YouGile. Подробности — в логах бэкенда.').catch(() => {});
        })
        .finally(() => submitting.delete(taskId));
}

bot.action(/^approve_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingTasks.get(taskId) ?? await recoverPendingTask(taskId);
    if (!pending) return ack(ctx, 'Задача устарела или не найдена.');
    if (pending.originChatId) {
        const ws = await resolveTenant(pending.originChatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        if (!(await canManageTasks(pending.originChatId, ctx.from!.id, pending.tenantId, mode))) {
            return ack(ctx, 'Только администратор или модератор может подтверждать задачи.', true);
        }
    }
    await ack(ctx, 'Проверяю…');
    // Не блокируем поллинг: тяжёлый запрос в бэкенд (дедуп + YouGile) уходит в фон,
    // иначе следующие клики висят в очереди и их callback_query протухает.
    guardedSubmit(ctx, taskId, pending, false);
});

// «Да, добавить» — создать несмотря на найденные дубли.
bot.action(/^force_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingTasks.get(taskId) ?? await recoverPendingTask(taskId);
    if (!pending) return ack(ctx, 'Задача устарела или не найдена.');
    if (pending.originChatId) {
        const ws = await resolveTenant(pending.originChatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        if (!(await canManageTasks(pending.originChatId, ctx.from!.id, pending.tenantId, mode))) {
            return ack(ctx, 'Только администратор или модератор может подтверждать задачи.', true);
        }
    }
    await ack(ctx, 'Добавляю…');
    guardedSubmit(ctx, taskId, pending, true);
});

bot.action(/^reject_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingTasks.get(taskId) ?? await recoverPendingTask(taskId);
    if (!pending) return ctx.answerCbQuery('Задача устарела или не найдена.');
    if (pending.originChatId) {
        const ws = await resolveTenant(pending.originChatId).catch(() => null);
        const mode = ws?.confirm_mode ?? 'admin_only';
        if (!(await canManageTasks(pending.originChatId, ctx.from!.id, pending.tenantId, mode))) {
            return ctx.answerCbQuery('Только администратор или модератор может отклонять задачи.', { show_alert: true });
        }
    }
    pendingTasks.delete(taskId);
    clearCardEntry(taskId);
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

    const isAdmin = await canManageSettings(ctx.chat.id, ctx.from!.id, ws.tenant_id);
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
    const isAdmin = await canManageSettings(chatId, ctx.from!.id, ws.tenant_id);
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
    const isAdmin = await canManageSettings(chatId, ctx.from!.id, ws.tenant_id);
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

async function sendHelp(ctx: Context) {
    const miniAppLine = MINI_APP_URL
        ? `👈 *Кнопка «Ovra»* слева от поля ввода — профиль и все доски.\n\n`
        : ``;
    await ctx.reply(
        `🤖 *Ovra* — задачи из чата прямо в YouGile\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        miniAppLine +
        `*Как создать задачу:*\n` +
        `• Напиши поручение в групповом чате\n` +
        `  _«Нужно сдать отчёт к пятнице» → карточка на подтверждение_\n` +
        `• Поставь реакцию ✍️ или 🔥 на любое сообщение\n` +
        `• Нажми *✅ Одобрить* — задача уйдёт в YouGile\n\n` +
        `*Как сменить статус / колонку задачи:*\n` +
        `• Ответь на карточку задачи: «в работе», «готово», «в тестирование»\n` +
        `• Или напиши/наговори голосом: _«лендинг готов»_, _«отчёт в согласование»_\n` +
        `  _(работает с любыми колонками вашей доски, не только стандартными)_\n\n` +
        `*Команды в групповом чате:*\n` +
        `/board — канбан-доска по статусам\n` +
        `/digest — сводка по исполнителям\n` +
        `/digest\\_time — время ежедневного дайджеста\n` +
        `/sync — синхронизация с YouGile\n` +
        `/trash — корзина (24 ч до удаления)\n` +
        `/setup — подключить или переподключить YouGile\n` +
        `/confirm group|pm — куда приходят подтверждения\n` +
        `/confirm\\_mode — кто может подтверждать задачи\n` +
        `/calendar — Google / Яндекс Календарь\n` +
        `/bind Имя — привязать @ к аккаунту YouGile\n\n` +
        `*Команды в личке:*\n` +
        `/start — онбординг новой доски\n` +
        `/stats — статус системы\n` +
        `/help — эта справка`,
        { parse_mode: 'Markdown' }
    );
}
bot.command('help', sendHelp);

// /makeadmin @username — назначить пользователя администратором Ovra в группе.
bot.command('makeadmin', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Команда работает только в группах.');
    const callerId = ctx.from.id;
    const callerMember = await ctx.telegram.getChatMember(ctx.chat.id, callerId);
    if (callerMember.status !== 'administrator' && callerMember.status !== 'creator') {
        return ctx.reply('❌ Только администраторы Telegram могут назначать роли Ovra.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('❌ Этот чат не привязан к доске.');

    const args = ctx.message.text.split(' ').slice(1).join(' ').trim().replace(/^@/, '').toLowerCase();
    if (!args) return ctx.reply('Использование: /makeadmin @username');

    const users = await listWorkspaceUsers(ws.tenant_id).catch(() => []);
    const user = users.find(u => u.tg_username?.replace(/^@/, '').toLowerCase() === args);
    if (!user) return ctx.reply(`❌ @${args} не найден в пространстве. Пользователь должен сначала привязаться через /start.`);

    await setUserRole(ws.tenant_id, user.tg_id, 'admin');
    await ctx.reply(`✅ @${args} теперь администратор Ovra — может подтверждать задачи и управлять доской.`);
});

// /removeadmin @username — снять роль администратора Ovra.
bot.command('removeadmin', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Команда работает только в группах.');
    const callerId = ctx.from.id;
    const callerMember = await ctx.telegram.getChatMember(ctx.chat.id, callerId);
    if (callerMember.status !== 'administrator' && callerMember.status !== 'creator') {
        return ctx.reply('❌ Только администраторы Telegram могут изменять роли Ovra.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('❌ Этот чат не привязан к доске.');

    const args = ctx.message.text.split(' ').slice(1).join(' ').trim().replace(/^@/, '').toLowerCase();
    if (!args) return ctx.reply('Использование: /removeadmin @username');

    const users = await listWorkspaceUsers(ws.tenant_id).catch(() => []);
    const user = users.find(u => u.tg_username?.replace(/^@/, '').toLowerCase() === args);
    if (!user) return ctx.reply(`❌ @${args} не найден в пространстве.`);

    await setUserRole(ws.tenant_id, user.tg_id, 'member');
    await ctx.reply(`✅ @${args} больше не администратор Ovra.`);
});

// /makemod @username — назначить пользователя модератором Ovra (управление задачами).
bot.command('makemod', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Команда работает только в группах.');
    if (!(await isTgAdmin(ctx.chat.id, ctx.from.id))) {
        return ctx.reply('❌ Только администраторы Telegram могут назначать роли Ovra.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('❌ Этот чат не привязан к доске.');

    const args = ctx.message.text.split(' ').slice(1).join(' ').trim().replace(/^@/, '').toLowerCase();
    if (!args) return ctx.reply('Использование: /makemod @username');

    const users = await listWorkspaceUsers(ws.tenant_id).catch(() => []);
    const user = users.find(u => u.tg_username?.replace(/^@/, '').toLowerCase() === args);
    if (!user) return ctx.reply(`❌ @${args} не найден в пространстве. Пользователь должен сначала привязаться через /start.`);

    await setUserRole(ws.tenant_id, user.tg_id, 'moderator');
    await ctx.reply(`✅ @${args} теперь модератор Ovra — может подтверждать и редактировать задачи.`);
});

// /removemod @username — снять роль модератора Ovra.
bot.command('removemod', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('Команда работает только в группах.');
    if (!(await isTgAdmin(ctx.chat.id, ctx.from.id))) {
        return ctx.reply('❌ Только администраторы Telegram могут изменять роли Ovra.');
    }
    const ws = await resolveTenant(ctx.chat.id).catch(() => null);
    if (!ws) return ctx.reply('❌ Этот чат не привязан к доске.');

    const args = ctx.message.text.split(' ').slice(1).join(' ').trim().replace(/^@/, '').toLowerCase();
    if (!args) return ctx.reply('Использование: /removemod @username');

    const users = await listWorkspaceUsers(ws.tenant_id).catch(() => []);
    const user = users.find(u => u.tg_username?.replace(/^@/, '').toLowerCase() === args);
    if (!user) return ctx.reply(`❌ @${args} не найден в пространстве.`);

    await setUserRole(ws.tenant_id, user.tg_id, 'member');
    await ctx.reply(`✅ @${args} больше не модератор Ovra.`);
});

// Бота добавили в группу / сделали админом → создаём воркспейс и зовём настраивать доску.
bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    if (!upd || upd.chat.type === 'private') return;
    const status = upd.new_chat_member.status;
    if (status !== 'administrator' && status !== 'member') return;

    try {
        const chat: any = upd.chat;
        const ws = await createWorkspace(chat.id, chat.title || 'Группа', upd.from?.id || '');
        const me = await ctx.telegram.getMe();
        const adminNote = status === 'administrator' ? '' :
            '\n\n⚠️ Дайте мне права *администратора*, чтобы я видел сообщения и реакции.';

        // Single clean CTA: open the Mini App when available, else the deep-link.
        const buttons: ReturnType<typeof Markup.button.url | typeof Markup.button.webApp>[][] = [];
        if (MINI_APP_URL) {
            const miniAppUrl = `${MINI_APP_URL}?tenant=${encodeURIComponent(ws.tenant_id)}`;
            buttons.push([Markup.button.webApp('🚀 Открыть Ovra', miniAppUrl)]);
        } else {
            const deepLink = `https://t.me/${me.username}?start=${ws.tenant_id}`;
            buttons.push([Markup.button.url('🚀 Открыть Ovra', deepLink)]);
        }

        await ctx.telegram.sendMessage(chat.id,
            `👋 Привет! Я *Ovra* — превращаю поручения из чата в задачи YouGile.\n` +
            `Администратор: нажмите кнопку ниже, чтобы подключить доску YouGile:` + adminNote,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
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
                Markup.button.callback('✅', `mtask_ok_${taskId}`),
                Markup.button.callback('❌', `mtask_no_${taskId}`),
            ]),
        });
    }
}

bot.action(/^mtask_ok_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]!;
    const pending = pendingMeetingTasks.get(taskId);
    if (!pending) return ack(ctx, 'Задача устарела или не найдена.');

    const ws = await resolveTenant(pending.groupChatId).catch(() => null);
    const mode = ws?.confirm_mode ?? 'admin_only';
    if (!(await canManageTasks(pending.groupChatId, ctx.from!.id, pending.tenantId, mode))) {
        return ack(ctx, 'Только администратор или модератор может подтверждать задачи.', true);
    }

    try {
        await ack(ctx, 'Создаю…');

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
    if (!(await canManageTasks(pending.groupChatId, ctx.from!.id, pending.tenantId, mode2))) {
        return ctx.answerCbQuery('Только администратор или модератор может отклонять задачи.', { show_alert: true });
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
async function sendBoard(ctx: Context) {
    if (ctx.chat?.type === 'private') {
        return ctx.reply(
            MINI_APP_URL
                ? '📋 Просматривайте задачи через кнопку *👤 Профиль* — выберите нужную доску.'
                : 'Команда /board работает в групповом чате.',
            { parse_mode: 'Markdown', ...mainReplyKeyboard() }
        );
    }
    const ws = await resolveTenant(ctx.chat!.id).catch(() => null);
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

        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('board:', e);
        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            '❌ Не удалось загрузить доску.');
    }
}
bot.command('board', sendBoard);

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
        const tz = (assignee as any).timezone || 'Europe/Moscow';
        for (const t of assignee.tasks) {
            const dl = t.deadline
                ? ` · ${t.overdue ? '🔴' : '📅'} ${new Date(t.deadline).toLocaleDateString('ru-RU', { timeZone: tz })}`
                : '';
            lines.push(`  ${statusEmoji(t.status)} ${t.title}${dl}`);
        }
    }

    if (data.unassigned?.length) {
        lines.push(`\n❓ *Без исполнителя*`);
        for (const t of data.unassigned) {
            const dl = t.deadline
                ? ` · ${t.overdue ? '🔴' : '📅'} ${new Date(t.deadline).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}`
                : '';
            lines.push(`  ${statusEmoji(t.status)} ${t.title}${dl}`);
        }
    }

    lines.push(`\n━━━━━━━━━━━━━━━━━━\n_Всего открытых: ${total}_`);
    return lines.join('\n');
}

// Шлёт батч напоминаний о задачах в личку исполнителю — планировщик (POST /internal/reminder).
export async function handleReminderDue(
    payload: { tg_id: string; timezone?: string; tasks: { title: string; deadline: string; overdue: boolean }[] }
): Promise<void> {
    const userId = Number(payload.tg_id);
    if (!userId) throw new Error(`invalid tg_id: ${payload.tg_id}`);

    const tz = payload.timezone || 'Europe/Moscow';
    const tasks = payload.tasks ?? [];

    const formatDate = (deadline: string) =>
        deadline
            ? new Date(deadline).toLocaleString('ru-RU', {
                timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            })
            : '—';

    const overdue = tasks.filter(t => t.overdue);
    const upcoming = tasks.filter(t => !t.overdue);

    const lines: string[] = [];

    if (overdue.length > 0) {
        lines.push(overdue.length === 1
            ? `🔴 *Просрочена задача*`
            : `🔴 *Просроченные задачи (${overdue.length})*`);
        lines.push('━━━━━━━━━━━━━━━━━━');
        for (const t of overdue) {
            lines.push(`📌 ${t.title}\n⏳ Дедлайн был: ${formatDate(t.deadline)}`);
        }
    }

    if (upcoming.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(upcoming.length === 1
            ? `⏰ *Напоминание о задаче*`
            : `⏰ *Напоминания о задачах (${upcoming.length})*`);
        lines.push('━━━━━━━━━━━━━━━━━━');
        for (const t of upcoming) {
            lines.push(`📌 ${t.title}\n📅 Дедлайн: ${formatDate(t.deadline)}`);
        }
    }

    if (lines.length === 0) return;

    // Может упасть с 403 (бот заблокирован) / 400 (чат не найден), если юзер не
    // запускал бота в личке — это перманентно, эндпоинт обработает отдельно.
    await bot.telegram.sendMessage(userId, lines.join('\n'), { parse_mode: 'Markdown' });
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
async function sendDigest(ctx: Context) {
    if (ctx.chat?.type === 'private') {
        return ctx.reply('Команда /digest работает в групповом чате.', mainReplyKeyboard());
    }
    const ws = await resolveTenant(ctx.chat!.id).catch(() => null);
    if (!ws) return ctx.reply('⚠️ Этот чат не привязан к доске.');

    const loading = await ctx.reply('⏳ Собираю дайджест…');

    try {
        const data = await getDigest(ws.tenant_id);
        const text = formatDigest(data);

        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            text ?? '✅ Открытых задач нет — всё чисто!', { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('digest:', e);
        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            '❌ Не удалось получить дайджест. Проверьте логи.');
    }
}
bot.command('digest', sendDigest);

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

    const isAdmin = await canManageSettings(ctx.chat.id, ctx.from!.id, ws.tenant_id);
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
    const isAdmin = await canManageSettings(chatId, ctx.from!.id, ws.tenant_id);
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
    const isAdmin = await canManageSettings(chatId, ctx.from!.id, ws.tenant_id);
    if (!isAdmin) return ctx.answerCbQuery('Только администратор может менять настройки.', { show_alert: true });

    const time = ws.digest_time || '09:00';
    await updateDigestSettings(ws.tenant_id, false, time);
    await ctx.editMessageText(digestSettingsText(false, time), {
        parse_mode: 'Markdown',
        ...digestSettingsKeyboard(time, false),
    }).catch(() => { /* message not modified — игнорируем */ });
    await ctx.answerCbQuery('Дайджест выключен');
});

// --- Часовой пояс пользователя ---

const TIMEZONE_OPTIONS: Array<{ label: string; iana: string }> = [
    { label: 'Москва (МСК, UTC+3)',       iana: 'Europe/Moscow' },
    { label: 'Самара (UTC+4)',             iana: 'Europe/Samara' },
    { label: 'Екатеринбург (UTC+5)',       iana: 'Asia/Yekaterinburg' },
    { label: 'Омск (UTC+6)',               iana: 'Asia/Omsk' },
    { label: 'Красноярск (UTC+7)',         iana: 'Asia/Krasnoyarsk' },
    { label: 'Иркутск (UTC+8)',            iana: 'Asia/Irkutsk' },
    { label: 'Якутск (UTC+9)',             iana: 'Asia/Yakutsk' },
    { label: 'Владивосток (UTC+10)',       iana: 'Asia/Vladivostok' },
    { label: 'Магадан (UTC+11)',           iana: 'Asia/Magadan' },
    { label: 'Камчатка (UTC+12)',          iana: 'Asia/Kamchatka' },
];

bot.command('timezone', async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply('Используйте эту команду в личке с ботом.');
    }
    const buttons = TIMEZONE_OPTIONS.map(tz =>
        [Markup.button.callback(tz.label, `tz_set:${tz.iana}`)]
    );
    await ctx.reply('🌍 *Выберите ваш часовой пояс:*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
    });
});

bot.action(/^tz_set:(.+)$/, async (ctx) => {
    const iana = ctx.match[1]!;
    const userId = ctx.from!.id;
    await ctx.answerCbQuery('Сохраняю…');
    try {
        await setUserTimezone(String(userId), iana);
        const label = TIMEZONE_OPTIONS.find(t => t.iana === iana)?.label ?? iana;
        await ctx.editMessageText(`✅ Часовой пояс установлен: *${label}*\n\nТеперь дедлайны и напоминания будут показаны в вашем времени.`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('tz_set:', e);
        await ctx.editMessageText('❌ Не удалось сохранить часовой пояс. Попробуйте позже.');
    }
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
async function sendTrashView(ctx: Context) {
    if (ctx.chat?.type === 'private') {
        return ctx.reply('Команда /trash работает в групповом чате.', mainReplyKeyboard());
    }
    const ws = await resolveTenant(ctx.chat!.id).catch(() => null);
    if (!ws) return ctx.reply('⚠️ Этот чат не привязан к доске.');

    const loading = await ctx.reply('⏳ Загружаю корзину…');
    try {
        const tasks = await getTrash(ws.tenant_id);
        if (tasks.length === 0) {
            await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
                '🗑 Корзина пуста — удалять нечего.');
            return;
        }
        const { text, keyboard } = buildTrashMessage(tasks, ws.tenant_id);
        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        console.error('trash:', e);
        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            '❌ Не удалось загрузить корзину.');
    }
}
bot.command('trash', sendTrashView);

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
async function sendSync(ctx: Context) {
    if (ctx.chat?.type === 'private') {
        return ctx.reply('Команда /sync работает в групповом чате.', mainReplyKeyboard());
    }
    const ws = await resolveTenant(ctx.chat!.id).catch(() => null);
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
        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('sync:', e);
        await ctx.telegram.editMessageText(ctx.chat!.id, loading.message_id, undefined,
            '❌ Ошибка синхронизации. Проверьте что YouGile подключён (/stats).');
    }
}
bot.command('sync', sendSync);

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