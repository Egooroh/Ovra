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

const SYSTEM_PROMPT = `
Это сообщение из рабочего чата. Определи: это реальная задача (task) или нет (none)?
Если task — извлеки: title (краткое название), assignee (исполнитель), deadline (срок), description (описание).
Если это не задача, верни {"isTask": false}.
Отвечай строго в формате JSON. Никаких пояснений, только JSON.

Пример ответа для задачи:
{
  "isTask": true,
  "title": "Сделать кнопку",
  "assignee": "@ivan",
  "deadline": "завтра",
  "description": "Нужно добавить красную кнопку на главную"
}
`;

export async function parseMessageWithAI(message: string): Promise<ParsedTask | null> {
    try {
        console.log("⏳ Отправляю запрос в OpenRouter...");
        
        const completion = await openai.chat.completions.create({
            model: process.env.AI_MODEL || "mistralai/mistral-7b-instruct:free",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
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