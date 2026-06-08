// CalendarWatcher — runs inside the orchestrator process.
//
// Every CALENDAR_POLL_MS it resolves the set of tenants to poll, then for each
// tenant asks its calendar providers for upcoming events. Events with a
// Telemost link are upserted into the Call table as SCHEDULED, tagged with the
// owning organizationId. Events that disappear from a tenant's calendars
// (cancelled/deleted) are marked CANCELLED — but only within that tenant's own
// rows, and only if still SCHEDULED (not already in progress).
//
// Multi-tenant vs single-tenant is decided entirely by the injected resolver
// (see calendar/index.ts): DB-backed CalendarAccount rows, or an env fallback.

import type { PrismaClient } from "@prisma/client";
import type { CalendarProvider, CalendarEvent } from "./provider";
import { config } from "../util/config";
import { log } from "../util/log";

/** One tenant's calendar providers. organizationId is null in single-tenant mode. */
export interface TenantProviders {
  organizationId: string | null;
  providers: CalendarProvider[];
}

/** Resolves which tenants (and their providers) to poll. Called every cycle so
 *  newly added/removed CalendarAccount rows are picked up without a restart. */
export type TenantResolver = () => Promise<TenantProviders[]>;

export class CalendarWatcher {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly resolveTenants: TenantResolver,
  ) {}

  start(): void {
    log.info("calendar.watcher.started");
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
    let tenants: TenantProviders[];
    try {
      tenants = await this.resolveTenants();
    } catch (err) {
      log.error({ err: String(err) }, "calendar.resolve_tenants.error");
      return;
    }

    if (tenants.length === 0) {
      log.warn("calendar.watcher: no tenants/providers configured — nothing to poll");
      return;
    }

    // Poll tenants independently so one tenant's failure never affects another.
    await Promise.allSettled(tenants.map((t) => this.pollTenant(t)));
  }

  /** Poll one tenant's providers and reconcile its Call rows. */
  private async pollTenant(tenant: TenantProviders): Promise<void> {
    // Look slightly into the past so we don't miss meetings that just started.
    const from = new Date(Date.now() - 5 * 60_000);
    const to = new Date(Date.now() + config.calendar.lookaheadMs);

    const discovered: CalendarEvent[] = [];

    // Query the tenant's providers in parallel; one failing doesn't stop the others.
    const settled = await Promise.allSettled(
      tenant.providers.map((p) => p.fetchEvents(from, to)),
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      const providerName = tenant.providers[i]!.name;
      if (result.status === "fulfilled") {
        log.info(
          { org: tenant.organizationId, provider: providerName, found: result.value.length },
          "calendar.poll.ok",
        );
        discovered.push(...result.value);
      } else {
        log.error(
          { org: tenant.organizationId, provider: providerName, err: String(result.reason) },
          "calendar.poll.error",
        );
      }
    }

    // Upsert all found events into the DB, tagged with this tenant.
    await Promise.allSettled(discovered.map((e) => this.upsert(e, tenant.organizationId)));

    // Mark CANCELLED this tenant's SCHEDULED calls that are no longer in its
    // calendars. Scoped to organizationId so one tenant's poll never cancels
    // another tenant's meetings.
    await this.cancelDeleted(discovered, from, to, tenant.organizationId);
  }

  private async upsert(event: CalendarEvent, organizationId: string | null): Promise<void> {
    try {
      const existing = await this.prisma.call.findUnique({
        where: { sourceId: event.id },
        select: { id: true, status: true },
      });

      if (!existing) {
        // Deduplicate by joinUrl: same Telemost link may appear in multiple
        // calendars. This stays GLOBAL (not per-tenant) on purpose: one physical
        // room must never get two bots. First claim wins.
        const sameUrl = await this.prisma.call.findFirst({
          where: {
            joinUrl: event.joinUrl,
            status: { notIn: ["DONE", "FAILED", "CANCELLED"] },
          },
          select: { id: true, sourceId: true },
        });

        if (sameUrl) {
          log.info(
            { org: organizationId, sourceId: event.id, existingId: sameUrl.id, joinUrl: event.joinUrl },
            "calendar.call.skipped_duplicate_url",
          );
          return;
        }

        await this.prisma.call.create({
          data: {
            sourceId: event.id,
            organizationId: organizationId ?? null,
            joinUrl: event.joinUrl,
            title: event.title,
            startsAt: event.startAt,
            endsAt: event.endAt,
            status: "SCHEDULED",
          },
        });
        log.info(
          { org: organizationId, sourceId: event.id, title: event.title, startsAt: event.startAt },
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
          { org: organizationId, sourceId: event.id },
          "calendar.call.updated",
        );
      }
    } catch (err) {
      log.error({ org: organizationId, sourceId: event.id, err: String(err) }, "calendar.upsert.error");
    }
  }

  private async cancelDeleted(
    activeEvents: CalendarEvent[],
    from: Date,
    to: Date,
    organizationId: string | null,
  ): Promise<void> {
    try {
      const activeIds = new Set(activeEvents.map((e) => e.id));

      // Find SCHEDULED calls for THIS tenant in the time window. A null org id
      // (single-tenant mode) matches the legacy untagged rows via IS NULL.
      const scheduled = await this.prisma.call.findMany({
        where: {
          status: "SCHEDULED",
          startsAt: { gte: from, lte: to },
          organizationId: organizationId ?? null,
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
            { org: organizationId, sourceId: call.sourceId, title: call.title },
            "calendar.call.cancelled",
          );
        }
      }
    } catch (err) {
      log.error({ org: organizationId, err: String(err) }, "calendar.cancel_deleted.error");
    }
  }
}
