// src/services/backend.ts
import dotenv from 'dotenv';
dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8080';
const TENANT_ID = process.env.TENANT_ID || 'ws-demo';

// 1. Описываем, что именно мы ожидаем от Go-бэкенда
export interface OvraBackendResponse {
    yougile_task_id?: string;
    status?: string;
    error?: string;
}

// 2. Указываем, что функция возвращает Promise<OvraBackendResponse>
export async function sendTaskToOvraBackend(
    title: string, 
    assignee: string, 
    description: string
): Promise<OvraBackendResponse> {
    const url = `${BACKEND_URL}/v1/tasks`;
    
    const body = {
        tenant_id: TENANT_ID,
        title: title,
        assignee: assignee,
        description: description 
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ovra Backend HTTP error! status: ${response.status}, body: ${errorText}`);
        }

        // 3. Явно говорим TypeScript'у, что полученный JSON соответствует нашему интерфейсу
        const data = await response.json();
        return data as OvraBackendResponse;
        
    } catch (error) {
        console.error("Ошибка отправки задачи в Ovra Backend:", error);
        throw error;
    }
}