# Automatic exercise delivery

The Mac app downloads published exercise batches when a configured profile opens its deck list or deck overview. It applies them to existing, trusted skill cards without an import dialog. New skills and changed descriptions still require **Tools > Import skills…** and its preview.

Network fetches run outside the collection queue, at most once a minute per open profile and connection. There is no timer polling or mid-review mutation. If a response arrives during review, the app keeps one bounded snapshot until the next safe boundary. It checks the profile, connection, and screen again when the serialized collection operation starts. A Study click during that short operation waits for it to finish before loading the question. Changing the screen, deck, or profile cancels that delayed start. Switching profiles or changing the connection discards an old response. A profile with no trusted imported cards makes no delivery request.

A batch update passes the existing snapshot, identity, content, and append-only history checks. It cannot create cards, change a description revision, remove exercises, or roll a bank back. It changes note content through a native transaction without changing the card, schedule, review records, or usage bitmap. Native operation hooks refresh the UI and sync status. Download or update failures log a fixed message and leave cached review available; manual import still shows actionable errors.

## Undo and interruptions

The native cache transaction keeps the existing undo and redo queues and adds no background undo step. Rating undo restores its schedule and usage while retaining the downloaded bank. Rollback also preserves the queues.

If a saved note edit, deletion, or note-type change could restore an older bank or field layout, automatic delivery defers instead of changing that undo history. Reopening the profile clears in-memory undo history and allows delivery again. This is conservative: an unrelated note-type edit can also defer delivery. Manual import remains available as an explicit undoable operation.

Undoing the original skill import still removes that card. Background delivery never recreates it. Redo restores the original import, and a later delivery check can fetch its published batches again.

The bank and its linked note fields commit together. A client killed before the commit can retry; one killed after it finds the batch already applied. No separate delivery receipt can fall behind the collection. A disconnected client keeps reviewing its local bank. On reconnect, the snapshot supplies missed batches. Two clients can apply the same batch independently and converge through native collection sync.

## Local proof

Use fresh synthetic storage and the [fixture refill setup](REFILLS.md). Import the original skill once, rate an exercise, and run the fixture worker. Leave the current question on screen while generation finishes, then return to the deck list after the fetch interval. The app should add the completed batch without opening **Import skills**. Restarting the app also starts a new fetch interval.

Review undo and redo should still operate on the last rating. Stop the companion, restart the app, and review through the newly cached variations. No model call is needed. A later description revision should wait for manual preview rather than arrive as an automatic cache update.

Automated checks cover safe boundaries, queued state/profile changes, connection changes, authentication and fetch limits, unchanged retries, stale revisions, import undo, saved edit undo/redo, failed native transactions, process death around commit, and two-client offline review and sync-server restart. They use synthetic data and make no paid calls.

The store retains its existing 100-exercise and 1 MiB snapshot limits. This slice adds no hosting, Skill editor, reporting UI, cleanup, or complete backup restoration. All clients and the sync server must run the matching LearnRecur build. The [Qt accessibility crash](../MAC-ACCESSIBILITY.md) remains open before daily use or distribution.

On October 2, 2026, the packaged Mac app rated the original `hablar` exercise in fresh synthetic storage. The fixture worker completed three variations while `trabajar` remained displayed; reveal still showed `trabajé`. Returning to the deck list automatically expanded the bank from three to six. A comparison through the app's debug console confirmed the exact native card row, review row, and Answer Card undo action were unchanged. Native undo and redo restored that same state while retaining six exercises.

With the companion stopped, the restarted app reviewed through `trabajar` and `comprar` to the delivered `cantar`/`canté`. Again, undo, and redo passed. Reopening retained one card, four review records, and six exercises. Reconnecting queued exactly one second refill; after it completed, returning to the deck list expanded the bank to nine with the exact card and all four reviews preserved. Both fixture batches cost zero. Ignored evidence is in `out/learnrecur/delivery-mac-20261002/`.
