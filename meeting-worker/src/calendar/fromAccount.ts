// Builds a CalendarProvider from a stored, encrypted CalendarAccount row.
//
// The credentials column holds AES-256-GCM ciphertext of a provider-specific
// JSON blob (see CalendarCreds below). We decrypt it here, at the boundary,
// so plaintext secrets never live longer than one provider build.

import type { CalendarProvider } from "./provider";
import { GoogleCalendarProvider } from "./google";
import { YandexCalendarProvider } from "./yandex";
import { decryptCred } from "../util/crypto";

/** Shape of the encrypted credentials blob, by provider. */
export interface GoogleCreds {
  /** Service-account key: inline JSON string or a file path. */
  saJson: string;
}
export interface YandexCreds {
  username: string;
  /** App-password (not the account password). */
  password: string;
}

/** The CalendarAccount fields this module needs (decoupled from Prisma's type). */
export interface AccountRow {
  id: string;
  organizationId: string;
  provider: string;
  label: string | null;
  credentials: string;
  calendarIds: string[];
}

/**
 * Decrypt + instantiate the right provider. Throws on an unknown provider,
 * a bad key, or malformed credentials — callers should catch per-account so
 * one broken row never sinks the whole poll.
 */
export function buildProviderFromAccount(account: AccountRow): CalendarProvider {
  const raw = decryptCred(account.credentials);

  let creds: unknown;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error(`CalendarAccount ${account.id}: credentials are not valid JSON after decrypt`);
  }

  switch (account.provider) {
    case "google": {
      const { saJson } = creds as GoogleCreds;
      if (!saJson) throw new Error(`CalendarAccount ${account.id}: missing google saJson`);
      return new GoogleCalendarProvider(account.calendarIds, saJson);
    }
    case "yandex": {
      const { username, password } = creds as YandexCreds;
      if (!username || !password) {
        throw new Error(`CalendarAccount ${account.id}: missing yandex username/password`);
      }
      return new YandexCalendarProvider(username, password);
    }
    default:
      throw new Error(`CalendarAccount ${account.id}: unknown provider "${account.provider}"`);
  }
}
