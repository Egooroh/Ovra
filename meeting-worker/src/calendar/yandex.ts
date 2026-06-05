import { sync as icalSync } from "node-ical";
import type { VEvent } from "node-ical";
import type { CalendarProvider, CalendarEvent } from "./provider";
import { extractFromFields, toString } from "./extract";
import { log } from "../util/log";

const CALDAV_BASE = "https://caldav.yandex.ru";

function basicAuth(u: string, p: string): string {
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

function fmtDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function propfind(url: string, auth: string, depth: "0" | "1", body: string): Promise<string> {
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: { Authorization: auth, "Content-Type": "application/xml; charset=utf-8", Depth: depth },
    body,
  });
  if (res.status === 401) throw new Error("401 Unauthorized — check YANDEX_CALDAV_PASSWORD (must be app-password)");
  if (!res.ok) throw new Error(`PROPFIND ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

function xmlValue(xml: string, ...tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const re = new RegExp(`<[a-zA-Z]*:?${tag}[^>]*>\\s*([^<]+)\\s*<\\/[a-zA-Z]*:?${tag}>`, "i");
    const m = xml.match(re);
    if (m) return m[1]!.trim();
    const blockRe = new RegExp(`<[a-zA-Z]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[a-zA-Z]*:?${tag}>`, "i");
    const block = xml.match(blockRe);
    if (block) {
      const href = block[1]!.match(/<[a-zA-Z]*:?href[^>]*>\s*([^<]+)\s*<\/[a-zA-Z]*:?href>/i);
      if (href) return href[1]!.trim();
    }
  }
  return null;
}

/**
 * Extract calendar collection hrefs from a PROPFIND Depth:1 response.
 * Strategy: take ALL hrefs that are sub-paths of calendarHome,
 * skipping the home itself. Yandex uses URL-encoded @ in paths.
 */
function extractCalendarHrefs(xml: string, calendarHome: string): string[] {
  const seen = new Set<string>();
  const homePath = calendarHome.replace(/^https?:\/\/[^/]+/, "");

  // Split into per-<response> blocks and only keep those with <C:calendar/>
  // resourcetype — this filters out inbox/outbox/todos/schedule collections.
  const responseRe = /<D:response>([\s\S]*?)<\/D:response>/g;
  let block: RegExpExecArray | null;
  while ((block = responseRe.exec(xml)) !== null) {
    const content = block[1]!;

    // Must have a caldav:calendar resourcetype (not just collection/inbox/outbox)
    if (!/C:calendar|caldav.*:calendar|urn:ietf:params:xml:ns:caldav.*calendar/i.test(content)) continue;
    // Skip scheduling collections (inbox/outbox)
    if (/schedule-inbox|schedule-outbox/i.test(content)) continue;
    // Skip todo/tasks collections
    if (/todos?-|vtodo/i.test(content)) continue;

    const hrefMatch = content.match(/<[a-zA-Z]*:?href[^>]*>([^<\s]+)<\/[a-zA-Z]*:?href>/);
    if (!hrefMatch) continue;

    const raw = hrefMatch[1]!.trim();
    const decoded = decodeURIComponent(raw);
    const decodedHome = decodeURIComponent(homePath);

    if (
      (decoded.startsWith(decodedHome) && decoded.length > decodedHome.length) ||
      (raw.startsWith(homePath) && raw.length > homePath.length)
    ) {
      seen.add(raw);
    }
  }
  return [...seen];
}

function extractIcalBlocks(xml: string): string[] {
  const results: string[] = [];
  const re = /<[^:>\s]*:?calendar-data[^>]*>([\s\S]*?)<\/[^:>\s]*:?calendar-data>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const data = m[1]!.trim();
    if (data.startsWith("BEGIN:VCALENDAR")) results.push(data);
  }
  return results;
}

function buildReportXml(from: Date, to: Date): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${fmtDate(from)}" end="${fmtDate(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

export class YandexCalendarProvider implements CalendarProvider {
  readonly name = "yandex";

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const username = process.env.YANDEX_CALDAV_USERNAME ?? "";
    const password = process.env.YANDEX_CALDAV_PASSWORD ?? "";
    const auth = basicAuth(username, password);

    // Step 1: current-user-principal
    let principalUrl: string;
    try {
      const xml = await propfind(`${CALDAV_BASE}/`, auth, "0",
        `<?xml version="1.0" encoding="UTF-8"?>
<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`);
      const href = xmlValue(xml, "current-user-principal");
      if (!href) throw new Error("current-user-principal not found");
      principalUrl = href.startsWith("http") ? href : `${CALDAV_BASE}${href}`;
      log.info({ principalUrl }, "yandex.caldav.principal_found");
    } catch (err) {
      log.error({ err: String(err) }, "yandex.caldav.principal_error");
      return [];
    }

    // Step 2: calendar-home-set
    let calendarHome: string;
    try {
      const xml = await propfind(principalUrl, auth, "0",
        `<?xml version="1.0" encoding="UTF-8"?>
<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <prop><c:calendar-home-set/></prop>
</propfind>`);
      const href = xmlValue(xml, "calendar-home-set");
      if (!href) throw new Error("calendar-home-set not found");
      calendarHome = href.startsWith("http") ? href : `${CALDAV_BASE}${href}`;
      log.info({ calendarHome }, "yandex.caldav.home_found");
    } catch (err) {
      log.error({ err: String(err) }, "yandex.caldav.homeset_error");
      return [];
    }

    // Step 3: list calendar collections (Depth:1)
    let calendarHrefs: string[] = [];
    try {
      const xml = await propfind(calendarHome, auth, "1",
        `<?xml version="1.0" encoding="UTF-8"?>
<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <prop><resourcetype/><displayname/></prop>
</propfind>`);

      calendarHrefs = extractCalendarHrefs(xml, calendarHome);
      log.info({ count: calendarHrefs.length, hrefs: calendarHrefs }, "yandex.caldav.calendars_found");

      // If still nothing found, fall back to trying the default Yandex calendar paths
      if (calendarHrefs.length === 0) {
        const homePath = calendarHome.replace(/^https?:\/\/[^/]+/, "");
        calendarHrefs = [
          `${homePath}events-v2/`,
          `${homePath}events/`,
        ];
        log.warn({ fallback: calendarHrefs }, "yandex.caldav.using_fallback_hrefs");
      }
    } catch (err) {
      log.error({ err: String(err) }, "yandex.caldav.list_error");
      return [];
    }

    // Step 4: fetch events from each calendar
    const results: CalendarEvent[] = [];

    for (const href of calendarHrefs) {
      const url = href.startsWith("http") ? href : `${CALDAV_BASE}${href}`;
      try {
        const res = await fetch(url, {
          method: "REPORT",
          headers: { Authorization: auth, "Content-Type": "application/xml; charset=utf-8", Depth: "1" },
          body: buildReportXml(from, to),
        });

        if (!res.ok) {
          log.warn({ href, status: res.status }, "yandex.caldav.report_skipped");
          continue;
        }

        const xml = await res.text();
        for (const icalStr of extractIcalBlocks(xml)) {
          let parsed: Record<string, unknown>;
          try { parsed = icalSync.parseICS(icalStr); } catch { continue; }

          for (const component of Object.values(parsed)) {
            if (!component || (component as { type?: string }).type !== "VEVENT") continue;
            const event = component as VEvent;
            const start = event.start instanceof Date ? event.start : new Date(event.start as string);
            if (isNaN(start.getTime()) || start < from || start > to) continue;
            const joinUrl = extractFromFields(event.location, event.description, event.summary);
            if (!joinUrl) continue;
            results.push({
              id: `yandex:${event.uid}`,
              title: toString(event.summary) || "Без названия",
              startAt: start,
              endAt: event.end instanceof Date ? event.end : null,
              joinUrl,
            });
          }
        }
      } catch (err) {
        log.error({ href, err: String(err) }, "yandex.caldav.report_error");
      }
    }

    return results;
  }
}

export function buildYandexProvider(): YandexCalendarProvider | null {
  const u = process.env.YANDEX_CALDAV_USERNAME;
  const p = process.env.YANDEX_CALDAV_PASSWORD;
  if (!u || !p) return null;
  return new YandexCalendarProvider();
}