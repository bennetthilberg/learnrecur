# Automatic backend backups

The VPS makes a daily age-encrypted backup of both server stores and uploads it to a private Azure Blob container. Your Mac can be asleep. This preserves server data; it does not replace app sync or protect reviews that have not synced yet.

The snapshot includes native collections and media, skill descriptions and revisions, exercise banks, jobs, response IDs, and generation accounting. Passwords, provider keys, and generation configuration remain outside it. Keep those credentials separately, along with the exact backend image named in each backup. [Linux recovery](LINUX.md#restore-on-another-host) describes the restore procedure and paid-generation pause. Scheduled archives cannot release paid generation. If the source survives, a [final source handoff](LINUX.md#recover-paid-generation-from-the-original-host) can recover later work before replacing it.

## Storage and identity

Use a dedicated Standard LRS, Hot, StorageV2 account and a private `backups` container. Require HTTPS and TLS 1.2, disable public blob access and shared-key access, and enable seven-day blob and container soft deletion. A deleted blob remains recoverable during that period; deleted bytes still consume storage. This protects against losing the VM, not losing access to the entire Azure account or region.

Enable the VM's system-assigned managed identity. Give it `Storage Blob Data Contributor` only on this container, rather than the whole subscription or storage account. The host backup process uses `ManagedIdentityCredential`; there is no stored Azure access key or interactive login. An authorized operator needs separate read access to retrieve backups if the VM is lost. The VM identity can read and delete backups in its container, so this is not immutable storage.

Keep only the public age recipient on the VPS. Keep its private identity on a separate trusted machine and in a second protected recovery location. The scheduler cannot decrypt its archives. Losing that identity makes the backups unreadable.

Azure for Students [publishes a Blob Storage allowance](https://azure.microsoft.com/en-us/free/students/), with credits available for eligible usage beyond free amounts. Free amounts and credits are shared with other resources. Confirm billed usage and the current credit expiry; do not remove the subscription spending limit or enable pay-as-you-go without authorization. The trial subscription's credits expire August 4, 2027. Stop or renew before expiry. The initial scheduler caps each encrypted archive at 32 MiB and live backup objects at 512 MiB; it stops rather than deleting history to make space. These are application limits, not billing caps. Soft-deleted data and interrupted uploads can add storage beyond the listed live objects.

## Installation

Use the dedicated `learnrecur` service user from the Linux setup. Install Python's `venv` package, then install the pinned host SDK dependencies:

```sh
sudo -u learnrecur python3 -m venv /srv/learnrecur/backup-venv
sudo -u learnrecur /srv/learnrecur/backup-venv/bin/pip install \
  -r /srv/learnrecur/repo/learnrecur/deploy/backup-requirements.txt
```

Create `/srv/learnrecur/backup.json`, owned by `learnrecur` with mode `600`. Use absolute, separate paths and the existing backend's exact image:

```json
{
  "state": "/srv/learnrecur/state",
  "secrets": "/srv/learnrecur/secrets",
  "image": "learnrecur-backend:EXACT_REVISION",
  "project": "learnrecur",
  "directory": "/srv/learnrecur/automatic-backups",
  "recipient": "age1YOUR_PUBLIC_RECIPIENT",
  "account": "YOUR_STORAGE_ACCOUNT",
  "container": "backups"
}
```

From the deployed repository, initialize a new backup directory. It refuses to adopt an existing directory:

```sh
sudo -u learnrecur /srv/learnrecur/backup-venv/bin/python \
  -m learnrecur.deploy.scheduled_backup --config /srv/learnrecur/backup.json init
```

Install the five files in `learnrecur/deploy/systemd/` under `/etc/systemd/system/`, owned by root. Check them with `systemd-analyze verify`, then enable both timers and the boot recovery service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now learnrecur-backup.timer learnrecur-backup-check.timer \
  learnrecur-backup-recover.service
```

The daily timer runs at 06:00 UTC, with up to 15 minutes of jitter. `Persistent=true` catches a missed daily run after reboot. The hourly check reports a failed run or a snapshot older than 36 hours as a failed systemd service. Status contains only backup names, sizes, hashes, image, timestamps, and exception class names. It contains no deck content or credentials. These checks are local to the VPS; no email, external uptime monitor, or notification delivery is configured. A powered-off VM cannot report its own failure.

## Upload, retry, and retention

The scheduler takes an exclusive lock. Its existing deployment manager briefly stops all running writers, captures a consistent snapshot, and restarts only the services that were running. A stopped paid worker stays stopped. The server is unavailable while its snapshot is made; upload and read-back happen after services resume. Before stopping writers, the scheduler saves which services were running. Recovery runs after a failed service, at boot, and before the next backup. It stops any abandoned, labeled backup helper before restarting those same services. An existing pending archive cannot count as successful while its stopped services still need recovery.

Uploads use unique names under `learnrecur/v1/` and refuse overwrites. The scheduler downloads the entire encrypted object and compares its size and SHA-256 hash. Only then does it remove older backups, keeping the newest snapshot from seven distinct UTC days and four ISO weeks. These overlap, so the usual total is at most eleven objects. It also keeps the just-verified object if two snapshots share a timestamp. Three local encrypted copies remain. Unrecognized objects stop retention instead of being deleted.

A failed upload leaves the local archive and older remote copies intact. The next run retries the same archive, including when Azure received it but the acknowledgement was lost. A pending snapshot from several days ago does not become fresh merely because its upload succeeded today. Run the service again to take a current snapshot after that retry. Finish a pending backup before changing its image, destination, or other configuration.

An archive over 32 MiB cannot upload, and normal retries keep it. After inspecting status, an operator can replace that pending snapshot:

```sh
sudo -u learnrecur /srv/learnrecur/backup-venv/bin/python \
  -m learnrecur.deploy.scheduled_backup --config /srv/learnrecur/backup.json \
  replace-oversized --archive EXACT_PENDING_ARCHIVE_NAME
```

This requires the original configuration and exact pending name. It recovers any stopped services, refuses archives already listed remotely, and preserves the encrypted file as `.oversized-<name>` before clearing the pending state. Preserved files are outside automatic retention; inspect and remove them manually when no longer needed. The command does not mark backups healthy, change storage limits, or resume a stopped worker. After reducing snapshot size, run the backup service to create and verify a fresh snapshot. A small archive with a failed upload must use the normal retry path.

Inspect or retry without enabling generation:

```sh
sudo systemctl list-timers 'learnrecur-backup*'
sudo systemctl status learnrecur-backup.service learnrecur-backup-check.service
sudo journalctl -u learnrecur-backup.service --since yesterday
sudo systemctl start learnrecur-backup.service
sudo systemctl start learnrecur-backup-check.service
```

After an image upgrade, finish any pending upload, update `backup.json` to the exact new image, and preserve both images while their backups remain. The host scheduler can back up an older deployed image without rebuilding it.

## Restore drill

Download an actual scheduled object with your operator identity, compare its ciphertext hash to the saved status, and restore on a different host into fresh LearnRecur storage using the matching image and private age identity. Do not overwrite or start a second writable copy of the production backend.

Check native cards, schedules, reviews, media, companion snapshot, generation jobs, response IDs, and recorded spending. Download the restored collection through a fresh synthetic client. Verify both restore markers and confirm that paid worker startup and refill requests stay blocked. A successful backup upload alone does not establish successful restoration.

On October 4, 2026, the live deployment and scheduler tools were upgraded to `a729de7e00b3f3acade1bc3a00cd7dd57e7fac20`. Fresh backups completed before and after the upgrade. The new service-created archive passed ciphertext verification and restored on the Mac's Linux host with matching native records, companion data, and accounting. Both generation pauses remained, and the restored services stayed stopped. Daily and hourly timers remain active; the live paid worker remains stopped. [The hosted check](LINUX.md#hosted-creation-and-final-handoff-check) records the boundaries and image preservation.
