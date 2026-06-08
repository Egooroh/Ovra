// Dev helper: schedule a one-off call for a given Telemost URL so the running
// orchestrator picks it up within one poll (~15 s) and forks a worker.
//
//   node --env-file=.env -r ts-node/register src/dev/joinUrl.ts <telemost-url>
//
// Combine with SPEAKER_DIAG=1 on the orchestrator to capture audio-topology
// and active-speaker telemetry from a live call.

import { prisma, disconnect } from "../db/prisma";

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || !url.includes("telemost")) {
    console.error("usage: joinUrl.ts <telemost-url>");
    process.exit(1);
  }

  const now = new Date();
  const sourceId = `dev:${Date.now()}`;
  const call = await prisma.call.create({
    data: {
      sourceId,
      joinUrl: url,
      title: "DIAG test call",
      startsAt: now,
      endsAt: new Date(now.getTime() + 60 * 60_000),
      status: "SCHEDULED",
    },
  });
  console.log(`scheduled call ${call.id} for ${url} — orchestrator will join shortly`);
  await disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
