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
    listYougileMembers, registerUser,
    saveYougileCreds, listYougileProjects, setWorkspaceProject,
    type YougileMember, type YougileProject,
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

function cleanup() {
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

        pendingTasks.delete(taskId);
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
