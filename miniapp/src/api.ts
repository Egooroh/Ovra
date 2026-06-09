// Secure API client. Every request carries the signed Telegram initData in the
// Authorization header; the Go backend re-verifies its HMAC signature, so the
// server never trusts a client-supplied user id. Secrets (YouGile key, calendar
// credentials) are POSTed straight to the backend over HTTPS and never persisted
// in the browser.

import { initData } from "./telegram";

const BASE = "/app/api";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `tma ${initData}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? safeParse(text) : undefined;

  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// --- Types mirrored from the backend ------------------------------------- */
export interface Me {
  tg_id: string;
  username: string;
  first_name: string;
  tenant_id: string;
  workspace_name: string;
  role: "host" | "member" | "guest";
  connected: boolean;
  board_resolved: boolean;
  linked: boolean;
}

export interface YougileProject {
  id: string;
  title: string;
}

export interface YougileUser {
  id: string;
  name: string;
  email: string;
}

export interface DigestTask {
  id: string;
  title: string;
  status: string;
  deadline?: string;
  overdue: boolean;
}

export interface DigestAssignee {
  full_name: string;
  tg_username: string;
  tasks: DigestTask[];
}

export interface Digest {
  digest_enabled: boolean;
  digest_time: string;
  assignees: DigestAssignee[];
  unassigned: DigestTask[];
}

export interface CalendarAccount {
  id: string;
  provider: string;
  label: string | null;
  active: boolean;
}

// --- Endpoints ------------------------------------------------------------ */
export const api = {
  me: () => request<Me>("GET", "/me"),

  // Onboarding (host).
  connectYougile: (t: string, creds: { api_key?: string; login?: string; password?: string }) =>
    request<{ status: string }>("POST", `/workspaces/${t}/credentials`, creds),
  projects: (t: string) =>
    request<{ projects: YougileProject[] }>("GET", `/workspaces/${t}/yougile-projects`),
  setProject: (t: string, projectId: string) =>
    request<unknown>("POST", `/workspaces/${t}/project`, { project_id: projectId }),
  resolveBoard: (t: string) => request<unknown>("POST", `/workspaces/${t}/board/resolve`),

  // Join (any member).
  yougileUsers: (t: string) =>
    request<{ users: YougileUser[] }>("GET", `/workspaces/${t}/yougile-users`),
  join: (t: string, yougile_user_id: string, full_name?: string) =>
    request<unknown>("POST", `/workspaces/${t}/join`, { yougile_user_id, full_name }),

  // Views (member).
  digest: (t: string) => request<Digest>("GET", `/workspaces/${t}/digest`),

  // Settings (host).
  updateDigest: (t: string, enabled: boolean, time: string) =>
    request<unknown>("PATCH", `/workspaces/${t}/digest`, { enabled, time }),
  calendarAccounts: (t: string) =>
    request<CalendarAccount[]>("GET", `/workspaces/${t}/calendar/accounts`),
  addCalendar: (t: string, provider: "google" | "yandex", credentials: object, label?: string) =>
    request<CalendarAccount>("POST", `/workspaces/${t}/calendar/accounts`, {
      provider,
      credentials,
      label,
    }),
  deleteCalendar: (t: string, id: string) =>
    request<unknown>("DELETE", `/workspaces/${t}/calendar/accounts/${id}`),
};
