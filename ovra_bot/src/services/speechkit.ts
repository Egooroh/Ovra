// src/services/speechkit.ts
// Yandex SpeechKit synchronous REST recognition for short audio (≤ 60 sec).
// Telegram voice messages are OGG/Opus at 48 kHz — a perfect fit for this API.
// Set YANDEX_SPEECHKIT_API_KEY in .env to enable; without it the function returns null silently.

const SPEECHKIT_API_KEY = process.env.YANDEX_API_KEY ?? '';
const SPEECHKIT_FOLDER_ID = process.env.YANDEX_FOLDER_ID ?? '';
const SPEECHKIT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';

export async function transcribeOgg(buffer: Buffer): Promise<string | null> {
    if (!SPEECHKIT_API_KEY) {
        console.warn('[speechkit] YANDEX_API_KEY not set — voice messages are skipped');
        return null;
    }

    const url = new URL(SPEECHKIT_URL);
    url.searchParams.set('lang', 'ru-RU');
    url.searchParams.set('format', 'oggopus');
    url.searchParams.set('sampleRateHertz', '48000');
    if (SPEECHKIT_FOLDER_ID) url.searchParams.set('folderId', SPEECHKIT_FOLDER_ID);

    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Authorization': `Api-Key ${SPEECHKIT_API_KEY}`,
                'Content-Type': 'application/octet-stream',
            },
            body: buffer,
            signal: AbortSignal.timeout(30_000),
        });
    } catch (e) {
        console.error('[speechkit] fetch error:', e);
        return null;
    }

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[speechkit] HTTP ${resp.status}: ${body}`);
        return null;
    }

    const data = await resp.json() as { result?: string };
    return data.result?.trim() || null;
}
