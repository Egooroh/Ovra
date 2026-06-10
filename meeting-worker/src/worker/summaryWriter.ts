// src/worker/summaryWriter.ts
//
// После завершения созвона читает транскрипт из Postgres,
// просит LLM (OpenRouter) сделать краткое саммари + список задач,
// и отправляет результат HTTP POST на Go-бэкенд (POST /v1/meetings/summary).
//
// Для длинных созвонов (> CHUNK_CHARS) используется map-reduce:
// транскрипт бьётся на куски, каждый суммаризируется отдельно,
// потом финальный запрос объединяет всё в одно саммари и дедублицирует задачи.

import { PrismaClient } from "@prisma/client";
import { config } from "../util/config";
import { log } from "../util/log";

// Транскрипты короче этого порога обрабатываются одним запросом.
// ~60k символов ≈ 15k токенов — комфортно для одного прохода.
const CHUNK_CHARS = 60_000;

// ── типы payload ──────────────────────────────────────────────────────────────

export interface MeetingTask {
  title: string;
  assignee: string; // имя или пустая строка
  deadline: string; // ISO-8601 или пустая строка
}

export interface MeetingSummaryPayload {
  tenant_id: string;
  call_id: string;
  title: string;
  started_at: string;  // ISO-8601
  ended_at: string;    // ISO-8601
  summary: string;
  tasks: MeetingTask[];
  transcript: string;
}

// ── основная функция ──────────────────────────────────────────────────────────

export async function writeSummary(
  prisma: PrismaClient,
  callId: string,
  organizationId: string | null,
  title: string | null,
  startedAt: Date | string,
  endedAt: Date | string,
): Promise<void> {
  // fork() serializes via JSON so Date becomes string — normalise here.
  const startDate = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const endDate = endedAt instanceof Date ? endedAt : new Date(endedAt);
  startedAt = startDate;
  endedAt = endDate;
  const transcript = await prisma.transcript.findUnique({
    where: { callId },
    select: { fullText: true },
  });

  const fullText = transcript?.fullText?.trim() ?? "";

  let summary = "";
  let tasks: MeetingTask[] = [];

  if (!fullText) {
    log.warn({ callId }, "summaryWriter: empty transcript, notifying without summary");
    summary = "Во время встречи речь не была зафиксирована.";
  } else {
    log.info({ callId, chars: fullText.length }, "summaryWriter: starting");
    const llmStart = Date.now();

    ({ summary, tasks } = fullText.length <= CHUNK_CHARS
      ? await summarizeDirect(fullText, title ?? "")
      : await summarizeChunked(fullText, title ?? ""));

    log.info({ callId, llmMs: Date.now() - llmStart, tasks: tasks.length }, "summaryWriter: llm done");
  }

  const { url, workerSecret, tenantId } = config.backend;
  if (!url) {
    log.warn({ callId }, "summaryWriter: BACKEND_URL not set, skipping push");
    return;
  }

  // Prefer the call's own tenant; fall back to the process-wide env tenant for
  // single-tenant deployments (where organizationId is null).
  const effectiveTenant = organizationId ?? tenantId;

  const payload: MeetingSummaryPayload = {
    tenant_id: effectiveTenant,
    call_id: callId,
    title: title ?? "",
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    summary,
    tasks,
    transcript: fullText,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (workerSecret) headers["Authorization"] = `Bearer ${workerSecret}`;

  const res = await fetch(`${url}/v1/meetings/summary`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`backend responded ${res.status}: ${body}`);
  }

  const result = await res.json().catch(() => ({})) as { created?: number; failures?: string[] };
  log.info({
    callId,
    created: result.created ?? 0,
    failures: result.failures?.length ?? 0,
    tasks: tasks.length,
  }, "summaryWriter: done");
}

// ── стратегии суммаризации ────────────────────────────────────────────────────

interface LlmResult {
  summary: string;
  tasks: MeetingTask[];
}

// Короткий созвон — один запрос.
async function summarizeDirect(transcript: string, title: string): Promise<LlmResult> {
  return callLlm(buildMainPrompt(transcript, title));
}

// Длинный созвон — map-reduce.
async function summarizeChunked(transcript: string, title: string): Promise<LlmResult> {
  const chunks = splitIntoChunks(transcript, CHUNK_CHARS);
  log.info({ chunks: chunks.length, totalChars: transcript.length }, "summaryWriter: chunked mode");

  // Map: суммаризируем каждый кусок параллельно
  const partials = await Promise.all(
    chunks.map((chunk, i) => {
      log.info({ chunk: i + 1, of: chunks.length }, "summaryWriter: processing chunk");
      return callLlm(buildChunkPrompt(chunk, i + 1, chunks.length, title));
    }),
  );

  // Reduce: объединяем частичные результаты в финальное саммари
  const combinedSummaries = partials.map((p, i) => `Часть ${i + 1}:\n${p.summary}`).join("\n\n");
  const allTasks = partials.flatMap((p) => p.tasks);

  return callLlm(buildReducePrompt(combinedSummaries, allTasks, title));
}

// Делим по границам слов, не разрывая их посередине.
function splitIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      // Отступаем до ближайшего пробела чтобы не резать слово
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start) end = boundary;
    }
    chunks.push(text.slice(start, end).trim());
    start = end + 1;
  }
  return chunks;
}

// ── промпты ───────────────────────────────────────────────────────────────────

function buildMainPrompt(transcript: string, title: string): string {
  return `Ты — ассистент по управлению проектами.
Ниже транскрипция встречи "${title}".

Верни ТОЛЬКО JSON-объект (без markdown-блоков, без объяснений):
{
  "summary": "Пройдись по КАЖДОЙ обсуждённой теме (по каждой команде/проекту/вопросу) отдельным пунктом: что обсудили, какие решения и замечания прозвучали. Не сжимай встречу до одного общего вывода и не описывай только концовку — сохрани все ключевые блоки обсуждения по порядку.",
  "tasks": [
    { "title": "...", "assignee": "имя или пустая строка", "deadline": "ISO-8601 или пустая строка" }
  ]
}

Если задач нет — "tasks": [].

Транскрипция:
${transcript}`;
}

function buildChunkPrompt(chunk: string, n: number, total: number, title: string): string {
  return `Ты — ассистент по управлению проектами.
Это часть ${n} из ${total} транскрипции встречи "${title}".

Извлеки из этой части ключевые моменты и задачи.
Верни ТОЛЬКО JSON-объект (без markdown-блоков, без объяснений):
{
  "summary": "2-3 предложения: что обсуждалось в этой части",
  "tasks": [
    { "title": "...", "assignee": "имя или пустая строка", "deadline": "ISO-8601 или пустая строка" }
  ]
}

Если задач нет — "tasks": [].

Транскрипция (часть ${n}/${total}):
${chunk}`;
}

function buildReducePrompt(summaries: string, tasks: MeetingTask[], title: string): string {
  return `Ты — ассистент по управлению проектами.
Встреча "${title}" была разбита на части и суммаризирована. Ниже — саммари каждой части и список всех задач.

Саммари частей:
${summaries}

Все задачи (могут быть дубликаты):
${JSON.stringify(tasks, null, 2)}

Верни ТОЛЬКО JSON-объект (без markdown-блоков, без объяснений):
{
  "summary": "Единое саммари всей встречи: пройдись по КАЖДОЙ обсуждённой теме (по каждой команде/проекту/вопросу) отдельным пунктом, сохраняя порядок частей. Не сжимай встречу до одного общего вывода и не описывай только концовку — сохрани все ключевые блоки обсуждения и главные решения.",
  "tasks": [
    { "title": "...", "assignee": "имя или пустая строка", "deadline": "ISO-8601 или пустая строка" }
  ]
}

Дедублицируй задачи: если одна и та же задача встречается несколько раз — оставь одну.`;
}

// ── OpenRouter API ────────────────────────────────────────────────────────────

// Semaphore: caps simultaneous LLM requests so bursts of parallel map-reduce
// chunks don't exhaust the OpenRouter rate limit.
class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.slots = Math.max(1, concurrency);
  }

  async acquire(): Promise<void> {
    if (this.slots > 0) { this.slots--; return; }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.slots++; }
  }
}

const llmSemaphore = new Semaphore(config.openrouter.concurrency);

const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

async function callLlm(prompt: string): Promise<LlmResult> {
  const { apiKey, model, baseUrl } = config.openrouter;
  if (!apiKey) {
    log.warn("summaryWriter: OPENROUTER_API_KEY not set, returning empty summary");
    return { summary: "", tasks: [] };
  }

  let lastError: Error = new Error("no attempts made");

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      log.warn({ attempt, delay }, "summaryWriter: retrying LLM call");
      await new Promise((r) => setTimeout(r, delay));
    }

    await llmSemaphore.acquire();
    try {
      return await callLlmOnce(prompt, baseUrl, apiKey, model);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn({ attempt: attempt + 1, err: lastError.message }, "summaryWriter: LLM attempt failed");
    } finally {
      llmSemaphore.release();
    }
  }

  throw lastError;
}

async function callLlmOnce(prompt: string, baseUrl: string, apiKey: string, model: string): Promise<LlmResult> {
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
