// src/services/backend.ts
import dotenv from 'dotenv';
dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const TENANT_ID = process.env.TENANT_ID || 'ws-demo';

// Найденный бэкендом похожий дубликат.
export interface DuplicateTask {
    id: string;
    title: string;
    status?: string;
}

// 1. Описываем, что именно мы ожидаем от Go-бэкенда
export interface OvraBackendResponse {
    yougile_task_id?: string;
    status?: string;
    error?: string;
    // Если бэкенд нашёл дубли (HTTP 409) — заполняется и выставляется isDuplicate.
    isDuplicate?: boolean;
    duplicates?: DuplicateTask[];
}

// 2. Отправка задачи. force=true создаёт задачу в обход дедупликации.
export async function sendTaskToOvraBackend(
    title: string,
    assignee: string,
    description: string,
    deadline?: string,
    force?: boolean
): Promise<OvraBackendResponse> {
    const url = `${BACKEND_URL}/v1/tasks`;

    const body = {
        tenant_id: TENANT_ID,
        title: title,
        assignee: assignee,
        description: description,
        // дедлайн опционален; шлём только если задан (бэкенд парсит дату/RFC3339)
        ...(deadline ? { deadline } : {}),
        ...(force ? { force: true } : {})
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json().catch(() => ({}));

        // 409 — это не ошибка, а «найдены похожие задачи». Возвращаем их наверх,
        // чтобы спросить у пользователя, добавлять ли всё равно.
        if (response.status === 409 && Array.isArray((data as any).duplicates)) {
            return { ...(data as OvraBackendResponse), isDuplicate: true };
        }

        if (!response.ok) {
            throw new Error(`Ovra Backend HTTP error! status: ${response.status}, body: ${JSON.stringify(data)}`);
        }

        return data as OvraBackendResponse;

    } catch (error) {
        console.error("Ошибка отправки задачи в Ovra Backend:", error);
        throw error;
    }
}