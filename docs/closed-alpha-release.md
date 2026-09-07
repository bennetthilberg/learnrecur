# Closed alpha release verification

Release work started September 7, 2026 from merged revision `5373a3e`.
External learner invitations are excluded from this task.

## Access and deployment checks

`ALPHA_ALLOWED_EMAILS` accepts exact addresses and `*@example.com` rules. A
domain rule matches only that exact email domain, requires a verified primary
Clerk email, and applies to both web and MCP access. Subdomains, suffix lookalikes,
partial wildcards and malformed configuration do not grant access. The requested
production policy is `*@bennetthilberg.com,bennett.hilberg@gmail.com`.

Authenticated readiness now checks for the latest required completed Prisma
migration. Missing, unfinished or rolled-back migration records fail readiness;
public liveness remains minimal. A unit check requires the declared migration to
match the latest tracked migration, and database tests exercise missing,
unfinished and rolled-back states inside transactions that always roll back.

The authenticated CI job has a 45-minute limit so serial database verification
cannot consume the entire browser verification window.

## Verified production database change

Snapshot `snap-summer-sun-ap0yvzf0` was restored into a separate branch before
changing production. The restored 1,376 skills, 82 attempts and 46 review logs
matched production by ordered record checksums. Migration
`20260906173000_retention_preferences` then applied through Prisma migrate deploy.
Checksums of the pre-existing skill, attempt and review fields remained identical
after migration. No historical grades, schedules or owner preferences changed.

## Remaining evidence

- Deploy and verify the matching worker and web release, including rollback.
- Set and verify the production access policy.
- Complete CI and production browser checks on the final revision.
- Prove new MCP scopes through consent, refresh, settings operations and revocation.
- Complete the disposable learner flow, reminders, export and deletion.
- Run bounded live generation canaries and review their accepted exercises.

Deployment receipts, test output and synthetic fixture identifiers are retained
locally in ignored `.aws-build/`. Secrets are held in mode-0600 files and are not
part of these release records.
