// Entry point for the calendar subsystem.
// Reads env vars and builds only the providers that are configured.
// If nothing is configured → watcher starts but logs a warning and stays idle.
//
// Also exposes a CLI entry point for `npm run calendar:once` (one-shot poll).

import { prisma } from "../db/prisma";
import { CalendarWatcher } from "./watcher";
import { buildGoogleProvider } from "./google";
import { buildYandexProvider } from "./yandex";
import { log } from "../util/log";
import type { CalendarProvider } from "./provider";

export function buildCalendarWatcher(): CalendarWatcher {
  const providers: CalendarProvider[] = [];

  const google = buildGoogleProvider();
  if (google) {
    providers.push(google);
    log.info("calendar: Google Calendar provider enabled");
  }

  const yandex = buildYandexProvider();
  if (yandex) {
    providers.push(yandex);
    log.info("calendar: Yandex Calendar provider enabled");
  }

  if (providers.length === 0) {
    log.warn(
      "calendar: no providers configured. " +
      "Set GOOGLE_SA_JSON + GOOGLE_CALENDAR_IDS for Google " +
      "or YANDEX_CALDAV_USERNAME + YANDEX_CALDAV_PASSWORD for Yandex.",
    );
  }

  return new CalendarWatcher(prisma, providers);
}

// ---- CLI: run a single poll and exit (useful for testing) ----
if (require.main === module) {
  const arg = process.argv[2];
  if (arg !== "--once") {
    console.error("Usage: ts-node src/calendar/index.ts --once");
    process.exit(1);
  }

  const watcher = buildCalendarWatcher();
  // Start + wait one poll cycle, then exit.
  // CalendarWatcher.start() fires the first poll immediately via void this.poll(),
  // but we need to wait for it to finish. Use a one-off internal call instead.
  (async () => {
    // Access the private poll through a cast — only for the CLI runner.
    await (watcher as unknown as { poll: () => Promise<void> }).poll();
    log.info("calendar.once: poll complete");
    await prisma.$disconnect();
    process.exit(0);
  })().catch((e) => {
    log.error({ err: String(e) }, "calendar.once: fatal");
    process.exit(1);
  });
}

export { CalendarWatcher };
export type { CalendarProvider, CalendarEvent } from "./provider";
