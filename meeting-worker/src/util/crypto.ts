// Symmetric encryption for calendar credentials stored at rest in the
// CalendarAccount table. AES-256-GCM (authenticated): tampering or a wrong key
// fails loudly on decrypt rather than yielding garbage.
//
// The key comes from CALENDAR_CRED_KEY (config.calendar.credKey) and lives ONLY
// in the environment — never in the database. Losing it means the stored
// credentials are unrecoverable, so back it up like any other secret.
//
// Serialized format (single string, safe for a TEXT column):
//   v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
// The "v1" prefix lets us rotate the scheme later without ambiguity.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config";

const SCHEME = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // standard nonce size for GCM
const KEY_BYTES = 32; // AES-256

/**
 * Parse CALENDAR_CRED_KEY into 32 raw bytes. Accepts hex (64 chars) or base64.
 * Throws a clear error if missing or the wrong length — fail fast at first use
 * rather than silently producing an unusable key.
 */
function loadKey(): Buffer {
  const raw = config.calendar.credKey;
  if (!raw) {
    throw new Error(
      "CALENDAR_CRED_KEY is not set — required to (de)crypt calendar credentials. " +
        "Generate one with: openssl rand -hex 32",
    );
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CALENDAR_CRED_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Use 64 hex chars or 32-byte base64. Generate with: openssl rand -hex 32",
    );
  }
  return key;
}

/** Encrypt a plaintext credentials blob (typically JSON) for DB storage. */
export function encryptCred(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SCHEME,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt a value produced by encryptCred. Throws on tampering or wrong key. */
export function decryptCred(serialized: string): string {
  const parts = serialized.split(":");
  if (parts.length !== 4 || parts[0] !== SCHEME) {
    throw new Error(`decryptCred: unrecognized credential format (expected "${SCHEME}:iv:tag:data")`);
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = loadKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64!, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
