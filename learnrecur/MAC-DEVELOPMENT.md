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

On Mac, startup disables Qt WebEngine's search through Chrome folders for its Widevine DRM plugin. Protected streaming media is not supported. [MAC-ACCESSIBILITY.md](MAC-ACCESSIBILITY.md) records the separate accessibility crash and the blocked-data-access notification.

Anki's desktop updater is disabled. Sync requires a separate server URL in Preferences. The desktop's old `--syncserver` shortcut is disabled; server setup belongs to a later milestone.

On startup, a separate background check compares the system clock with Cloudflare's HTTPS `Date` header. It sends no profile or collection data and warns before closing the app if the clock differs by more than five minutes, allowing for response time. This check still runs with updates disabled. If the network, certificate verification, or response is unavailable, offline review remains available and the clock isn't verified.

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

Isolation tests use fake Anki folders in temporary directories. They check ignored Anki settings, rejected existing folders, symbolic links, downgrade paths, updater entry points, custom-server login, and clock checks. They don't read the user's Anki data.

## Build a local package

```sh
./ninja installer:package
codesign --verify --deep --strict \
  out/installer/build/anki/macos/app/LearnRecur.app
```

The app is in `out/installer/build/anki/macos/app/LearnRecur.app`; the disk image is in `out/installer/dist/`. The inherited internal Briefcase key is still `anki`, but the executable and app are named LearnRecur and the bundle ID is `io.github.bennetthilberg.learnrecur.anki`.

Installer builds and packaging are restricted to Mac. Linux and Windows still have inherited Anki installation paths and must be isolated before those packages can be enabled.

Run the full package target before checking the signature. The build target alone changes Python resources after Briefcase signs them; the package step signs the final bundle again. Without `SIGN_IDENTITY`, it uses an ad hoc signature. This has been checked locally, but notarization and distribution on other Macs haven't been checked.

Rust 1.97.1's debug stripping produced a library macOS 27 couldn't load. The bridge's development and release profiles disable stripping to avoid that [Rust issue](https://github.com/rust-lang/rust/issues/157750). Keep the workaround until a tested toolchain update makes it unnecessary.

## Check a review and restart

Create a synthetic Basic card in a disposable LearnRecur profile. Open its deck, study it, reveal the answer, and rate it Good. Quit normally, then reopen with the same base folder. Check that the card and its review state remain. Use Browse > Card Info to inspect its history.

On September 30, 2026, the packaged app passed this check with “What is 2 + 3?” and “5”. Good recorded one review with rating 3, one repetition, and a learning state. After restart, the deck showed one learning card and one studied card. The disabled updater and separate-server sync message were checked in the app too.

After the review fixes, the rebuilt package and ad hoc signature passed again. A fresh synthetic profile with a loopback server URL showed the server-account login dialog with Username and Password fields and no AnkiWeb link. No credentials were entered or sent. The independent clock check also succeeded against its live HTTPS endpoint.

The ordinary-deck package checks and native review results are recorded in [ORDINARY-DECKS.md](ORDINARY-DECKS.md). The Mac app and Qt windows now use the blue seahorse icon; its SVG source and regeneration command are in [qt/icons/README.md](../qt/icons/README.md).
