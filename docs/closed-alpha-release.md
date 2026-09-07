# Closed alpha release verification

Release work started September 7, 2026 from merged revision `5373a3e`.
External learner invitations are excluded from this task.

## Access and deployment checks

`ALPHA_ALLOWED_EMAILS` accepts exact addresses and `*@example.com` rules. A
domain rule matches only that exact email domain, requires a verified primary
Clerk email, and applies to both web and MCP access. Subdomains, suffix lookalikes,
partial wildcards and malformed configuration do not grant access. The requested
production policy is `*@bennetthilberg.com,bennett.hilberg@gmail.com`.

Authenticated readiness now checks that the required Prisma migration is complete.
Missing, unfinished or rolled-back migration records fail readiness;
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

## Release checkpoint

- PR #130 CI at `40ba24a` passed lint, runtime audit, 920 unit tests with coverage,
  392 database tests and 15 authenticated browser tests without retries.
- Production worker update completed successfully with artifact
  `b49dad9ebec54f23ebf98be14fc80a503dc9dc0daa96dc160472fc921ca99fdd.zip`,
  retaining configuration revision `vercel-92a7b3d9-e563-4eb7-9dbd-b7ed2171d312`
  and enabled schedules.
- Production candidate `dpl_GZ4tro8S9CK3ZF31WNCwa2cj5cQc` at `40ba24a` passed
  authenticated readiness in GitHub run `34162744777`.
- WorkOS now defines `practice:read` and `practice:write` with consent descriptions.
  The existing PKCE gate application requests both in addition to its original
  scopes. Consent and refresh proof are still pending.
- A bounded 30-job production canary is running with synthetic Spanish, French,
  technical text, numeric, symbolic and biology skills. It records real job IDs
  and outcomes in `.aws-build/production-canary.json`; resume that manifest rather
  than queueing replacement jobs if the runner is interrupted.

Deployment receipts, test output and synthetic fixture identifiers are retained
locally in ignored `.aws-build/`. Secrets are held in mode-0600 files and are not
part of these release records.

## Findings from the production trial

The PDF upload trial found a deployment packaging failure: quick-upload page
inspection imported PDF.js, whose rendering worker and native dependencies were
absent from the web function. Page counting now uses the existing `pdf-lib`
dependency. A regression test verifies it with PDF.js unavailable; full material
text extraction continues in the packaged background worker.

The first canary fixture stored rules as arrays instead of the application's
`{ items: [...] }` representation. That run is excluded from source-fidelity
evidence. The corrected run found recognition families attached to typed input:
some French prompts supplied a list containing the answer. The planner now uses
cued recall for those input slots. Generation and semantic verification prohibit
answer lists, and native and external-agent validation reject explicit lists.
Prompt and blueprint versions advance for this behavior. A new live canary is
required after deployment; neither earlier run approves this revision.

A dedicated third-party WorkOS client displayed the real consent screen. Both
the initial signed token and a rotated refresh token contain all five application
scopes. Production MCP account preference edits, read-back and restoration passed.
Collection/skill changes and revocation remain pending.
