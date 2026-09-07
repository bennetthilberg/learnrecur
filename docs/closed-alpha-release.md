# Closed alpha release verification

Release work started September 7, 2026 from merged revision `5373a3e`.
No external learner invitations are authorized or sent by this task.

## Access and schema

Production allows `*@bennetthilberg.com,bennett.hilberg@gmail.com`. Domain rules
match only that exact domain on the verified primary Clerk email. Subdomains,
suffix lookalikes, partial wildcards and malformed configuration fail closed.
The policy applies to web and MCP access. A disposable account with a verified
address on the allowed domain signed in; a fresh Gmail alias outside the exact
allowlist received HTTP 403.

Authenticated readiness requires migration
`20260906173000_retention_preferences` with non-null `finished_at` and null
`rolled_back_at`. Missing, unfinished and rolled-back records fail readiness.
Public liveness remains minimal. Unit coverage keeps the declared requirement
aligned with the latest tracked migration; database tests exercise incompatible
states inside transactions that roll back.

The authenticated CI job limit is now 45 minutes. It runs the serial database
suite and browser suite against an isolated development database.

## Database and recovery

Before migration, snapshot `snap-summer-sun-ap0yvzf0` was restored into separate
branch `br-floral-wildflower-apfy29bb`. The restored 1,376 skills, 82 attempts and
46 review logs matched production by ordered record checksums. All 32 migrations
then applied to production. Checksums of pre-existing skill, attempt and review
fields stayed identical. No historical grades, schedules or owner preferences
were changed.

The worker rollback drill restored the original artifact
`99ff029cab06b51c40efcbd19f06bfb8e8907e1c7c0a3d14e89fb053117889cf.zip` through
CloudFormation, initialized it against the current database and encrypted SSM
configuration, then restored the updated worker and repeated initialization.
Queues and schedules were retained. The application rollback drill promoted the
original web deployment `dpl_JCj7pwtJQ8L4zSgEFNZ2M6E2CR4d`, checked HTTP 200
liveness and MCP discovery, and restored the updated deployment.

These were real rollback operations, with database restoration into a separate
branch. They do not establish a longer recovery window than Neon's configured
six hours. The pre-migration snapshot remains available.

## Real OAuth and MCP settings

A disposable third-party WorkOS client displayed a fresh consent screen. PKCE
S256 authorization produced a signed token with all five application scopes,
including `practice:read` and `practice:write`. Refresh rotated the token while
preserving its issuer, resource, client, subject, grant and scopes.

Authenticated production HTTP MCP calls verified:

- Account preference and mixed review edits, read-back and restoration.
- Collection preference and Natural, Exact and Custom text policies.
- Skill preference, text policies, both Custom flags and `alreadyStudied`.
- Explicit false values, partial updates, null inheritance resets and effective
  inherited values. The browser displayed the resulting skill settings.
- Denial of a write to a different synthetic user's skill.
- Revocation from Settings: the previously valid access token received HTTP 401,
  refresh received HTTP 400 `invalid_refresh_token`, and the remote revocation
  outbox completed successfully.

The extra MCP-created technical draft reported `INVALID_GENERATION`. Its fixture
requested choice exercises while also prohibiting choice lists. It
remained a recoverable draft and served as the settings target. This is not
recorded as successful agent skill activation. PDF skill activation is proven
separately below.

## Production learner trial

A verified disposable Clerk user completed PDF upload, source processing, saved
draft review, editing and activation. The skill retained the PDF's quarter/eighth
facts and generated verified exercises. A real primary-provider HTTP 429 during
activation used the configured fallback and completed successfully.

The learner answered an exercise on mobile, received deterministic Correct
feedback with Good preselected, and saved a review. Database and export evidence
show the new FSRS schedule and preserved mixed-review context. History and
practice were checked at 1280px and 390px. The version-4 account export contained
the user's attempt and review and excluded other synthetic accounts.

Reminder settings persisted through a reload. A bounded production reminder call
for this user returned a provider message ID; repeating the same day's request
returned `already-processed`. The matching message arrived at 22:17 UTC in the recipient's iCloud Junk folder.
Its raw headers report SPF, DKIM and DMARC passing for `learnrecur.com`; both
links target the production practice and settings pages. Delivery is proven,
but inbox placement is not. The send-only API key could not read delivery
events, so the evidence comes from the recipient mailbox.

Both disposable Clerk accounts have been removed. Export followed by account
deletion succeeded after the download fix. The deletion job completed on its
first attempt: the user was absent from the database, Clerk returned HTTP 404,
the uploaded PDF returned S3 HTTP 404, and WorkOS listed no remaining grants.
All four canary fixture users have also been removed after asserting that they
contained only the expected synthetic skills and terminal generation jobs.

## Exercise quality

The valid production canary ran 30 queued jobs through SQS, Lambda, the real
providers and verification. Six subjects covered Spanish preterite accents,
French nouns, exact protocol strings, numeric fractions, polynomial derivatives
and biology transport concepts. All 60 accepted exercises were manually reviewed
for correctness, source scope and answer-mode suitability. No incorrect answer
keys or answer lists in typed recall prompts were found.

Production release record `cmtrtxvdn0000uupv2yrbnzdl` stores the final canary
observation from generation revision `05a1acf` and
passes the unchanged bounded canary policy:

| Measure | Observed |
| --- | --- |
| Completed jobs | 30 |
| Jobs with accepted exercises | 30 |
| Accepted/requested exercises | 60/65 |
| Rejected candidates | 5 |
| Critical defects | 0 |
| Job schema failures | 0 |
| Jobs using fallback | 1/30 |
| P95 queue-to-terminal persisted update | 26,891 ms |

The record describes the configured Google `gemini-3.8-flash` and Meta
`muse-spark-1.3` chain across modes. It does not claim 30 samples per provider or
mode. Latency uses `updatedAt - createdAt`, because the existing `completedAt`
field uses the caller's captured timestamp. Repeated synthetic examples do not
establish broad exercise diversity. All accepted prompts also passed the revised
contract guard after review fixes. One numeric exercise allowed tolerance
`0.0001` under the existing numeric grading contract; this canary does not
establish zero-tolerance decimal comparison. The later reminder copy correction
does not change generation code or configuration.

Separate live provider smokes passed for Gemini, Muse and a forced-primary-503
handoff. Each verifier rejected a deliberately contradictory answer key. The
forced handoff is distinguished from the real production 429 above.

## Defects found and fixed

- PDF upload inspection imported PDF.js rendering dependencies missing from the
  web deployment. Page counting now uses the existing `pdf-lib` dependency;
  full extraction continues in the packaged worker. A regression counts a real
  PDF with PDF.js unavailable.
- The initial canary fixture stored rules as arrays instead of `{ items: [...] }`.
  That run was excluded from source-fidelity evidence. A corrected run exposed
  recognition families assigned to typed input. The planner now uses cued recall
  for those slots, and versioned prompts and validators prohibit answer lists.
- Review found false positives for ordinary comma lists and numbered calculation
  instructions, plus missed inline/numbered choices. Table-driven contract tests
  cover those cases. The guard handles explicit lists; semantic verification
  still checks less regular answer cues.
- Explicitly saved recognition families and unlabelled word banks could still
  leak into typed input. The planner now filters both default and saved family
  lists, and the shared guard rejects explicit word banks. Regressions cover
  both paths and preserve valid recall and calculation prompts.
- The delivered reminder said "You have 1 skill is ready". Both HTML and plain
  text now say "1 skill is ready", with singular and plural rendering coverage.
- Export used client-side navigation, leaving subsequent Settings actions posting
  to the export endpoint, which returns HTTP 405. Both links now use native
  downloads. A browser regression reproduced the failure, then passed by saving
  preferences after each export link.
- CLI deployments do not inherit Git exclusions. `.vercelignore` excludes local
  credentials, OAuth sessions, worker artifacts and test reports. Source file
  listings verified clean uploads; the three superseded uploads containing local
  artifacts were removed from Vercel.

## Verification and release references

Local verification passed 947 unit tests, lint, Prisma validation/generation,
production builds and ARM64 worker packaging. The database suite passed 390
cases initially; its two stale prompt-version assertions passed on targeted
rerun. The complete local browser suite passed all 28 tests after the export fix.
CI run `34165917776` at `2f8b58f` passed 392 database tests and 15 authenticated
browser tests. The final revision must pass the same required CI checks before merge; current
results and merge status are linked from [PR #130](https://github.com/bennetthilberg/learnrecur/pull/130).

Two manual code-review requests have been used on PR #130. All findings are
fixed. The numbered-instruction, saved-family, word-bank, export and reminder-copy
fixes follow the last manually reviewed revision. They are not claimed to have
received a clean review of their exact head.

The generation release was promoted to web deployment
`dpl_99F7rTs6TJQ9WTae6YytVCe29SNu` and worker artifact
`5e8bbec193a41011af3fca7aaa63e99bbac6626c74c52bee0f1277f2d56f20cb.zip`.
Canonical production readiness passed in
[run 34167734433](https://github.com/bennetthilberg/learnrecur/actions/runs/34167734433).
The reminder copy correction requires a matching web and worker rollout before
release completion. Final deployment identifiers and checks belong in the PR
release receipt so that documenting them does not change the verified source.

Redacted receipts and synthetic fixture identifiers remain in ignored
`.aws-build/`. Secret files are mode 0600 and excluded from Git and deployment
source. Never publish token, connection-string or private source files.
