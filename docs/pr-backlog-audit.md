# Pull request backlog audit — September 17, 2026

The audit starts from `28b3925`, which includes the Heroku migration and its
review fixes. Dependency work preserves `@prisma/adapter-pg`, verified TLS,
bounded pools, disposable PostgreSQL CI, and all current application code.

| PR | Disposition and reason |
| --- | --- |
| #119 | Closed as superseded: `js-yaml` 4.3.2 already exists in main's lockfile. |
| #118 | Closed as superseded: Browserslist 4.28.8 and its supporting data are already present (Electron data is newer). |
| #117 | Closed as superseded: main already resolves brace-expansion to patched 1.1.18; the old nested vulnerable package is absent. |
| #122 | Closed as unsuitable for this runtime: Node 26 declarations describe APIs beyond deployed Node 24. A future types refresh should target Node 24, not advance the declared runtime implicitly. |
| #123 | Closed as incompatible: the proposed TypeScript 7 compiler is rejected by the current typescript-eslint stack. CI run 34393198747 fails with its explicit unsupported-compiler error. Keep TypeScript 6 until the complete lint/build toolchain supports the replacement. |
| #125 | Closed as incompatible: ESLint 10 CI run 34393230420 fails because minimatch expects brace-expansion's newer API. Existing Next plugins also need coordinated compatibility review. Keep ESLint 9 rather than force an invalid peer graph. |
| #116 | Fold concurrently 10.0.5 into #139. Preserve main's newer shell-quote 1.10.0 override instead of downgrading to 1.9.0. Close once the combined update is merged. |
| #124 | Fold Undici 8.10.2 into #139 and verify URL-ingestion security tests and builds. Its declared Node requirement is >=22.19.0, compatible with Node 24. Close once the combined update is merged. |
| #133 | Reconciled into replacement #139. Dependabot automatically closed and deleted its branch after the update; the complete reconciled commit is preserved in #139. The obsolete Neon adapter upgrade becomes matching PostgreSQL adapter/client/CLI 7.10.0. |
| #134 | Fold the useful release evidence into #139, explicitly label it as the September 9 historical receipt, and link to the current Heroku hosting record. Close the original after integration. |

Dependabot also opened #140 during the audit. It was closed because it overlaps
#139 and again bundles the held-back Clerk, Compute Engine, and React Native
changes. Later releases should be evaluated separately from this verified batch.

## Deliberately retained dependencies

The original #133 is not safe to merge unchanged. CI run 34523716476 shows its
Cortex Compute Engine upgrade incorrectly grading `(x + 1)^2`. Keep 0.58.0;
changing answer-checking semantics requires a separate compatibility migration,
not weaker expected results.

Keep Clerk backend 3.16.13 and Next integration 7.4.2. The proposed upgrade
removes keyless local development, as the existing review notes. A future
upgrade must deliberately update the local setup contract and test it.

Keep React Native 0.84.1, which is a peer dependency in this web project. The
proposed pre-1.0 minor jump must not be bundled with an unrelated database
migration while Metro remains pinned to the existing compatible release.

Updated packages use the original PR's exact proposed versions so installation does not
silently select later releases. Mantine packages remain aligned with one another.
The existing security overrides remain, with PostCSS advanced consistently.

## Validation

Local installation, lint, Prisma validation/generation, web and worker builds,
and runtime auditing passed. The combined unit/database run passed 1,699 tests
and the coverage gates (81.70% lines and 72.42% branches). The initial browser
run passed 123 of 124 tests; the mobile fast-animation check failed once, then
passed three consecutive repeats at both viewport sizes without changes. A full
rerun and hosted checks remain required before merging. Hosted CI must check
the actual updated PR head.
The historical receipt changes documentation only; no production configuration
or application code is reverted by its merge.
