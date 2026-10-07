# Exercise storage and limits

The companion limits new work so storage stays bounded. Its defaults are higher than the original proof limits, and operators can change them. The settings live in the companion database; the API, worker, and restored backups use the same values.

| Setting | Default | Highest supported value |
| --- | ---: | ---: |
| Exercises per skill revision | 200 | 256 |
| Retained generation jobs, across the store | 1,000 | 10,000 |
| Snapshot size, including earlier revisions and batches | 8 MiB | 64 MiB |
| Skills | 500 | 5,000 |
| Batches per skill, across revisions | 1,000 | 5,000 |

An exercise still counts if it was reported or retired. Completed jobs still count: their request IDs prevent duplicate generation, their examples guide refills, and their attempts record spending. The snapshot limit covers published skill data, not the whole SQLite file. Jobs, attempts, reports, indexes, and database overhead add to the backup size.

## Change the limits

Pass the settings when starting the companion. For example:

```sh
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m learnrecur.companion.server \
  --data-dir out/learnrecur/companion \
  --max-exercises 240 --max-jobs 2000 --max-snapshot-bytes 16777216 \
  --max-skills 750 --max-batches 1500
```

Omitted settings keep their saved values. Each value must be a positive integer within the supported range. An invalid update changes nothing. Raising storage limits does not change the generation budget or authorize paid calls.

For Compose deployments, set `LEARNRECUR_MAX_EXERCISES`, `LEARNRECUR_MAX_JOBS`, `LEARNRECUR_MAX_SNAPSHOT_BYTES`, `LEARNRECUR_MAX_SKILLS`, and `LEARNRECUR_MAX_BATCHES` in the environment used to run the deployment commands. Recreate the companion and worker containers to apply them. Both apply the same settings before starting work, so startup order cannot bypass a lower quota. Empty or omitted variables keep the saved values. The standalone server accepts the same variables; command-line flags override them. Backups include the saved settings.

## When a limit is reached

Reads and cached review use the format ceilings in the table, rather than the configured quotas. Lowering a quota never deletes data or makes an existing bank unreadable. Identical imports and generation-request retries still return their original records. A changed import rolls back if it exceeds a quota.

Refills request up to three exercises, using a smaller batch near the exercise limit. A full bank stops new generation. Cached review can reuse eligible exercises; reported and retired exercises remain excluded. The native card, schedule, and review history stay intact.

Workers reserve room for the largest valid response before reserving cost. Concurrent claims include room already reserved by running jobs and saved results. They check capacity again before contacting the provider, so lowering a limit can release an unused cost reservation. A queued job that loses capacity waits without making a provider call. Raising the limit lets it resume. A saved result can wait too, then publish without another generation call. Generation history calls this state **Storage paused**.

The 256-exercise ceiling keeps usage inside Anki's native 100-byte card field. Larger usage bitmaps use compact Base64; existing hexadecimal cursors remain readable and change format only as needed during a rating. Usage still commits and rolls back with native rating, undo, and redo. Other custom card data can reduce the available room; an oversized cursor stops before rating.

All clients and the sync server need the matching LearnRecur build to use the larger format. Earlier builds retain their old bounds. Skill description history still supports at most 100 revisions. The generation-history page size, provider-response limit, and backup archive guards remain separate bounds.

Native bank fields keep batches alongside the flattened exercises and escape Unicode to preserve the original text. That can repeat text twice and triple its UTF-8 size. Native bank reads and reporting therefore allow up to six times the 64 MiB snapshot ceiling; the companion's snapshot quota still governs published data. Regression tests cover reporting, cache retry, reconnection, and undo/redo with large escaped banks.

## Retention

There is no automatic deletion in this slice. Banks and batches are append-only, and clients compare earlier content when importing or syncing. Removing an item can change usage positions, break an offline client's checks, or discard an exercise referenced by a report or undo. Deleting jobs can also lose deduplication, example guidance, or unsettled charges.

Measure the actual stores before adding cleanup. These quotas bound the existing workflow while preserving its recovery records. A future cleanup change needs a protocol for clients that still have older data; raising a number does not solve that problem.

## Check growth

The synthetic lifetime test creates three skills, fills three revisions of each to 200 exercises, and makes 603 zero-cost generation jobs. It checks 325 native ratings, reports, revision retirement, undo/redo, restart, complete collection export, verified reconnection, and a separate companion restore. Saved source examples continue to guide every refill. The data contains no textbook or personal deck content.

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m pytest learnrecur/companion/tests/test_storage_lifetime.py -q -s
```

The test prints snapshot, companion database, collection, and package sizes, plus elapsed time. Separate cases check both default and configured quotas, concurrent claims, full-bank review at 256 exercises, native cursor migration, and two-client sync after more than 100 batches. These checks measure storage and recovery, not exercise quality or months of actual study.

The October 7 run took 44.5 seconds. Its snapshot was 1.52 MiB, companion database 11.42 MiB, collection 2.71 MiB, and compressed collection package 121 KiB. The repetitive synthetic text compresses well; real exercise text and job histories will have different sizes. The run reached batch sequence 198 and preserved all 325 ratings through edits, export, and reconnection. A separate two-client sync test preserved usage and review history beyond the old batch limit; report exclusions remained local to the reporting client, as before.

The packaged Mac app also passed offline reveal, rating across the hexadecimal-to-Base64 boundary, exact native undo/redo, report-and-skip to a backup, ordinary-card review, and restart with a 256-exercise synthetic bank. Restart preserved both cards, two review records, and the exclusion, and showed the same backup prompt and answer. The final package also passed report-and-skip and undo/redo from a 2 MiB bank with exact cards and no ratings changed. The test apps exited normally. No personal Anki data, paid calls, or Azure changes were used.

The highest table values are format bounds, not load-test results. This slice tested default banks, the 256-exercise review ceiling, and smaller configured quotas; it did not fill a 64 MiB snapshot or 10,000-job store. Automatic pruning and an upstream update remain separate work.
