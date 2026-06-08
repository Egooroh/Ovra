// src/worker/summaryWriter.ts
//
// После завершения созвона читает транскрипт из Postgres,
// просит LLM (OpenRouter) сделать краткое саммари + список задач,
// и пишет JSON-файл в ./output/{date}_{callId}.json
//
// Это граница ответственности TS-воркера: дальше файл забирает Go-разработчик.

import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { config } from "../util/config";
import { log } from "../util/log";

const OUTPUT_DIR = path.resolve(process.cwd(), "output");

// ── типы выходного файла ──────────────────────────────────────────────────────

export interface MeetingTask {
  title: string;
  assignee: string; // имя или пустая строка
  deadline: string; // ISO-8601 или пустая строка
}

export interface MeetingSummaryFile {
  call_id: string;
  title: string;
  started_at: string;  // ISO-8601
  ended_at: string;    // ISO-8601
  summary: string;     // краткий текст от Claude
  tasks: MeetingTask[];
  transcript: string;  // полный текст для Go-разработчика
}

// ── основная функция ──────────────────────────────────────────────────────────

export async function writeSummary(
  prisma: PrismaClient,
  callId: string,
  title: string | null,
  startedAt: Date,
  endedAt: Date,
): Promise<void> {
  // 1. Читаем транскрипт из Postgres
  const transcript = await prisma.transcript.findUnique({
    where: { callId },
    select: { fullText: true },
  });

  const fullText = transcript?.fullText?.trim() ?? "";
  if (!fullText) {
    log.warn({ callId }, "summaryWriter: empty transcript, skipping");
    return;
  }

  // 2. Генерируем саммари через LLM
  const { summary, tasks } = await callLlm(fullText, title ?? "");

  // 3. Формируем структуру файла
  const payload: MeetingSummaryFile = {
    call_id: callId,
    title: title ?? "",
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    summary,
    tasks,
    transcript: fullText,
  };

  // 4. Пишем файл
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const date = startedAt.toISOString().slice(0, 10); // "2026-06-05"
  const filename = `${date}_${callId}.json`;
  const filepath = path.join(OUTPUT_DIR, filename);

  await fs.writeFile(filepath, JSON.stringify(payload, null, 2), "utf8");
  log.info({ callId, filepath }, "summaryWriter: wrote meeting summary");
}

// ── OpenRouter API ────────────────────────────────────────────────────────────

interface LlmResult {
  summary: string;
  tasks: MeetingTask[];
}

async function callLlm(transcript: string, meetingTitle: string): Promise<LlmResult> {
  const { apiKey, model, baseUrl } = config.openrouter;
  if (!apiKey) {
    log.warn("summaryWriter: OPENROUTER_API_KEY not set, returning empty summary");
    return { summary: "", tasks: [] };
  }

  const prompt = `Ты — ассистент по управлению проектами.
Ниже транскрипция встречи "${meetingTitle}".

Верни ТОЛЬКО JSON-объект (без markdown-блоков, без объяснений):
{
  "summary": "3-5 предложений: о чём была встреча и главные решения",
  "tasks": [
    { "title": "...", "assignee": "имя или пустая строка", "deadline": "ISO-8601 или пустая строка" }
  ]
}

Если задач нет — "tasks": [].

Транскрипция:
${transcript}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter API ${res.status}: ${body}`);
  }

  const rawBody = await res.text();

  let envelope: { choices: Array<{ message: { content: string } }> };
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new Error(`OpenRouter: invalid JSON response: ${rawBody.slice(0, 500)}`);
  }

  const text = envelope.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error(`OpenRouter: empty content in response: ${rawBody.slice(0, 500)}`);
  }

  const clean = text.trim().replace(/^```json|^```|```$/gm, "").trim();

  let parsed: LlmResult;
  try {
    parsed = JSON.parse(clean) as LlmResult;
  } catch {
    throw new Error(`OpenRouter: model returned non-JSON: ${clean.slice(0, 500)}`);
  }
  return parsed;
}
