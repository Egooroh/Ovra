// Streams 16-bit PCM to Yandex SpeechKit v3 over gRPC.
// Each unique speaker gets its own bidirectional gRPC session (created lazily
// on the first push for that speaker) so transcripts are labeled per-person.
// If YANDEX_API_KEY is not set every call is a no-op.

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import type { Transcriber, Segment } from "../deps";
import { config } from "../../util/config";
import { log } from "../../util/log";

const PROTO_PATH = path.resolve(__dirname, "../../../proto/stt_v3.proto");

const pkgDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
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
  speechkit: { stt: { v3: { Recognizer: RecognizerCtor } } };
};
const Recognizer = proto.speechkit.stt.v3.Recognizer;

interface SttAlternative {
  text?: string;
  startTimeMs?: number;
  endTimeMs?: number;
}
interface SttAlternativeUpdate { alternatives?: SttAlternative[] }
interface SttResponse {
  partial?: SttAlternativeUpdate;
  final?: SttAlternativeUpdate;
  finalRefinement?: { finalIndex?: number; normalizedText?: SttAlternativeUpdate };
}

// ---------------------------------------------------------------------------

class SpeakerSession {
  private client: InstanceType<RecognizerCtor>;
  private stream: DuplexStream;
  private active = true;

  constructor(
    private readonly speaker: string | undefined,
    private readonly onSeg: (seg: Segment) => void,
  ) {
    this.client = new Recognizer(config.speechkit.endpoint, grpc.credentials.createSsl());

    const meta = new grpc.Metadata();
    meta.set("authorization", `Api-Key ${config.speechkit.apiKey}`);
    if (config.speechkit.folderId) meta.set("x-folder-id", config.speechkit.folderId);

    this.stream = this.client.recognizeStreaming(meta);

    const stream = this.stream;
    stream.on("data", (resp: SttResponse) => this.onResponse(resp));
    stream.on("error", (err: grpc.ServiceError) => {
      log.warn({ code: err.code, msg: err.message, speaker }, "speechkit.session_error");
      this.active = false;
    });
    stream.on("end", () => { this.active = false; });

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
          languageRestriction: [{
            restrictionType: "WHITELIST",
            languageCode: [config.speechkit.lang],
          }],
        },
        textNormalization: { textNormalization: "TEXT_NORMALIZATION_ENABLED" },
      },
    });

    log.info({ speaker, endpoint: config.speechkit.endpoint }, "speechkit.session_opened");
  }

  push(pcm: Buffer): void {
    if (!this.active) return;
    this.stream.write({ chunk: { data: pcm } });
  }

  close(): Promise<void> {
    this.active = false;
    this.stream.end();
    // Wait for the server to flush and close its side (sends remaining
    // final_refinement responses) before tearing down the channel.
    // Cap at 4 s so a hung stream doesn't block shutdown indefinitely.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.client.close();
        log.info({ speaker: this.speaker }, "speechkit.session_closed");
        resolve();
      }, 4000);
      this.stream.once("end", () => {
        clearTimeout(timer);
        this.client.close();
        log.info({ speaker: this.speaker }, "speechkit.session_closed");
        resolve();
      });
    });
  }

  private onResponse(resp: SttResponse): void {
    // SpeechKit emits, per utterance: live `partial`s, then a raw `final`,
    // then a `final_refinement` (normalized numbers + capitalization).
    // Treat only the refinement as the authoritative final segment so we
    // persist each utterance once with the best text; `final` is logged but
    // not persisted to avoid duplicates.
    const refinement = resp.finalRefinement?.normalizedText;
    const update = resp.partial ?? resp.final ?? refinement;
    if (!update) return;
    const alt = update.alternatives?.[0];
    const text = alt?.text?.trim();
    if (!text) return;

    const isFinal = refinement !== undefined;
    if (!isFinal) { log.debug({ text, speaker: this.speaker }, "speechkit.partial"); return; }

    const seg: Segment = {
      startMs: alt?.startTimeMs ?? 0,
      endMs: alt?.endTimeMs ?? 0,
      text,
      isFinal: true,
      speaker: this.speaker,
    };
    log.info({ text, speaker: this.speaker, startMs: seg.startMs }, "speechkit.segment");
    this.onSeg(seg);
  }
}

// ---------------------------------------------------------------------------

export class SpeechKitTranscriber implements Transcriber {
  private sessions = new Map<string, SpeakerSession>();
  private callbacks: Array<(seg: Segment) => void> = [];
  private running = false;

  async start(): Promise<void> {
    if (!config.speechkit.apiKey) {
      log.warn("speechkit.no_api_key — transcription disabled");
      return;
    }
    this.running = true;
    log.info("speechkit.transcriber_started");
  }

  push(pcm: Buffer, speaker?: string): void {
    if (!this.running) return;
    const key = speaker ?? "__default__";
    let session = this.sessions.get(key);
    if (!session) {
      session = new SpeakerSession(speaker, (seg) => {
        for (const cb of this.callbacks) cb(seg);
      });
      this.sessions.set(key, session);
    }
    session.push(pcm);
  }

  onSegment(cb: (seg: Segment) => void): void {
    this.callbacks.push(cb);
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    log.info("speechkit.transcriber_stopped");
  }
}
