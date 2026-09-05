# AWS migration verification

Verified 2026-09-05 UTC. The production migration is live. Owner alert delivery
and final revocation of the retired Inngest event key remain open; this is not
an unconditional production-readiness sign-off.

## Deployed state

- `alpha.learnrecur.com` was promoted at approximately 03:54 UTC to
  `dpl_3tV95EaNym1Nv5EwvC9QQ2CPCqy6`, built from `b144002`.
- The dedicated staging site, `project-0oqzu.vercel.app`, runs
  `dpl_HVo9pZRRu7FncuWtotuVbKBacTfS`, built from `e8344ed`.
- Production and staging run the same content-addressed worker artifact:
  `232cddf8a6b79d4fbc3aca52c374aa429058269cdd9ab1cd1abac3843a7f198c.zip`.
- Production worker configuration:
  `vercel-92a7b3d9-e563-4eb7-9dbd-b7ed2171d312` (22 settings).
- Staging worker configuration:
  `vercel-staging-4bfdce10-b2db-4429-8109-bddd193bace7` (23 settings).
- Production schedules are enabled; staging schedules are disabled. Both source
  queues were empty, including in-flight messages, at 04:16 UTC.
- Local development has its own FIFO queue and dead-letter queue. The local
  consumer completed a real no-op material delivery using the scoped development
  identity. Local configuration uses the staging S3 identity rather than the
  production publisher and includes the staging WorkOS settings required for
  account cleanup.
- Production and preview database, Clerk and S3 identities are separated in
  Vercel. The dedicated `learnrecur-agent-staging` project also uses AWS and
  retains its staging WorkOS configuration.

## Automated verification

- 836 unit tests passed across 84 files.
- All 353 database tests passed across 23 files against the hosted development
  database. Files run sequentially; concurrency tests within each file still
  race the actual operations. Parallel files had produced unrelated fixture
  conflicts and expired transactions on the small shared Neon database.
- All 24 browser tests passed, including isolated Clerk provisioning, authenticated
  learner flows, export, deterministic grading, permissions and fixture cleanup.
- Lint, Prisma validation/generation, Next.js build and the ARM64 worker bundle
  passed. Production and staging Vercel builds also passed.
- Coverage thresholds passed: 48.43% statements, 43.55% branches, 56.89% functions,
  48.04% lines in the last full coverage run before the three additional staging
  export tests. These are whole-repository coverage numbers.
- Runtime dependency audit: zero blocking findings; four existing development
  tooling exceptions remain documented in the repository audit policy.
- The first pull-request CI run stopped before database tests because its saved
  Neon password was stale. Both CI database secrets were refreshed from the
  verified development database credentials; production credentials were not used.

## Live execution evidence

| Scenario | Observed result |
| --- | --- |
| Duplicate delivery | Same envelope completed once; subsequent delivery logged as duplicate. |
| Invalid envelope | Real poison message reached the dead-letter queue and was removed after inspection. |
| Interrupted worker | A real Lambda was terminated by its five-second timeout. The normal worker waited for the eleven-minute lease to expire, reclaimed attempt two, and generated three accepted exercises. No database clock was changed. |
| Skill generation | Real choice, math and exact-input jobs completed with validated exercises. A separate oversized timeout fixture ended in semantic rejection; it is not counted as successful generation. |
| PDF ingestion | A real PDF moved through S3, SQS and the ARM64 Lambda PDF runtime, then Gemini summarization/embedding, to READY with a chunk and section. |
| Quick source draft | Real uploaded PDF reached READY and produced a skill draft. |
| Material draft and activation | Real scope planning, drafting and activation produced an ACTIVE skill with five exercises. |
| Agent operation | A synthetic database connection queued a real agent operation that generated and activated a skill. This does not prove an OAuth grant flow. |
| Production generation and ingestion | Real production SQS/Lambda executions generated two accepted exercises and ingested the synthetic PDF. |
| Production deletion | Real material cleanup deleted the database material and its S3 object. Account cleanup then reached COMPLETE and removed the synthetic learner. Clerk's already-absent identity path was exercised. |
| Clerk identity deletion | A disposable development Clerk user with an active session was queued through AWS. The account job reached COMPLETE, and subsequent provider reads confirmed the identity and session were deleted. |
| Hosted app publishing | Signed into the dedicated staging deployment with the documented test user, submitted exercise preparation through the UI, and observed five verified exercises and `Target met` after the Lambda completed. Only the isolated fixture skill was removed afterward. |
| Staging cleanup recovery | Missing WorkOS configuration initially blocked account cleanup. After the authoritative staging configuration transfer, all seven fixture accounts reached COMPLETE. |
| Retry exhaustion and dead-letter recovery | Seven staging cleanup envelopes exhausted four attempts and reached the real dead-letter queue with `JOB_RETRIES_EXHAUSTED`. After their domain jobs reached COMPLETE and their fixture users were gone, only those seven messages were removed. The staging dead-letter queue was empty, including in-flight messages, at 04:35 UTC. |
| Scheduled work | Account-deletion recovery completed at 03:55:27 UTC, agent-access maintenance at 03:55:27 UTC, and practice reminders at 04:00:05 UTC. All seven production alarms were OK at 04:21 UTC. |
| Configuration regression guard | Two failing tests reproduced acceptance of missing account-cleanup settings. The worker now rejects snapshots without `WORKOS_API_KEY` or `MCP_RESOURCE_URL`, even when agent creation is disabled. Both environments were redeployed and completed an isolated no-op delivery on attempt one at 04:46 UTC. |

The forced-timeout test used a temporary directly invoked Lambda, followed by
real SQS redelivery to the normal worker. A native SQS-triggered timeout can wait
for the queue's one-hour visibility timeout; the test does not establish an
eleven-minute end-to-end bound for that case. The temporary fault Lambda was
removed after verification.

## Cutover and credentials

The production Inngest app was archived at 03:53:48 UTC before promotion. The
separate Agent Staging app was also archived after checking its run history.
Production's RUNNING/QUEUED view was empty beforehand, and the API returned zero
unfinished runs afterward.
One previously scheduled maintenance invocation appeared at 03:55 UTC and failed
after cutover. The event audit from 03:53 UTC contained only Inngest internal
events, with no learner events requiring transfer.

The Vercel Inngest integration now excludes both LearnRecur projects; the
unrelated project retains its existing access. All `INNGEST_*` environment
variables were removed from both LearnRecur Vercel projects and local development.
The exposed Inngest deployment-bypass token was revoked. A protected preview
returned a redirect for that old token and HTTP 200 for the replacement token
at 04:07 UTC. The replacement is stored as a GitHub Actions secret for candidate
health checks. Temporary SSM export permissions were removed after each transfer.

Candidate liveness and authenticated readiness passed before promotion:
[production candidate check](https://github.com/bennetthilberg/learnrecur/actions/runs/33943000755).
The public production target passed after promotion:
[post-cutover check](https://github.com/bennetthilberg/learnrecur/actions/runs/33943148902).
The isolated preview and dedicated agent-staging deployment also returned
`ready` for database, storage, provider and background-job checks.

## Open operational items

- Confirm an owner-controlled SNS destination and deliver a test alert. Topics
  and alarms exist, but topic existence does not establish owner notification.
- Permanently revoke the retired `Vercel: learnrecur` Inngest event key. The
  browser confirmation request is pending. The old app is archived and cannot
  execute new LearnRecur work.
- Complete pull-request CI/review and record the final reviewed commit.

Raw verification receipts and synthetic fixture identifiers are kept locally in
ignored `.aws-build/`; credentials remain in private mode-0600 files. Synthetic
production and staging learner data were cleaned up through the AWS worker.
