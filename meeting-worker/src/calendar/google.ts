// Google Calendar provider.
//
// Auth: service account JSON key (file path or inline JSON in env var).
// The team admin needs to share each calendar with the service account email
// (read-only is enough).
//
// Required env vars:
//   GOOGLE_SA_JSON  — path to the key file OR the raw JSON string itself
//   GOOGLE_CALENDAR_IDS — comma-separated list of calendar IDs
//               e.g. "primary,team@group.calendar.google.com"

import { google } from "googleapis";
import type { CalendarProvider, CalendarEvent } from "./provider";
import { extractFromFields } from "./extract";
import { log } from "../util/log";

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";

  private readonly calendarIds: string[];

  constructor(calendarIds: string[]) {
    if (calendarIds.length === 0) throw new Error("GoogleCalendarProvider: no calendar IDs");
    this.calendarIds = calendarIds;
  }

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const auth = await this.buildAuth();
    const cal = google.calendar({ version: "v3", auth });
    const results: CalendarEvent[] = [];

    for (const calId of this.calendarIds) {
      try {
        const res = await cal.events.list({
          calendarId: calId,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,      // expand recurring events
          orderBy: "startTime",
          maxResults: 50,
        });

        for (const event of res.data.items ?? []) {
          if (!event.id) continue;

          const joinUrl = extractFromFields(
            event.location,
            event.description,
            event.summary,
          );
          if (!joinUrl) continue;

          const startRaw = event.start?.dateTime ?? event.start?.date;
          const endRaw = event.end?.dateTime ?? event.end?.date;
          if (!startRaw) continue;

          results.push({
            id: `google:${calId}:${event.id}`,
            title: event.summary ?? "Без названия",
            startAt: new Date(startRaw),
            endAt: endRaw ? new Date(endRaw) : null,
            joinUrl,
          });
        }
      } catch (err) {
        log.error({ calId, err: String(err) }, "google.calendar.fetch_error");
      }
    }

    return results;
  }

  private async buildAuth() {
    const raw = process.env.GOOGLE_SA_JSON;
    if (!raw) throw new Error("GOOGLE_SA_JSON is not set");

    // Support both: path to JSON file and inline JSON string
    let keyFileOrJson: string | object;
    if (raw.trim().startsWith("{")) {
      keyFileOrJson = JSON.parse(raw);
    } else {
      keyFileOrJson = raw; // treat as file path
    }

    const auth = new google.auth.GoogleAuth({
      ...(typeof keyFileOrJson === "string"
        ? { keyFile: keyFileOrJson }
        : { credentials: keyFileOrJson as never }),
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    return auth;
  }
}

/** Returns null if not configured, so the factory can skip it gracefully. */
export function buildGoogleProvider(): GoogleCalendarProvider | null {
  const json = process.env.GOOGLE_SA_JSON;
  const ids = process.env.GOOGLE_CALENDAR_IDS;
  if (!json || !ids) return null;
  return new GoogleCalendarProvider(ids.split(",").map((s) => s.trim()).filter(Boolean));
}
