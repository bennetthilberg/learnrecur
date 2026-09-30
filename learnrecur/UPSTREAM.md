# Upstream base

- Repository: [ankitects/anki](https://github.com/ankitects/anki).
- Release: [26.09.3](https://github.com/ankitects/anki/releases/tag/26.09.3).
- Commit: `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`.
- Imported on September 30, 2026, with full Git ancestry.

This file records the base from which LearnRecur changes are measured. The desktop app and standalone sync server come from the same release. Keep Anki's source paths, license, notices, and existing submodule references intact.

## Remotes and components

`origin` points to `https://github.com/bennetthilberg/learnrecur.git`. `upstream` points to `https://github.com/ankitects/anki.git`. The existing LearnRecur GitHub repository is retained; a GitHub fork badge is not required for shared ancestry or upstream merges.

Desktop changes belong in Anki's existing source tree. The standalone sync-server executable is in `rslib/sync/`; shared sync code is in `rslib/src/sync/`. LearnRecur's companion service and deployment configuration live in `learnrecur/companion/` and `learnrecur/deploy/`.

Anki already uses four submodules for translations and installer templates. Their pinned references are preserved. They have not been initialized as part of repository preparation; initialize the required dependencies when establishing the build.

## Inspect the fork

From the repository root:

```sh
git status --short
git diff 26.09.3 --stat
git diff 26.09.3 -- qt ts pylib rslib proto
```

Repository preparation changes documentation and automation only. A build, application identity, isolated launch, and sync behavior have not been verified. Read `AGENTS.md` before following upstream run instructions.

## Carry upstream updates

1. Start from a clean working tree on a dedicated `a/` update branch.
2. Fetch the selected stable release tag from `upstream` and merge that tag. Preserve its ancestry; do not replace the source with a copied archive.
3. Review new and changed workflows, dependency automation, agent instructions, packaging identity, update destinations, and profile paths. Keep upstream publishing and PR-management jobs inactive in LearnRecur unless deliberately adapted.
4. Run relevant checks and the isolated Mac and sync compatibility checks. Review changes to Anki's existing submodule pins.
5. Update this pin and the roadmap with evidence and remaining limitations.

## Automation status

All eight inherited workflows retain their job definitions, with conditions that restrict execution to `ankitects/anki`. Their 32 jobs therefore stay inactive in LearnRecur. This includes CI, SonarCloud, release/package publishing, cache pruning, and PR-management bots. Focused LearnRecur CI has not been added yet.

Dependabot's four version-update groups have `open-pull-requests-limit: 0` while the fork is pinned. GitHub security-update settings are separate from those limits. Revisit dependency maintenance after the first build; review security fixes alongside upstream releases.
