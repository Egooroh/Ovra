// src/services/ai.ts
import OpenAI from "openai";
import dotenv from "dotenv";
import { HttpsProxyAgent } from 'https-proxy-agent';

dotenv.config();

const proxyUrl = process.env.PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    httpAgent: agent,
    timeout: 10_000,
});

export interface ParsedTask {
    isTask: boolean;
    assignee?: string;
    deadline?: string;
    description?: string;
    title?: string;
}

function buildSystemPrompt(): string {
    const today = new Date().toISOString().slice(0, 10);
    return `Ты анализируешь сообщения из рабочего чата и извлекаешь КОНКРЕТНЫЕ задачи.

Верни ТОЛЬКО JSON (без markdown, без пояснений):
{"tasks": [{"title": "...", "assignee": "...", "deadline": "...", "description": "..."}]}

Если задач нет — {"tasks": []}.

ЗАДАЧА — это конкретное поручение с понятным действием:
  ✅ "Даниил, подготовь презентацию к вечеру" → задача
  ✅ "купить макбук, задача на @user, до конца дня" → задача
  ✅ "этим займется иван до 5 числа" + контекст про лендинг → задача "Лендинг, Иван, 5-е"
  ❌ "нужно сделать до конца месяца" — непонятно ЧТО делать → не задача
  ❌ "нужно сделать лендинг" без исполнителя — предложение, не поручение → не задача
  ❌ "ок", "понял", "спасибо", светская беседа → не задача
  ❌ обсуждение без конкретного поручения → не задача

Если сообщение ссылается на предыдущее ("этим", "это", "тем", "тут") — ищи тему в контексте разговора.

Если в контексте есть маркер "[ЗАДАЧА УЖЕ СОЗДАНА: ...]" — значит задача уже поставлена. Сообщения вроде "дедлайн до конца дня", "добавь описание", "с лаврушкой" и т.п. это УТОЧНЕНИЯ к существующей задаче, а НЕ новые задачи → верни {"tasks": []}.

Сегодня ${today}. Поле deadline: YYYY-MM-DD или YYYY-MM-DDTHH:mm, пустая строка если не указан.
Правила:
- Каждое поручение — отдельный элемент
- Исполнитель "я" — оставить строго "я"
- Нет исполнителя — пустая строка
- Нет чёткого действия → {"tasks": []}`;
}

// Partial update returned by parseTaskEdit — only changed fields.
export type TaskPatch = Partial<Pick<ParsedTask, 'title' | 'assignee' | 'deadline' | 'description'>>;

export async function parseTaskEdit(current: ParsedTask, editText: string): Promise<TaskPatch> {
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = `Сегодня ${today}. Пользователь редактирует задачу. Верни ТОЛЬКО JSON с полями которые нужно изменить.

Правила:
- Не включай поля которые остаются прежними
- Если ничего не изменилось — верни {}
- Дедлайн: YYYY-MM-DD или YYYY-MM-DDTHH:mm, пустая строка = убрать
- Если пользователь ДОБАВЛЯЕТ новое действие к задаче («добавляется», «ещё нужно», «плюс», «также») — обнови TITLE чтобы он отражал полный объём работы, и обнови description
- Если пользователь ПЕРЕИМЕНОВЫВАЕТ — обнови только title
- Если уточняет детали без смены сути — обнови только description

Примеры:
  «переименуй в Отчёт Q2» → {"title": "Отчёт Q2"}
  «добавляется ещё депнуть в прод» → {"title": "...текущее + и депнуть в прод", "description": "..."}
  «исполнитель Иван» → {"assignee": "Иван"}
  «дедлайн до пятницы» → {"deadline": "YYYY-MM-DD"}`;

    const userPrompt = `Текущая задача:
- Название: ${current.title || '—'}
- Исполнитель: ${current.assignee || '—'}
- Дедлайн: ${current.deadline || '—'}
- Описание: ${current.description || '—'}

Правка пользователя: "${editText}"`;

    try {
        const completion = await openai.chat.completions.create({
            model: process.env.AI_MODEL || "mistralai/mistral-7b-instruct:free",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            max_tokens: 512,
        });
        let raw = completion.choices[0]?.message?.content?.trim() ?? '{}';
        raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
        const patch = JSON.parse(raw);
        return typeof patch === 'object' && patch !== null ? patch as TaskPatch : {};
    } catch (e) {
        console.error('parseTaskEdit error:', e);
        return {};
    }
}

// pickTaskAndColumn решает, к какой из СУЩЕСТВУЮЩИХ задач относится сообщение о
// перемещении («лендинг готов», «беру дизайн в работу», «отчёт в тестирование»)
// и в какую РЕАЛЬНУЮ колонку доски его двигать — включая кастомные колонки
// («Тестирование», «Согласование», «Заблокировано»…). AI видит настоящие
// названия колонок и сам сопоставляет фразу с нужной. Вызывается только после
// дешёвого эвристического фильтра (looksLikeStatusOrMove) — чтобы не дёргать AI
// на каждом сообщении. Возвращает индекс задачи + id колонки, либо null.
export async function pickTaskAndColumn(
    text: string,
    tasks: { title: string; status: string }[],
    columns: { id: string; title: string }[],
): Promise<{ taskIndex: number; columnId: string } | null> {
    if (tasks.length === 0 || columns.length === 0) return null;

    const taskList = tasks.map((t, i) => `${i + 1}. "${t.title}"`).join('\n');
    const colList = columns.map((c, i) => `${i + 1}. "${c.title}"`).join('\n');

    const systemPrompt = `Пользователь в рабочем чате сообщает о ПЕРЕМЕЩЕНИИ существующей задачи в колонку доски. Примеры: «лендинг готов», «беру дизайн в работу», «отчёт отправил на тестирование», «карточку X в согласование».

Тебе даны:
- пронумерованный список существующих ЗАДАЧ;
- пронумерованный список реальных КОЛОНОК доски (статусы могут быть нестандартными);
- сообщение пользователя.

Определи, какую задачу и в какую колонку нужно переместить. Сопоставляй по смыслу: «готово/сделал» → колонка завершения; «в работу/делаю» → колонка работы; «на проверку/ревью/тест» → соответствующая колонка; и т.п. Если в доске есть колонка с подходящим названием — выбирай её.

Верни ТОЛЬКО JSON без markdown:
{"task": <номер задачи 1..N>, "column": <номер колонки 1..M>}

Если это НЕ перемещение задачи из списка, либо непонятно какая задача/колонка — верни {"task": 0}.`;

    const userPrompt = `ЗАДАЧИ:\n${taskList}\n\nКОЛОНКИ:\n${colList}\n\nСообщение: "${text}"`;

    try {
        const completion = await openai.chat.completions.create({
            model: process.env.AI_MODEL || "mistralai/mistral-7b-instruct:free",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            max_tokens: 64,
        });
        let raw = completion.choices[0]?.message?.content?.trim() ?? '{}';
        raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(raw);

        const ti = Number(parsed.task);
        const ci = Number(parsed.column);
        if (!Number.isInteger(ti) || ti < 1 || ti > tasks.length) return null;
        if (!Number.isInteger(ci) || ci < 1 || ci > columns.length) return null;

        return { taskIndex: ti - 1, columnId: columns[ci - 1]!.id };
    } catch (e) {
        console.error('pickTaskAndColumn error:', e);
        return null;
    }
}

export async function parseMessageWithAI(message: string, context: string[] = []): Promise<ParsedTask[]> {
    try {
        console.log("⏳ Отправляю запрос в OpenRouter...");

        const userContent = context.length > 0
            ? `Контекст предыдущих сообщений:\n${context.map(m => `- ${m}`).join('\n')}\n\nТекущее сообщение:\n${message}`
            : message;

        const completion = await openai.chat.completions.create({
            model: process.env.AI_MODEL || "mistralai/mistral-7b-instruct:free",
            messages: [
                { role: "system", content: buildSystemPrompt() },
                { role: "user", content: userContent }
            ],
            max_tokens: 2048,
        });

        let resultText = completion.choices[0]?.message?.content;

        if (!resultText) {
            console.log("❌ ИИ вернул пустой ответ.");
            return [];
        }

        console.log("🤖 Сырой ответ от ИИ:\n", resultText);

        resultText = resultText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const parsed = JSON.parse(resultText);

        // Новый формат: { tasks: [...] }
        if (Array.isArray(parsed.tasks)) {
            return parsed.tasks
                .filter((t: any) => t.title)
                .map((t: any) => ({ isTask: true, ...t } as ParsedTask));
        }

        // Обратная совместимость: старый формат { isTask, title, ... }
        if (parsed.isTask === true && parsed.title) {
            return [parsed as ParsedTask];
        }

        return [];

    } catch (error) {
        console.error("❌ Ошибка парсинга AI:", error);
        return [];
    }
}
