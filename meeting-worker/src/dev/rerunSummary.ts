// Dev helper: re-runs writeSummary for an existing call that already has a transcript.
//
//   node --env-file=.env -r ts-node/register src/dev/rerunSummary.ts <callId>

import { prisma, disconnect } from "../db/prisma";
import { writeSummary } from "../worker/summaryWriter";

async function main(): Promise<void> {
  const callId = process.argv[2];
  if (!callId) {
    console.error("usage: rerunSummary.ts <callId>");
    process.exit(1);
  }

  const call = await prisma.call.findUniqueOrThrow({
    where: { id: callId },
    select: { organizationId: true, title: true, startsAt: true, endedAt: true },
  });

  console.log(`re-running summary for call ${callId} ("${call.title}")`);

  await writeSummary(
    prisma,
    callId,
    call.organizationId,
    call.title ?? null,
    call.startsAt,
    call.endedAt ?? new Date(),
  );

  console.log("done — check meeting-worker/output/");
  await disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
