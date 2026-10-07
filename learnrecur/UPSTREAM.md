# Upstream base

- Repository: [ankitects/anki](https://github.com/ankitects/anki).
- Release: [26.09.3](https://github.com/ankitects/anki/releases/tag/26.09.3).
- Commit: `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`.
- Imported on September 30, 2026, with its full Git history.

Use this commit as the base when reviewing LearnRecur's changes. The desktop app and standalone sync server come from the same release. Keep Anki's source paths, license, notices, and submodule references intact.

## Remotes and components

`origin` points to `https://github.com/bennetthilberg/learnrecur.git`. `upstream` points to `https://github.com/ankitects/anki.git`. We kept the existing LearnRecur repository. Its shared history lets us merge upstream changes without a GitHub fork badge.

Desktop changes belong in Anki's existing source tree. The standalone sync-server executable is in `rslib/sync/`, and shared sync code is in `rslib/src/sync/`. The companion service goes in `learnrecur/companion/`, and deployment configuration goes in `learnrecur/deploy/`.

Anki uses four submodules for translations and installer templates. Their pinned references are unchanged. All four have been initialized locally for the Mac build and package checks.

## Inspect the fork

From the repository root:

```sh
git status --short
git diff 26.09.3 --stat
git diff 26.09.3 -- qt ts pylib rslib proto
```

LearnRecur changes application identity, storage, updater behavior, and build configuration. The Mac build, package, isolation tests, and a synthetic review have passed locally. Hosted sync and restoration have passed synthetic checks on separate Linux hosts, including Azure; see [the Linux deployment notes](deploy/LINUX.md). Read `AGENTS.md` and [MAC-DEVELOPMENT.md](MAC-DEVELOPMENT.md) before following upstream run instructions.

## Update from upstream

1. Start from a clean working tree. Create a disposable worktree for the rehearsal so the current app and backend stay available. Fetch the selected stable tag from `upstream` and record its exact commit.
2. Merge that commit without pushing. Preserve its history instead of copying files from an archive. Resolve conflicts while preserving LearnRecur's identity, storage isolation, native review behavior, and sync metadata.
3. Audit every resulting workflow job, including newly added workflows. A job inherited from Anki must require `github.repository == 'ankitects/anki'` unless it has been adapted for LearnRecur. Check dependency automation, agent instructions, update destinations, profile paths, publishing targets, and submodule pins too.
4. Build the desktop app and matching sync server in the worktree's own output folders. Run the Python and Qt suites, affected Rust tests, ordinary package round trips, and two-client sync checks. Package and sign-check the Mac app, then exercise review, report-and-skip, undo/redo, and restart in fresh synthetic storage. Use only explicit LearnRecur profiles and disposable loopback services.
5. Build the matching Linux image and run encrypted backup restoration with a fresh native client. Keep the checked image and a recovery copy of the current deployment before a real upgrade.
6. Record the conflicts, fixes, elapsed effort, checks, and limits. Open an update PR only for a selected stable release. Change the base recorded here when that update lands, and handle deployment separately.

The [October 7 rehearsal](UPSTREAM-REHEARSAL.md) checked 29 commits on upstream's development branch. It did not change this stable base or the deployed services. A development snapshot can help measure merge effort, but it doesn't replace a stable-release update.

## Workflow status

All eight inherited workflows still contain their original jobs, with added conditions that allow them to run only in `ankitects/anki`. Their 32 jobs do not run in LearnRecur. These include CI, SonarCloud, release and package publishing, cache pruning, and PR-management bots. LearnRecur's Mac and Linux workflows build and test the fork. They don't publish releases or deploy services.

Dependabot's four version-update groups have `open-pull-requests-limit: 0` while the fork is pinned. GitHub security-update settings are separate. Revisit dependency updates after the first build, and check for security fixes when reviewing upstream releases.
