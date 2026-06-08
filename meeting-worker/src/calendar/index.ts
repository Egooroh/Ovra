// Entry point for the calendar subsystem.
//
// Resolves tenants every poll:
//   1. Multi-tenant: active CalendarAccount rows in the DB, grouped by
//      organizationId, each providing its own decrypted credentials.
//   2. Single-tenant fallback: if there are no CalendarAccount rows, build
//      providers from env vars (GOOGLE_*/YANDEX_*) under the BACKEND_TENANT_ID
//      tenant — preserving the original single-deployment behavior.
//
// Also exposes a CLI entry point for `npm run calendar:once` (one-shot poll).

import { prisma } from "../db/prisma";
import { CalendarWatcher, type TenantProviders } from "./watcher";
import { buildGoogleProvider } from "./google";
import { buildYandexProvider } from "./yandex";
import { buildProviderFromAccount } from "./fromAccount";
import { config } from "../util/config";
import { log } from "../util/log";
import type { CalendarProvider } from "./provider";

/**
 * Resolve the tenants to poll this cycle. Called fresh each poll so newly
 * added/paused CalendarAccount rows take effect without a restart.
 */
async function resolveTenants(): Promise<TenantProviders[]> {
  // 1) DB-backed multi-tenant accounts.
  let accounts: Awaited<ReturnType<typeof prisma.calendarAccount.findMany>> = [];
  try {
    accounts = await prisma.calendarAccount.findMany({ where: { active: true } });
  } catch (err) {
    // e.g. table not migrated yet — fall through to the env path rather than
    // taking the whole watcher down.
    log.error({ err: String(err) }, "calendar.accounts.query_failed");
  }

  if (accounts.length > 0) {
    const byOrg = new Map<string, CalendarProvider[]>();
    for (const acc of accounts) {
      try {
        const provider = buildProviderFromAccount(acc);
        const list = byOrg.get(acc.organizationId) ?? [];
        list.push(provider);
        byOrg.set(acc.organizationId, list);
      } catch (err) {
        // One broken account (bad key / malformed creds) must not sink the rest.
        log.error(
          { accountId: acc.id, org: acc.organizationId, err: String(err) },
          "calendar.account.build_failed",
        );
      }
    }
    return [...byOrg.entries()].map(([organizationId, providers]) => ({ organizationId, providers }));
  }

  // 2) Single-tenant env fallback.
  const providers: CalendarProvider[] = [];
  const google = buildGoogleProvider();
  if (google) providers.push(google);
  const yandex = buildYandexProvider();
  if (yandex) providers.push(yandex);

  if (providers.length === 0) {
    log.warn(
      "calendar: no CalendarAccount rows and no env providers configured. " +
        "Add accounts (multi-tenant) or set GOOGLE_SA_JSON+GOOGLE_CALENDAR_IDS / " +
        "YANDEX_CALDAV_USERNAME+YANDEX_CALDAV_PASSWORD (single-tenant).",
    );
    return [];
  }

  // organizationId null when BACKEND_TENANT_ID is unset → legacy untagged rows.
  return [{ organizationId: config.backend.tenantId || null, providers }];
}

export function buildCalendarWatcher(): CalendarWatcher {
  return new CalendarWatcher(prisma, resolveTenants);
}

// ---- CLI: run a single poll and exit (useful for testing) ----
if (require.main === module) {
  const arg = process.argv[2];
  if (arg !== "--once") {
    console.error("Usage: ts-node src/calendar/index.ts --once");
    process.exit(1);
  }

  const watcher = buildCalendarWatcher();
  // Access the private poll through a cast — only for the CLI runner.
  (async () => {
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
