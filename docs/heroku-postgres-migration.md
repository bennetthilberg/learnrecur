# PostgreSQL hosting and migration

LearnRecur uses ordinary PostgreSQL through Prisma's `adapter-pg`. Heroku hosts
separate production (`learnrecur-db`) and staging (`learnrecur-staging-db`)
databases in the US. Vercel hosts the web application and AWS runs background
jobs. No Heroku dynos or Eco subscription are required.

## Cost and limits

Each database uses Essential-0: $5/month, 1 GB storage and 20 connections. The
combined $10/month fits within the approved $13/month GitHub student credit.
Expected database out-of-pocket cost is $0 while those credits remain valid and
no other Heroku charges consume them. Credits expire; this is not permanently
free hosting. Before credits end, retire hosted staging or move it elsewhere to
keep the user's ongoing database bill at or below $5/month. Production alone
costs $5/month. Do not upgrade plans without approval.

This is a small managed database, not a high-availability tier with automatic
failover or an uptime guarantee. Daily logical backups run at 08:00 UTC for
production and 09:00 UTC for staging. Heroku also reports continuous protection.
Monitor database storage and connections with `heroku pg:info --app learnrecur-db`.

## Connections and trust

`DATABASE_URL` serves Prisma; `DIRECT_URL` serves schema migrations. Web and
worker URLs must point to the same database within each environment. Credentials
live in Vercel secrets and versioned AWS SSM SecureStrings, never repository files.

`src/lib/postgres-config.ts` limits each application pool to two connections,
with a five-second connection timeout and ten-second idle timeout. Production
Lambda concurrency is five, so its pools can consume ten connections. Web
instances and operator sessions share the remaining capacity; this is not a
hard global pool limit. Revisit pooling before increasing traffic or concurrency.
`DATABASE_POOL_MAX` accepts 1–5; database integration tests use five because lock
race tests need independent blocker, waiter and observer connections.

Remote connections require certificate and hostname verification. The checked-in
public trust bundle, `src/lib/rds-us-east-1-ca.json`, comes from
https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem
(retrieved 2026-09-17). Only `*.us-east-1.rds.amazonaws.com` hosts use that bundle;
other hosts use system roots. Local disposable databases can use unencrypted
loopback connections. Do not work around certificate failures with
`rejectUnauthorized: false`. Refresh the official regional bundle when AWS
rotates its certificate authorities, and verify both a real connection and the
connection-config unit tests.

For Prisma CLI/libpq commands against Heroku, supply `PGSSLROOTCERT` with the
public PEM bundle and `PGSSLMODE=verify-full` (or the client's corresponding
`sslrootcert` option). Application connections already embed that trust.

Heroku can rotate database credentials. After a credential change, retrieve the
new URL using `heroku config:get DATABASE_URL --app <app>` into a mode-0600 local
file, update **both** Vercel database variables using stdin, deploy the web app,
and deploy a new worker configuration revision with that same URL. A Heroku
attachment does not update external Vercel or AWS consumers automatically. Keep
readiness monitoring enabled so a stale credential is detected promptly.

## Tests and local development

Use a disposable PostgreSQL 18 database with pgvector for local tests. CI creates
its own pgvector PostgreSQL service and a unique database per run; it does not
need hosted database credentials. Keep Clerk test credentials separate from
production. Browser fixtures use `pg` rather than Neon's HTTP query API.

Run lint, unit tests, Prisma validation/generation, the production build,
`npm run test:db`, and anonymous/authenticated browser tests. Never point the
full test suite at the production database.

## Cutover and rollback

1. Preserve the old deployment and worker revision. Keep source databases intact.
2. Restore staging first and compare all application tables by row count and
   hashes of canonical JSON rows. Check pgvector and a deployed worker operation.
3. Build the production candidate with automatic domain promotion disabled.
4. Pause production schedules and queue consumption, wait for active deliveries
   to finish, then freeze source writes and disconnect old application sessions.
5. Take the final consistent custom-format dump. Restore in one transaction,
   keeping Heroku's existing public schema and extensions. Schema-only selection
   omits extension creation, so install `vector` explicitly before restoring.
6. Compare every table and migration record, deploy the new worker configuration,
   verify the worker, promote the web candidate, and resume queue consumption and
   schedules. Check dependency readiness and the signed-in application.
7. Retain Neon read-only as the pre-cutover snapshot. Do not allow both providers
   to accept writes.

Before any Heroku writes, rollback can thaw Neon and restore the old web and
worker deployments. **After Heroku accepts writes, do not simply switch URLs
back:** that would lose new practice history. Pause writers, copy and verify the
current Heroku data back into the rollback target, then change both web and
worker configuration together. Prefer fixing the new deployment when feasible.

Migration dumps, credentials and private verification artifacts belong in
`.migration-private/`, excluded from Git, Vercel uploads and lint. Never attach
them to a PR or print learner rows in deployment logs.

## Migration evidence

On 2026-09-17, production and staging moved to Heroku PostgreSQL 18.3 with
pgvector 0.8.1. Final frozen-source comparisons matched all 36 public tables:
14,119 production rows and 2,844 staging rows. The comparison included row counts
and hashes of every row, including Prisma migration history.

- Production web: `dpl_4pZwoqGMkPRmFiRTdhqNQopZYuaf`,
  `https://learnrecur-3u0xmk0ie-learn-recur.vercel.app`, promoted to
  `https://alpha.learnrecur.com`.
- Staging web: `dpl_2ZXRJLn6CmqjQwkmhbEqCiEJ1ga6`,
  `https://learnrecur-agent-staging-ok0bx5y01-learn-recur.vercel.app`, promoted to
  the staging project's existing domains.
- Worker artifact SHA-256:
  `4920068cb51aeafacb7b5544c37045538f4edaebf75cdde155963b7ac56136bc`.
- Production SSM revision: `bb2607c5-bfa1-43f8-a8a6-878a70d2e02e`.
- Both deployed workers read synthetic completed deliveries from Heroku and
  classified them as duplicates without executing them. Fixtures were removed.
- Production queue consumption and all three schedules resumed; staging
  schedules remain disabled.
- Production candidate dependency check:
  https://github.com/bennetthilberg/learnrecur/actions/runs/35250286638
  (successful second attempt; the first ran before the candidate finished).
- Canonical production dependency check:
  https://github.com/bennetthilberg/learnrecur/actions/runs/35250743505 (passed).
- Production logical backup `b002` completed after cutover.
- Both Vercel projects' preview database variables now use Heroku staging.
  Older immutable deployments retain their old variables; Neon write freezes
  prevent them from creating a second writable copy.

Neon production project `green-thunder-73986028` and staging project
`steep-flower-25531082` remain intact with database-level default read-only mode.
This is a guard against writes by old deployments, not a replacement for access
control: an administrator can override it deliberately for rollback.

Local validation includes 1,176 unit tests, 523 database integration tests,
15 anonymous browser tests, lint, Prisma validation/generation, worker build,
production build and the runtime dependency audit. Authenticated testing passed
108 cases on the first run; the sole failure selected both loading and loaded
copy. The selector now targets visible content and its focused rerun passed all
four setup/test/cleanup cases. A combined coverage run exposed a fixture set
exactly at its ten-minute lease boundary; the fixture now sets a clearly expired
lease. The final combined run passed all 1,699 tests with 81.70% line coverage
and 72.42% branch coverage; all coverage gates passed.

The production browser smoke reached the expected sign-in redirect. No signed-in
production learner action was performed; deterministic authenticated behavior
was exercised against the isolated local database.
