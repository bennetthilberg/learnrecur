# Local generation jobs

The companion saves generation requests and processes them with a separate worker. Jobs and exercise batches share its SQLite database. The default provider returns three predetermined Spanish exercises without network or model calls. An explicit [OpenAI trial](OPENAI.md) can now generate a real batch after key setup and spending authorization.

## Request and run a batch

Start the companion and post `spanish-import.json` using [the local setup](README.md). Keep its token and URL in the environment. Then enqueue a job:

```sh
PYTHONPATH=pylib:out/pylib out/pyenv/bin/python - <<'PY'
import json
import os
from pathlib import Path
import requests

with requests.Session() as session:
    session.trust_env = False
    headers = {"Authorization": "Bearer " + os.environ["LEARNRECUR_COMPANION_TOKEN"]}
    response = session.post(
        os.environ["LEARNRECUR_COMPANION_URL"] + "/v1/generation-jobs",
        headers=headers,
        json=json.loads(Path("learnrecur/fixtures/spanish-generation-request.json").read_text()),
        timeout=10,
        allow_redirects=False,
    )
    response.raise_for_status()
    job_id = response.json()["id"]
    print(job_id, response.json()["state"])
PY
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m learnrecur.companion.jobs \
  --data-dir out/learnrecur/companion --once
```

The worker must use the same companion folder as the API. Omit `--once` to poll for jobs once a second. Only the original `spanish-import.json` skill is supported by the fixture provider; other definitions fail without publication. The fixture skips previously published prompts and supplied examples. Its six variations support two full batches; later requests stop when the pool is exhausted.

Authenticated `GET /v1/generation-jobs/<job_id>` returns the saved request, generation context, state, attempt count, retry time, error, and usage when available. Repeating the same POST returns that job, including after completion or a restart. Reusing `request_id` with different settings returns 409. Use a new request ID for an intentional new batch.

After completion, choose **Tools > Import skills…** in a separately stored LearnRecur profile. The snapshot includes the published batch. Its native import keeps the existing card, schedule, reviews, and exercise cursor; cached reveal and ratings work with the companion stopped.

## Request format and examples

A request contains `request_id`, `skill_id`, `revision`, and `count`. The skill must already exist and the revision must be current. This proof accepts 1–3 exercises per request. `provider` is optional: `fixture` is the default, and `openai` selects the separately enabled OpenAI worker. `examples` is optional and defaults to an empty list. Each example contains `prompt`, `answer`, and `explanation`; supply at most five. Text fields are limited to 8 KiB and the whole request to 64 KiB. OpenAI also limits the assembled model request to 32 KiB.

Examples are saved with the job and passed separately to the provider as reference material. The OpenAI worker uses them to guide format and difficulty. They do not change the skill definition, override its boundaries, or become review exercises automatically. Exact copies of example prompts are refused during publication. The fixture uses predetermined output and excludes exact example prompts; tests confirm that the provider receives the saved examples.

The context also freezes the skill payload, requested count, provider name, generation instructions, and instruction version. Credentials are not part of that context. Changing a skill after requesting a job makes the old job obsolete; output for the old revision stays unpublished.

## States and recovery

| State | Meaning |
| --- | --- |
| `queued` | Saved and ready for a worker. |
| `waiting_budget` | No provider call; retry after a delay when funds may be available. |
| `running` | Claimed with a 60-second lease and a reserved cost. |
| `provider_pending` | An accepted OpenAI response ID is saved; retrieve it without another generation. |
| `retry_wait` | A confirmed temporary, uncharged failure; another attempt is scheduled. |
| `result_ready` | Output and usage are saved; validation/publication can resume without another call. |
| `completed` | A batch was published in the companion; a desktop may still need to fetch it. |
| `obsolete` | The description changed before the job could publish. |
| `failed` | Terminal provider failure, rejected output, or the attempt limit. |
| `needs_attention` | The provider result or cost is uncertain; the reservation remains held. |

Requests, claims, saved results, and publication use short database transactions. Provider work happens outside the transaction. Concurrent workers cannot claim the same job. Each worker has a unique claim token; an expired or replaced token cannot save output or publish over a newer worker.

An abandoned claim can resume if no call was started. The worker records that it is about to contact the provider before doing so. After that point, a crash or unclassified error is uncertain and stops automatic retry. Confirmed temporary, uncharged failures retry after a delay, with at most three attempts. Known terminal, uncharged failures stop immediately. Provider error details are not copied into public job errors.

Publication saves the batch and completion state together. Exercise IDs derive from the job ID and output position. A restart before publication resumes saved output; a restart after publication finds the completed job. Process-death tests cover both sides of that commit.

There is no automatic resolver for an uncertain POST without a saved response ID. Keep the database and reservation intact. [The OpenAI notes](OPENAI.md) describe retrieval of saved responses and operator reconciliation of a confirmed ID, including charged failures. Local publication can be made safe to retry; this cannot guarantee that a provider bills exactly once.

## Cost records

`generation_budget` stores the monthly out-of-pocket limit, available promotional credit, and its expiry. `generation_attempts` records each attempt's month, gross estimate, reserved credit, net reservation, and actual costs when known. Amounts use integer millionths of a US dollar: `5000000` is $5.

Claims reserve estimated cost after available, unexpired credits. Concurrent claims account for existing reservations. The budget and credit expiry are checked again immediately before a call. If the available budget cannot cover it, no call is made. A reservation made before midnight moves to the month in which the call starts. Actual usage settles the reservation; a failed or obsolete batch still keeps any known cost. Uncertain attempts retain their reservation across month changes.

The fixture estimates and records zero cost. Tests use simulated prices and credits, without paid calls. For a fresh disposable store, `Jobs.configure_budget(monthly_limit, credit_total=0, credit_expires=0)` sets the allowance before the first attempt; repeating the same settings does not reset spend. This proof limits both configured amounts to $5 and has no budget-management UI. The OpenAI worker records token usage and estimates its cost from saved rates. Apply actual discounts and offers, track expiry, and never infer that an uncertain error was free. Obtain authorization before enabling paid calls. An estimate cannot enforce a provider's billing cap. Uncertain reservations remain committed in later months too.

## Exercise batches and cache updates

The immutable skill payload remains unchanged. Published jobs add a `bank_updates` map to the snapshot, keyed by skill ID. Each batch has a `job_id`, description `revision`, monotonically increasing `sequence`, and exercises. The client caches the original exercises followed by batches for the current description. Batches for older descriptions remain archived but are not eligible for review.

Description revisions and batch sequences are separate. Importing a refill preserves the native card rows and review cursor. It also changes the full bank fingerprint, so an already displayed exercise cannot be rated against a silently changed bank. Native undo/redo restores an import or rating. Stale snapshots cannot remove batches or revert descriptions; conflicting histories stop import.

Sync orders trusted skill content by description revision, then batch sequence. Tags and other note metadata retain native conflict handling. A same-description refill must preserve prior exercises, batch history, and definition fields. Ordinary note behavior is unchanged. All clients and the sync server must run the matching LearnRecur build.

The current proof retains at most 100 jobs, 100 batches per skill, and 100 active cached exercises per description revision. Published data and retained history share the 1 MiB snapshot limit. The Mac app can now make [bounded low-bank refill requests](REFILLS.md), but completed batches still need manual import. There is no cleanup, Skill editor, hosting, or complete backup/restore flow yet. Back up the whole companion database, including job and cost records; ordinary deck exports do not include those records.

## Verification

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m pytest learnrecur/companion/tests learnrecur/deploy/tests -q
./ninja check:pytest:pylib check:pytest:aqt
```

On October 1, 2026, the packaged Mac app imported the original skill and rated `hablar`. A real authenticated local request with one optional example queued a job; the standalone worker published one fixture batch. Native import, undo, and redo passed. Saved card and review rows matched exactly before and after the bank update. The skill stayed at description revision 1 with six exercises. After restarting with the companion stopped, review resumed at `trabajar`, advanced through `comprar` to the appended `cantar`, revealed `canté`, and passed rating undo/redo. The reopened collection had one card, four review records, and cursor position 4 (`bailar`). Ignored evidence is in `out/learnrecur/generation-mac-20261001/`.

Automated checks cover optional examples, authenticated requests, concurrent retries/claims, bounded failures, lease expiry, stale workers, budget reservations, credit expiry, recorded usage, rejected output, description changes, process death during publication, cache undo/restart, and two-profile sync with offline tags and ratings. These checks establish storage and recovery behavior, not AI exercise quality. The known [Qt accessibility issue](../MAC-ACCESSIBILITY.md) remains open.
