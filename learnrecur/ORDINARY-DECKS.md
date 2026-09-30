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
PYTHONPATH=qt/tests out/pyenv/bin/python - <<'PY'
from pathlib import Path
from launch_anki_for_e2e import _seed_prefs
base = Path("out/learnrecur/package-check/desktop")
base.mkdir()
_seed_prefs(base)
PY
./tools/run-learnrecur -b "$PWD/out/learnrecur/package-check/desktop" -p test \
  "$PWD/out/learnrecur/package-check/synthetic.apkg"
```

Import the package, edit the Basic answer, and study the deck. Check typed-answer feedback, both Cloze cards, the styled image, ratings, and Edit > Undo Answer Card. Export an Anki Deck Package with media and learning progress, then compare it in separate upstream storage. Never use the user's Anki profiles for this check.

### Repeat the native upstream check

Save the GUI export as `out/learnrecur/package-check/reviewed.apkg`, with media, scheduling information, and deck presets included. Quit LearnRecur before taking the expected snapshot:

```sh
PYTHONPATH=pylib:out/pylib out/pyenv/bin/python - <<'PY'
import json
from pathlib import Path
from anki.collection import Collection
from tests.learnrecur_deck_fixture import DECK, content, scheduling
root = Path("out/learnrecur/package-check").resolve()
col = Collection(str(root / "desktop/test/collection.anki2"))
try:
    preset = col.decks.config_dict_for_deck_id(col.decks.id(DECK))
    for key in ("id", "mod", "usn"):
        preset.pop(key, None)
    snapshot = {"content": content(col), "scheduling": scheduling(col), "preset": preset}
    (root / "expected.json").write_text(json.dumps(snapshot))
finally:
    col.close()
PY
curl -fL https://github.com/ankitects/anki/releases/download/26.09.3/anki-26.09.3-mac-apple.dmg \
  -o out/learnrecur/package-check/anki.dmg
out/pyenv/bin/python qt/tools/prepare_anki_compatibility_app.py \
  out/learnrecur/package-check/anki.dmg \
  out/learnrecur/package-check/reviewed.apkg \
  out/learnrecur/package-check/upstream
out/learnrecur/package-check/upstream/AnkiCompatibility.app/Contents/MacOS/Anki \
  "$PWD/out/learnrecur/package-check/reviewed.apkg"
```

The preparation script checks the exact release hash and signature, requires fresh storage below this checkout's `out/learnrecur`, and rejects symlinked paths. The copied app always uses its new test profile, even when opened without arguments. Its wrapper permits only the named synthetic package. It has a separate bundle identity and single-instance key, with no document associations. The script verifies the final signature and checks that the upstream Rust bridge remains byte-identical.

In Anki's native importer, enable learning progress and deck presets, then import. Check the deck and a reveal without rating another card. Quit the app before comparing its saved collection. This command loads the release's own library and bridge and checks their paths:

```sh
PYTHONPATH="$PWD/out/learnrecur/package-check/upstream/AnkiCompatibility.app/Contents/Resources/app_packages:$PWD/pylib" \
  out/pyenv/bin/python - <<'PY'
import inspect
import json
from pathlib import Path
from anki import _rsbridge
from anki.collection import Collection
from tests.learnrecur_deck_fixture import DECK, content, scheduling
root = Path("out/learnrecur/package-check").resolve()
packages = root / "upstream/AnkiCompatibility.app/Contents/Resources/app_packages"
assert Path(inspect.getfile(Collection)).is_relative_to(packages)
assert Path(_rsbridge.__file__).is_relative_to(packages)
col = Collection(str(root / "upstream/upstream-profile/test/collection.anki2"))
try:
    preset = col.decks.config_dict_for_deck_id(col.decks.id(DECK))
    for key in ("id", "mod", "usn"):
        preset.pop(key, None)
    actual = {"content": content(col), "scheduling": scheduling(col), "preset": preset}
    assert actual == json.loads((root / "expected.json").read_text())
    assert col.db.scalar("pragma integrity_check") == "ok"
    (root / "restored.json").write_text(json.dumps(actual))
    print("Content, media, deck preset, scheduling, and review history match")
finally:
    col.close()
PY
```

## Checked on September 30, 2026

All eight package cases passed locally. The full suites passed with 192 library tests and 178 Qt tests, including seven checks of the upstream preparation script's storage guards. The prepared app passed another native import and exact persisted collection comparison. The Mac package built, its ad hoc signature passed verification, and its bundled icon matched the new seahorse ICNS.

The packaged app imported four synthetic notes and five cards through its native importer. Editing the Basic answer changed its reveal. Typed-answer feedback, Cloze reveal, HTML/CSS, and the PNG displayed correctly. Again, Hard, Good, Easy, and menu-based review undo worked. After quitting, the saved collection contained the edited answer and three reviews with ratings 3, 4, and 2. Exporting that collection through the native collection API and importing it through the pinned upstream library preserved the content, media, and scheduling snapshot.

The native Mac export and upstream import also passed. File > Export produced a current-format `.apkg` with media, scheduling information, and deck presets checked. The native Save dialog saved the synthetic package to Documents; it was then moved to `out/learnrecur/milestone2/gui-export.apkg`. The upstream importer added all four notes and five cards with learning progress and deck presets enabled. After restarting upstream, the deck showed the same counts and three studied cards. Its reviewer displayed and revealed a Cloze card correctly without submitting another rating.

After closing both apps, the upstream release's own Python library and Rust bridge read the imported GUI collection. Its note GUIDs, fields, tags, templates, CSS, rendered questions and answers, deck names, image bytes, card scheduling, and all three review records matched the LearnRecur snapshot. The cards included new, learning, and review states. The deck preset also matched after excluding its database ID and sync metadata. SQLite's integrity check returned `ok`. A separate import through the release library produced the same result.

This completes milestone 2's tested ordinary-deck round trip. No skill feature was added, and neither the installed Anki app nor the user's Anki data was opened.

### Upstream app and local evidence

The GUI check used a fresh download of [Anki 26.09.3 for Apple Silicon](https://github.com/ankitects/anki/releases/download/26.09.3/anki-26.09.3-mac-apple.dmg). Its Developer ID signature verified before copying. The private copy, `out/learnrecur/milestone2/AnkiCompatibility.app`, has a separate bundle identity, no document associations, and a small launch wrapper that always supplies the disposable base folder and a separate single-instance key. It accepts only this synthetic package or no arguments. It was signed again with an ad hoc signature, which also verified. The upstream `anki` and `aqt` packages were copied unchanged; the Rust bridge remained byte-identical to the downloaded release after signing. This check uses upstream's independent bridge, unlike the eight source-library cases above.

| Artifact | SHA-256 |
| --- | --- |
| GUI-exported package | `87e29a2cf00017dadd60d096c63cfa98abb7df58c65251c25c999be884828d40` |
| Upstream disk image | `b36fe8f6c015a602feaf3ef38f5967c27c8964ee30a5c74ca2532225cf602345` |
| Upstream Rust bridge | `64db6db082deff445696471ea8939fb8bfc06635973f50779070ed638675cd6e` |

The ignored `out/learnrecur/milestone2/` folder holds `expected.json`, `upstream-gui-restored.json`, `released-api.json`, `upstream-app-provenance.json`, and screenshots of the native import and Cloze reveal. The source profile is `out/learnrecur/ordinary-ui`; upstream's profile is `out/learnrecur/milestone2/upstream-profile`. Collections, packages, and runtime logs stay out of Git.

To reopen this prepared test app without importing again:

```sh
out/learnrecur/milestone2/AnkiCompatibility.app/Contents/MacOS/Anki
```

For another run, use the preparation script and comparison commands above. Never launch the installed Anki app for this check.

### Remaining limits

Opening Browse during Mac UI automation crashed both LearnRecur and the private upstream release with exit code 139. The cause hasn't been established. Export, import, restart, and Cloze reveal passed, but the Browse path needs investigation before claiming the Mac app is dependable. The successful export session used `QTWEBENGINE_CHROMIUM_FLAGS=--disable-renderer-accessibility`; this is a local test setting, not a product change or a confirmed crash fix.

Filtered decks, audio/video, add-ons, conflicting note-type names, older releases, and collection-package restoration remain outside these checks. Notarization and distribution on other Macs are also unverified.
