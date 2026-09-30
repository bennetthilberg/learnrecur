# LearnRecur

LearnRecur is a Mac-first fork of Anki that helps learners keep skills fresh with varied AI-generated exercises. A skill comes back on its spaced-repetition schedule with a different exercise, so the learner has to apply the rule again. Users reveal the answer and rate their own recall through Anki's normal review flow. They can study ordinary Anki decks in the same app.

## Status

The repository is based on Anki 26.09.3, with its history and source layout preserved. The Mac app builds and runs with its own identity and storage. A synthetic review survives a restart. Skill cards and the companion service haven't been built yet.

Read [AGENTS.md](AGENTS.md) before working on the code. Use synthetic data. LearnRecur must never discover, load, copy, or migrate local Anki data, in development or production.

## Structure

- `qt/`, `ts/`, `pylib/`, `rslib/`, and `proto/`: upstream desktop and library code.
- `rslib/sync/`: standalone sync-server executable; shared sync code is in `rslib/src/sync/`.
- `learnrecur/companion/`: space for the skill API and generation worker.
- `learnrecur/deploy/`: space for hosting, backups, and moving between hosts.

These components share one Git repository. Anki's submodules for translations and installer templates are still in place. [UPSTREAM.md](learnrecur/UPSTREAM.md) records the exact base commit, remotes, workflow status, and update steps.

## Plan and development

[ROADMAP.md](ROADMAP.md) records the order of work and what has been checked. [PRODUCT-SEED.md](learnrecur/PRODUCT-SEED.md) preserves the original plan. Later decisions appear in the roadmap and agent guidance.

Use the [Mac build guide](learnrecur/MAC-DEVELOPMENT.md) for LearnRecur's build and run commands. Anki's [development documentation](docs/development.md) and `justfile` remain useful references. A LearnRecur workflow checks the Mac build, isolation rules, and Python tests; inherited workflow jobs remain disabled.

## License

The fork preserves Anki's [license and notices](LICENSE) and [upstream contributors](CONTRIBUTORS). LearnRecur is an independent project, not an official Anki distribution.
