# LearnRecur

LearnRecur is a Mac-first fork of Anki for reviewing learned skills with varied AI-generated exercises. It schedules each skill while changing its exercises, so practice tests applying a rule rather than recognizing a fixed answer. Users reveal answers and rate their own recall through Anki's normal review flow. Ordinary Anki decks remain supported.

## Status

The repository is based on Anki 26.09.3 with its original history and source layout. LearnRecur features, an isolated app launch, and the companion service have not been implemented or verified. This is repository scaffolding, not a usable LearnRecur release.

Read [AGENTS.md](AGENTS.md) before working on the code. Development must protect existing Anki installations and collections and use synthetic data or disposable copies. Upstream run instructions require an explicit isolated profile before use.

## Structure

- `qt/`, `ts/`, `pylib/`, `rslib/`, and `proto/`: upstream desktop and library code.
- `rslib/sync/`: standalone sync-server executable; shared sync code is in `rslib/src/sync/`.
- `learnrecur/companion/`: reserved for the skill API and generation worker.
- `learnrecur/deploy/`: reserved for hosting, backups, and migration configuration.

All components share one Git repository. Anki's existing translation and installer-template submodules are retained. See [UPSTREAM.md](learnrecur/UPSTREAM.md) for the exact pin, remotes, automation status, and update procedure.

## Plan and development

[ROADMAP.md](ROADMAP.md) records the ordered milestones and verified progress. [PRODUCT-SEED.md](learnrecur/PRODUCT-SEED.md) preserves the original product plan; later decisions are recorded in the roadmap and agent guidance.

Anki's [development documentation](docs/development.md) and `justfile` remain available as build references. Read the LearnRecur guidance first. Inherited workflow jobs are inactive in this repository; application CI will follow the first build.

## License

The fork retains Anki's [license and notices](LICENSE) and [upstream contributors](CONTRIBUTORS). LearnRecur is an independent project, not an official Anki distribution.
