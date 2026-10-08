# Upstream merge rehearsal

On October 7, 2026, a disposable worktree merged 29 upstream development commits into LearnRecur. The merge needed one startup conflict resolved and two new workflow jobs disabled. The stable base remains Anki 26.09.3; this rehearsal is not a release upgrade.

## Commits and fixes

| Input | Exact commit |
| --- | --- |
| Stable Anki base | `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba` |
| LearnRecur after PR 31 | `f1e0386d6e221558de6e78a26d5e81b64e5d9a57` |
| Upstream development snapshot | `a13d8a6e9e91d87eb046bf7b26ee64880a4eb544` |
| Local rehearsal merge | `c1e1b8a0219f1aafdb53041e7a7fbef2947cd0fe` |

The snapshot changed 50 files, mainly adding upstream tests. It also changed graphics setup, typed-answer comparison, Browser selections, and full-sync downloads. Submodule pins and the collection schema version did not change.

`qt/aqt/__init__.py` was the only conflicted file. Keep LearnRecur's `APP_NAME`, `APP_ID`, organization settings, desktop file name, and base-specific single-instance key. Pass upstream's new `safe_mode` argument to `AnkiApp` so its graphics setup can run before Qt starts. Keep the `pm` check before single-instance detection; rejected data folders must still follow LearnRecur's error path.

The new `.github/workflows/sync-release.yml` had two unguarded jobs: `flathub` and `create-pr`. Add `github.repository == 'ankitects/anki'` to both job conditions. They publish or manage upstream releases and must not run in LearnRecur. After that change, all nine inherited workflows and 34 jobs were restricted to upstream. Scheduled Dependabot version PRs stayed paused.

The reviewer and full-sync code merged without conflicts. Inspection confirmed that skill review bookkeeping and the download path's saved identities, reports, and report outbox remained in place. Tests and native checks below exercised those paths.

## Checks

All builds used the rehearsal's own outputs. Synthetic data stayed in ignored storage; no personal Anki data, provider key, paid call, or Azure change was involved.

| Check | Result |
| --- | --- |
| Fresh Mac library and Qt build | Passed in 85 seconds |
| Python library suite | 365 passed, including eight ordinary package round trips through the independent Anki 26.09.3 wheel |
| Qt suite | 318 passed, including four new upstream startup cases and LearnRecur isolation checks |
| Rust library suite | 747 passed, including full sync, scheduling, and undo |
| Companion and deployment suites | 430 passed, including the matching standalone server, two-client sync, interruption, and backup recovery |
| Mac package and signature | Built in 78 seconds; `codesign --verify --deep --strict` passed |
| Linux ARM64 image and encrypted restore | Passed; fresh client recovered two cards, four reviews, media, identities, and nine exercises; final handoff preserved five reviews and a mocked later charge |
| Focused Python lint | Passed for startup, collection, and reviewer |

The packaged Mac app ran with outbound networking blocked except for loopback, in an explicitly named synthetic profile. Report-and-skip moved from *hablar* to *trabajar* without changing any card row or recording a rating. Native undo restored *hablar* and removed the exclusion; redo restored the exclusion. Reveal showed the saved answer and explanation. Again recorded one review and advanced to *comprar*. Rating undo restored the exact pre-rating card rows, and redo restored the review.

An ordinary typed-answer card accepted *casa*, displayed native answer feedback, and recorded a Good rating. Restart preserved both cards, both review rows, and the reported exercise exactly. Reopening the skill showed *comprar*, with no model call. The app closed normally after both launches.

The Linux check used `learnrecur-backend:upstream-rehearsal`, built from the local merge, with its full commit recorded in the image label. An encrypted backup restored into a separate deployment; a damaged archive failed authentication. A queued fixture job resumed once. A final handoff preserved a later mocked provider charge, exercises, and reviews while the older backup stayed blocked from paid generation. Test containers were removed afterward. This was ARM64 Linux on the Mac's Docker host; x86-64 and a separate VPS were not checked for this snapshot.

## Repeat the check

Use a disposable checkout starting at the recorded LearnRecur commit. Fetch the exact upstream target, then merge it locally:

```sh
git fetch upstream main
git merge --no-commit --no-ff a13d8a6e9e91d87eb046bf7b26ee64880a4eb544
```

Apply the startup resolution and workflow guards described above. Commit the local rehearsal, initialize the pinned submodules, and run from that checkout:

```sh
git submodule update --init ftl/core-repo ftl/qt-repo qt/installer/mac-template
./ninja pylib qt
cargo build --locked -p anki-sync-server
./ninja check:pytest:pylib check:pytest:aqt
cargo test -p anki --lib
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m pytest learnrecur/companion/tests learnrecur/deploy/tests -q
./ninja installer:package
codesign --verify --deep --strict out/installer/build/anki/macos/app/LearnRecur.app
```

Follow [the Mac development notes](MAC-DEVELOPMENT.md) for isolated launch and [the Linux restore check](deploy/LINUX.md#check-the-setup-before-a-vps) for the container proof. Don't reuse another checkout's compiled bridge or an existing learner profile.

## Effort and limits

The rehearsal took about 20 minutes through the local restore check. The conflict and workflow fixes took roughly five minutes to inspect and apply. The Linux server compiled in 2 minutes 21 seconds, and the restore check took 9 seconds. Automated checks and the native user path took more time than conflict resolution. This small update was manageable, but 29 commits without toolchain or submodule upgrades do not predict the cost of a major release or a long gap between updates.

This checks one Mac and the local test environments, not daily use or a live server upgrade. The existing Mac accessibility issue remains outside this rehearsal's scope. Private logs and synthetic evidence are under `out/learnrecur/upstream-*` in the original checkout. The local merge stays unpushed and can be recovered from its archived worktree. Keep reviewing stable releases; rehearse the next selected tag and rerun these checks before upgrading.
