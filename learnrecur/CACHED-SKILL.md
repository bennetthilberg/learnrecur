# Review one cached skill

The first skill practices **yo in the preterite of regular Spanish -ar verbs**. Three manually written exercises use *hablar*, *trabajar*, and *comprar*. Each asks for the same conjugation in a simple sentence. The skill excludes spelling changes, irregular verbs, other persons, and other tenses.

The skill has one native note, one card, and one schedule. Its note type has an explicit `learnrecur: "skill-v1"` metadata marker; the field name alone does not change ordinary review. Its `LearnRecurSkill` field holds a versioned JSON exercise bank with a stable skill ID, revision, and exercise IDs. Exercises are plain text. The reviewer escapes HTML and native typed-answer markers, then pins both sides of the selected exercise. Reveal, redraw, or leaving review does not consume it.

Rating saves a small `lr` cursor in native card custom data. The answer operation checks the current bank and cursor before calling Anki's scheduler. The cursor, schedule, and review record commit together. Native undo and redo restore them together. This uses the existing Python and Rust answer path; no scheduler or protocol changes are needed.

The bank cycles through eligible exercises. Reported and retired items are excluded. An empty or malformed bank, or one that changes during a review, leaves the card unrated and shows **Back to deck**. Auto-advance stops scheduling timers while this error is shown. A changed bank starts a new cursor while retaining the card's review history. Native custom data has a 100-byte limit; a rating that cannot fit the cursor is rejected without consuming the exercise.

This is a local review proof. Generation, companion storage, sync reconciliation, skill editing, and report-and-skip controls remain later work. Previews and ordinary exports show the template's fixed example, not the current variation. The bank and cursor travel with the native collection, but this does not establish the complete backup or two-service sync design.

## Repeat the Mac check

Run from the repository root. Use fresh fixture and profile folders under `out/learnrecur`; the seed helper rejects existing folders, paths outside that storage, and symlinks.

```sh
export PATH="/Users/main/.cargo/bin:$PATH"
./ninja pylib qt
./ninja installer:package
ANKI_TEST_MODE=1 PYTHONPATH=pylib:out/pylib out/pyenv/bin/python \
  pylib/tests/learnrecur_skill_fixture.py \
  out/learnrecur/skill-seed/collection.anki2 \
  out/learnrecur/skill-seed/spanish-skill.apkg

PYTHONPATH=qt/tests out/pyenv/bin/python - <<'PY'
from pathlib import Path
from launch_anki_for_e2e import _seed_prefs
base = Path("out/learnrecur/skill-proof").resolve()
base.mkdir()
_seed_prefs(base)
PY

out/installer/build/anki/macos/app/LearnRecur.app/Contents/MacOS/LearnRecur \
  -b "$PWD/out/learnrecur/skill-proof" -p test \
  "$PWD/out/learnrecur/skill-seed/spanish-skill.apkg"
```

Import the package. Press `/`, choose **Spanish skill**, and start studying. Reveal *hablé*, rate Again, and check that the next prompt uses *trabajar*. Press `u` to undo: the *hablar* prompt and new-card state return. Rate Again once more, reveal *trabajé*, and quit without rating it. Reopen the same profile: *trabajar* remains next.

For the offline check, quit first and use this process-only network restriction. It blocks outbound IP connections except loopback, which Anki's local reviewer server needs. The temporary Qt flags avoid nested sandbox startup failure and reduce accessibility problems during automation. They are not app defaults.

```sh
QTWEBENGINE_DISABLE_SANDBOX=1 \
QTWEBENGINE_CHROMIUM_FLAGS=--disable-renderer-accessibility \
/usr/bin/sandbox-exec -p \
  '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))' \
  out/installer/build/anki/macos/app/LearnRecur.app/Contents/MacOS/LearnRecur \
  -b "$PWD/out/learnrecur/skill-proof" -p test
```

Reveal and rate *trabajar*. The next prompt uses *comprar*, whose answer is *compré*. Undo restores *trabajar*. The **Ordinary sample** deck also contains a native typed-answer card; enter *casa*, reveal, and rate Good. It must keep ordinary behavior and have no skill cursor.

## Checked on September 30, 2026

- The packaged Mac app passed native import, paired reveal, Again, variation, undo, and restart. These first checks used normal app defaults.
- The process sandbox rejected an external socket connection with `PermissionError` and allowed loopback. Under that restriction, the app passed cached reveal, Again, variation, undo, and ordinary typed-answer review.
- After quitting, the collection contained one skill card with two Again review records and cursor `2`. The third exercise was next. The ordinary card had one Good record and no skill cursor.
- The library and Qt tests cover all four ratings with FSRS on/off, undo/redo, restart, failed native answers, stale or unavailable banks, plain-text escaping, answer preloading, redraw, and ordinary typed-answer behavior. The eight ordinary-deck round trips still pass.
- The Mac installer package builds and its ad hoc signature verifies. This remains a development package, not a notarized release.

Automation also crashed while querying macOS accessibility during deck navigation. The stack reaches Qt accessibility and `__AXCopyAttributeValueForHierarchy`, matching the earlier Browse failure in LearnRecur and upstream Anki. The retry passed with the test flags above, but the cause and accessibility reliability remain unresolved. No real Anki data or installation was used.
