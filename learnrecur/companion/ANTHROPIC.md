# Claude generation

The worker can generate exercises with Claude instead of OpenAI. If you use Claude for AI help, use the same API key here too, so one Anthropic account pays for both. OpenAI still works; one manager command switches between them.

## What it sends

Each attempt is one [Message Batches](https://platform.claude.com/docs/en/build-with-claude/batch-processing) request to `claude-sonnet-5-5` with adaptive thinking at `xhigh` effort and at most 300,000 output tokens, thinking included. The system prompt ends with a line asking Claude to solve and check every exercise before writing the JSON. Above 128,000 tokens, batches need the `output-300k-2026-03-24` beta header, which every request sends. Thinking text isn't returned, so a long think doesn't enlarge the results file. The request has the same exercise rules, skill fields, examples, and existing prompts as an OpenAI job. A JSON schema separates the instruction, prompt, context, answer, explanation, and blank fills. Claude's schemas can't set an array's length, so the count is in the instructions instead. The worker trims extra exercises, and a short batch fails on import and retries later, like any other bad batch.

Batches cost half the normal price: $1 per million input tokens and $5 per million output tokens for Sonnet 5.5, as of November 5, 2026. Most finish within an hour; the limit is 24 hours. That's fine for refills, which start well before the bank runs out, but a new skill's first exercises can take a while to arrive. The worker checks a pending batch every 30 seconds.

A job saves its model settings and prices. When the worker picks up a job that hasn't called Claude yet and its saved settings differ from the current ones, it switches the job to the current model, effort, limit, prices, and guidance first. A job already waiting on a batch keeps its settings, since that batch is billed at them. The reservation covers the request size plus 4,096 tokens of slack for the schema's system prompt, and the full output limit: about $1.50 per job. Most jobs use a small part of that, and the rest returns to the budget when the batch settles. The monthly limit must be above $1.50, or nothing runs; $20 holds about 13 jobs at once.

The first deployment, on November 5, 2026, used Haiku 5.5 at `max` effort with a 32,000-token limit. All eight of its batches spent every token thinking and returned no exercises, at about $0.008 each. At `max`, Haiku doesn't bound its thinking, so a fixed limit can't make room for the answer.

Sonnet then ran at `high` effort. On November 6–8, six of the seven batches checked had no thinking block and about 1,000 output tokens, which is just the JSON. Adaptive thinking lets Claude skip thinking when a request looks easy, and ten short exercises look easy. Without thinking, Sonnet fixed mistakes inside the JSON (an explanation that says "No: ...", a translation of a different sentence) or returned 8 exercises instead of 10. The one batch that thought had no such problems. Generation now uses `xhigh` plus the think-first line. AI help stays at `high`, since a person reads its answer and can ask again.

## Set up on the server

1. Create an API key in the [Claude Console](https://platform.claude.com/settings/keys). You can reuse the key from AI help.
2. Copy it, then send it from your clipboard to the server. It never appears in a command or your shell history:

   ```sh
   pbpaste | ssh -i ~/.ssh/learnrecur/azure_ed25519 -o IdentitiesOnly=yes \
     -o UserKnownHostsFile=~/.ssh/learnrecur/known_hosts lradmin@100.79.63.76 \
     'sudo install -d -o learnrecur -g learnrecur -m 700 /srv/learnrecur/secrets/anthropic &&
      sudo install -o learnrecur -g learnrecur -m 600 /dev/stdin /srv/learnrecur/secrets/anthropic/anthropic-api-key'
   ```

3. As the `learnrecur` user in `/srv/learnrecur/repo`, stop the services, switch the provider with a monthly limit in microusd, and start the worker. `IMAGE` is the running image from `/srv/learnrecur/backup.json`:

   ```sh
   M="python3 -m learnrecur.deploy.manage --state /srv/learnrecur/state --secrets /srv/learnrecur/secrets --image IMAGE --project learnrecur"
   $M stop
   $M configure-anthropic --monthly-limit-microusd 20000000
   $M start-worker
   ```

`configure-anthropic` refuses to run while services are up, when a restore is pending, or when the key file is missing or not private. Only the worker mounts the key, at `/run/learnrecur-anthropic`. To switch back, run `configure-openai` the same way.

## Switching providers

A job records the provider it was created for. When the worker picks up a job made for the other paid provider that hasn't called it yet, the job switches to the current provider's settings and guidance. That covers queued jobs, jobs waiting to retry, and failed refills that retry later. A job that already reached the old provider stays with it: its response can still be read and billed there, so recover it with that provider's commands.

## Recovery and charges

The batch ID works like OpenAI's response ID. The worker logs it as soon as the POST returns, saves it, and then only reads it. A restart reads the same batch and never submits another. Three read failures in a row stop the job with its reservation held.

Rejections at submission (400, 401, 403, 404, 413) fail the job without a charge, and 429 or 529 retry later. Other errors, timeouts, and a result for a different request are uncertain and hold the reservation. Errored, canceled, and expired batch requests aren't billed, so they settle at zero. A finished request that stopped for `max_tokens` or a refusal is billed but publishes nothing.

To recover an uncertain job, find its batch in the Console by the job's request ID, `lr-JOB_ID-ATTEMPT`. With the batch ID, stop the services and run `reconcile-anthropic --job-id JOB_ID --response-id msgbatch_...`. Without one, check usage in the Console and record the charge with `release-generation`, as in [the OpenAI notes](OPENAI.md#recovery-and-charges).

## Limits

The adapter has been checked against a fake batch API, not the real one. The first real refills still need a check of the cost records and of exercise quality. Data sent in batches is kept for 29 days and isn't eligible for zero data retention.
