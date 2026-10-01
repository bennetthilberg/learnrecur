# Local sync proof

The matching standalone Anki server syncs LearnRecur's collection and media. The companion runs beside it and supplies immutable skills with stable native card identities. Both use separate, marked LearnRecur folders. This is a loopback development setup with synthetic accounts; hosting, paid generation, and production backups remain ahead.

## Run the server

From the repository root:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
./ninja pylib qt
cargo build --locked -p anki-sync-server
LEARNRECUR_SYNC_ACCOUNT=synthetic:synthetic-pass \
  out/pyenv/bin/python learnrecur/deploy/run_sync_server.py \
  --data-dir out/learnrecur/local-sync/server
```

The launcher binds to `127.0.0.1:45331`. It requires an explicit data folder and account, rejects Anki-named folders, symlinks, and unmarked nonempty storage, and drops inherited sync settings before launching the binary. Don't run the desktop's disabled `--syncserver` mode. Keep this test server on loopback.

Run the [companion](../companion/README.md) in another shell and post the synthetic batch. Create two disposable LearnRecur profiles, each in a fresh marked base folder. The test helpers in `qt/tests/launch_anki_for_e2e.py` can seed those folders without reading any installed app or existing profile.

In each profile, set **Preferences > Syncing > Self-hosted sync server** to `http://127.0.0.1:45331/`. Leave automatic sync off for the proof. Import skills into the first profile, then use native **Sync** with the synthetic account. Confirm uploading its collection to the empty local server. In the empty second profile, sync and confirm downloading. Anki's full-sync choice replaces one collection; don't use two unrelated collections with data you want to keep for this test.

The second profile should show both the ordinary and skill decks. Repeating **Tools > Import skills…** must keep the existing card. Stop both services, review a skill, reveal its answer, choose Again, and check undo and redo. Close and reopen that test profile, restart the services with the same folders, and sync both profiles. The card ID, cached bank, exercise cursor, and review record should match.

## Run the recovery checks

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m pytest learnrecur/companion/tests learnrecur/deploy/tests -q
./ninja check:pytest:pylib check:pytest:aqt
```

The tests start real authenticated HTTP services and native collections in temporary storage. They cover ordinary cards and media, companion restart and retry, independently importing the same skill into two clients with a shared schema, offline ratings, native undo and redo, client reopen, server termination, and reconnect. A proxy drops the native sync `finish` response after the server commits. Killing and restarting the server, reopening the client, and retrying must leave one card and one copy of each review record.

The independent-import test rates the same card in both offline profiles. Both review records survive. The current card schedule and exercise cursor follow Anki's existing last-modified conflict rules; they are not combined into a new schedule or cursor. Simultaneous reviews can therefore repeat a cached variation. This proof doesn't claim a merge policy for exercise usage across concurrent reviews.

The companion assigns note and card IDs before import. Native sync matches those IDs; it doesn't deduplicate a source/skill link field. An older client-created identity, an occupied ID, or a known deletion record stops import without replacing cards. Legacy duplicate links block further skill ratings and stay intact. Never discard a copy merely because it looks unused locally: a disconnected client could still have reviews for it.

## Evidence and remaining work

On October 1, 2026, the local tests passed the recovery cases above. The packaged Mac app uploaded a synthetic ordinary card, its SVG image, and an imported skill from profile A. Profile B downloaded both decks, rendered the image, and retried the skill import. With both services stopped, it revealed `hablé`, rated Again, showed the next `trabajar` exercise, and passed native undo and redo. Its reopened collection had two cards and one skill review record. After restarting the sync server and both app sessions, native Sync brought that rating into profile A. Reopened collections matched in fields, templates, media, scheduling, review history, and exercise cursor; import retries changed neither. The ignored evidence is in `out/learnrecur/local-sync-mac-20261001/reconnected-comparison.json`.

The local suites pass 252 library tests, including eight round trips through Anki's independently released backend, 206 Qt tests, 8 companion tests, and 13 sync/launcher tests. The package and ad hoc signature pass. The known Qt accessibility warnings still appear; the [accessibility crash](../MAC-ACCESSIBILITY.md) remains open.

Milestone 4 remains open. Next, add description revisions and reconcile a revised bank onto the same native card without changing its history. Generation/refill jobs, reports, complete backups, restoration on another host, and deployment need later slices. Keep the current native concurrent-review behavior explicit until the exercise-use policy is decided.

Before hosting, measure resource use and choose HTTPS or a private network, production credential storage, restart handling, and complete backups. Hosting has a $5/month out-of-pocket limit; generation has a separate configurable $5/month estimated limit, both after student discounts, credits, and promotions. Track offer expiry and get authorization before spending. The Windows utility PC remains the hosting fallback. See [ROADMAP.md](../../ROADMAP.md).
