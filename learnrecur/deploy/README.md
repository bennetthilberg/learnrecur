# Local sync proof

The matching standalone LearnRecur server uses Anki's collection and media sync. The companion runs beside it and supplies immutable skills with stable native card identities. Both use separate, marked LearnRecur folders. This is a loopback development setup with synthetic accounts; hosting, paid generation, and production backups remain ahead.

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

The companion assigns note and card IDs before import. Native sync matches those IDs; it doesn't deduplicate a source/skill link field. An older client-created identity, an occupied ID, or a known deletion record stops import without replacing cards. Normal sync also checks note GUIDs and card ownership before applying incoming records. A collision aborts the sync transaction instead of accepting a different object under the same ID. Legacy duplicate links block further skill ratings and stay intact. Never discard a copy merely because it looks unused locally: a disconnected client could still have reviews for it.

Native deletion records contain only numeric IDs, so they can't distinguish a deleted skill from an unrelated card with a colliding ID. This slice refuses remote deletions of existing skill notes, cards, and decks before applying any deletion changes. This also blocks intentional skill deletions from syncing. Ordinary deletions still sync. If a profile deletes a skill locally, stop and restore that disposable profile from the unchanged server copy; don't upload it as a full replacement. Full sync retains Anki's explicit replacement behavior. Ownership-aware skill deletion and recovery need a later slice.

Deletion protection uses a separate identity table populated by the native companion-import API and authenticated sync. It never trusts note fields or model markers. The matching server carries these records alongside notes in incremental sync; full sync includes them in the collection. Ordinary `.apkg` imports don't copy this table, even if a package author forges one. File-based `.colpkg` restores discard claimed ownership and rebuild the link index from restored notes before replacing the destination or restoring media. They keep cached cards, scheduling, and review history, but companion import refuses to adopt those cards without verified ownership. A complete LearnRecur restore still needs that verification in a later slice. An unmodified upstream server cannot carry this sync extension. Use fresh profiles for this proof: older development cards without trusted identities are kept, but companion import refuses to silently adopt them.

Duplicate checks during review use a native index of source/skill links and read at most two matching note IDs. Native note writes, deletion, undo, and field changes keep it current. Older collections build the index once, inside a transaction; link parsing is limited to 1 KiB. Malformed unrelated links don't prevent valid skills from being reviewed; the collection check after sync still reports them. A damaged copy of the same skill blocks review, including when its digest is invalid.

## Sync skill revisions

Publish the next complete revision to the companion, then accept it through **Tools > Import skills…** in either profile. Sync both profiles. The same native card should now have the revised description and bank, with its existing schedule and reviews. Older banks remain cached for history but are excluded from review.

For trusted skill notes, a higher revision takes precedence over an older offline revision, even if the older note has a later modification timestamp. An older bank therefore cannot roll back the revised cache. Revision order applies to the seven skill-content fields; tags and other note metadata keep native conflict handling, including pending offline edits. Offline ratings still keep both review records, while the card schedule and cursor follow native conflict rules.

Different skill content at the same revision stops incremental sync and keeps both collections. The current client displays Anki's generic sync/database error. Keep both copies and recover the published definition from the companion; don't force-upload an edited collection over the server. A Skill editor and a guided recovery flow remain ahead. Ordinary notes retain Anki's normal timestamp rules. Explicit full sync still replaces a collection.

Tests cover two offline ratings followed by revision sync, an offline revision 2 arriving after revision 3, conflicting same-revision content, and offline tag additions/removals during a revision update. The conflict check confirms that the server keeps its definition and receives no partial review upload. The dropped-finish recovery test also passes when a revision is pending.

## Evidence and remaining work

On October 1, 2026, the local tests passed the recovery cases above. The packaged Mac app uploaded a synthetic ordinary card, its SVG image, and an imported skill from profile A. Profile B downloaded both decks, rendered the image, and retried the skill import. With both services stopped, it revealed `hablé`, rated Again, showed the next `trabajar` exercise, and passed native undo and redo. Its reopened collection had two cards and one skill review record. After restarting the sync server and both app sessions, native Sync brought that rating into profile A. Reopened collections matched in fields, templates, media, scheduling, review history, and exercise cursor; import retries changed neither. The ignored evidence is in `out/learnrecur/local-sync-mac-20261001/reconnected-comparison.json`.

The earlier sync slice passed 261 library tests, including eight round trips through Anki's independently released backend, 206 Qt tests, 9 companion tests, and 35 sync/launcher tests. Deletion tests preserve an unsynced, reviewed skill when another profile sends a colliding note or card deletion, including after the skill's model marker is removed. Refused intentional deletions leave the server copy intact after full and incremental sync. Ordinary deletions still sync, including imported packages with forged markers or identity tables. Current and legacy full-collection restores preserve cards, reviews, and media, discard claimed ownership, rebuild forged indexes, and allow later deletion sync. Invalid ownership schemas leave the destination and its media intact. The package and ad hoc signature pass. The known Qt accessibility warnings still appear; the [accessibility crash](../MAC-ACCESSIBILITY.md) remains open.

The final ownership check also passed a fresh packaged Mac import, native upload, import retry, offline reveal, Again, undo, redo, server restart, and native reconnect. A second synthetic profile downloaded the server copy through the native backend. Both reopened profiles had matching card state, one review record, and one trusted identity; the second profile's import retry changed nothing. The ignored comparison is in `out/learnrecur/trusted-sync-mac-20261001/comparison.json`.

The final indexed-review build reopened that synthetic profile, revealed `trabajé`, advanced to `comprar` on Again, and restored `trabajar` on undo with both services stopped. After quitting, it retained one card, one review, one trusted identity, and one indexed link. The ignored record is `out/learnrecur/trusted-sync-mac-20261001/indexed-review.json`.

The revision slice passes 273 library tests, 206 Qt tests, 13 companion tests, and 41 sync/launcher tests. Its Mac package and ad hoc signature pass. Native revision import, undo/redo, restart, and cached review with the companion stopped also passed; [the companion notes](../companion/README.md) record those checks.

Milestone 4 remains open. Description revisions now update the same native card without changing its history. Generation/refill jobs, reports, complete backups, restoration on another host, and deployment need later slices. Keep the current native concurrent-review behavior explicit until the exercise-use policy is decided.

Before hosting, measure resource use and choose HTTPS or a private network, production credential storage, restart handling, and complete backups. Hosting has a $5/month out-of-pocket limit; generation has a separate configurable $5/month estimated limit, both after student discounts, credits, and promotions. Track offer expiry and get authorization before spending. The Windows utility PC remains the hosting fallback. See [ROADMAP.md](../../ROADMAP.md).
