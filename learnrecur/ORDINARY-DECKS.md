# Check ordinary deck transfer

The package checks use synthetic Basic, typed-answer, Cloze, and HTML notes, with a small PNG and custom CSS. LearnRecur imports the package, creates and edits notes, changes a template's CSS, and reviews cards through Anki's scheduler. The checks cover Again and undo, learning and graduated cards, and persistence after reopening the collection.

Eight cases cover current and legacy `.apkg` files, with and without scheduling, using FSRS and the older scheduler. Exports that include scheduling preserve the tested card state, FSRS memory values, and review log. Exports without scheduling restore new cards with no reviews. Note fields, tags, templates, rendered questions and answers, deck names, and image bytes must match in both cases.

## Run the checks

From the repository root, after building:

```sh
./ninja pylib qt
ANKI_TEST_MODE=1 PYTHONPATH=pylib:out/pylib \
  out/pyenv/bin/python -m pytest pylib/tests/test_learnrecur_packages.py -q
```

The tests extract the pinned upstream Python library from Git commit `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`. Separate processes create the source package and import LearnRecur's exports using that library. All collections live in temporary directories. No installed Anki app or local Anki data is opened.

The two libraries share the generated bindings and built Rust bridge. The tests first check that the bridge, Rust library, protocol, binding generators, and dependency lockfile still match upstream. They stop if those sources change. At that point, build an independent upstream bridge before using these checks to claim compatibility. The fork's build configuration disables binary stripping, as described in [MAC-DEVELOPMENT.md](MAC-DEVELOPMENT.md).

CI fetches that exact commit before running the library suite. The tests do not call an AI service.

## Make a package for a Mac check

Choose fresh paths for each run. The fixture helper refuses to open an existing collection:

```sh
mkdir -p out/learnrecur/package-check
ANKI_TEST_MODE=1 PYTHONPATH=pylib:out/pylib \
  out/pyenv/bin/python -m tests.learnrecur_deck_fixture seed \
  "$PWD/out/learnrecur/package-check/source/collection.anki2" \
  "$PWD/out/learnrecur/package-check/synthetic.apkg" \
  > out/learnrecur/package-check/source.json
./tools/run-learnrecur -b "$PWD/out/learnrecur/package-check/desktop" \
  "$PWD/out/learnrecur/package-check/synthetic.apkg"
```

Import the package, edit the Basic answer, and study the deck. Check typed-answer feedback, both Cloze cards, the styled image, ratings, and Edit > Undo Answer Card. Export an Anki Deck Package with media and learning progress, then compare it in separate upstream storage. Never use the user's Anki profiles for this check.

## Checked on September 30, 2026

All eight package cases passed locally. The full suites passed with 192 library tests and 171 Qt tests. The Mac package built, its ad hoc signature passed verification, and its bundled icon matched the new seahorse ICNS.

The packaged app imported four synthetic notes and five cards through its native importer. Editing the Basic answer changed its reveal. Typed-answer feedback, Cloze reveal, HTML/CSS, and the PNG displayed correctly. Again, Hard, Good, Easy, and menu-based review undo worked. After quitting, the saved collection contained the edited answer and three reviews with ratings 3, 4, and 2. Exporting that collection through the native collection API and importing it through the pinned upstream library preserved the content, media, and scheduling snapshot.

The Mac export dialog opened, but automation could not operate its format selector. Its file-picker flow remains unchecked. Upstream compatibility was checked through its collection library, not an upstream GUI or an independently built binary. Filtered decks, audio/video, add-ons, conflicting note-type names, older releases, and collection-package restoration are outside these checks.
