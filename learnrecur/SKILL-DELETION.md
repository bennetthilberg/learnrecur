# Skill deletion

You delete a skill the way you delete any Anki note: delete its deck, choose **Delete Note** in Browse or during review, or remove its card with **Empty Cards** or a template change. The card goes away, Undo works until the next sync, and there's no extra dialog. As in upstream Anki, the review log rows stay in the collection.

The deletion syncs to the server and your other devices without a one-way sync, and the companion retires the skill so **Tools > Import skills…** can't add it back and refills stop.

## Why sync needs a marker

Anki's deletion records, called graves, hold only numeric IDs. Skill cards get their IDs from the companion, so two different notes can end up with the same ID. A bare grave can't tell "I deleted this skill" from "I deleted an unrelated note that has this skill's ID." Earlier builds refused every grave for a trusted skill to protect against the second case, which also blocked the first.

Now the deleting client saves a deletion marker in the same undoable step as the deletion. The marker holds the skill's note ID, card ID, and note GUID. It's saved when the skill's note or its scheduled card is removed, whichever comes first. Deleting a card from an extra template doesn't delete the skill and saves no marker.

Sync sends markers inside the graves messages, ahead of the graves. The client puts its markers at the front of the first `applyGraves` chunk, and the server returns its markers with its graves in the `start` reply. The receiver saves each marker that matches its own trusted identity for that skill, then applies the skill's graves only if a matching marker is saved: the same note ID, card ID, and GUID. A marker for a different GUID or card is ignored. So a grave with no marker, or with a marker for another skill, is still refused with the existing messages, and nothing changes. That's the ID-collision protection.

Markers live in the synced `learnrecur_skill_deletions` table. Like graves, they carry a USN: pending markers upload once, and received ones get the server's USN so they aren't sent back. They stay after sync, including after a full upload, which clears graves. Native imports and **Reconnect restored skills…** treat a marker like a grave and won't reuse that identity.

Undo before sync removes the marker along with the graves. After a sync, Undo isn't available, as in upstream.

An older peer ignores the new field and refuses the skill's graves with its existing message, without changing either collection. An older server tells the deleting client to download; an older client receiving a deletion says another device deleted a note with the same ID as a skill.

## Companion retirement

The same step queues a retirement request in the client's `learnrecur_retirement_outbox`. The note is gone by then, so the row carries everything the request needs: the stable retirement ID, the companion source and skill IDs, the note GUID and ID, whether it's active, and a version that increases with each change. The queue belongs to this client, like the report queue, so a full download keeps it.

Delivery reuses the report delivery code. Right after a note is deleted or restored, and at the deck list or deck overview, the app checks that the companion's source ID matches, then sends at most ten states per pass. Failures retry at those screens no more than once a minute, with no dialog, and requests survive offline use and restarts. The app also resends acknowledged requests once per connection, so a companion restored from an older backup learns about the deletion again. A 400 or 409 reply can't change on retry, so the app logs it, counts the request as handled, and moves on to the next one.

Authenticated `POST /v1/skill-retirements` takes `retirement_id`, `version`, `active`, `source_id`, `skill_id`, `guid`, and `native_id`. It returns `retirement_id`, `version`, `active`, and `status`, which is `retired`, `active`, or `unknown` for a skill the companion doesn't have. The companion keeps the newest version, accepts identical retries, and ignores older versions. A different state at the same version, a different source, or a skill whose saved identity has another GUID or native ID returns 409. The table holds at most 10,000 requests.

While a skill is retired:

- `GET /v1/skills` leaves it out completely, including its identity, earlier revisions, and exercise batches. The snapshot format is unchanged, so older apps read it too. Importing a new revision under the same skill ID is refused; an identical retry of a stored revision still succeeds.
- Refill requests, manual jobs, edits, definitions, and reports for it return 409.
- Waiting jobs for it (`queued`, `retry_wait`, `waiting_budget`, `waiting_capacity`, and `result_ready`) become `obsolete` right away. A job in the middle of a provider call finishes the call and records its charge, then becomes obsolete without publishing. A job with an uncertain charge stays in `needs_attention` until it's reconciled, as before.
- **Tools > Generation history…** keeps every job and charge. Stopped jobs say the skill was deleted before they finished.
- Its rows stay in the database and still count toward the storage quotas and the skill limit, so deleting skills doesn't change those rules.

Until the request arrives, the companion still lists the skill. Import skills skips any skill that has a local deletion marker, so neither the deleting device nor a device that synced the deletion adds it back.

## Undo after delivery

The companion may already have the request when you choose Undo; delivery can run before the next sync. Undo is still allowed. It queues a withdrawal with a newer version, and the companion puts the skill back in the snapshot. A refill that the retirement stopped resumes in its own row and keeps any saved result, so no second charge is needed. An edit job that the retirement stopped stays stopped; use **Edit skill…** again.

This keeps both stores matching what native Undo restored. The window is short, because sync discards Undo.

## Rollout

Upgrade the backend first, then the Mac app. The sync server and companion ship in one image.

- **New backend, old app:** safe. An old app can't delete skills, and the companion's snapshot format is unchanged.
- **New app, old backend:** don't delete skills yet. An old server refuses the deletion, and every sync stops with a message suggesting Download, which would bring the skill back and discard unsynced changes. The deletion stays pending, and it syncs once the server is upgraded. An old companion returns 404 for retirements, and the app retries later.
- **Several apps:** update all of them before deleting a skill. An old app that receives a deletion refuses it, and its message suggests Upload, which would restore the skill for every device.

## Limits

Only the deleting device sends the retirement. If that device is lost before delivering it, other devices still skip the skill on import because they have the marker, but a new profile that hasn't synced could import it again. Native review history for deleted cards stays in the collection, as in upstream; it isn't sent to the companion.

## Checks

```sh
./ninja pylib qt
cargo build --locked -p anki-sync-server
cargo test -p anki --lib -- skill_deletions graves::test
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m pytest \
  learnrecur/companion/tests/test_retirements.py learnrecur/deploy/tests/test_local_sync.py -q
ANKI_TEST_MODE=1 PYTHONPATH=pylib:qt:out/pylib:out/qt out/pyenv/bin/python \
  -m pytest qt/tests/test_learnrecur_retirement_delivery.py -q
```

The tests use synthetic data and fixture providers only. They cover deleting a skill's note, deck, note type, and scheduled card through Empty Cards and a template change; sync to the server and a second client; Undo before sync and after delivery; an offline deletion delivered after client and server restarts; a fresh profile that downloads the collection; Import skills afterward; refused refills; jobs stopped while waiting, claimed, or calling the provider, with their charges kept; graves without a marker or with a marker for another skill; and markers that older peers ignore.
