# Operations

This page is how to keep LearnRecur running now that it's used daily. It says what runs where, how to update each part, and what to do when something goes wrong. The linked docs have the full commands and the history behind them.

## What runs where

- **Mac app.** *LearnRecur Daily* (`~/Desktop/LearnRecur Daily.app`, pinned to the Dock) is the packaged app with its own name, bundle ID, and profile. `qt/tools/learnrecur_daily/install.py` builds and installs it. Its configuration, logs, and install snapshots live in a private folder outside the repository, `~/.local/share/learnrecur/daily-use/2026-10-08`. On launch it opens an SSH tunnel to the server, and it syncs on open and quit. Reviews keep working offline from cached exercises. See [DAILY-USE.md](DAILY-USE.md).
- **Server.** An Azure ARM VM (Ubuntu 24.04, resource group `learnrecur-rg`) runs one Docker image as three containers: the sync server, the companion, and the paid generation worker. Their HTTP ports listen only on the VM's loopback address. The checkout, state, secrets, and backup configuration are under `/srv/learnrecur/`. See [deploy/LINUX.md](deploy/LINUX.md).
- **Network.** The Mac reaches the VM over Tailscale. A public SSH firewall rule exists but is set to deny. See [Access](#access).
- **Backups.** A timer on the VM makes a daily encrypted backup and uploads it to a private Azure Blob container. The decryption key isn't on the VM. See [deploy/AUTOMATIC-BACKUPS.md](deploy/AUTOMATIC-BACKUPS.md).
- **Private notes.** Receipts and the current-state handoff, `HANDOFF.md`, are in the Mac configuration folder. Checked ARM images are in `~/.local/share/learnrecur/backend-images`. Neither is in Git.

## Update the Mac app

1. Pull `main` and run `./ninja installer:package`.
2. Let the app sync, then quit it. The installer refuses to run while the app is open.
3. Run `install.py` with `--dry-run`. The full command is in [Build, install, and update the app](DAILY-USE.md#build-install-and-update-the-app). A dry run checks everything and changes nothing.
4. Run the same command without `--dry-run`. Before swapping in the new app, it saves the collection rows, a collection copy, and the previous app under `<config>/installs/<UTC time>/`.
5. Open the app and check that your decks and due counts look right and that sync succeeds.

To roll back, quit the app and move `previous.app` from that install folder back into place, using the commands in DAILY-USE.md. Restore `collection-before.anki2` only if the collection itself is damaged, since that throws away any review that hasn't synced since the install.

## Upgrade the server

The October 18 and 20 upgrades used these steps; [DAILY-USE.md](DAILY-USE.md#current-app) records what they checked. There's no script for this in the repository. Run each step by hand and check its result before going on.

1. **Build the ARM image on the Mac.** Use a clean checkout of the merged commit and the build command in [Prepare the host](deploy/LINUX.md#prepare-the-host). Apple Silicon builds the `arm64` image the VM needs; CI's x86 image won't run there. Save it with `docker image save` and keep a compressed copy in `~/.local/share/learnrecur/backend-images`.
2. **Run the restore check locally** with that image, using `learnrecur.deploy.check_restore` as in [Check the setup before a VPS](deploy/LINUX.md#check-the-setup-before-a-vps). Stop here if it fails.
3. **Transfer** the image archive and a `git archive` of the same commit to a private staging folder on the VM over Tailscale. Load the image with `docker image load` and check that its architecture is `arm64`.
4. **Quit the Mac app, then take a pre-upgrade off-host backup.** With the app closed, no client can sync while you compare rows below. Check that no upload is pending, run `sudo systemctl start learnrecur-backup.service`, and confirm the result is `ok`.
5. **Stop backups, then the services.** Stop `learnrecur-backup.timer`, `learnrecur-backup-check.timer`, and `learnrecur-backup-recover.service` so nothing restarts the containers mid-upgrade. Then stop all three containers with the manager's `stop` command, which holds the deployment lock while it runs. Confirm that nothing is running.
6. **Fingerprint the rows.** Open both databases read-only and hash every row of the native `notes`, `cards`, and `revlog` tables and the companion's `skills`, `skill_revisions`, `identities`, `exercise_batches`, `generation_jobs`, `generation_attempts`, and `generation_budget` tables. Save each table's row count, hash, and column list.
7. **Swap the source.** Move `/srv/learnrecur/repo` to a dated folder under `/srv/learnrecur/releases/`, unpack the new source in its place, and make the `learnrecur` user its owner. Leave the old image loaded.
8. **Update `backup.json`** so `image` names the new image. Each backup records the image needed to restore it, so this must match what's running.
9. **Start without the worker.** Run the manager's `start` with the new image. It starts sync and the companion, which applies any database migration, and leaves the worker stopped. Confirm that only those two are running.
10. **Compare fingerprints** using the saved column lists, before anything else writes. An upgrade can add columns, so compare only the original ones. Every count and hash must match. A running worker would change the job tables, so it must stay stopped until this passes.
11. **Start the worker and restart backups.** Run the manager's `start-worker`, confirm that sync, companion, and worker are running, then restart the backup timers and the recover service.
12. **Keep the previous source and image** while any backup you might restore still names the old image.

Then update the Mac app from the same commit, since the app and sync server must match. The exception is a release that adds exercise fields, such as `blanks` in instruction version 5. For those, update the Mac app first, because an older app refuses snapshots with fields it doesn't know. [Exercise presentation](PRESENTATION.md#saved-data-and-rollout) says which releases need this order.

Rolling back hasn't been needed or tested. It means stopping the services, putting the previous source back, pointing `backup.json` at the old image, and starting again. If the upgrade changed the database schema, check that the old code accepts the new databases before relying on that.

## Spending

The permanent control is the backend's $1 monthly ceiling. It resets at the start of each UTC month, which is 6 or 7 p.m. Chicago time on the last day of the month. Nothing needs doing at the reset. [DAILY-USE.md](DAILY-USE.md#spending) explains the decision.

- **Estimates aren't a provider cap.** Each job reserves its maximum estimated cost from saved prices before it calls OpenAI. The prepaid OpenAI balance doesn't stop spending instantly either; it can briefly go negative.
- **Unconfirmed reservations carry over.** A reservation whose result or charge is uncertain counts against every month until someone reconciles it. The monthly reset doesn't clear it.
- **Check spending** in **Tools > Generation history…**, which shows the month's spending, the limit, and unresolved reservations from any month. See [GENERATION-HISTORY.md](GENERATION-HISTORY.md).
- **Stuck jobs.** A job in `needs_attention` pauses refills for every skill. Run the manager's `inspect-generation` to see it. With a saved response ID, stop the services and run `reconcile-openai`. Without one, find the request in the OpenAI dashboard and record its charge with `release-generation`, which can run while services are up. If a result was saved but not published, stop the services and run `publish-ready`. Afterward, run `start-worker`. The commands are in [Restore on another host](deploy/LINUX.md#restore-on-another-host), and [Recovery and charges](companion/OPENAI.md#recovery-and-charges) explains them.
- **Stop paid generation.** Run the manager's `stop`, move `secrets/openai/openai-api-key` out of the `openai` folder, then run `start`. That brings back sync and companion only, and `start-worker` refuses to run without the key. Refill requests wait in the queue, and cached review keeps working.

Don't reset accounting or remove restore markers to get around the ceiling. Raising it, up to the $5 maximum, needs the user's approval.

## Backups and alerts

The VM backs up both stores at 06:00 UTC each day. It verifies the uploaded copy and keeps a week of dailies and four weeklies. An hourly check fails if the last backup failed or is more than 36 hours old. [Automatic backend backups](deploy/AUTOMATIC-BACKUPS.md) has the details.

Alerts email the user through two separate paths, so a dead VM can't hide its own failure:

- **Healthchecks.io.** Each successful backup pings a check, and a failed backup or freshness check pings `/fail`. The ping URL is in `/etc/learnrecur/healthcheck-url`. Missing the daily ping also sends an email.
- **Azure.** Resource Health and activity-log alerts email when the VM becomes unavailable or degraded, or is stopped, deallocated, or deleted. A $5 monthly budget on `learnrecur-rg` emails at 80% and 100% of actual cost and at 100% of forecast. It counts usage before student credits, so it's an early warning, not a bill.

Neither path watches the containers. If the app can't sync while the VM is up, connect and run `sudo docker ps` to see what's running.

When an alert fires:

- **Healthchecks.io says down.** Connect over Tailscale and read `systemctl status` and `journalctl` for `learnrecur-backup.service` and `learnrecur-backup-check.service`. Fix the cause and run the backup service again. The check goes back up after the next successful ping. A failed upload retries the same archive, and one over 32 MiB needs `replace-oversized`, as described in [Upload, retry, and retention](deploy/AUTOMATIC-BACKUPS.md#upload-retry-and-retention).
- **VM unavailable or degraded.** This is usually an Azure problem. Wait for the resolved email, then check that the app syncs. Docker restarts the containers that were running, and the daily timer catches up on a missed backup.
- **VM stopped, deallocated, or deleted.** If you didn't do it, check the Azure activity log. Start a stopped VM from the portal or `az vm start`. If it was deleted, restore on a new host; see [Restore on another host](deploy/LINUX.md#restore-on-another-host).
- **Budget warning.** Open Cost Management for `learnrecur-rg` and find what grew. Hosting must stay under $5 a month out of pocket after credits. Don't add paid resources or switch to pay-as-you-go without the user's approval.

## Restore drills

A backup counts only once you've restored it. Run a drill every quarter, and after any change to the backup tooling. The next one is due by January 2027.

Follow [Restore drill](deploy/AUTOMATIC-BACKUPS.md#restore-drill) and [Restore on another host](deploy/LINUX.md#restore-on-another-host). Download a real scheduled backup and decrypt it with the password-manager copy of the age identity, which also checks that copy. Restore it on the Mac's Linux Docker host into fresh storage with the matching image. Compare the cards, reviews, media, and generation records, and check that both restore pauses are still in place. Never start the restored copy as a second live server. Record the result in `ROADMAP.md`.

Paid generation stays paused after any restore. See [deploy/LINUX.md](deploy/LINUX.md) for how to recover it.

## Access

- **Tailscale** connects the Mac and the VM on one account. Key expiry is turned off for both devices, and the VM updates Tailscale automatically. If the app can't connect, check that Tailscale is connected in the Mac's menu bar.
- **Emergency SSH.** The public `ssh-from-mac` rule stays set to deny. If Tailscale fails, open it for your current address only, connect, fix Tailscale, then set it back to deny. The commands are in [Reach the host from other networks](deploy/LINUX.md#reach-the-host-from-other-networks). The Azure serial console is the last resort.
- **Secrets.** The sync password, companion token, and OpenAI key live in the VM's secrets folder, and only the worker mounts the OpenAI key. On the Mac, the companion token is in the private configuration folder and the sync login is in the Daily profile. The backup decryption key is never on the VM; it's in the Mac's protected configuration and the password manager.

## Calendar

- **Each UTC month:** the spending ceiling resets. Glance at Generation history and the Azure costs.
- **Each quarter:** run a restore drill.
- **Before August 4, 2027:** the Azure student credits expire. Decide by early summer 2027 whether to renew eligibility or move to another host within the $5 limit. Moving a live backend uses the final handoff in [deploy/LINUX.md](deploy/LINUX.md).
- **New stable Anki releases:** rehearse the merge as described in [Update from upstream](UPSTREAM.md#update-from-upstream) and [UPSTREAM-REHEARSAL.md](UPSTREAM-REHEARSAL.md). Then deploy it with the server and Mac app steps above.
