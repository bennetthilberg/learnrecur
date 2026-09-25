# AWS background jobs

The migration replaces the Inngest transport with SQS FIFO, a Node.js 24 ARM64
Lambda worker, and EventBridge Scheduler. This document describes the deployment
contract. Production cutover and live verification must be recorded separately;
the existence of this document is not a production-readiness receipt.

## Runtime

The web app publishes typed envelopes containing IDs, counts, and timestamps.
Source documents remain in private S3 storage. All 14 job definitions are in
`src/lib/jobs/contracts.ts`; `dispatch.ts` calls the existing domain handlers.
Scheduling and deterministic answer grading remain unchanged.

SQS groups serialize refills for a skill and the applicable operations for a
user. Draft and activation jobs use two stable per-user lanes. The worker runs
one message per invocation, with a ten-minute timeout and an eleven-minute
database lease. SQS visibility is one hour, allowing Lambda's recommended
timeout margin. Explicit execution failures and infrastructure exceptions
shorten visibility using bounded backoff. An exception before the database
claim retries after 30 seconds to 15 minutes according to the SQS receive
count, while a durable lease still prevents duplicate execution. The queue
permits up to 30 native receives before redrive so these quicker retries do
not exhaust the delivery budget during a brief database outage.
The SQS event-source mapping caps production concurrency at five and staging at
two. Lambda reserved concurrency is optional and uses the same cap when enabled.
Without a reservation, other functions in the account can throttle this worker.

The worker deliberately publishes follow-up jobs to its own FIFO queue. Lambda
normally stops a supported recursive chain after about 16 invocations, which
can interrupt a valid import fan-out. The function therefore opts into AWS's
`Allow` setting for this intentional pattern. That setting disables Lambda's
`RecursiveInvocationsDropped` metric, so application limits and queue alarms
must bound the work: each delivery may publish at most 100 follow-ups; the
validated envelope depth may not exceed 64; item and job attempts are bounded;
and the SQS event source caps concurrency at five in production and two in
staging. Hitting a continuation limit is a permanent, logged job
failure sent to the FIFO dead-letter queue. Maintenance rethrows this typed
limit error instead of converting it into a recoverable scan failure. Queue
age and the FIFO dead-letter queue have CloudWatch alarms in both environments;
production also alarms on the scheduler dead-letter queue. Review these limits
before increasing batch sizes or concurrency. [AWS's recursion guidance](https://docs.aws.amazon.com/lambda/latest/dg/invocation-recursion.html)
recommends guardrails whenever an intentional recursive pattern is enabled.

`BackgroundJobDelivery` atomically claims an envelope ID and payload hash within
its environment. Completed duplicate deliveries are acknowledged. Live leases
are retried; expired leases can be reclaimed. Completion and failure writes are
fenced by the lease token. Domain handlers must remain idempotent because a
process can die after a side effect but before recording completion.

Malformed and permanently failed messages are sent to a FIFO dead-letter queue
before acknowledgment. A failure to publish to that queue leaves the source
message available for retry. SQS also has a native redrive limit for invocations
that cannot initialize or acknowledge. Scheduler failures use a separate
standard dead-letter queue. Queue retention is four days, dead-letter retention
14 days, delivery-record retention 30 days, and log retention 14 days.

## Deploy

Use an authenticated AWS CLI v2 session in the intended account and region.
Runtime Lambda credentials come from its scoped execution role. Never copy a
root key or a developer's CLI session into Vercel or Lambda configuration.

Bootstrap the private deployment-artifact bucket once:

```sh
aws cloudformation deploy --stack-name learnrecur-job-artifacts \
  --template-file infra/aws/bootstrap-template.json --region us-east-1
npm run jobs:build
```

Prepare a mode-0600 environment file from the authoritative environment store.
It must contain the worker's database, isolated S3 bucket, Clerk, Gemini, and
Resend configuration. `WORKOS_API_KEY` and `MCP_RESOURCE_URL` are also required
for account cleanup, including when agent creation is disabled. Other optional
Meta and WorkOS settings are included when used.
The allowlist is in `src/lib/jobs/environment.ts`. `[SENSITIVE]` placeholders
from a Vercel environment export are not usable credentials.

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/deploy-aws-jobs.ts \
  --environment staging --env-file /secure/path/staging.env \
  --source-bucket VERIFIED_STAGING_BUCKET --database-host VERIFIED_STAGING_HOST \
  --schedules disabled
```

The optional `--reserve-concurrency enabled|disabled` flag controls Lambda
reserved concurrency. New stacks default to `disabled`; omitting the flag on
later deploys preserves the stack's current setting. On the first update of an
older stack without this parameter, the script reads the live Lambda reservation
and passes `enabled` when one exists. A zero reservation stops deployment until
an operator chooses explicitly, so updating cannot silently restart a paused
worker. Enable a reservation only
after checking the account's Lambda concurrency quota: AWS requires at least ten
unreserved slots in addition to existing reservations. The SQS event-source
cap applies in either mode, but without a Lambda reservation, competing
functions can throttle this worker. Watch the queue-age and dead-letter alarms
when using shared concurrency.

The script checks the database host and bucket against the explicit targets,
uploads a content-addressed worker artifact, writes a complete revision of
standard encrypted SSM parameters, and deploys the CloudFormation stack. Source
secrets are excluded from process arguments and output. Lambda reads only the
configuration revision deployed with its code, preventing mixed configuration
during rotation. A completion manifest is written last; workers reject partial
snapshots. Redeploy after rotating secrets. Keep previous revisions for
rollback; remove obsolete revisions only after their worker versions are retired.

For unreadable Vercel production secrets, the optional prebuild exporter can
transfer them directly to SSM. Set `AWS_WORKER_CONFIG_EXPORT_REVISION` only on a
production candidate build with `--skip-domain`, and grant its existing AWS
identity temporary `ssm:PutParameter`/`kms:Encrypt` access to that exact revision.
Remove the temporary permission after the build. For a dedicated staging project,
both `JOBS_ENVIRONMENT` and `LEARNRECUR_DEPLOYMENT_TIER` must be `staging`; its
production-target build exports only to the staging parameter namespace.
The exporter rejects previews and copies only the worker allowlist. Deploy the worker using
`--configuration-revision REVISION` instead of `--env-file`; the deploy command
still checks the database host and bucket. Ordinary builds do not export secrets.

Queues, logs, and artifacts are retained if the stack is deleted. Do not delete
and recreate a failed stack casually: retained named resources must be imported
or reconciled. Keep schedules disabled until producer cutover and old-scheduler
retirement are verified.

## Local development

Use a `learnrecur-local-jobs.fifo` queue with a matching FIFO dead-letter queue,
an isolated development database, and non-production service credentials.
Create the queues and grant the existing development identity access with:

```sh
aws cloudformation deploy --stack-name learnrecur-local-jobs \
  --template-file infra/aws/local-queues-template.json \
  --capabilities CAPABILITY_NAMED_IAM --region us-east-1
```

`JOBS_ENVIRONMENT=local`, `JOBS_QUEUE_URL`, and `AWS_REGION` must agree.
`npm run dev` runs Next.js and the local queue consumer. The local consumer does
not execute EventBridge schedules. Run individual maintenance jobs explicitly
when testing those paths. Never consume a staging or production queue locally.
Set `S3_BUCKET_NAME` and AWS credentials to the development/staging identity,
never the production publisher. Keep credentials in the ignored local environment
file; the queues template does not create access keys.

## Operations and cutover

Production has alarms for queue age, both dead-letter queues, Lambda errors, and
each of the three scheduled jobs failing to complete. Staging has queue-age,
worker-error, and job-dead-letter alarms. This totals ten standard alarms
across the two stacks.
SNS topics require a confirmed destination and a delivered test alert before
claiming that owner notification works.

Before production cutover:

1. Apply database migrations and verify the production worker's scoped access.
2. Prove staging delivery, retries, duplicates, poison messages, timeouts, and
   domain behavior through real SQS and Lambda execution.
3. Deploy the AWS publisher with matching production queue configuration.
4. Stop old Inngest schedules and drain in-flight work before enabling AWS
   schedules. Do not run both schedulers against the production database.
5. Verify the three scheduled completions, queue and DLQ state, authenticated
   readiness, and a real end-to-end background operation.
6. Revoke retired Inngest credentials and any exposed deployment bypass token.

The production-health workflow accepts the canonical production URL or one
explicitly trusted immutable candidate. Before testing a candidate, verify its
Vercel project, production target and source commit, then set the repository
variable `PRODUCTION_HEALTH_CANDIDATE_URL` to that exact URL. A matching hostname
alone is insufficient. Only trusted repository operators should update this
variable or dispatch the workflow; no credentials are sent to an unpinned target.

For a failed delivery, inspect its redacted log outcome and durable record,
then inspect the associated domain status. Fix the cause before replaying.
Keep the envelope ID for an ambiguous-delivery retry so completed work remains
deduplicated. A terminal delivery requires an explicit operator recovery that
checks domain idempotency and uses a fresh envelope ID. Never bulk-redrive a DLQ
without reviewing its contents and the scope of the underlying side effects.

Rollback requires coordinating producers and schedules: first stop new AWS
scheduled work, inspect/drain pending messages, then restore a reviewed previous
application release and its compatible transport. Do not reactivate exposed or
revoked credentials as a shortcut.
