# Build and run on Mac

LearnRecur uses its own data in development and production. It doesn't discover or import local Anki profiles, preferences, decks, add-ons, or media. Use synthetic data for testing.

## Build

Install Xcode and its command-line tools, Rustup, and Ninja or N2. The build downloads the pinned Rust and Python versions and other dependencies. Keep Rustup's `bin` directory on your `PATH`.

From the repository root:

```sh
./ninja pylib qt
```

This builds the app without launching it. Don't run the build as root.

## Run

For development:

```sh
./tools/run-learnrecur
```

This builds and launches with data in `out/learnrecur/dev-data`. The first launch asks for a language and creates a new profile. Its data persists until you remove that disposable folder.

For another synthetic profile:

```sh
./tools/run-learnrecur -b "$PWD/out/learnrecur/another-test"
```

The app accepts `LEARNRECUR_BASE` or `-b` for a separate folder. The folder must be empty or contain LearnRecur's `.learnrecur-data` marker. It rejects Anki folder names and nonempty folders without that marker. Don't add a marker to an existing Anki folder or copy its contents into LearnRecur.

Launching `./run` or the packaged app without an override uses `~/Library/Application Support/LearnRecur`. This is the production default. `ANKI_BASE` and `ANKI_SINGLE_INSTANCE_KEY` have no effect. The local web server uses a free loopback port; development overrides use `LEARNRECUR_API_PORT` and `LEARNRECUR_API_HOST`.

Anki's desktop updater is disabled. Sync requires a separate server URL in Preferences. The desktop's old `--syncserver` shortcut is disabled; server setup belongs to a later milestone.

## Check

```sh
./ninja check:pytest:pylib check:pytest:aqt
PYTHONPATH=pylib:qt:out/pylib:out/qt:qt/tools \
  out/pyenv/bin/python -m pytest qt/tests/test_learnrecur.py -q
out/pyenv/bin/ruff check qt/aqt/learnrecur.py qt/tests/test_learnrecur.py
```

The Qt suite includes installer checks that need the Mac template:

```sh
git submodule update --init qt/installer/mac-template
```

Isolation tests use fake Anki folders in temporary directories. They check ignored Anki settings, rejected existing folders, symbolic links, updater entry points, and the missing sync-server case. They don't read the user's Anki data.

## Build a local package

```sh
./ninja installer:package
codesign --verify --deep --strict \
  out/installer/build/anki/macos/app/LearnRecur.app
```

The app is in `out/installer/build/anki/macos/app/LearnRecur.app`; the disk image is in `out/installer/dist/`. The inherited internal Briefcase key is still `anki`, but the executable and app are named LearnRecur and the bundle ID is `io.github.bennetthilberg.learnrecur.anki`.

Run the full package target before checking the signature. The build target alone changes Python resources after Briefcase signs them; the package step signs the final bundle again. Without `SIGN_IDENTITY`, it uses an ad hoc signature. This has been checked locally, but notarization and distribution on other Macs haven't been checked.

Rust 1.97.1's debug stripping produced a library macOS 27 couldn't load. The bridge's development and release profiles disable stripping to avoid that [Rust issue](https://github.com/rust-lang/rust/issues/157750). Keep the workaround until a tested toolchain update makes it unnecessary.

## Check a review and restart

Create a synthetic Basic card in a disposable LearnRecur profile. Open its deck, study it, reveal the answer, and rate it Good. Quit normally, then reopen with the same base folder. Check that the card and its review state remain. Use Browse > Card Info to inspect its history.

On September 30, 2026, the packaged app passed this check with “What is 2 + 3?” and “5”. Good recorded one review with rating 3, one repetition, and a learning state. After restart, the deck showed one learning card and one studied card. The disabled updater and separate-server sync message were checked in the app too.

That check proves a native review persists in LearnRecur storage. Ordinary-deck export and import compatibility still need the next milestone's round-trip checks.
