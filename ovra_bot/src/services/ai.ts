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
    return `
Это сообщение из рабочего чата. Найди ВСЕ задачи в сообщении — каждую отдельно.

Верни ТОЛЬКО JSON-объект (без пояснений, без markdown):
{
  "tasks": [
    {
      "title": "краткое название задачи",
      "assignee": "имя исполнителя или пустая строка",
      "deadline": "дата",
      "description": "описание"
    }
  ]
}

Если задач нет — верни {"tasks": []}.

Сегодня ${today}. Поле deadline — АБСОЛЮТНАЯ дата:
- без времени → YYYY-MM-DD
- с временем → YYYY-MM-DDTHH:mm
- не указан → ""

Правила:
- Каждая задача — отдельный элемент массива, не объединяй несколько в одну
- Если исполнитель — местоимение "я" — оставь строго "я" (не меняй)
- Если исполнитель не назван — пустая строка
`;
}

// Partial update returned by parseTaskEdit — only changed fields.
export type TaskPatch = Partial<Pick<ParsedTask, 'title' | 'assignee' | 'deadline' | 'description'>>;

export async function parseTaskEdit(current: ParsedTask, editText: string): Promise<TaskPatch> {
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = `Сегодня ${today}. Пользователь хочет отредактировать задачу.
Верни ТОЛЬКО JSON с полями, которые нужно изменить (не включай поля, которые остаются прежними).
Формат дедлайна: YYYY-MM-DD или YYYY-MM-DDTHH:mm. Пустая строка означает "убрать дедлайн".
Если ничего не изменилось — верни {}.
Пример ответа: {"title": "Новое название", "assignee": "Иван"}`;

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

export async function parseMessageWithAI(message: string): Promise<ParsedTask[]> {
    try {
        console.log("⏳ Отправляю запрос в OpenRouter...");

        const completion = await openai.chat.completions.create({
            model: process.env.AI_MODEL || "mistralai/mistral-7b-instruct:free",
            messages: [
                { role: "system", content: buildSystemPrompt() },
                { role: "user", content: message }
            ]
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
