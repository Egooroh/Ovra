// Dev/ops helper: create a CalendarAccount with ENCRYPTED credentials.
//
// The credentials blob is encrypted with CALENDAR_CRED_KEY (must be set in .env)
// before it ever touches the DB. Until the Go control plane owns onboarding,
// this is how tenants get their calendars connected.
//
// Google:
//   node --env-file=.env -r ts-node/register src/dev/seedAccount.ts \
//     --org acme --provider google --label "director@acme.ru" \
//     --calendars "primary,team@group.calendar.google.com" --sa-json ./sa.json
//
//   (--sa-json may be a path to the key file OR inline JSON.)
//
// Yandex:
//   node --env-file=.env -r ts-node/register src/dev/seedAccount.ts \
//     --org acme --provider yandex --label "director@acme.ru" \
//     --username user@yandex.ru --password <app-password>

import { readFileSync } from "node:fs";
import { prisma, disconnect } from "../db/prisma";
import { encryptCred } from "../util/crypto";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const org = arg("org");
  const provider = arg("provider");
  const label = arg("label") ?? null;
  if (!org) fail("--org <organizationId> is required");
  if (provider !== "google" && provider !== "yandex") {
    fail('--provider must be "google" or "yandex"');
  }

  let credsObj: Record<string, string>;
  let calendarIds: string[] = [];

  if (provider === "google") {
    const saArg = arg("sa-json");
    if (!saArg) fail("--sa-json <path-or-inline-json> is required for google");
    // Accept a file path or inline JSON; store whatever the provider accepts.
    const saJson = saArg!.trim().startsWith("{") ? saArg! : readFileSync(saArg!, "utf8");
    credsObj = { saJson };
    calendarIds = (arg("calendars") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (calendarIds.length === 0) fail("--calendars is required for google (comma-separated)");
  } else {
    const username = arg("username");
    const password = arg("password");
    if (!username || !password) fail("--username and --password are required for yandex");
    credsObj = { username: username!, password: password! };
  }

  const credentials = encryptCred(JSON.stringify(credsObj));

  const account = await prisma.calendarAccount.create({
    data: { organizationId: org!, provider: provider!, label, credentials, calendarIds, active: true },
  });

  console.log(
    `created CalendarAccount ${account.id} (org=${org}, provider=${provider}` +
      (calendarIds.length ? `, calendars=${calendarIds.length}` : "") +
      `) — credentials encrypted at rest`,
  );
  await disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
