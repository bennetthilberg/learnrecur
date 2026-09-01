# Production release readiness audit

**Audit date:** 2026-08-31

**Audited revision:** `5b7a438887ad59b1116c1299da8af8654295ed6d`

**Release target:** closed external alpha at `https://alpha.learnrecur.com`

**Current verdict:** deployed, but **not ready to invite external users** until the P0 gates below are closed.

A successful deployment is not the same as a production release. The production alias currently serves the audited revision and GitHub CI passed, but important user-safety and operating controls remain unproved or incomplete.

## Evidence collected

- `alpha.learnrecur.com`, `/privacy`, `/terms`, and the MCP protected-resource metadata returned HTTP 200.
- The production Vercel deployment was `READY` and GitHub recorded it against the audited revision.
- GitHub CI passed for the audited revision. Its current scope is lint, unit tests, Prisma validation/generation, and build only.
- All 680 unit tests passed during `npm run test:coverage`, but the coverage command failed its configured 80% global thresholds: 46.99% statements, 42.47% branches, 55.39% functions, and 46.58% lines.
- The configured development database reported all 27 Prisma migrations applied. This is not evidence about the production database.
- `npm audit --omit=dev` reported three high and two moderate advisories, all reached through the Prisma CLI dependency tree rather than `@prisma/client` runtime code.
- The public site returns HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and `X-Frame-Options`. No Content Security Policy was observed.
- Website ingestion validates HTTPS destinations, rejects private/reserved addresses, pins validated DNS results, bounds redirects, response size, and request time, and has focused unit tests. No specific SSRF defect was found in this quick scan.
- Existing untracked product-discovery files were excluded from this audit and remain untouched.

## P0: required before inviting external users

### 1. Restrict enrollment and prevent accidental discovery

**Current evidence**

- The public home page offers account creation.
- No application-level alpha allowlist was found. Clerk may be restricting signups in its hosted configuration, but that was not verified.
- No `robots.txt` or equivalent Next.js robots route was found.

**Required change**

- Decide the alpha cohort and enforce it in Clerk or in the application. Do not rely on an undocumented dashboard setting.
- Reject or hold unapproved accounts before they can create or upload data.
- Add `noindex, nofollow` for the alpha site until open enrollment is intentional.
- Record the Clerk production-instance setting and the tested approved/denied signup paths in the release evidence.

**Done when**

- One invited address can sign up and reach the dashboard.
- One uninvited address cannot complete enrollment.
- Anonymous `curl https://alpha.learnrecur.com/robots.txt` shows the intended alpha policy.

### 2. Replace draft legal pages and publish a real support path

**Current evidence**

- The production privacy and terms pages call themselves drafts, warn that they require review before external testers, and say they are not legal advice.
- The pages do not provide a support/privacy contact address.
- The privacy disclosure does not fully enumerate the current operational processors and features, including Clerk, Vercel, Neon, AWS S3, Inngest, Resend, WorkOS, and model providers used by enabled features.
- No explicit deletion response target or retention schedule is published.

**Required change**

- Founder/legal review the actual product behavior and publish final terms and privacy text.
- Add a monitored support/privacy email.
- State what is stored, why, the processors involved, source-material/model handling, retention, export and deletion procedures, and the alpha nature of the service.
- Verify links from signup and account settings.

**Done when**

- Neither public page contains draft/review placeholders.
- A test message to the published address reaches an owned inbox.
- A release reviewer checks the disclosures against the production environment and enabled feature flags.

### 3. Make account deletion complete and recoverable

**Current evidence**

- Account deletion is an operator command rather than a user-facing flow.
- `npm run ops -- delete-user` deletes the database user before deleting S3 objects. A later S3 failure can leave private orphaned objects after their database references are gone.
- The command does not delete or disable the associated Clerk identity.

**Required change**

- Implement a deletion workflow with a durable manifest/status so retries are safe. Delete or quarantine objects before final database removal, or use an outbox/job that preserves enough information to retry.
- Revoke agent connections and sessions, delete/disable the Clerk identity, and define how failed provider steps are retried.
- Add integration tests for success, partial S3 failure, retry, already-deleted data, and cross-user isolation.
- Publish the operator runbook and deletion service-level target.

**Done when**

- A production-like test user with skills, attempts, material files, generation history, reminders, and an agent connection is exported and deleted.
- Database, S3, Clerk, and agent-access checks all confirm removal or the explicitly documented retained audit subset.
- Injected S3/provider failures recover on retry without losing the deletion manifest.

### 4. Prove production database recovery and migration safety

**Current evidence**

- Migration status was checked only against the configured development Neon branch.
- Backup/PITR configuration and a restore drill were not verified in this audit.

**Required change**

- Confirm production is on the intended 27-migration schema before release.
- Enable and document Neon backups/PITR, retention, RPO, and RTO.
- Restore the latest backup into an isolated branch, run integrity queries, and start the application against it.
- Assign the migration operator and rollback decision owner. Apply migrations before promoting code that requires them.

**Done when**

- `prisma migrate status` against production reports no pending or failed migrations without exposing the connection string.
- A dated restore receipt identifies the backup point, restored branch, integrity checks, elapsed recovery time, and cleanup.

### 5. Verify private storage and rehearse reconciliation

**Current evidence**

- The code uses private S3 object access and presigned operations, but live bucket policy, encryption, CORS, lifecycle, and IAM settings were not verified.
- `npm run ops -- storage-audit` is dry-run detection; orphan cleanup is not an automated, proved recovery path.
- Source deletion contains a documented storage-audit race caveat.

**Required change**

- Confirm S3 Block Public Access, default encryption, least-privilege IAM, exact-origin CORS, and incomplete-multipart-upload lifecycle rules.
- Verify an unauthenticated direct object URL is denied and one user's presign cannot address another user's object.
- Rehearse missing-object and orphan-object detection with production-like fixtures.
- Define a reviewed orphan cleanup procedure with a quarantine/grace period rather than immediate deletion.

**Done when**

- A dated configuration receipt and negative-access test are attached to the release record.
- The storage audit finds the seeded discrepancies, cleanup is recoverable, and a second audit is clean.

### 6. Expand the release test gate beyond signed-out smoke tests

**Current evidence**

- Playwright has 12 tests concentrated on public pages, auth shells, and signed-out route protection.
- There is no browser test covering a signed-in learner's complete path.
- E2E and database integration suites do not run in GitHub CI.
- The coverage command is knowingly red even though its 680 unit tests pass.

**Required change**

- Add an authenticated production-like Playwright flow covering:
  1. approved signup/sign-in;
  2. skill creation with substantial source context;
  3. draft review and activation;
  4. due-practice loading;
  5. exact, choice, and math answer submission with deterministic grading;
  6. FSRS scheduling persistence and the next due state;
  7. history, flagging, export, and deletion initiation;
  8. signed-out and cross-user denial paths.
- Add narrower browser coverage for upload failure/retry and stale/double submission.
- Run database integration and E2E tests in CI against disposable, isolated resources.
- Replace the misleading blanket coverage gate with risk-based thresholds or combine unit/integration coverage. Critical modules such as practice scheduling, quality incidents, refill jobs, material lifecycle, agent operations, storage, and deletion must receive direct failure-path tests.

**Done when**

- A clean commit passes lint, unit, database integration, Prisma validation/generation, build, and authenticated E2E in CI.
- The coverage script is green with an intentional policy; no threshold is simply removed without replacement coverage for critical behavior.

### 7. Protect `main` and make CI a real merge gate

**Current evidence**

- GitHub returned no branch-protection rule for `main`.
- The repository is public.
- Dependabot security updates are disabled and no Dependabot configuration was found.

**Required change**

- Protect `main`: require pull requests, passing release checks, resolved conversations, protection for administrators, and prevention of force pushes/deletion.
- Require at least one human approval once another regular contributor/reviewer exists; until then, preserve the required-check and no-direct-push controls without inventing a blocking solo workflow.
- Enable Dependabot security updates and a weekly npm update schedule.
- Add a dependency audit policy that fails on new runtime high/critical issues and records time-bounded exceptions for non-runtime tooling findings.

**Done when**

- GitHub's branch API shows the intended rule and a deliberately failing test PR cannot merge.
- The dependency policy records disposition of [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) and [GHSA-5qjj-4xww-7phc](https://github.com/advisories/GHSA-5qjj-4xww-7phc). Do not blindly downgrade Prisma; upgrade when compatible or document why the CLI-only path is temporarily accepted, with an owner and expiry date.

### 8. Establish monitoring, alert ownership, and safe logs

**Current evidence**

- No application error-tracking initialization or general health/readiness route was found.
- Operational code primarily logs to the platform console.
- Live alert rules, escalation destinations, and log redaction were not verified.

**Required change**

- Configure Vercel application-error and availability alerts plus Inngest function-failure alerts.
- Add privacy-safe structured fields: request/correlation ID, operation kind, status, duration, provider/model identifier, retry count, and non-sensitive error category. Never log source text, answers, tokens, presigned URLs, or provider payloads.
- Add a minimal liveness route and an operator-only readiness probe for database/storage/provider checks; do not expose dependency details publicly.
- Assign an owner and response procedure for auth spikes, generation/refill failures, reminder failures, storage discrepancies, and database saturation.

**Done when**

- Synthetic failures in a preview/staging environment reach the owner with enough redacted context to diagnose them.
- A runbook states alert thresholds, first checks, mitigation, rollback, and escalation.

### 9. Verify all background functions and scheduled work in production

**Current evidence**

- The application currently registers 12 Inngest functions, while `docs/production-human-tasks.md` documents only five.
- Production synchronization, cron execution, concurrency, and failure alerts for all 12 were not verified.

**Required change**

- Update the operations document to list the actual functions: choice, exact, and math refill; source-upload draft; material ingestion, cleanup, draft-item, and batch activation; agent operation, connection revocation, and maintenance; due-practice reminders.
- Confirm each function is synced to the intended production environment.
- Exercise idempotency and retry behavior for duplicate events, timeouts, provider failure, and partial persistence.
- Verify scheduled reminder and agent-maintenance runs execute at the documented cadence.

**Done when**

- The Inngest production dashboard shows all 12 functions and a dated successful or intentionally failed-and-recovered run for every function family.
- Duplicate test events do not create duplicate exercises, batches, emails, or agent operations.

### 10. Finish the model/provider release, including degraded modes

**Current evidence**

- The merged implementation adds stronger generation contracts, provider fallback, validation, observability, and rollout controls.
- Code and tests do not prove current live provider credentials, quotas, regional access, model availability, or output quality.
- The operational plan still requires blinded quality review, canary observation, and delayed retrieval evidence.
- Meta fallback credentials are optional in environment validation, so production can silently lack the intended fallback unless the rollout policy verifies it.

**Required change**

- Run the production-like primary and fallback probes using a difficult, context-heavy fixture with no private learner material.
- Confirm model IDs, account access, timeout behavior, quotas, billing alerts, schema compliance, validator decisions, fallback activation, and audit persistence.
- Execute the blinded acceptance benchmark and canary procedure in `docs/ai-skill-generation-operations.md`; record sample identity, reviewer rubric, result, incident thresholds, and rollback owner.
- Decide explicitly whether embeddings and fallback are required release dependencies. If unavailable, disable the affected feature or document the bounded degraded behavior and monitor it.

**Done when**

- Both providers produce valid, useful exercise sets on the production-like fixture, and forced primary failure proves fallback end to end.
- The agreed benchmark and canary gates pass, with no unresolved critical/high quality incidents.
- A rollback test confirms generation can be disabled without breaking deterministic practice for existing exercises.

### 11. Run a complete production smoke test and rollback rehearsal

**Current evidence**

- The production alias is healthy and points to the audited merge, but only anonymous HTTP checks were performed in this audit.
- `curl` did not establish the signed-out `/dashboard` browser behavior, and no authenticated production journey was run.

**Required change**

- Use a disposable invited production account to run the learner journey from signup through scheduled review, export, and deletion rehearsal.
- Verify email delivery, source upload/presign, generation/refill, grading, scheduling, history, flagging, and MCP flows that are enabled for launch.
- Capture the currently deployed revision and previous known-good deployment.
- Rehearse Vercel rollback and confirm the previous build remains schema-compatible.

**Done when**

- A release receipt records tester, UTC time, deployment ID/revision, exact checks, redacted artifacts, failures, and cleanup.
- A rollback drill restores the previous known-good build within the stated RTO.

## P1: complete before widening beyond the first controlled cohort

### Add a Content Security Policy

Start with `Content-Security-Policy-Report-Only`, accounting for Clerk, Vercel, KaTeX, S3 uploads, WorkOS, and other required origins. Review reports, remove unnecessary origins, then enforce it. Include `frame-ancestors 'none'` even though `X-Frame-Options: DENY` is already present.

### Run a focused security review

Review tenant isolation, auth/authz, MCP OAuth and scope enforcement, presigned S3 access, URL ingestion/redirect behavior, file parsing limits, prompt-injection boundaries, rate limits, and sensitive-data logging. Add abuse tests for oversized uploads, request floods, repeated generation, malicious documents, and cross-user IDs. The quick scan found meaningful SSRF defenses; this gate is broader and should not start from the assumption that a known exploit exists.

### Add accessibility and browser coverage

Run automated accessibility checks on the authenticated core flow and manual keyboard/screen-reader checks on practice, draft review, dialogs, uploads, and error states. Test current Chrome, Safari/WebKit, and Firefox at representative mobile and desktop widths.

### Add product-health metrics without collecting study content

Track counts and rates for skill creation, draft accept/edit/reject, generation validation rejection, fallback use, flagged exercises, due-session completion, reminder delivery, and returning learners. Define success and rollback thresholds before widening the cohort. Use IDs/categories and aggregated counts, not source text or answers.

### Verify email reputation and failure handling

Confirm Resend domain verification, SPF, DKIM, DMARC policy, bounce/complaint handling, unsubscribe behavior where required, and a monitored sender/reply-to address. Test one real reminder plus bounce and suppression behavior.

### Update operator documentation

Rewrite `docs/production-human-tasks.md` to describe the live alpha rather than the pre-production state. Include all current environment variables, providers, Inngest functions, WorkOS/MCP settings, deployment tier, strict environment validation, backups, storage, alerts, release evidence, and rollback commands. Keep one canonical release checklist to prevent drift.

## P2: repository and maintenance quality

- Add a real root `README.md` with local setup, architecture, test commands, environment tiers, deployment links, and operator-document pointers. The roadmap calls for it, but it is absent.
- Add `SECURITY.md` with a private vulnerability-reporting path appropriate for a public repository.
- Add `CODEOWNERS` when there is a real review owner; do not create ceremonial ownership rules for a one-person team.
- Turn on automatic deletion of merged branches if it matches the team's branch-retention policy.
- Schedule quarterly restore, account-deletion, storage-reconciliation, and provider-failover drills, and retain compact redacted receipts.
- Review cost and quota alarms for Vercel, Neon, S3, Inngest, Clerk, Resend, Gemini, Meta, and WorkOS after the first week of real usage.

## Exact release gate

Run this from a clean candidate commit:

```bash
npm ci
npm run lint
npm run test:unit
npm run test:coverage
RUN_DATABASE_TESTS=1 npm run test:db
npm run prisma:validate
npm run prisma:generate
npm run build
npm run test:e2e
LEARNRECUR_STRICT_ENV=1 npm run env:check
npm audit --omit=dev
git status --short
```

The release owner must also attach evidence that cannot be established by local commands:

- final signup policy and legal/support pages;
- production migration status and restore drill;
- S3 security/reconciliation checks;
- all Inngest functions synced and exercised;
- live primary/fallback provider and canary evidence;
- authenticated production smoke and cleanup;
- branch protection and required checks;
- alert delivery and rollback rehearsal.

Do not release merely by waiving every red item. Each exception must identify the precise risk, why exposure is bounded for the initial cohort, compensating control, owner, expiry date, and rollback trigger.

## Explicitly not required for this release

These items may matter later, but they should not block a small closed alpha unless the release scope changes:

- native mobile applications;
- billing or multi-tenant school administration;
- a content marketplace or chat tutor;
- broad institutional compliance certification;
- 80% line coverage across every presentation module, provided critical domain and failure paths have an intentional green coverage gate;
- open public enrollment.
