# Low-bank refill requests

With refills enabled, each linked skill keeps a spare of unused exercises. **Preferences > Review > Exercises ready per skill** sets its size, from 3 to 20, and defaults to 10. The Mac app asks the companion for more once a skill has fewer unused exercises than that setting, and each refill adds that many. New skills and edited revisions start with 10. The check runs when a question appears and after a successful rating. Requests run on a background thread outside the collection queue. Reveal and rating use the local bank, even when the companion is unavailable.

The setting is saved in the collection config, so it syncs between Macs. A value outside 3–20, from an edited profile or another app, counts as 10.

## Why a spare of ten

A refill takes a while to reach the app. Only one refill per skill can be outstanding, and a finished batch is added only at the deck list or deck overview, not during review. So after a skill asks for more, its bank has to last the rest of the review session.

A new card's first day uses the most exercises. Every rating uses one, including Again and each learning step, so a new skill can use three or four before the learner leaves review, and more after repeated lapses. With the default, the first rating queues a refill while nine fresh exercises remain. After a batch arrives, a skill holds roughly 10–19 unused exercises, so a repeat needs about ten ratings of one skill between deck list visits. A repeat is still possible, for example during a long offline stretch or once the monthly budget runs out.

Until November 2026, new skills started with three exercises, the app asked at two, and refills added three. A skill could run out during its first session, and an older bank could run dry before the next deck list visit. Skills with fewer than ten unused exercises ask as soon as their question appears, so the first session after the upgrade can queue refills for many skills at once.

## Cost

A bigger spare doesn't raise spending per review, since each review still uses one exercise. It generates exercises earlier: up to about twice the setting per skill, made once, as each skill comes up for review. At about $0.0003 per exercise and the default of 10, 55 skills front-load about 1,000 exercises, or about $0.31. At 20, that's about $0.64. Normal reviews come on top of that. If a month's spending reaches the $1 ceiling, refills wait until the next month and cached review continues, reusing older exercises if a bank runs out.

Completed batches now use [automatic delivery](DELIVERY.md) at the deck list or deck overview. **Tools > Import skills…** remains available. A refill request never changes the exercise on screen or adds an undo entry.

## Enable a local fixture proof

Follow [the local setup](README.md), using a fresh synthetic companion and LearnRecur profile. Add `--refill-provider fixture` when starting the server:

```sh
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m learnrecur.companion.server \
  --data-dir out/learnrecur/companion --refill-provider fixture
```

Import the original Spanish skill and show its first question. Its three unused exercises are fewer than the default of ten, so that queues one job. Run the fixture worker against the same companion folder:

```sh
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m learnrecur.companion.jobs \
  --data-dir out/learnrecur/companion --provider fixture --once
```

Return to the deck list after the fetch interval, or restart the app, to add the completed batch automatically. The fixture has 24 predetermined variations, enough for two ten-exercise refills. It skips prompts already in the bank or supplied as examples, then stops when its pool is exhausted. It makes no model calls and costs nothing.

The server disables refills by default. `--refill-provider openai` queues OpenAI jobs, but the worker still requires a private key, `--allow-paid-generation`, and spending authorization. The model remains `gpt-6-luna` with `xhigh` reasoning. Set the budget before starting the worker; see [OpenAI setup](OPENAI.md). Enabling the server alone does not run generation.

## Requests and duplicate protection

Authenticated `POST /v1/refill-requests` accepts these fields, and no others:

```json
{
  "source_id": "5528c1f8-2792-4e70-8a47-75d48c397e02",
  "skill_id": "spanish-ar-preterite-yo",
  "revision": 1,
  "bank_sequence": 0,
  "remaining": 2,
  "ready": 10
}
```

`remaining` counts active exercises not yet used in a successful native rating. It must be 0–20. `ready` is the learner's setting and becomes the batch size, shrunk to fit the bank limit. It must be 3–20; a request without it, from an older app, gets 10. The server checks the source, current description revision, and imported batch sequence. The client cannot select a provider or ask for more than 20. Two Macs with different settings share the job for a checkpoint; the first request sets its size.

Servers released before November 2026 reject the `ready` field, so a newer app gets no refills from them. Upgrade the server before the app. An older app still works with a newer server; it asks at two and gets ten.

New refill jobs use the examples saved when the current skill revision was created or edited. When the learner's material has suitable exercises, supply those examples so later batches keep the same guidance. Suitability is checked before saving the definition; the server does not assess the original material. Removing unsuitable examples in the editor lets that revision use the fallback.

If no examples were saved for the current revision, the job uses the first exercise in the initial bank without an active companion report. If none is eligible, it uses no example. A newer revision never inherits an older revision's examples. The job freezes its skill and guidance; retries and jobs already queued keep their saved context. Manual generation requests still accept their own optional examples. Examples guide generation and are never added to the review bank themselves.

The source, skill, revision, and sequence form a stable request ID. Checking and creating the job share one database write transaction. Concurrent clients, reconnects, and restarts therefore return the same job for that checkpoint. The response contains `status` and `job_id`, without exercise text. A client behind the latest published sequence receives `awaiting_import`; it must import that batch before another automatic refill can be created.

A failed refill doesn't stop that skill for good. Failures include rejected keys, repeated rate limits, refused or incomplete output, and batches that copy an example. Once every attempt in the failed job has a recorded charge, possibly zero, the same checkpoint can start a new round. The round reuses the same job row, request ID, and frozen guidance, so it still deduplicates across clients and restarts and never adds to the job quota. Its attempt limit and short retry backoff count only that round's attempts. The first new round waits an hour after the failure. Each later round waits twice as long as the one before, up to a day. A charged failure counts against the monthly ceiling like any other attempt.

An unfinished manual job for the current skill revision also blocks a replacement; a failed one with recorded charges doesn't. A failed or discarded edit no longer holds back refills for the published revision; its leftover draft is removed. Any job with an uncertain charge blocks new automatic work across the store. Recovery requires an operator: reconcile a saved response, or release a confirmed failure as described in [OpenAI setup](OPENAI.md#recovery-and-charges). Reopening the app never creates a new request ID to bypass the stopped job. Existing budget reservations, credit expiry, attempt limits, and publication checks apply unchanged. A waiting job makes no provider call until the worker can reserve its cost.

The desktop limits concurrent requests and remembered checkpoints to 100. It retries a checkpoint no more than once a minute when another question or rating triggers a check. There is no timer polling, startup bulk scan, or error dialog during review. A connection failure logs a fixed message and leaves cached review available. Import errors continue to use the existing import dialog.

## Exercise usage and native undo

The native card's `lr` custom data stores its rating counter, bank fingerprint, and a compact bitmap of used exercise positions. Banks support up to 256 exercises. Larger bitmaps use compact Base64 to stay within the native 100-byte custom-data limit; existing hexadecimal cursors remain readable. It commits with the rating, scheduling changes, and review record. Native undo and redo restore them together; reveal does not change usage.

For example, after all three original exercises have been rated, all three bits are set. Repeating the old bank leaves those bits set. Importing three appended exercises adds three unset positions, so the next review chooses a fresh exercise regardless of how often the old bank cycled. After every eligible exercise has been used, offline review can reuse older eligible items. Reported and retired exercises remain excluded. A description revision starts fresh usage for its new bank.

Older cards with only a counter conservatively treat the first `n` active exercises as used, capped at the bank size. The conversion maps those active exercises back to their raw positions, so reported and retired items do not shift usage. Their next successful rating saves the bitmap. Past selections after wrapping cannot be reconstructed exactly from a counter. Usage syncs with the native card state and follows Anki's existing last-modified conflict rules; it is not a union of concurrent offline clients' selections.

## Limits

Refill requests queue generation; [delivery](DELIVERY.md) fetches and applies published batches separately. [Report delivery](../REPORTS.md) also shares these checkpoints. This request path adds no hosting, budget UI, or paid trial. The defaults are 1,000 jobs, 1,000 batches per skill, 200 exercises per revision, and an 8 MiB snapshot. The [storage limits](../STORAGE.md) are configurable. A full bank stops generation; older exercises remain available for eligible cached review. Ordinary decks never request refills. A linked card must also have a trusted native import identity; a deck package alone cannot authorize background generation.

With the default, a revision reaches 200 exercises after its first 10 and 19 refills. That's about 190 ratings at one revision; after that, review reuses older eligible exercises. The usage bitmap holds 256 positions, so it never limits a 200-exercise bank. Larger batches use fewer jobs for the same exercises: filling three revisions of three skills takes 180 jobs, down from 603 with batches of three. That leaves more room under the 1,000-job quota, which counts every job ever created.

Before each paid call, the worker reserves the attempt's worst-case cost: the full 16,384-token output cap at the output price, plus the request's input. The output cap is in tokens, not exercises, so the hold is about $0.0086 for any batch size and still covers any bill. A response that reports more tokens than that is treated as an uncertain charge. Recent three-exercise jobs used about 500 output tokens, so a batch of 20 should need about 3,500. Batches above three haven't been tried with the real model yet.

Each running or saved job also reserves room in the snapshot limit for its worst-case batch, about 98 KB per exercise. A batch of 10 holds about 1 MB of the default 8 MiB, and a batch of 20 about 2 MB, so roughly seven or three jobs can be in flight. Others wait in `waiting_capacity` and try again a minute later. Queued jobs reserve nothing.

The OpenAI request lists every existing prompt so the model avoids repeats, and requests are capped at 32 KiB. The base request is about 5 KB. Short prompts fit at 200 exercises, but prompts near 150 bytes reach the cap at about 180. A job over the cap fails before any call, so it costs nothing. Its later retry rounds fail the same way, though, so that skill stops getting new exercises, and the job's error says only that its saved provider settings can't run.


## Verification

On November 5, 2026, automated checks covered the setting and the new sizes. The app asks once fewer unused exercises remain than the setting, and sends the setting. Invalid saved values fall back to 10, and the value survives reopening. Preferences saves it only when it changes. On the companion, `ready` of 3, 15, and 20 sets the batch size; a checkpoint without it gets 10; values outside 3–20 are rejected; and a second Mac with a different setting shares the same job. Near the bank limit, a refill shrinks to the room left. A snapshot with room for three worst-case exercises refuses a batch of ten. A 20-exercise OpenAI refill holds its worst-case cost under the $1 ceiling, settles below that hold, and waits without calling when the budget is one microdollar short. A new skill and an edited revision each publish ten. These checks use synthetic data and mocked responses; no paid call ran. The packaged Mac app hasn't been checked with the setting yet.

The checks below were run with the earlier sizes: three initial exercises, a threshold of two, and refills of three.

On October 2, 2026, the packaged Mac app imported the original three-exercise skill in fresh synthetic storage. Its first question queued nothing; rating Again automatically queued one refill. The fixture worker published three exercises at zero cost. Native rating undo/redo passed, and five ratings cycled through the original bank without creating another job.

Manual import and import undo/redo expanded the bank to six while retaining the exact native card and all five review rows. After restarting with the companion stopped, the app selected the first fresh exercise (`cantar`), revealed `canté`, rated Again, and restored the selection through native undo/redo. Reopening retained six review records, the used bitmap, and two unused exercises. Reconnecting and showing that question queued one job for sequence 1; the fixture worker published another distinct batch at zero cost. The final ownership-guard build reopened the same profile, revealed `bailé`, retained the exact saved card and six review rows, and left the store at two jobs. The app and companion were stopped after verification.

Automated checks cover concurrent clients, restart, failed and uncertain jobs, exhausted budgets, revisions, stale and foreign checkpoints, authentication, proxy/redirect guards, background request throttling, profile changes, legacy counters, wrapped banks, native undo, package ownership, and a full 100-exercise bitmap. These checks use synthetic data and make no paid calls. Ignored evidence is in `out/learnrecur/refill-mac-20261002/`. The existing Qt accessibility warnings and [unresolved crash](../MAC-ACCESSIBILITY.md) remain open.

The initial review found an excluded-item edge case in legacy conversion. Reported and retired exercises are now skipped when mapping the old active-list counter to raw usage bits. Regression tests cover both statuses before and after wrapping. The rebuilt Mac app selected fresh `comprar` after a synthetic legacy `trabajar` rating with `hablar` reported. Reveal, Again, undo, and redo passed; reopening saved only the two active usage bits and two review records. That separate fixture is in `legacy-profile/` under the same ignored proof folder.

On October 5, 2026, saved-example guidance passed all 242 companion tests. Seven new regression cases cover the provider request, concurrent requests and restart, later batches, edited or cleared examples, imported revisions, report retries and withdrawals, and oversized guidance. A read-only check of the [Spanish trial](../SPANISH-QUALITY.md) selected the exact two approved book examples for each of its three skills. The original trial data stayed unchanged; no paid call ran.

A separate native Mac check used two synthetic examples and a fixture worker. Again queued one refill with both examples. Reporting the next exercise shared that job, showed a cached replacement, and preserved the card and review entry through report undo/redo. Reveal still matched the replacement after generation. Automatic delivery grew the bank from three to six exercises without changing the card, review entry, or report; reopening with the companion stopped preserved those rows. The app, companion, and worker are stopped. Private evidence remains in LearnRecur's local trial storage outside Git. No Azure changes or personal Anki data were used.
