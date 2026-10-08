# OpenAI generation trial

The worker can generate exercises through OpenAI's Responses API. OpenAI jobs are explicit: add `"provider": "openai"` to a generation request and start the OpenAI worker. The default worker and requests still use free fixtures. Desktop review uses the cached bank and never needs the key.

This slice uses `gpt-6-luna` on the default processing tier, with `xhigh` reasoning effort and at most 16,384 output tokens, including reasoning. The request contains the skill's title and description, requested count, optional examples, and existing prompts to avoid. It asks for plain-text prompts, answers, and brief explanations through a strict JSON schema. During development, inspect each prompt on its own, then check its answer and explanation. A valid schema does not establish exercise quality.

The job saves the full instructions, model settings, and price assumptions. Text requests are limited to 32 KiB. Jobs retain the existing 1–3 exercise limit. [The model page](https://developers.openai.com/api/docs/models/gpt-6-luna), [structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs), and [API pricing](https://developers.openai.com/api/docs/pricing) describe the provider contract.

The native review card shows only the prompt before revealing the answer. Generation instructions require each prompt to state the task and supply any necessary forms, choices, units, or other information. For a skill that applies a given tense, identify that tense, the verb, and the subject. When choosing the tense or operation is the target skill, state that decision and supply the needed context or allowed options without making the choice for the learner. Keep instructions brief and avoid hints that solve the skill.

Separate task instructions go on their own line, followed by the exercise. Self-contained questions don't need an extra instruction. Fill-in-the-blank prompts use six underscores for a word or number and eight for a multiword form or phrase, without encoding the answer's letter count. Necessary choices and separate parts go on separate lines; cues stay beside the text they apply to. Wording should be natural and concise, with no decorative headings or unrelated vocabulary. These defaults apply even when source examples use a different layout. The native reviewer already preserves plain-text line breaks and underscores.

New OpenAI jobs save instruction version 3, including creation, editing, refills, and report replacements. Queued jobs and retries keep their saved instructions and version, even after a worker upgrade. Existing cached exercises are unchanged. This guidance still needs manual quality checks; it is not a semantic or layout validator.

## Save the test key

Run this yourself in an interactive terminal, from the repository root:

```sh
out/pyenv/bin/python -m learnrecur.companion.credentials
```

Paste the project key at the hidden prompt. The helper writes `~/.config/learnrecur/secrets/openai-api-key` with mode `600`, inside a folder with mode `700`. It refuses an existing file rather than overwrite it. The file contains plain text readable only by your account; keep it outside shared folders and backups of project files. The loader rejects links, unsafe permissions, non-regular files, this repository, and desktop application-data paths before reading the key. Protected-path checks ignore capitalization, including on Mac's default case-insensitive filesystem.

Do not paste the key into chat, source files, commands, or a profile. The worker reads the file directly into memory and sends it only in the HTTPS authorization header. The API server and Mac app do not load it. Database rows, job context, card content, exports, and test evidence never include it. A host deployment will need its own protected secret storage.

## Run one trial

Obtain spending authorization first. Use a fresh synthetic companion folder, following [the local setup](README.md), and import `spanish-import.json`. Keep the companion token separate from the OpenAI key. Then post the OpenAI request:

```sh
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python - <<'PY'
import json
import os
from pathlib import Path
import requests

with requests.Session() as session:
    session.trust_env = False
    response = session.post(
        os.environ["LEARNRECUR_COMPANION_URL"] + "/v1/generation-jobs",
        headers={"Authorization": "Bearer " + os.environ["LEARNRECUR_COMPANION_TOKEN"]},
        json=json.loads(Path("learnrecur/fixtures/spanish-openai-request.json").read_text()),
        timeout=10,
        allow_redirects=False,
    )
    response.raise_for_status()
    print(response.json()["id"], response.json()["state"])
PY
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m learnrecur.companion.jobs \
  --data-dir out/learnrecur/openai-companion \
  --provider openai --allow-paid-generation --monthly-limit-microusd 250000
```

Use the same companion folder for server and worker. `250000` means a $0.25 monthly estimated out-of-pocket allowance for this disposable store. The flag cannot reset recorded spend. Repeating the same budget is safe; changing it after attempts begin is refused. Use this flag only after that spending has been approved. Stop the worker with Ctrl+C after the job completes. `--once` performs one worker step, which may leave a background response pending; subsequent steps retrieve it.

Read the job through authenticated `GET /v1/generation-jobs/<job_id>`. It includes state, usage, response ID when known, and the client request ID. Fetch the snapshot and inspect all three exercises for correct answers, clear prompts, the same narrow skill and difficulty, useful variation, and brief explanations. Only then import through **Tools > Import skills…** in a disposable LearnRecur profile and check native reveal, ratings, undo, restart, and offline review.

## Recovery and charges

Requests use `background=true` and `store=true`, so OpenAI stores the supplied text and response for retrieval. [Background mode](https://developers.openai.com/api/docs/guides/background) explains polling and retention behavior. Only synthetic skills and examples are used in this trial.

After acceptance, the worker commits the response ID to the attempt before processing output. `provider_pending` means the response can be fetched. A restart retrieves that same ID with GET and does not submit another generation. Concurrent workers cannot poll under the same claim. A missing, expired, or mismatched response stops with the reservation held. Transient GET failures retry at most three times; they never create another paid request.

If a POST loses its reply before its response ID is saved, the attempt becomes `needs_attention`. Its reservation remains held across restarts and month changes. HTTP validation/authentication rejections stop without generation; rate-limit rejections allow at most three delayed attempts. Timeouts, server errors, and unexpected redirects are uncertain. There are no hidden transport retries, proxy settings, or redirect handling.

Each POST has a stable `X-Client-Request-Id` derived from its job and attempt. This is a trace for provider investigation, not a promise of idempotent billing. [OpenAI's request-ID documentation](https://developers.openai.com/api/reference/overview#supplying-your-own-request-id-with-x-client-request-id) explains how it can help locate a lost request. Confirm a response ID from provider records before reconciliation:

```sh
PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m learnrecur.companion.jobs \
  --data-dir out/learnrecur/openai-companion \
  --provider openai --allow-paid-generation \
  --reconcile-job JOB_ID --response-id RESPONSE_ID
```

Reconciliation uses GET only. The response must match the saved job, attempt, model, and tier. It cannot settle an unrelated request or release an unknown charge by guessing zero. If no matching response can be found, keep the database and reservation intact. There is no automatic retry or operator override that declares an unknown attempt free.

Usage records include input and output tokens. The worker prices ordinary and cached input separately; reasoning tokens are already included in the output count. Refused, incomplete, malformed, obsolete, and rejected batches still record known usage and cost. Unexpected models, tiers, missing usage, or invalid token totals hold the reservation instead of claiming a known bill.

Rates were checked on October 2, 2026: $0.10 per million ordinary input tokens, $0.01 cached input, $0.125 cache writes, and $0.50 output. Input tokens use one of those three rates; cache writes are not an extra fee added to ordinary input. This short trial requests explicit caching without breakpoints, which disables cache writes. [The caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) explains that setting. Reservations still use the highest input rate, a conservative UTF-8 byte estimate with framing slack, and the maximum output allowance. Cost records are estimates from actual usage and those rates, not invoices or a provider billing cap. Unexpired, explicitly configured credits apply before checking the out-of-pocket allowance. No account credit is assumed. Recheck offers, expiry, and rates before changing provider settings.

## Verification

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m pytest learnrecur/companion/tests -q
```

Simulated responses cover the outbound schema and examples, cache-aware usage accounting, charged failures, uncertain charges, retrieval retries, wrong response identities, concurrent workers, and process death immediately before and after the response-ID commit. Existing fixture-job databases upgrade without losing reservations or retry safety. A call that crosses a month boundary counts against the new month's budget. A native-backend check imports a published batch, preserves the existing card and review rows, and passes import/review undo, redo, and reopen. Credential tests use synthetic keys only.

On October 2, 2026, a real three-exercise request with `gpt-6-luna` and `xhigh` reasoning authenticated and returned a background response ID. Retrieval reported `credit_balance_exhausted`, with no exercises or usage record. The job stopped in `needs_attention`, without another generation call. Its $0.008567 estimated reservation remains held because no usage was supplied; this is not a confirmed charge.

After the user added API credits and requested a retry, a new job in the same disposable store completed with one submission and a later retrieval. It used 349 input tokens and 281 output tokens, including 132 reasoning tokens. There were no cache reads or writes. The estimated cost from recorded usage is $0.000176; total committed spending, including the first job's held reservation, is $0.008743 of the approved $0.25 allowance. These are estimates, not a reconciled invoice.

All three exercises passed a manual check for correct answers, clear past-tense context, regular first-person forms, similar difficulty, and useful variation. Each explanation correctly replaces `-ar` with `-é`.

| Generated prompt | Answer |
| --- | --- |
| El sábado yo ___ por el parque. (caminar) | caminé |
| La semana pasada yo ___ a mis primos. (visitar) | visité |
| Anoche yo ___ la cena. (preparar) | preparé |

The packaged Mac app imported the batch through **Tools > Import skills…**. Native import undo/redo passed. After quitting, an exact comparison confirmed the same card, schedule, original review, and cursor, with the bank expanded from three exercises to six. The companion was then stopped. A Mac reboot interrupted the first review attempt; the saved job, bank, and original review remained intact afterward. The resumed check passed paired reveal of all three generated exercises, Again, variation, review undo/redo, and another app restart. The last revealed exercise stayed unrated and reappeared after reopening. One card retained five review rows and five repetitions.

Evidence is in the ignored folder `out/learnrecur/openai-mac-20261002/`, including provider responses, job records, and collection comparisons. No further generation is running. Preserve `companion/` there so the held reservation still counts toward any future authorized trial. Reusing either request ID returns its existing job. This checks one narrow skill; broader exercise quality, automatic refills, hosted operation, and the existing Qt accessibility crash remain open. The cause of the Mac reboot was not investigated in this slice.
