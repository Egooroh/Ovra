// Streams 16-bit PCM to Yandex SpeechKit v3 over gRPC and emits segments.
// If YANDEX_API_KEY is not set, start() becomes a no-op and push() is ignored,
// so the worker runs in dev without a real SpeechKit subscription.

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import type { Transcriber, Segment } from "../deps";
import { config } from "../../util/config";
import { log } from "../../util/log";

// proto/ sits at the package root, one level above src/ and dist/.
// __dirname is always 3 levels deep: {src|dist}/worker/transcriber/
const PROTO_PATH = path.resolve(__dirname, "../../../proto/stt_v3.proto");

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,   // snake_case → camelCase in JS objects
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});

type DuplexStream = grpc.ClientDuplexStream<unknown, unknown>;
type RecognizerCtor = new (
  host: string,
  creds: grpc.ChannelCredentials,
) => { recognizeStreaming(meta: grpc.Metadata): DuplexStream; close(): void };

const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
  yandex: { cloud: { ai: { stt: { v3: { Recognizer: RecognizerCtor } } } } };
};
const Recognizer = proto.yandex.cloud.ai.stt.v3.Recognizer;

// Typings for the response shape after camelCase conversion.
interface SttAlternative {
  text?: string;
  audioTimeBoundaries?: { startTimeMs?: number; endTimeMs?: number };
}
interface SttAlternativeUpdate {
  alternatives?: SttAlternative[];
}
interface SttResponse {
  partial?: SttAlternativeUpdate;
  final?: SttAlternativeUpdate;
  finalRefinement?: SttAlternativeUpdate;
}

export class SpeechKitTranscriber implements Transcriber {
  private client?: InstanceType<RecognizerCtor>;
  private stream?: DuplexStream;
  private callbacks: Array<(seg: Segment) => void> = [];
  private active = false;

  async start(): Promise<void> {
    if (!config.speechkit.apiKey) {
      log.warn("speechkit.no_api_key — transcription disabled");
      return;
    }

    this.active = true;
    this.client = new Recognizer(config.speechkit.endpoint, grpc.credentials.createSsl());

    const meta = new grpc.Metadata();
    meta.set("authorization", `Api-Key ${config.speechkit.apiKey}`);
    if (config.speechkit.folderId) {
      meta.set("x-folder-id", config.speechkit.folderId);
    }

    this.stream = this.client.recognizeStreaming(meta);

    const stream = this.stream;
    stream.on("data", (resp: SttResponse) => this.onResponse(resp));

    stream.on("error", (err: grpc.ServiceError) => {
      log.warn({ code: err.code, msg: err.message }, "speechkit.stream_error");
      this.active = false;
    });

    stream.on("end", () => {
      log.info("speechkit.stream_ended");
      this.active = false;
    });

    // First message: session options (must arrive before any audio chunk).
    stream.write({
      sessionOptions: {
        recognitionModel: {
          model: "general",
          audioFormat: {
            rawAudio: {
              audioEncoding: "LINEAR16_PCM",
              sampleRateHertz: config.audio.sampleRate,
              audioChannelCount: config.audio.channels,
            },
          },
          // repeated field — send as single-element array
          languageRestriction: [
            {
              restrictionType: "WHITELIST",
              languageCode: [config.speechkit.lang],
            },
          ],
        },
        textNormalization: {
          textNormalization: "TEXT_NORMALIZATION_ENABLED",
        },
      },
    });

    log.info({ endpoint: config.speechkit.endpoint, lang: config.speechkit.lang }, "speechkit.started");
  }

  push(pcm: Buffer): void {
    if (!this.stream || !this.active) return;
    this.stream.write({ chunk: { data: pcm } });
  }

  onSegment(cb: (seg: Segment) => void): void {
    this.callbacks.push(cb);
  }

  async stop(): Promise<void> {
    this.active = false;
    this.stream?.end();
    this.stream = undefined;
    this.client?.close();
    this.client = undefined;
    log.info("speechkit.stopped");
  }

  private onResponse(resp: SttResponse): void {
    const update = resp.partial ?? resp.final ?? resp.finalRefinement;
    if (!update) return;

    const isFinal = resp.final !== undefined || resp.finalRefinement !== undefined;
    const alt = update.alternatives?.[0];
    const text = alt?.text?.trim();
    if (!text) return;

    if (!isFinal) {
      log.debug({ text }, "speechkit.partial");
      return;
    }

    const seg: Segment = {
      startMs: alt?.audioTimeBoundaries?.startTimeMs ?? 0,
      endMs: alt?.audioTimeBoundaries?.endTimeMs ?? 0,
      text,
      isFinal: true,
    };
    log.info({ text: seg.text, startMs: seg.startMs, endMs: seg.endMs }, "speechkit.segment");
    for (const cb of this.callbacks) cb(seg);
  }
}
