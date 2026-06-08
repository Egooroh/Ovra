// src/services/ai.ts
import OpenAI from "openai";
import dotenv from "dotenv";
import { HttpsProxyAgent } from 'https-proxy-agent';

dotenv.config();

// Читаем прокси из .env
const proxyUrl = process.env.PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    httpAgent: agent, // <-- ДОБАВИЛИ ПРОКСИ ДЛЯ ИИ
});

export interface ParsedTask {
    isTask: boolean;
    assignee?: string;
    deadline?: string;
    description?: string;
    title?: string;
}

// Промпт строится при каждом вызове, чтобы подставить СЕГОДНЯШНЮЮ дату —
// тогда модель может вычислить абсолютный срок из «завтра», «до 10 июня» и т.п.
function buildSystemPrompt(): string {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `
Это сообщение из рабочего чата. Определи: это реальная задача (task) или нет (none)?
Если task — извлеки: title (краткое название), assignee (исполнитель),
deadline (срок), description (описание).

Сегодня ${today}. Поле deadline верни как АБСОЛЮТНУЮ дату, вычислив её из текста
(«завтра», «до 10 июня», «к пятнице»):
- если время НЕ названо — формат YYYY-MM-DD (напр. "2026-06-10");
- если время названо («к 18:00», «в 15:30») — формат YYYY-MM-DDTHH:mm (напр. "2026-06-10T18:00").
Если срок не указан — верни пустую строку "".

Если это не задача, верни {"isTask": false}.
Отвечай строго в формате JSON. Никаких пояснений, только JSON.

Пример ответа для задачи:
{
  "isTask": true,
  "title": "Сделать кнопку",
  "assignee": "@ivan",
  "deadline": "2026-06-10",
  "description": "Нужно добавить красную кнопку на главную"
}
`;
}

export async function parseMessageWithAI(message: string): Promise<ParsedTask | null> {
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
            return null;
        }

        // Выводим в консоль то, что пришло от ИИ
        console.log("🤖 Сырой ответ от ИИ:\n", resultText);

        // Срезаем маркдаун (```json и ```)
        resultText = resultText.replace(/```json/gi, '').replace(/```/g, '').trim();

        return JSON.parse(resultText) as ParsedTask;
        
    } catch (error) {
        console.error("❌ Ошибка парсинга AI (вероятно, кривой JSON или таймаут):", error);
        return null;
    }
}