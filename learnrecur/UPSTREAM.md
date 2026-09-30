# Upstream base

- Repository: [ankitects/anki](https://github.com/ankitects/anki).
- Release: [26.09.3](https://github.com/ankitects/anki/releases/tag/26.09.3).
- Commit: `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`.
- Imported on September 30, 2026, with its full Git history.

Use this commit as the base when reviewing LearnRecur's changes. The desktop app and standalone sync server come from the same release. Keep Anki's source paths, license, notices, and submodule references intact.

## Remotes and components

`origin` points to `https://github.com/bennetthilberg/learnrecur.git`. `upstream` points to `https://github.com/ankitects/anki.git`. We kept the existing LearnRecur repository. Its shared history lets us merge upstream changes without a GitHub fork badge.

Desktop changes belong in Anki's existing source tree. The standalone sync-server executable is in `rslib/sync/`, and shared sync code is in `rslib/src/sync/`. The companion service goes in `learnrecur/companion/`, and deployment configuration goes in `learnrecur/deploy/`.

Anki uses four submodules for translations and installer templates. Their pinned references are unchanged, but we haven't downloaded them yet. Initialize the dependencies needed for the build when working on milestone 1.

## Inspect the fork

From the repository root:

```sh
git status --short
git diff 26.09.3 --stat
git diff 26.09.3 -- qt ts pylib rslib proto
```

So far, we've changed documentation and automation. We haven't checked the build, application identity, separate profile path, or sync behavior. Read `AGENTS.md` before following upstream run instructions.

## Update from upstream

1. Start from a clean working tree on a dedicated `a/` update branch.
2. Fetch and merge the selected stable release tag from `upstream`. Preserve its history instead of copying files from an archive.
3. Check changed workflows, dependency automation, agent instructions, app identity, update destinations, and profile paths. Keep publishing and PR-management jobs disabled unless they've been adapted for LearnRecur.
4. Run the relevant checks, including Mac launch isolation and sync compatibility. Review changes to upstream submodule pins.
5. Update the base commit here and record the results and remaining problems in the roadmap.

## Workflow status

All eight inherited workflows still contain their original jobs, with added conditions that allow them to run only in `ankitects/anki`. Their 32 jobs do not run in LearnRecur. These include CI, SonarCloud, release and package publishing, cache pruning, and PR-management bots. We haven't added LearnRecur application CI yet.

Dependabot's four version-update groups have `open-pull-requests-limit: 0` while the fork is pinned. GitHub security-update settings are separate. Revisit dependency updates after the first build, and check for security fixes when reviewing upstream releases.
