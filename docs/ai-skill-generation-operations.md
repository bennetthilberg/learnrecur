# Skill Generation Quality Operations

This runbook covers release evidence, provider smoke tests, incident containment,
and rollback for the generation-quality contracts introduced with
`generation-quality-v1`.

## Release evidence

Run deterministic fixtures on every prompt, schema, validator, context-builder,
or model change:

```bash
npm run eval:ai-generation -- --provider both --output /tmp/generation-eval.json
```

The default is offline and makes no provider calls. A live run is deliberately
opt-in and uses synthetic material only:

```bash
LEARNRECUR_AI_GENERATION_EVAL_LIVE=1 npm run eval:ai-generation -- --live --provider both --output /tmp/generation-live.json
LEARNRECUR_AI_GENERATION_EVAL_LIVE=1 npm run eval:ai-generation -- --live --provider chain --output /tmp/generation-handoff.json
```

The live contract requires a production-shaped batch to pass deterministic
validation, independent solving, dimension-by-dimension auditing, and the known
confidence-interval contradiction check. The `chain` run injects a retryable
primary outage and proves that the real fallback request passes through the same
contracts. Artifacts contain counts, versions, models, defect codes, and timing;
they do not contain source text, prompts, credentials, or raw responses.

Compare a candidate with a prior artifact by passing `--baseline`. A failed
quality or critical-defect gate means rollback. Insufficient sample or metadata
means pause, not approval.

## Canary and rollback policy

Register model and prompt configurations as immutable version tuples in
`model_releases`. Use a stable release fingerprint and keep the previous approved
release in `rollbackToId`. Canary assignment is deterministic by job ID and
release fingerprint.

The default automatic stop policy is:

- rollback on any critical defect or schema failure;
- pause if fallback exceeds 25%, accepted yield falls below 60%, or P95 latency
  exceeds 90 seconds;
- require at least 30 clean synthetic/approved canary jobs before approval.

`evaluateCanary` and `canTransitionRelease` enforce these decisions. Rolled-back
and rejected releases are terminal. Keep the prior approved environment tuple
available for immediate restoration; changing only a floating model alias is not
an acceptable release process.

## Generation-job recovery

Generation jobs record an explicit stage, checkpoint, attempts, failure category,
release tuple, context-manifest hash, and bounded counts. Choice generation uses
per-skill SQS FIFO ordering and two retries in the Lambda worker. Transport/capacity failures may
use fallback; semantic rejection is never reclassified as provider downtime.

For a stranded job, first inspect its `stage`, `updatedAt`, `failureCategory`, and
audit record. Requeue only an idempotent pending/failed operation. Never change a
failed candidate to accepted manually. Prefer a smaller trusted inventory over
publishing an under-verified batch.

Delivery-level attempts, leases, and terminal state live in `BackgroundJobDelivery`.
Inspect those alongside the domain record; a completed delivery can also mean an
idempotent handler found work already finished. Queue and recovery procedures are
documented in [AWS background jobs](aws-background-jobs.md).

## Learner quality incidents

Reporting an exercise immediately retires it from selection. Adjudication is a
separate decision:

- rejected/inconclusive reports do not rewrite review history;
- confirmed defects preserve attempts and review logs, mark the affected evidence,
  and replay FSRS from the remaining independent reviews;
- related exercises may be quarantined only when the operator has evidence of a
  release/family-wide defect.

Use `adjudicateExerciseQualityIncident` from a trusted operator path. Record a
short stable reason code. Confirm the resulting flag has correction status
`COMPLETE`, the bad exercise remains retired, and the attempt/review rows remain
present for audit.

## Evidence boundaries

Passing automated and live synthetic tests establishes contract compatibility;
it does not establish learner benefit or a production defect rate. Broad rollout
still requires a blind human usefulness/correctness audit and delayed independent
retrieval evidence. Priority-2 calibration and optimization must not be enabled
until enough adjudicated production outcomes exist.
