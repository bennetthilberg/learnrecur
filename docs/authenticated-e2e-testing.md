# Authenticated end-to-end testing

LearnRecur's authenticated Playwright suite uses real Clerk development-instance sessions. It does not add an application auth bypass.

## What the harness does

- Fetches Clerk testing tokens through `@clerk/testing` so browser automation is not rejected as bot traffic.
- Creates one ephemeral `+clerk_test` user for each Playwright worker.
- Signs each worker in through Clerk's ticket-based helper and stores browser state only under ignored `test-results/` output.
- Exercises the real `clerkMiddleware`, server-side `auth.protect()`, Clerk user lookup, and database-user mirroring paths.
- Deletes mirrored database rows and Clerk users after the dependent test project completes.
- Sweeps interrupted CI users by their exact test email and private metadata markers before provisioning.
- Refuses production Clerk keys.

The default is two workers/users. Set `E2E_CLERK_USER_COUNT` to an integer from 2 to 6 when a different limit is needed. Ownership tests require at least two.

## Local setup

Set these development values in `.env.local`:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...
E2E_CLERK_USER_COUNT=2
```

The database must be non-production and must have current migrations. Then run:

```bash
npm run prisma:deploy
npm run test:e2e:auth
```

Run the secret-free signed-out suite with `npm run test:e2e`, or both with `npm run test:e2e:all`.

## CI contract

The authenticated CI job accepts only same-repository pull requests and pushes to `main`. Fork pull requests do not receive or execute with authentication/database secrets.

Configure these Actions secrets with an isolated Clerk development instance and non-production Neon branch:

- `E2E_CLERK_PUBLISHABLE_KEY`
- `E2E_CLERK_SECRET_KEY`
- `E2E_DATABASE_URL`
- `E2E_DIRECT_URL`

The initial repository secrets use the existing non-production development branch that already supports temporary integration-test rows. Each CI run creates a disposable PostgreSQL database, applies that checkout's migrations only inside the disposable database, and drops it after Playwright. Before creating a database, the serialized job also removes abandoned `e2e_<run>_<attempt>` databases from interrupted earlier jobs. The shared development database is never migrated by pull-request tests.

Move `E2E_DATABASE_URL` and `E2E_DIRECT_URL` to a dedicated automation branch before granting untrusted collaborators write access or increasing CI concurrency. Per-run databases protect test data and migrations, but a separate Neon branch also isolates resource consumption and operational mistakes.

## Failure recovery

If a local Playwright run is interrupted before teardown, the ignored manifest at `test-results/e2e-clerk-users.json` records the created user IDs. Rerunning the authenticated suite attempts cleanup before provisioning its new users. CI runners additionally mark users with a private `ci` scope: the next serialized run removes any prior CI-scoped users and abandoned disposable databases even when the earlier runner and manifest are gone. Recent local users are protected from a concurrent CI sweep; marked local users older than 24 hours are treated as abandoned.

If automatic cleanup fails, inspect the local manifest or Clerk private metadata, remove only identities with the exact LearnRecur E2E email and marker pair, drop only databases matching `e2e_<run>_<attempt>`, and rerun.

Never commit the manifest, Playwright storage state, Clerk keys, database URLs, or copied production learner data. Real-provider generation and production smoke checks belong in separate protected workflows; ordinary authenticated PR tests should stay deterministic.
