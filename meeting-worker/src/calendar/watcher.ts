// CalendarWatcher — runs inside the orchestrator process.
//
// Every CALENDAR_POLL_MS it asks all configured providers for upcoming events.
// Events with a Telemost link are upserted into the Call table as SCHEDULED.
// Events that disappear from the calendar (cancelled/deleted) are marked CANCELLED
// in the DB — but only if they're still SCHEDULED (not already in progress).

import type { PrismaClient } from "@prisma/client";
import type { CalendarProvider, CalendarEvent } from "./provider";
import { config } from "../util/config";
import { log } from "../util/log";

export class CalendarWatcher {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly providers: CalendarProvider[],
  ) {}

  start(): void {
    if (this.providers.length === 0) {
      log.warn("calendar.watcher: no providers configured — watcher inactive");
      return;
    }
    log.info(
      { providers: this.providers.map((p) => p.name) },
      "calendar.watcher.started",
    );
    void this.poll(); // first poll immediately, don't wait for interval
    this.timer = setInterval(
      () => void this.poll(),
      config.calendar.pollMs,
    );
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    // Look slightly into the past so we don't miss meetings that just started.
    const from = new Date(Date.now() - 5 * 60_000);
    const to = new Date(Date.now() + config.calendar.lookaheadMs);

    const discovered: CalendarEvent[] = [];

    // Query all providers in parallel; one failing doesn't stop the others.
    const settled = await Promise.allSettled(
      this.providers.map((p) => p.fetchEvents(from, to)),
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      const providerName = this.providers[i]!.name;
      if (result.status === "fulfilled") {
        log.info(
          { provider: providerName, found: result.value.length },
          "calendar.poll.ok",
        );
        discovered.push(...result.value);
      } else {
        log.error(
          { provider: providerName, err: String(result.reason) },
          "calendar.poll.error",
        );
      }
    }

    // Upsert all found events into the DB.
    await Promise.allSettled(discovered.map((e) => this.upsert(e)));

    // Mark as CANCELLED any SCHEDULED calls in the window that are no longer
    // in any calendar (event was deleted or moved outside the window).
    await this.cancelDeleted(discovered, from, to);
  }

  private async upsert(event: CalendarEvent): Promise<void> {
    try {
      const existing = await this.prisma.call.findUnique({
        where: { sourceId: event.id },
        select: { id: true, status: true },
      });

      if (!existing) {
        // Deduplicate by joinUrl: same Telemost link may appear in both
        // Google and Yandex calendars. Skip if a non-terminal Call already
        // exists for this URL so we don't spawn two workers for one room.
        const sameUrl = await this.prisma.call.findFirst({
          where: {
            joinUrl: event.joinUrl,
            status: { notIn: ["DONE", "FAILED", "CANCELLED"] },
          },
          select: { id: true, sourceId: true },
        });

        if (sameUrl) {
          log.info(
            { sourceId: event.id, existingId: sameUrl.id, joinUrl: event.joinUrl },
            "calendar.call.skipped_duplicate_url",
          );
          return;
        }

        await this.prisma.call.create({
          data: {
            sourceId: event.id,
            joinUrl: event.joinUrl,
            title: event.title,
            startsAt: event.startAt,
            endsAt: event.endAt,
            status: "SCHEDULED",
          },
        });
        log.info(
          { sourceId: event.id, title: event.title, startsAt: event.startAt },
          "calendar.call.created",
        );
        return;
      }

      // Only update timing/URL if the call hasn't been picked up yet.
      // Once CLAIMED or beyond, the worker owns the row.
      if (existing.status === "SCHEDULED") {
        await this.prisma.call.update({
          where: { sourceId: event.id },
          data: {
            joinUrl: event.joinUrl,
            title: event.title,
            startsAt: event.startAt,
            endsAt: event.endAt,
          },
        });
        log.info(
          { sourceId: event.id },
          "calendar.call.updated",
        );
      }
    } catch (err) {
      log.error({ sourceId: event.id, err: String(err) }, "calendar.upsert.error");
    }
  }

  private async cancelDeleted(
    activeEvents: CalendarEvent[],
    from: Date,
    to: Date,
  ): Promise<void> {
    try {
      const activeIds = new Set(activeEvents.map((e) => e.id));

      // Find SCHEDULED calls in this time window.
      const scheduled = await this.prisma.call.findMany({
        where: {
          status: "SCHEDULED",
          startsAt: { gte: from, lte: to },
        },
        select: { id: true, sourceId: true, title: true },
      });

      for (const call of scheduled) {
        if (!activeIds.has(call.sourceId)) {
          await this.prisma.call.update({
            where: { id: call.id },
            data: { status: "CANCELLED" },
          });
          log.info(
            { sourceId: call.sourceId, title: call.title },
            "calendar.call.cancelled",
          );
        }
      }
    } catch (err) {
      log.error({ err: String(err) }, "calendar.cancel_deleted.error");
    }
  }
}