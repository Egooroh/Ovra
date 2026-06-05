// Centralized config. Fail fast on missing critical vars at process start.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),

  orchestrator: {
    /** How often to scan Postgres for due calls (ms). */
    pollIntervalMs: num("ORCH_POLL_MS", 15_000),
    /** Lead time before startsAt at which we start joining (ms). */
    joinLeadMs: num("ORCH_JOIN_LEAD_MS", 60_000),
    /** Max concurrent forked workers (one Chromium each — memory bound). */
    maxConcurrentCalls: num("ORCH_MAX_CALLS", 3),
    /** A worker is considered dead if no heartbeat within this window (ms). */
    heartbeatTimeoutMs: num("ORCH_HEARTBEAT_TIMEOUT_MS", 45_000),
    /** Max relaunch attempts per call before giving up. */
    maxAttempts: num("ORCH_MAX_ATTEMPTS", 2),
  },

  worker: {
    heartbeatIntervalMs: num("WORKER_HEARTBEAT_MS", 15_000),
    /** Safety cap on call duration (ms). */
    maxCallDurationMs: num("WORKER_MAX_CALL_MS", 3 * 60 * 60 * 1000),
    /** Leave after this much continuous silence (ms). */
    silenceTimeoutMs: num("WORKER_SILENCE_MS", 5 * 60 * 1000),
  },

  audio: {
    sampleRate: num("AUDIO_SAMPLE_RATE", 16_000),
    channels: num("AUDIO_CHANNELS", 1),
  },

  speechkit: {
    apiKey: process.env.YANDEX_API_KEY ?? "",
    folderId: process.env.YANDEX_FOLDER_ID ?? "",
    endpoint: process.env.YANDEX_STT_ENDPOINT ?? "stt.api.cloud.yandex.net:443",
    lang: process.env.YANDEX_STT_LANG ?? "ru-RU",
  },

  calendar: {
    /** How often to poll calendars for new/changed events (ms). */
    pollMs: num("CALENDAR_POLL_MS", 5 * 60_000),
    /** How far ahead to look for upcoming meetings (ms). */
    lookaheadMs: num("CALENDAR_LOOKAHEAD_MS", 2 * 60 * 60_000),
    /** How far back to look (catch already-started meetings). */
    lookbackMs: num("CALENDAR_LOOKBACK_MS", 2 * 60 * 60_000),
  },
} as const;
