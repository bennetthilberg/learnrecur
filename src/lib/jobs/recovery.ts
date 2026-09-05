import "server-only";

import { getPrisma } from "@/lib/prisma";
import { markRefillJobRetryableFailure } from "@/lib/skills/refill-jobs";
import type { JobEnvelope } from "./contracts";

// Call only after the delivery ledger grants a retry lease. The eleven-minute
// lease exceeds Lambda's ten-minute execution limit, so the previous process
// cannot still be writing. Completed domain records are deliberately untouched.
export async function recoverInterruptedJob(job: JobEnvelope): Promise<void> {
  switch (job.name) {
    case "learnrecur/choice-refill.requested":
    case "learnrecur/exact-input-refill.requested":
    case "learnrecur/math-refill.requested":
      await markRefillJobRetryableFailure({
        ...job.data,
        now: new Date(),
        error: new Error("Previous worker attempt ended before completion."),
      });
      return;
    case "learnrecur/source-upload-draft.requested": {
      const prisma = getPrisma();
      const where = { id: job.data.sourceFileId, userId: job.data.userId, materialRevisionId: null, status: "PROCESSING" as const };
      // Drafts and READY are committed together by the upload handler. Existing
      // skill references in PROCESSING indicate an inconsistent record, which
      // must be inspected instead of generating another set of drafts.
      await prisma.sourceFile.updateMany({
        where: { ...where, skillRefs: { none: {} } },
        data: { status: "UPLOADED" },
      });
      if (await prisma.sourceFile.count({ where })) {
        throw Object.assign(new Error("JOB_SOURCE_RECOVERY_CONFLICT"), { retryable: false });
      }
    }
  }
}
