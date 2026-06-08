// HTTP management API for the meeting-worker.
//
// Routes (all protected by Authorization: Bearer <WORKER_SECRET>):
//   POST   /v1/calendar/accounts        — register a calendar account (google/yandex)
//   GET    /v1/calendar/accounts?org=   — list accounts, optionally filtered by org
//   DELETE /v1/calendar/accounts/:id    — deactivate an account (soft-delete)
//   POST   /v1/calls                    — schedule an ad-hoc call from a Telemost link

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { prisma } from "../db/prisma";
import { encryptCred } from "../util/crypto";
import { config } from "../util/config";
import { log } from "../util/log";

// ---- auth ----

function authorized(req: IncomingMessage): boolean {
  const secret = config.backend.workerSecret;
  if (!secret) return true; // dev mode: no secret set
  const header = req.headers["authorization"] ?? "";
  const got = header.replace(/^Bearer\s+/i, "");
  return got === secret;
}

// ---- request helpers ----

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk: string) => { buf += chunk; });
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(new Error("request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---- handlers ----

async function createAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = (await readBody(req)) as Record<string, unknown>; }
  catch (e) { send(res, 400, { error: String(e) }); return; }

  const { organizationId, provider, label, credentials, calendarIds } = body;

  if (!organizationId || !provider || !credentials) {
    send(res, 400, { error: "organizationId, provider, and credentials are required" });
    return;
  }
  if (provider !== "google" && provider !== "yandex") {
    send(res, 400, { error: 'provider must be "google" or "yandex"' });
    return;
  }

  const encrypted = encryptCred(JSON.stringify(credentials));
  const account = await prisma.calendarAccount.create({
    data: {
      organizationId: organizationId as string,
      provider: provider as string,
      label: (label as string | undefined) ?? null,
      credentials: encrypted,
      calendarIds: Array.isArray(calendarIds) ? (calendarIds as string[]) : [],
      active: true,
    },
  });

  log.info({ id: account.id, org: organizationId, provider }, "api.calendar_account.created");
  send(res, 201, {
    id: account.id,
    organizationId: account.organizationId,
    provider: account.provider,
    label: account.label,
    active: account.active,
  });
}

async function listAccounts(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://host");
  const org = url.searchParams.get("org");

  const accounts = await prisma.calendarAccount.findMany({
    where: org ? { organizationId: org } : {},
    select: {
      id: true,
      organizationId: true,
      provider: true,
      label: true,
      active: true,
      calendarIds: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  send(res, 200, accounts);
}

async function deactivateAccount(res: ServerResponse, id: string): Promise<void> {
  const existing = await prisma.calendarAccount.findUnique({ where: { id }, select: { id: true } });
  if (!existing) { send(res, 404, { error: "calendar account not found" }); return; }

  await prisma.calendarAccount.update({ where: { id }, data: { active: false } });
  log.info({ id }, "api.calendar_account.deactivated");
  send(res, 200, { id, active: false });
}

async function scheduleCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try { body = (await readBody(req)) as Record<string, unknown>; }
  catch (e) { send(res, 400, { error: String(e) }); return; }

  const { joinUrl, title, organizationId, startsAt, endsAt } = body;

  if (!joinUrl) { send(res, 400, { error: "joinUrl is required" }); return; }

  // Deduplicate: same active Telemost link must never have two scheduled rows.
  const existing = await prisma.call.findFirst({
    where: {
      joinUrl: joinUrl as string,
      status: { notIn: ["DONE", "FAILED", "CANCELLED"] },
    },
    select: { id: true },
  });
  if (existing) {
    send(res, 200, { id: existing.id, duplicate: true });
    return;
  }

  const now = new Date();
  const call = await prisma.call.create({
    data: {
      // sourceId must be unique; manual calls get a time+random key so they
      // never collide with calendar-sourced ids (which use the calendar event id).
      sourceId: `manual:${now.getTime()}:${Math.random().toString(36).slice(2, 9)}`,
      joinUrl: joinUrl as string,
      title: (title as string | undefined) ?? null,
      organizationId: (organizationId as string | undefined) ?? null,
      startsAt: startsAt ? new Date(startsAt as string) : now,
      endsAt: endsAt ? new Date(endsAt as string) : null,
      status: "SCHEDULED",
    },
  });

  log.info({ id: call.id, org: organizationId, joinUrl }, "api.call.scheduled");
  send(res, 201, { id: call.id });
}

// ---- routing ----

type RouteHandler = (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<void>;

const routes: Array<[string, RegExp, RouteHandler]> = [
  ["POST",   /^\/v1\/calendar\/accounts$/,           (req, res) => createAccount(req, res)],
  ["GET",    /^\/v1\/calendar\/accounts/,             (req, res) => listAccounts(req, res)],
  ["DELETE", /^\/v1\/calendar\/accounts\/([^/]+)$/,   (_req, res, m) => deactivateAccount(res, m[1]!)],
  ["POST",   /^\/v1\/calls$/,                         (req, res) => scheduleCall(req, res)],
];

// ---- server factory ----

export function createApiServer(): Server {
  return createServer(async (req, res) => {
    if (!authorized(req)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    const path = (req.url ?? "/").split("?")[0]!;

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const m = pattern.exec(path);
      if (!m) continue;
      try {
        await handler(req, res, m);
      } catch (err) {
        log.error({ err: String(err), method, path }, "api.handler_error");
        send(res, 500, { error: "internal error" });
      }
      return;
    }

    send(res, 404, { error: "not found" });
  });
}
