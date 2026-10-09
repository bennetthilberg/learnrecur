# Daily-use trial

The October 8–15, 2026 trial uses three Spanish skills: regular -ar preterite, por versus para, and present perfect with regular -ar, -er, and -ir verbs. Each skill has one new native card and three cached exercises. A week of actual use is still ahead.

## Use the app

Open `~/Desktop/LearnRecur Daily.app`, choose **Daily Spanish**, and press **Study Now**. Solve each exercise, reveal the answer, and rate your recall normally. Review what is due each day; don't force extra reviews to exercise the system. Use **Report and skip** for an incorrect, ambiguous, or out-of-scope exercise.

The launcher opens a pinned LearnRecur app and its separate profile under `~/.local/share/learnrecur/daily-use/2026-10-08/desktop`. It connects to the existing Azure services through an SSH tunnel. Native sync runs on open and quit. Cached exercises stay local; generation and refill requests use the companion service. The other two decks contain earlier synthetic checks and are outside this trial. Nothing reads or changes personal Anki profiles.

If sync fails during a backup, wait for the backup to finish and press **Sync** again. If the SSH tunnel has disconnected, quit and reopen the launcher. Local reviews can continue from eligible cached exercises while disconnected; new refills and sync need reconnection.

## Spending and end date

The user approved up to $1 total estimated generation spending, including initial jobs and refills. The worker uses GPT-6 Luna with `xhigh` reasoning. The initial jobs cost an estimated $0.001034 and left no unresolved reservations. No provider credits were assumed.

The existing backend monthly ceiling remains $1 and includes $0.000155 of earlier October usage. It was not reset, so the trial has slightly less than another dollar available. Jobs reserve their maximum estimate before calling the provider. Estimates are not a provider-enforced billing cap.

A one-time VPS timer stops the worker at **22:00 UTC on October 15, 2026**, or **5 p.m. in Chicago**. Its boot check also enforces the deadline after a missed run. At expiry it moves the worker key out of the mounted directory into protected server storage; it does not delete the key. Sync and companion remain available. Further paid generation needs new authorization.

To end generation early, stop the worker under the deployment lock and move its key out of the mounted directory before backup recovery could restart it. The private handoff records the paths. Starting the cutoff service before the deadline only checks the date; it does not end the trial early. Do not reset accounting or unpause a restored deployment to continue this trial.

## What was checked

The Mac app and ARM64 backend image use merged commit `fd3930eb5e246bc55c510494a462b0e5e5cab1af`, based on Anki 26.09.3. This does not deploy the upstream development rehearsal. The Mac package and launcher passed signature verification. The existing hosted records survived the upgrade unchanged; the previous image and source remain available for recovery.

All ten examples came from *Complete Spanish Step-by-Step*, with small adaptations to isolate the requested task. The saved provider requests retained those examples and generation instruction version 2. Private inspection found all nine answers correct, with clear tasks, appropriate scope, and useful variation. One present-perfect context is less natural than desired. Its initial bank covers -ar and -er, but not -ir; check coverage in later refills. These findings don't establish long-term exercise quality.

Native sync, normal quit, and restart preserved every card, note, and review exactly. All three trial cards remain new and unrated. No generated answers were shown in the user's preview, and no test ratings or reports were submitted on these cards. A restart during backup showed a network error; retrying sync after service recovery succeeded, and a subsequent launch was clean.

The retrieved password-manager key decrypted a current backup and passed every manifest hash. A fresh encrypted backup containing the trial restored on the separate Mac Linux host with three unrated cards, nine exercises, saved examples, jobs, and accounting. Both restore pauses remained, no restored service started, and no provider call ran during restoration. Daily backups, hourly freshness checks, and the trial cutoff timer are active on the VPS. No external failure notification is configured.

Definitions, source references, provider responses, keys, collections, receipts, and the operational handoff stay outside Git under `~/.local/share/learnrecur/daily-use/2026-10-08`. Start with `HANDOFF.md` there before resuming operational work. The matching image archive is under `~/.local/share/learnrecur/backend-images`.

## After the week

Check actual review friction, prompt clarity, por/para ambiguity, variation, naturalness, and coverage of all three regular verb endings. Confirm automatic refills arrive, report-and-skip uses an eligible backup without rating, sync and restart preserve reviews, backups remain fresh, and generation spending stays within the allowance. Keep observed failures separate from guesses. Use those results to choose the next small change.
