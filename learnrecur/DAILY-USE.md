# Daily-use trial

The trial started on October 8, 2026 with three Spanish skills: regular -ar preterite, por versus para, and present perfect with regular -ar, -er, and -ir verbs. Two more grammar skills were added on October 18. Each skill has one native card and a locally cached exercise bank. Paid refills are enabled again under the existing $1 monthly ceiling until the October 31 cutoff below.

## Use the app

Open `~/Desktop/LearnRecur Daily.app`, choose **Daily Spanish**, and press **Study Now**. Solve each exercise, reveal the answer, and rate your recall normally. Review what is due each day; don't force extra reviews to exercise the system. Use **Report and skip** for an incorrect, ambiguous, or out-of-scope exercise.

The pinned app opens its separate profile under `~/.local/share/learnrecur/daily-use/2026-10-08/desktop`. Its startup code connects to the existing Azure services through an SSH tunnel before opening the window. Native sync runs on open and quit. Cached exercises stay local; generation and refill requests use the companion service. The other two decks contain earlier synthetic checks and are outside this trial. Nothing reads or changes personal Anki profiles.

If sync fails during a backup, wait for the backup to finish and press **Sync** again. A background helper reconnects if its own SSH process exits and closes it when the app quits. If reconnection fails, quit and reopen the app. Sync errors stay visible until dismissed, including during quit. Local reviews can continue from eligible cached exercises while disconnected; new refills and sync need reconnection.

## Spending and end date

The user approved up to $1 in new estimated generation spending on October 18 and enabled refills through the end of October. The worker uses GPT-6 Luna with `xhigh` reasoning. The two new skills cost an estimated $0.001039. No provider credits were assumed.

The existing $1 backend monthly ceiling was not reset. Recorded October spending was $0.005515 when refills resumed, leaving $0.994485 available with no unresolved reservations. This includes all earlier October usage, so it is stricter than the new allowance. Jobs reserve their maximum estimate before calling the provider. Estimates are not a provider-enforced billing cap.

The VPS cutoff is **23:59 UTC on October 31, 2026**, or **6:59 p.m. in Chicago**. Stopping before the UTC month changes prevents the monthly budget reset from granting another allowance. The boot check also enforces the deadline after a missed run. The cutoff stops the worker and moves its key into protected server storage outside the mounted directory. Sync and companion remain available. Generation after this cutoff needs new authorization.

To end generation early, stop the worker under the deployment lock and move its key out of the mounted directory before backup recovery could restart it. The private handoff records the paths. Starting the cutoff service before the deadline only checks the date; it does not end the trial early. Do not reset accounting or unpause a restored deployment to continue this trial.

## What was checked

The initial Mac app and ARM64 backend image used merged commit `fd3930eb5e246bc55c510494a462b0e5e5cab1af`, based on Anki 26.09.3. This does not deploy the upstream development rehearsal. The Mac package and launcher passed signature verification. The existing hosted records survived the upgrade unchanged; the previous image and source remain available for recovery.

All ten examples came from *Complete Spanish Step-by-Step*, with small adaptations to isolate the requested task. The saved provider requests retained those examples and generation instruction version 2. Private inspection found all nine answers correct, with clear tasks, appropriate scope, and useful variation. One present-perfect context is less natural than desired. Its initial bank covers -ar and -er, but not -ir; check coverage in later refills. These findings don't establish long-term exercise quality.

Native sync, normal quit, and restart preserved every card, note, and review exactly. All three trial cards were new and unrated at setup. No generated answers were shown in that preview, and no test ratings or reports were submitted on these cards. A restart during backup showed a network error; retrying sync after service recovery succeeded, and a subsequent launch was clean.

The retrieved password-manager key decrypted a current backup and passed every manifest hash. A fresh encrypted backup containing the trial restored on the separate Mac Linux host with three unrated cards, nine exercises, saved examples, jobs, and accounting. Both restore pauses remained, no restored service started, and no provider call ran during restoration. Daily backups and hourly freshness checks were configured on the VPS. The original October 15 cutoff stopped generation successfully; the October 18 renewal uses the same cutoff mechanism with a new date. No external failure notification is configured.

Definitions, source references, provider responses, keys, collections, receipts, and the operational handoff stay outside Git under `~/.local/share/learnrecur/daily-use/2026-10-08`. Start with `HANDOFF.md` there before resuming operational work. The matching image archive is under `~/.local/share/learnrecur/backend-images`.

## Current app

On October 18, the Daily runtime was rebuilt with FSRS defaults, optional formatting preferences, structured exercise layout, skill-deck wording, and the sync-error fixes. **LearnRecur Daily** is pinned to the Dock and still opens the existing Daily Spanish profile through its supervised SSH connection. The previous runtime and a collection snapshot remain available locally for recovery.

All 375 library, 338 Qt, and 455 companion/deployment tests passed, along with focused lint, packaging, and signature verification. A disposable Mac profile passed separated instruction/context rendering, bold answers, native rating, and undo. Daily Spanish passed startup, manual sync, and normal quit with its three trial notes, five native cards, and all 21 reviews preserved. FSRS remained enabled and no uploads were pending. No test ratings or reports were added to the daily profile.

The hosted sync server and companion now use `d2a73884c47603aa2abe73431c53fa5351f7f472`, matching the current presentation contract. A fresh encrypted backup preceded the upgrade, and the checked native and companion tables matched their previous fingerprints. The previous source and image remain available for recovery.

The user approved two more grammar skills and up to $1 in new generation spending. Their two initial jobs each produced three exercises on the first attempt, using instruction version 4 and all four selected book examples. Their answers and scope were checked privately. One context has slightly awkward chronology; watch naturalness during use. The estimated cost was $0.001039, with no reservation left. After those jobs, the persistent worker was resumed for refills with the existing ceiling and spending records intact.

Native import, sync, and restart left the two new cards unrated in Daily Spanish. All five previous notes and cards and all 21 review records were preserved exactly. FSRS remains enabled, and no uploads are pending. A fresh encrypted off-host backup restored on the Mac Linux host with all checked source tables intact and both generation pauses retained. No restored service or paid call ran during restoration.

The pinned Daily app now contains the signed runtime itself. The previous shortcut launched a separate app, which gave the running window a second Dock icon. Startup, the running window, and the saved Dock entry now have the same bundle identity and location. Cold launch and repeated opening used one process; normal quit released its connection helper and preserved all seven cards and 21 reviews exactly. Seven focused startup and helper checks passed, covering profile isolation, reconnect, ownership, startup refusal, and cleanup. The previous shortcut and runtime remain available locally for recovery. Dock animation frames were not recorded.

## Follow-up

On October 9, normal skill revisions replaced the initial banks with clearer line breaks and wider blanks while retaining the source examples and review history. On October 12, the user enabled FSRS at 90% desired retention without immediate rescheduling. Native learning steps remain `1m 10m`; learn-ahead can show the ten-minute step early.

On October 15, sync recovery preserved all 21 review records and uploaded three pending records. The launcher now reconnects its SSH tunnel, and failed collection or media sync waits for acknowledgment before quitting. No test ratings or reports were added.

Assess actual review friction, prompt clarity, por/para ambiguity, variation, naturalness, and coverage of all three regular verb endings. Check that report-and-skip uses an eligible backup without rating, sync and restart preserve reviews, and backups remain fresh.

Check that automatic refills arrive as banks run low, and monitor generation spending before the cutoff. Keep observed failures separate from guesses, and use those results to choose the next small change.
