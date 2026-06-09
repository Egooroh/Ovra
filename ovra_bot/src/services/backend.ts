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

// 2. Отправка задачи в конкретный воркспейс. force=true — в обход дедупликации.
export async function sendTaskToOvraBackend(
    tenantId: string,
    title: string,
    assignee: string,
    description: string,
    deadline?: string,
    force?: boolean
): Promise<OvraBackendResponse> {
    const url = `${BACKEND_URL}/v1/tasks`;

    const body = {
        tenant_id: tenantId,
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

// --- Мультитенантность: воркспейсы, участники, регистрация ---

export interface WorkspaceInfo {
    tenant_id: string;
    chat_id: string;
    name: string;
    connected: boolean;       // подключены ли креды YouGile
    board_resolved: boolean;  // сопоставлены ли колонки
}

export interface YougileMember {
    id: string;
    name: string;
    email: string;
}

// Резолв воркспейса по чату. null, если чат не привязан.
export async function resolveTenant(chatId: string | number): Promise<WorkspaceInfo | null> {
    const res = await fetch(`${BACKEND_URL}/v1/chats/${chatId}/workspace`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`resolveTenant HTTP ${res.status}`);
    return await res.json() as WorkspaceInfo;
}

// Состояние воркспейса по tenant_id (подключён / доска готова).
export async function getWorkspaceInfo(tenantId: string): Promise<WorkspaceInfo> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}`);
    if (!res.ok) throw new Error(`getWorkspaceInfo HTTP ${res.status}`);
    return await res.json() as WorkspaceInfo;
}

// Создать (идемпотентно) воркспейс для чата.
export async function createWorkspace(chatId: string | number, name: string, hostTgId: string | number): Promise<WorkspaceInfo> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), name, host_tg_id: String(hostTgId) })
    });
    if (!res.ok) throw new Error(`createWorkspace HTTP ${res.status}`);
    return await res.json() as WorkspaceInfo;
}

// Участники проекта YouGile (для кнопок выбора себя).
export async function listYougileMembers(tenantId: string): Promise<YougileMember[]> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/yougile-users`);
    if (!res.ok) throw new Error(`listYougileMembers HTTP ${res.status}`);
    const data = await res.json();
    return (data.users || []) as YougileMember[];
}

// Зарегистрировать/привязать участника чата к YouGile-аккаунту.
export async function registerUser(
    tenantId: string,
    u: { tg_id: string; tg_username?: string; full_name: string; yougile_user_id?: string }
): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(u)
    });
    if (!res.ok) throw new Error(`registerUser HTTP ${res.status}`);
}

export interface YougileProject { id: string; title: string; }

export interface YougileCreds { api_key?: string; login?: string; password?: string; }

// Сохранить креды YouGile воркспейса (API-ключ ИЛИ логин/пароль).
export async function saveYougileCreds(tenantId: string, creds: YougileCreds): Promise<void> {
    const c = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/credentials`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
    });
    if (!c.ok) throw new Error(`saveYougileCreds HTTP ${c.status}`);
}

// Список проектов YouGile (для выбора админом).
export async function listYougileProjects(tenantId: string): Promise<YougileProject[]> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/yougile-projects`);
    if (!res.ok) throw new Error(`listYougileProjects HTTP ${res.status}`);
    const data = await res.json();
    return (data.projects || []) as YougileProject[];
}

// Запланировать созвон по Telemost-ссылке из чата.
export async function scheduleCallInOvra(
    tenantId: string,
    joinUrl: string,
    title?: string,
    startsAt?: string, // ISO-8601
): Promise<{ id: string; duplicate?: boolean }> {
    const url = `${BACKEND_URL}/v1/workspaces/${tenantId}/calls`;
    const body: Record<string, string> = { join_url: joinUrl };
    if (title) body.title = title;
    if (startsAt) body.starts_at = startsAt;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Schedule call HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data as { id: string; duplicate?: boolean };
}

// --- Calendar account management ---

export interface CalendarAccount {
    id: string;
    organizationId: string;
    provider: string;
    label: string | null;
    active: boolean;
    calendarIds: string[];
    createdAt: string;
}

export async function listCalendarAccounts(tenantId: string): Promise<CalendarAccount[]> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/calendar/accounts`);
    if (!res.ok) throw new Error(`listCalendarAccounts HTTP ${res.status}`);
    return await res.json() as CalendarAccount[];
}

export async function addCalendarAccount(
    tenantId: string,
    provider: 'google' | 'yandex',
    credentials: object,
    label?: string,
    calendarIds?: string[],
): Promise<CalendarAccount> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/calendar/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, credentials, label, calendarIds }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`addCalendarAccount HTTP ${res.status}: ${JSON.stringify(err)}`);
    }
    return await res.json() as CalendarAccount;
}

export async function deleteCalendarAccount(tenantId: string, accountId: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/calendar/accounts/${accountId}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error(`deleteCalendarAccount HTTP ${res.status}`);
}

// Привязать проект к воркспейсу и распознать колонки доски.
export async function setWorkspaceProject(tenantId: string, projectId: string): Promise<void> {
    const p = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/project`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId })
    });
    if (!p.ok) throw new Error(`setWorkspaceProject HTTP ${p.status}`);
    const r = await fetch(`${BACKEND_URL}/v1/workspaces/${tenantId}/board/resolve`, { method: 'POST' });
    if (!r.ok) throw new Error(`board/resolve HTTP ${r.status}`);
}